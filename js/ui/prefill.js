/**
 * 预填充 UI 同步
 * 保留 Gemini System Parts 初始化 + config:sync-prefill-ui 事件
 */

import { state } from '../core/state.js';
import { eventBus } from '../core/events.js';
import { saveCurrentConfig } from '../state/config.js';
import { showNotification } from './notifications.js';
import { escapeHtml } from '../utils/helpers.js';
import { showInputDialog, showConfirmDialog } from '../utils/dialogs.js';
import { logger } from '../utils/logger.js';

function autoResizeTextareaGeneric(textarea, minHeight = 60, maxHeight = 300) {
    if (!textarea) return;
    textarea.style.height = 'auto';
    const newHeight = Math.max(minHeight, Math.min(textarea.scrollHeight, maxHeight));
    textarea.style.height = newHeight + 'px';
}

// ==================== Gemini System Parts ====================

function renderGeminiSystemPartsList() {
    const container = document.getElementById('gemini-system-parts-list');
    if (!container) return;

    if (state.geminiSystemParts.length === 0) {
        // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML
        container.innerHTML =
            '<div style="text-align: center; color: var(--md-muted); font-size: 12px; padding: 12px;">暂无 System Parts</div>';
        return;
    }

    // eslint-disable-next-line no-restricted-syntax -- 已审计：已escapeHtml
    container.innerHTML = state.geminiSystemParts
        .map(
            (part, idx) => `
        <div class="system-part-item" data-index="${idx}">
            <div class="system-part-header">
                <span class="system-part-index">Part #${idx + 1}</span>
                <button class="delete-system-part" data-index="${idx}" title="删除">\u00d7</button>
            </div>
            <textarea class="system-part-content" data-index="${idx}" placeholder="System Instruction Part 内容...">${escapeHtml(part.text || '')}</textarea>
        </div>
    `
        )
        .join('');

    container.querySelectorAll('.system-part-content').forEach((textarea) => {
        autoResizeTextareaGeneric(textarea);
        textarea.addEventListener('input', (e) => {
            const idx = parseInt(e.target.dataset.index);
            state.geminiSystemParts[idx].text = e.target.value;
            state.currentGeminiPartsPresetName = '';
            updateGeminiPartsPresetSelect();
            saveCurrentConfig();
            autoResizeTextareaGeneric(e.target);
        });
    });

    container.querySelectorAll('.delete-system-part').forEach((btn) => {
        btn.addEventListener('click', (e) => {
            const idx = parseInt(e.target.dataset.index);
            state.geminiSystemParts.splice(idx, 1);
            state.currentGeminiPartsPresetName = '';
            renderGeminiSystemPartsList();
            updateGeminiPartsPresetSelect();
            saveCurrentConfig();
        });
    });
}

function addGeminiSystemPart() {
    const input = document.getElementById('gemini-system-part-input');
    if (!input) return;

    const text = input.value.trim();
    if (!text) {
        showNotification('请输入 System Part 内容', 'warning');
        return;
    }

    state.geminiSystemParts.push({ text });
    state.currentGeminiPartsPresetName = '';
    input.value = '';
    renderGeminiSystemPartsList();
    updateGeminiPartsPresetSelect();
    saveCurrentConfig();
    showNotification('System Part 已添加', 'success');
}

async function saveGeminiPartsPreset() {
    const name = await showInputDialog(
        '请输入预设名称:',
        state.currentGeminiPartsPresetName || '新预设',
        '保存预设'
    );
    if (!name) return;

    const preset = {
        name,
        geminiSystemParts: JSON.parse(JSON.stringify(state.geminiSystemParts))
    };

    const idx = state.savedGeminiPartsPresets.findIndex((p) => p.name === name);
    if (idx >= 0) {
        state.savedGeminiPartsPresets[idx] = preset;
    } else {
        state.savedGeminiPartsPresets.push(preset);
    }

    state.currentGeminiPartsPresetName = name;
    updateGeminiPartsPresetSelect();
    saveCurrentConfig();
    showNotification(`预设 "${name}" 已保存`, 'info');
}

function loadGeminiPartsPreset() {
    const name = document.getElementById('gemini-parts-preset-select')?.value;
    if (!name) {
        state.currentGeminiPartsPresetName = '';
        return;
    }

    const preset = state.savedGeminiPartsPresets.find((p) => p.name === name);
    if (preset) {
        state.geminiSystemParts = JSON.parse(JSON.stringify(preset.geminiSystemParts || []));
        state.currentGeminiPartsPresetName = name;
        renderGeminiSystemPartsList();
        saveCurrentConfig();
    }
}

async function deleteGeminiPartsPreset() {
    const name = document.getElementById('gemini-parts-preset-select')?.value;
    if (!name) {
        showNotification('请先选择要删除的预设', 'error');
        return;
    }
    const confirmed = await showConfirmDialog(`确定删除预设 "${name}" 吗？`, '确认删除');
    if (!confirmed) return;

    state.savedGeminiPartsPresets = state.savedGeminiPartsPresets.filter((p) => p.name !== name);
    state.currentGeminiPartsPresetName = '';
    updateGeminiPartsPresetSelect();
    saveCurrentConfig();
    showNotification(`预设 "${name}" 已删除`, 'info');
}

export function updateGeminiPartsPresetSelect() {
    const select = document.getElementById('gemini-parts-preset-select');
    if (!select) return;

    // eslint-disable-next-line no-restricted-syntax -- 已审计：已escapeHtml
    select.innerHTML =
        '<option value="">-- 自定义 --</option>' +
        state.savedGeminiPartsPresets
            .map(
                (p) =>
                    `<option value="${escapeHtml(p.name)}" ${p.name === state.currentGeminiPartsPresetName ? 'selected' : ''}>${escapeHtml(p.name)}</option>`
            )
            .join('');
}

export function initGeminiSystemParts() {
    const enabledToggle = document.getElementById('gemini-system-parts-enabled');
    if (enabledToggle) {
        enabledToggle.checked = state.geminiSystemPartsEnabled;
        document
            .getElementById('gemini-system-parts-content')
            ?.classList.toggle('disabled', !state.geminiSystemPartsEnabled);

        enabledToggle.addEventListener('change', (e) => {
            state.geminiSystemPartsEnabled = e.target.checked;
            document
                .getElementById('gemini-system-parts-content')
                ?.classList.toggle('disabled', !e.target.checked);
            saveCurrentConfig();
            logger.debug('[Prefill] Gemini System Parts 开关:', state.geminiSystemPartsEnabled);
        });
    }

    const addBtn = document.getElementById('add-gemini-system-part');
    addBtn?.addEventListener('click', addGeminiSystemPart);

    const input = document.getElementById('gemini-system-part-input');
    input?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            addGeminiSystemPart();
        }
    });

    document
        .getElementById('save-gemini-parts-preset')
        ?.addEventListener('click', saveGeminiPartsPreset);
    document
        .getElementById('delete-gemini-parts-preset')
        ?.addEventListener('click', deleteGeminiPartsPreset);
    document
        .getElementById('gemini-parts-preset-select')
        ?.addEventListener('change', loadGeminiPartsPreset);

    renderGeminiSystemPartsList();
    updateGeminiPartsPresetSelect();

    logger.debug('Gemini system parts initialized');
}

// config:sync-prefill-ui — 配置加载后同步设置面板中残留的 UI 元素
eventBus.on('config:sync-prefill-ui', () => {
    renderGeminiSystemPartsList();
    updateGeminiPartsPresetSelect();
});
