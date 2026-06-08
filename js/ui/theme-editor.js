/**
 * 主题编辑器
 * 独立 Modal 弹窗，集成色盘组件
 */

import { eventBus } from '../core/events.js';
import { escapeHtml, generateId } from '../utils/helpers.js';
import { showInputDialog, showConfirmDialog } from '../utils/dialogs.js';
import { openColorPicker } from './color-picker.js';
import {
    THEME_PROPERTIES,
    applyTheme,
    getCurrentSnapshot,
    resetTheme,
    cacheThemeToLocalStorage,
    getActiveThemeId,
    getBuiltinTheme,
    setThemeProperty,
    removeThemeProperty,
    applyCustomCSS,
    sanitizeCustomCSS
} from './theme-engine.js';
import {
    saveTheme,
    loadTheme,
    deleteTheme,
    listThemes,
    exportThemeAsJSON,
    importThemeFromFile
} from '../state/theme-storage.js';
import { bindTopmostEscape } from '../utils/modal-stack.js';
import { logger } from '../utils/logger.js';

let modal = null;
let beforeSnapshot = null;
let currentThemeData = null;
let activePickerHandle = null;
let cssDebounceTimer = null;

function getModal() {
    if (!modal) modal = document.getElementById('theme-editor-modal');
    return modal;
}

function closePicker() {
    if (activePickerHandle) {
        activePickerHandle.destroy();
        activePickerHandle = null;
    }
}

/* ===== 通用属性行构建 ===== */

function createPropRow(section, varName, meta, container) {
    const currentValue = getComputedStyle(document.documentElement)
        .getPropertyValue(`--${varName}`)
        .trim();
    const isColor = !meta.type || meta.type === 'color';
    const isFont = meta.type === 'font';
    const isSize = meta.type === 'size';

    const row = document.createElement('div');
    row.className = 'theme-prop-row';

    if (isColor) {
        // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
        row.innerHTML = `
            <span class="theme-prop-label">${escapeHtml(meta.label)}</span>
            <button class="color-swatch" style="background: ${escapeHtml(currentValue)}"></button>
            <span class="theme-prop-value">${escapeHtml(currentValue)}</span>
            <button class="theme-prop-reset" title="重置">↺</button>
        `;
        const swatch = row.querySelector('.color-swatch');
        swatch.addEventListener('click', () => {
            closePicker();
            activePickerHandle = openColorPicker(
                swatch,
                getComputedStyle(document.documentElement).getPropertyValue(`--${varName}`).trim(),
                (color) => {
                    setThemeProperty(varName, color);
                    swatch.style.background = color;
                    row.querySelector('.theme-prop-value').textContent = color;
                    setThemeValue(section, varName, color);
                },
                () => {
                    activePickerHandle = null;
                }
            );
        });
    } else if (isFont) {
        // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
        row.innerHTML = `
            <span class="theme-prop-label">${escapeHtml(meta.label)}</span>
            <input class="theme-prop-input theme-font-input" type="text" value="${escapeHtml(currentValue)}">
            <button class="theme-prop-reset" title="重置">↺</button>
        `;
        const input = row.querySelector('input');
        input.addEventListener('change', () => {
            setThemeProperty(varName, input.value);
            setThemeValue(section, varName, input.value);
        });
    } else if (isSize) {
        // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
        row.innerHTML = `
            <span class="theme-prop-label">${escapeHtml(meta.label)}</span>
            <input class="theme-prop-input theme-size-input" type="number"
                   value="${parseFloat(currentValue)}" min="${meta.min ?? ''}" max="${meta.max ?? ''}"
                   step="${meta.step || 1}">
            <span class="theme-prop-unit">${escapeHtml(meta.unit || '')}</span>
            <button class="theme-prop-reset" title="重置">↺</button>
        `;
        const input = row.querySelector('input');
        input.addEventListener('change', () => {
            const val = `${input.value}${meta.unit || ''}`;
            setThemeProperty(varName, val);
            setThemeValue(section, varName, val);
        });
    }

    row.querySelector('.theme-prop-reset').addEventListener('click', () => {
        removeThemeProperty(varName);
        const fresh = getComputedStyle(document.documentElement)
            .getPropertyValue(`--${varName}`)
            .trim();
        if (isColor) {
            row.querySelector('.color-swatch').style.background = fresh;
            row.querySelector('.theme-prop-value').textContent = fresh;
        } else {
            const input = row.querySelector('input');
            input.value = isFont ? fresh : parseFloat(fresh);
        }
        removeThemeValue(section, varName);
    });

    container.appendChild(row);
}

/* ===== Tab 切换 ===== */

function switchTab(tabName) {
    const m = getModal();
    if (!m) return;

    closePicker();
    clearTimeout(cssDebounceTimer);

    m.querySelectorAll('.theme-editor-tabs button').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.tab === tabName);
    });

    const body = m.querySelector('.theme-editor-body');
    // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
    body.innerHTML = '';

    switch (tabName) {
        case 'colors':
            renderColorsTab(body);
            break;
        case 'fonts':
            renderPropsTab(body, 'fonts');
            break;
        case 'effects':
            renderPropsTab(body, 'effects');
            break;
        case 'layout':
            renderLayoutTab(body);
            break;
        case 'css':
            renderCSSTab(body);
            break;
    }
}

/* ===== 颜色 Tab（分组显示） ===== */

function renderColorsTab(container) {
    const props = THEME_PROPERTIES.colors;
    const groups = {};

    for (const [varName, meta] of Object.entries(props)) {
        const group = meta.group || '其他';
        if (!groups[group]) groups[group] = [];
        groups[group].push({ varName, meta });
    }

    for (const [groupName, items] of Object.entries(groups)) {
        const section = document.createElement('div');
        section.className = 'theme-prop-section';
        // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
        section.innerHTML = `<h3 class="theme-prop-section-title">${escapeHtml(groupName)}</h3>`;

        for (const { varName, meta } of items) {
            createPropRow('colors', varName, meta, section);
        }

        container.appendChild(section);
    }
}

/* ===== 通用属性 Tab（字体/效果） ===== */

function renderPropsTab(container, sectionName) {
    const props = THEME_PROPERTIES[sectionName];
    for (const [varName, meta] of Object.entries(props)) {
        createPropRow(sectionName, varName, meta, container);
    }
}

/* ===== 间距/布局 Tab ===== */

function renderLayoutTab(container) {
    for (const sectionName of ['spacing', 'layout']) {
        const props = THEME_PROPERTIES[sectionName];
        for (const [varName, meta] of Object.entries(props)) {
            createPropRow(sectionName, varName, meta, container);
        }
    }
}

/* ===== 自定义 CSS Tab ===== */

const CSS_TEMPLATE = `/* ============================
 * 自定义 CSS 示例模板
 * 删除不需要的部分，修改后即时生效
 * ============================ */

/* --- 页面背景 --- */
/* .app-container {
    background: url('图片地址') center/cover fixed;
    background-color: #1a1a2e;
} */

/* --- 像素装饰元素（云朵/星星/钻石/心形/点阵） --- */
/* 隐藏全部装饰 */
/* .pixel-cloud, .pixel-star, .pixel-diamond,
.pixel-heart, .pixel-dots {
    display: none;
} */
/* 或单独调整 */
/* .pixel-star { filter: hue-rotate(90deg) brightness(1.5); }
.pixel-cloud { opacity: 0.3; filter: blur(2px); } */

/* --- 顶部导航栏 --- */
/* .app-header { background: linear-gradient(135deg, #667eea, #764ba2); }
.app-title { font-family: 'Comic Sans MS', cursive; } */

/* --- 侧边栏 --- */
/* .sidebar { backdrop-filter: blur(10px); }
.session-item { border-radius: 12px; }
.session-item.active { border-left: 3px solid var(--md-teal); } */

/* --- 聊天区域 --- */
/* .chat-container { background: rgba(0,0,0,0.3); } */

/* --- 消息气泡 --- */
/* 用户消息 */
/* .message.user .message-content {
    border-radius: 16px 16px 4px 16px;
} */
/* AI 消息 */
/* .message.assistant .message-content {
    border-radius: 16px 16px 16px 4px;
} */
/* 消息头像 */
/* .message-avatar { border-radius: 50%; } */

/* --- 输入区域 --- */
/* .input-bar-inner {
    border-radius: 24px;
    backdrop-filter: blur(8px);
}
.send-btn { border-radius: 50%; }
.cancel-btn { border-radius: 50%; } */

/* --- 代码块 --- */
/* .code-collapse-header { border-radius: 8px 8px 0 0; }
.code-collapse-content { font-size: 13px; line-height: 1.6; } */

/* --- 思维链/推理块 --- */
/* .thinking-block {
    border-left: 3px solid var(--md-yellow);
    background: rgba(var(--palette-yellow-rgb), 0.05);
} */

/* --- 欢迎页面 --- */
/* .welcome-message {
    backdrop-filter: blur(20px);
    border-radius: 24px;
} */

/* --- 设置面板 --- */
/* .settings-panel { backdrop-filter: blur(12px); }
.settings-group { border-radius: 12px; } */

/* --- 滚动条 --- */
/* ::-webkit-scrollbar { width: 6px; }
::-webkit-scrollbar-thumb {
    background: var(--md-blue);
    border-radius: 3px;
} */

/* --- 通知消息 --- */
/* .notification { border-radius: 12px; backdrop-filter: blur(8px); } */

/* --- 工具调用卡片 --- */
/* .tool-calls-summary-btn { border-radius: 12px; } */

/* --- 对话框/弹窗 --- */
/* .modal-content { border-radius: 16px; backdrop-filter: blur(12px); }
.btn-primary { border-radius: 8px; }
.btn-secondary { border-radius: 8px; } */

/* --- Mermaid 图表 --- */
/* .mermaid-block { border-radius: 12px; }
.mermaid-canvas { filter: none; } */

/* --- 图片查看器 --- */
/* .image-viewer-modal { backdrop-filter: blur(20px); } */

/* --- 快捷消息 --- */
/* .quick-messages-modal-content { border-radius: 16px; } */

/* --- 全局字体覆盖 --- */
/* * { font-family: 'Your Font', sans-serif; } */

/* --- 全局圆角风格 --- */
/* 改为全圆润 */
/* * { border-radius: 12px; } */
/* 改为全方角 */
/* * { border-radius: 0; } */

/* --- 毛玻璃效果 --- */
/* .settings-panel, .sidebar, .input-bar-inner {
    background: rgba(var(--color-bg-surface-rgb), 0.7);
    backdrop-filter: blur(16px);
} */
`;

function renderCSSTab(container) {
    const css = currentThemeData?.customCSS || '';
    // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
    container.innerHTML = `
        <div class="theme-css-editor">
            <div class="theme-css-toolbar">
                <p class="theme-css-hint">输入自定义 CSS，即时生效。禁止使用 @import 和 url()。</p>
                <button class="theme-css-template-btn" title="插入示例模板">插入模板</button>
            </div>
            <textarea class="theme-css-textarea" spellcheck="false"
                      placeholder="/* 在此输入自定义 CSS */">${escapeHtml(css)}</textarea>
        </div>
    `;

    const textarea = container.querySelector('.theme-css-textarea');
    textarea.addEventListener('input', () => {
        clearTimeout(cssDebounceTimer);
        cssDebounceTimer = setTimeout(() => {
            const val = textarea.value;
            const { css } = sanitizeCustomCSS(val);
            if (currentThemeData) currentThemeData.customCSS = css;
            applyCustomCSS(css);
        }, 300);
    });

    container.querySelector('.theme-css-template-btn').addEventListener('click', () => {
        if (textarea.value.trim() && !textarea.value.includes('自定义 CSS 示例模板')) {
            textarea.value = textarea.value + '\n\n' + CSS_TEMPLATE;
        } else if (!textarea.value.includes('自定义 CSS 示例模板')) {
            textarea.value = CSS_TEMPLATE;
        }
        textarea.dispatchEvent(new Event('input'));
        textarea.scrollTop = 0;
    });
}

/* ===== 主题数据操作 ===== */

function setThemeValue(section, varName, value) {
    if (!currentThemeData) currentThemeData = { base: 'dark' };
    if (!currentThemeData[section]) currentThemeData[section] = {};
    currentThemeData[section][varName] = value;
}

function removeThemeValue(section, varName) {
    if (currentThemeData?.[section]) {
        delete currentThemeData[section][varName];
    }
}

/* ===== 预设选择器 ===== */

async function populatePresetSelector() {
    const select = getModal()?.querySelector('#theme-preset-select');
    if (!select) return;

    try {
        const themes = await listThemes();
        // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
        select.innerHTML = '';

        for (const t of themes) {
            const opt = document.createElement('option');
            opt.value = t.id;
            opt.textContent = t.name;
            if (t.id === (currentThemeData?.id || getActiveThemeId())) {
                opt.selected = true;
            }
            select.appendChild(opt);
        }
    } catch (e) {
        logger.error('加载主题列表失败:', e);
    }
}

async function onPresetChange(e) {
    const themeId = e.target.value;
    try {
        const theme = await loadTheme(themeId);
        if (!theme) return;

        resetTheme();
        currentThemeData = { ...theme };
        await applyTheme(theme);
        switchTab(getActiveTabName());
    } catch (e2) {
        logger.error('切换主题失败:', e2);
        eventBus.emit('ui:notification', { message: '切换主题失败', type: 'error' });
    }
}

function getActiveTabName() {
    const btn = getModal()?.querySelector('.theme-editor-tabs button.active');
    return btn?.dataset.tab || 'colors';
}

/* ===== 操作按钮 ===== */

async function onSave() {
    if (!currentThemeData) return;

    if (currentThemeData.builtin) {
        eventBus.emit('ui:notification', {
            message: '内置主题不能修改，请使用"另存为"',
            type: 'warning'
        });
        return;
    }

    try {
        currentThemeData.updatedAt = Date.now();
        await saveTheme(currentThemeData);
        cacheThemeToLocalStorage(currentThemeData);
        beforeSnapshot = getCurrentSnapshot(); // 更新安全点，后续关闭回退到此
        eventBus.emit('ui:notification', { message: '主题已保存', type: 'success' });
    } catch (e) {
        logger.error('保存主题失败:', e);
        eventBus.emit('ui:notification', { message: '保存主题失败', type: 'error' });
    }
}

async function onSaveAs() {
    const name = await showInputDialog('输入新主题名称:', '', '新建主题');
    if (!name?.trim()) return;

    try {
        // 从 currentThemeData 拷贝（仅用户覆盖值），不用 getCurrentSnapshot（会包含全部默认值）
        const newTheme = {
            name: name.trim(),
            id: generateId('theme'),
            base:
                currentThemeData?.base ||
                (document.documentElement.classList.contains('dark-theme') ? 'dark' : 'light'),
            version: 1,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            customCSS: currentThemeData?.customCSS || ''
        };
        // 仅拷贝有覆盖的 section
        for (const section of Object.keys(THEME_PROPERTIES)) {
            if (currentThemeData?.[section] && Object.keys(currentThemeData[section]).length > 0) {
                newTheme[section] = { ...currentThemeData[section] };
            }
        }

        await saveTheme(newTheme);
        currentThemeData = newTheme;
        cacheThemeToLocalStorage(newTheme);
        beforeSnapshot = getCurrentSnapshot();
        await populatePresetSelector();
        eventBus.emit('ui:notification', {
            message: `主题"${escapeHtml(name)}"已保存`,
            type: 'success'
        });
    } catch (e) {
        logger.error('另存主题失败:', e);
        eventBus.emit('ui:notification', { message: '保存主题失败', type: 'error' });
    }
}

async function onDelete() {
    if (!currentThemeData?.id || currentThemeData.builtin) {
        eventBus.emit('ui:notification', { message: '不能删除内置主题', type: 'warning' });
        return;
    }

    const confirmed = await showConfirmDialog(
        `确定删除主题"${currentThemeData.name}"？`,
        '删除主题'
    );
    if (!confirmed) return;

    try {
        await deleteTheme(currentThemeData.id);
        resetTheme();
        currentThemeData = getBuiltinTheme('__dark__');
        cacheThemeToLocalStorage(currentThemeData);
        await applyTheme(currentThemeData);
        await populatePresetSelector();
        switchTab(getActiveTabName());
        eventBus.emit('ui:notification', { message: '主题已删除', type: 'success' });
    } catch (e) {
        logger.error('删除主题失败:', e);
        eventBus.emit('ui:notification', { message: '删除主题失败', type: 'error' });
    }
}

async function onImport() {
    try {
        const { theme, warnings } = await importThemeFromFile();
        if (warnings.length > 0) {
            eventBus.emit('ui:notification', {
                message: `导入警告: ${warnings.join('; ')}`,
                type: 'warning',
                duration: 5000
            });
        }

        await saveTheme(theme);
        resetTheme();
        currentThemeData = theme;
        cacheThemeToLocalStorage(theme);
        await applyTheme(theme);
        await populatePresetSelector();
        switchTab(getActiveTabName());
        eventBus.emit('ui:notification', {
            message: `主题"${escapeHtml(theme.name)}"导入成功`,
            type: 'success'
        });
    } catch (e) {
        if (e.message !== '用户取消选择') {
            eventBus.emit('ui:notification', { message: e.message, type: 'error' });
        }
    }
}

function onExport() {
    if (!currentThemeData) return;
    exportThemeAsJSON(currentThemeData);
}

/* ===== 打开/关闭 ===== */

export async function openThemeEditor() {
    const m = getModal();
    if (!m) return;

    beforeSnapshot = getCurrentSnapshot();

    try {
        const activeId = getActiveThemeId();
        if (activeId) {
            const theme = await loadTheme(activeId);
            currentThemeData = theme ? { ...theme } : getCurrentSnapshot();
        } else {
            currentThemeData = getCurrentSnapshot();
            currentThemeData.id = document.documentElement.classList.contains('dark-theme')
                ? '__dark__'
                : '__light__';
            currentThemeData.builtin = true;
            currentThemeData.name =
                currentThemeData.id === '__dark__' ? 'Dark（默认）' : 'Light（默认）';
        }
    } catch (e) {
        logger.error('加载活跃主题失败:', e);
        currentThemeData = getCurrentSnapshot();
    }

    m.style.display = 'flex';
    m.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';

    await populatePresetSelector();
    switchTab('colors');
}

export function closeThemeEditor(revert = true) {
    const m = getModal();
    if (!m) return;

    closePicker();

    if (revert && beforeSnapshot) {
        resetTheme();
        applyTheme(beforeSnapshot);
    }

    m.style.display = 'none';
    m.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
    beforeSnapshot = null;
}

/* ===== 初始化 ===== */

export function initThemeEditor() {
    const m = getModal();
    if (!m) return;

    m.querySelectorAll('.theme-editor-tabs button').forEach((btn) => {
        btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });

    m.querySelector('#theme-save-btn')?.addEventListener('click', onSave);
    m.querySelector('#theme-save-as-btn')?.addEventListener('click', onSaveAs);
    m.querySelector('#theme-delete-btn')?.addEventListener('click', onDelete);
    m.querySelector('#theme-import-btn')?.addEventListener('click', onImport);
    m.querySelector('#theme-export-btn')?.addEventListener('click', onExport);
    m.querySelector('#theme-preset-select')?.addEventListener('change', onPresetChange);

    m.querySelector('.close-theme-editor')?.addEventListener('click', () => closeThemeEditor(true));
    // ESC 关闭（叠层场景仅响应最顶层 modal）
    bindTopmostEscape(m, () => closeThemeEditor(true));
    m.addEventListener('click', (e) => {
        if (e.target === m) closeThemeEditor(true);
    });

    document.getElementById('theme-editor-toggle')?.addEventListener('click', openThemeEditor);

    logger.debug('主题编辑器已初始化');
}
