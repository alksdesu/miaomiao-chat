/**
 * 主题引擎
 * 管理 CSS 变量覆盖，实现自定义主题
 */

import { eventBus } from '../core/events.js';
import { updateVisibleMermaidTheme } from '../utils/mermaid.js';
import { hexToRgb } from './color-picker.js';
import { logger } from '../utils/logger.js';

/* ===== 属性注册表 ===== */

export const THEME_PROPERTIES = {
    colors: {
        'color-bg-primary': { label: '主背景', group: '背景' },
        'color-bg-surface': { label: '表面背景', group: '背景' },
        'color-bg-elevated': { label: '悬浮背景', group: '背景' },
        'color-bg-input': { label: '输入框背景', group: '背景' },
        'color-bg-code': { label: '代码背景', group: '背景' },
        'color-bg-accent': { label: '反色背景', group: '背景' },
        'color-text-primary': { label: '主文字', group: '文字' },
        'color-text-secondary': { label: '次要文字', group: '文字' },
        'color-text-muted': { label: '弱化文字', group: '文字' },
        'color-text-inverse': { label: '反色文字', group: '文字' },
        'color-border-primary': { label: '主边框', group: '边框' },
        'color-border-secondary': { label: '次边框', group: '边框' },
        'palette-blue': { label: '蓝色', group: '强调色' },
        'palette-blue-dark': { label: '深蓝', group: '强调色' },
        'palette-yellow': { label: '黄色', group: '强调色' },
        'palette-orange': { label: '橙色', group: '强调色' },
        'palette-teal': { label: '青绿', group: '强调色' },
        'palette-green': { label: '绿色', group: '强调色' },
        'palette-coral': { label: '珊瑚红', group: '强调色' },
        'palette-lime': { label: '柠檬绿', group: '强调色' },
        'palette-pink': { label: '粉红', group: '强调色' },
        'palette-red': { label: '红色', group: '强调色' },
        'color-success': { label: '成功', group: '状态色' },
        'color-warning': { label: '警告', group: '状态色' },
        'color-info': { label: '信息', group: '状态色' },
        'color-focus': { label: '焦点环', group: '状态色' },
        'welcome-gradient-start': { label: '欢迎渐变起', group: '欢迎' },
        'welcome-gradient-mid': { label: '欢迎渐变中', group: '欢迎' },
        'welcome-gradient-end': { label: '欢迎渐变止', group: '欢迎' },
        'syntax-keyword': { label: '关键字', group: '语法高亮' },
        'syntax-string': { label: '字符串', group: '语法高亮' },
        'syntax-number': { label: '数字', group: '语法高亮' },
        'syntax-function': { label: '函数', group: '语法高亮' },
        'syntax-comment': { label: '注释', group: '语法高亮' },
        'syntax-operator': { label: '操作符', group: '语法高亮' },
        'syntax-variable': { label: '变量', group: '语法高亮' }
    },
    fonts: {
        'font-sans': { label: '正文字体', type: 'font' },
        'font-ui-accent': { label: 'UI 字体', type: 'font' },
        'font-mono': { label: '等宽字体', type: 'font' },
        'fs-base': { label: '基础字号', type: 'size', unit: 'px', min: 10, max: 20 },
        'fs-sm': { label: '小号字', type: 'size', unit: 'px', min: 8, max: 16 },
        'fs-lg': { label: '大号字', type: 'size', unit: 'px', min: 12, max: 22 },
        'fs-xl': { label: '特大字', type: 'size', unit: 'px', min: 14, max: 28 }
    },
    effects: {
        'radius-sm': { label: '小圆角', type: 'size', unit: 'px', min: 0, max: 20 },
        'radius-md': { label: '中圆角', type: 'size', unit: 'px', min: 0, max: 24 },
        'radius-xl': { label: '大圆角', type: 'size', unit: 'px', min: 0, max: 32 },
        'radius-2xl': { label: '特大圆角', type: 'size', unit: 'px', min: 0, max: 48 },
        'duration-fast': { label: '快速动画', type: 'size', unit: 's', min: 0, max: 1, step: 0.05 },
        'duration-base': { label: '基础动画', type: 'size', unit: 's', min: 0, max: 1, step: 0.05 },
        'overlay-light': { label: '浅遮罩', type: 'color', group: '遮罩' },
        'overlay-medium': { label: '中遮罩', type: 'color', group: '遮罩' },
        'overlay-heavy': { label: '深遮罩', type: 'color', group: '遮罩' },
        'shadow-color-rgb': { label: '阴影色 RGB', type: 'font' }
    },
    spacing: {
        'sp-1': { label: '2xs 间距', type: 'size', unit: 'px', min: 0, max: 8 },
        'sp-4': { label: 'sm 间距', type: 'size', unit: 'px', min: 4, max: 16 },
        'sp-7': { label: 'md 间距', type: 'size', unit: 'px', min: 8, max: 32 },
        'sp-9': { label: 'lg 间距', type: 'size', unit: 'px', min: 12, max: 48 },
        'sp-12': { label: 'xl 间距', type: 'size', unit: 'px', min: 16, max: 64 }
    },
    layout: {
        'content-max-width': {
            label: '内容最大宽度',
            type: 'size',
            unit: 'px',
            min: 600,
            max: 1600
        }
    }
};

/* ===== RGB 三元组映射 ===== */

const RGB_TRIPLET_MAP = {
    'color-bg-primary': 'color-bg-primary-rgb',
    'color-bg-surface': 'color-bg-surface-rgb',
    'color-bg-elevated': 'color-bg-elevated-rgb',
    'color-bg-accent': 'color-bg-accent-rgb',
    'color-text-primary': 'color-text-primary-rgb',
    'color-text-secondary': 'color-text-secondary-rgb',
    'color-border-primary': 'color-border-primary-rgb',
    'palette-blue': 'palette-blue-rgb',
    'palette-teal': 'palette-teal-rgb',
    'palette-coral': 'palette-coral-rgb',
    'palette-orange': 'palette-orange-rgb',
    'palette-yellow': 'palette-yellow-rgb',
    'palette-green': 'palette-green-rgb',
    'palette-pink': 'palette-pink-rgb'
};

const CUSTOM_CSS_STYLE_ID = 'theme-custom-css';

/* ===== CSS 安全过滤 ===== */

function stripCSSComments(css) {
    return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

function decodeCSSEscapes(css) {
    return css
        .replace(/\\([0-9a-fA-F]{1,6})\s?/g, (_, hex) => {
            return String.fromCodePoint(parseInt(hex, 16));
        })
        .replace(/\\(.)/g, '$1');
}

const DANGEROUS_CSS_PATTERNS = [
    /@import/i,
    /url\s*\(/i,
    /expression\s*\(/i,
    /javascript\s*:/i,
    /behavior\s*:/i,
    /-moz-binding\s*:/i,
    /@charset/i
];

export function sanitizeCustomCSS(css) {
    if (!css || typeof css !== 'string') return { css: '', warnings: [] };

    const warnings = [];
    const normalized = decodeCSSEscapes(stripCSSComments(css));

    for (const pattern of DANGEROUS_CSS_PATTERNS) {
        if (pattern.test(normalized)) {
            warnings.push(`已删除不安全的 CSS 模式: ${pattern.source}`);
        }
    }

    let cleaned = css;
    if (warnings.length > 0) {
        cleaned = stripCSSComments(cleaned);
        cleaned = decodeCSSEscapes(cleaned);
        for (const pattern of DANGEROUS_CSS_PATTERNS) {
            cleaned = cleaned.replace(new RegExp(pattern.source, 'gi'), '/* [blocked] */');
        }
    }

    return { css: cleaned, warnings };
}

/* ===== 内置预设 ===== */

export const BUILTIN_THEMES = [
    { id: '__light__', name: 'Light（默认）', base: 'light', builtin: true },
    { id: '__dark__', name: 'Dark（默认）', base: 'dark', builtin: true },
    {
        id: '__monokai__',
        name: 'Monokai',
        base: 'dark',
        builtin: true,
        colors: {
            'color-bg-primary': '#272822',
            'color-bg-surface': '#2e2e28',
            'color-bg-elevated': '#3e3d32',
            'color-bg-input': '#222218',
            'color-bg-code': '#1e1f1c',
            'color-bg-accent': '#49483e',
            'color-text-primary': '#f8f8f2',
            'color-text-secondary': '#cfcfc2',
            'color-text-muted': '#75715e',
            'color-border-primary': '#49483e',
            'color-border-secondary': '#3e3d32',
            'palette-blue': '#66d9ef',
            'palette-green': '#a6e22e',
            'palette-orange': '#fd971f',
            'palette-coral': '#f92672',
            'palette-yellow': '#e6db74',
            'palette-pink': '#f92672',
            'syntax-keyword': '#f92672',
            'syntax-string': '#e6db74',
            'syntax-number': '#ae81ff',
            'syntax-function': '#a6e22e',
            'syntax-comment': '#75715e',
            'syntax-operator': '#f8f8f2',
            'syntax-variable': '#f8f8f2'
        }
    },
    {
        id: '__solarized__',
        name: 'Solarized Light',
        base: 'light',
        builtin: true,
        colors: {
            'color-bg-primary': '#fdf6e3',
            'color-bg-surface': '#eee8d5',
            'color-bg-elevated': '#fdf6e3',
            'color-bg-input': '#fdf6e3',
            'color-bg-code': '#eee8d5',
            'color-bg-accent': '#073642',
            'color-text-primary': '#657b83',
            'color-text-secondary': '#839496',
            'color-text-muted': '#93a1a1',
            'color-border-primary': '#93a1a1',
            'color-border-secondary': '#eee8d5',
            'palette-blue': '#268bd2',
            'palette-teal': '#2aa198',
            'palette-green': '#859900',
            'palette-orange': '#cb4b16',
            'palette-coral': '#dc322f',
            'palette-yellow': '#b58900',
            'syntax-keyword': '#859900',
            'syntax-string': '#2aa198',
            'syntax-number': '#d33682',
            'syntax-function': '#268bd2',
            'syntax-comment': '#93a1a1',
            'syntax-operator': '#657b83',
            'syntax-variable': '#657b83'
        }
    },
    {
        id: '__retro__',
        name: 'Retro Terminal',
        base: 'dark',
        builtin: true,
        colors: {
            'color-bg-primary': '#0c0c0c',
            'color-bg-surface': '#111111',
            'color-bg-elevated': '#1a1a1a',
            'color-bg-input': '#080808',
            'color-bg-code': '#080808',
            'color-bg-accent': '#1a3a1a',
            'color-text-primary': '#33ff33',
            'color-text-secondary': '#22cc22',
            'color-text-muted': '#118811',
            'color-border-primary': '#1a5a1a',
            'color-border-secondary': '#0a2a0a',
            'palette-blue': '#33ff33',
            'palette-teal': '#33ff33',
            'palette-green': '#33ff33',
            'palette-coral': '#ff3333',
            'palette-yellow': '#ffff33',
            'syntax-keyword': '#33ff33',
            'syntax-string': '#66ff66',
            'syntax-number': '#ffff33',
            'syntax-function': '#33ffff',
            'syntax-comment': '#118811',
            'syntax-operator': '#33ff33',
            'syntax-variable': '#22cc22'
        },
        effects: {
            'radius-sm': '0px',
            'radius-md': '0px',
            'radius-xl': '0px',
            'radius-2xl': '0px'
        }
    }
];

/* ===== 颜色工具 ===== */

function toRgbTriplet(value) {
    if (!value || typeof value !== 'string') return null;
    const v = value.trim();

    // hex 快速路径
    if (v.startsWith('#')) {
        const rgb = hexToRgb(v);
        return rgb ? `${rgb.r}, ${rgb.g}, ${rgb.b}` : null;
    }

    // rgba/rgb 字面量快速路径
    const m = v.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    if (m) return `${m[1]}, ${m[2]}, ${m[3]}`;

    // 兜底：用浏览器解析（支持命名色、hsl、现代 rgb 语法等）
    try {
        const ctx = document.createElement('canvas').getContext('2d');
        ctx.fillStyle = v;
        const parsed = ctx.fillStyle; // 浏览器返回标准 hex 或 rgba
        if (parsed.startsWith('#')) {
            const rgb = hexToRgb(parsed);
            return rgb ? `${rgb.r}, ${rgb.g}, ${rgb.b}` : null;
        }
        const m2 = parsed.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
        if (m2) return `${m2[1]}, ${m2[2]}, ${m2[3]}`;
    } catch {
        /* 解析失败，返回 null */
    }

    return null;
}

/* ===== 自定义 CSS 注入 ===== */

function getOrCreateCustomStyleElement() {
    let el = document.getElementById(CUSTOM_CSS_STYLE_ID);
    if (!el) {
        el = document.createElement('style');
        el.id = CUSTOM_CSS_STYLE_ID;
        el.setAttribute('type', 'text/css');
        document.head.appendChild(el);
    }
    return el;
}

function applyCustomCSS(css) {
    const el = getOrCreateCustomStyleElement();
    el.textContent = css || '';
}

function clearCustomCSS() {
    const el = document.getElementById(CUSTOM_CSS_STYLE_ID);
    if (el) el.textContent = '';
}

/* ===== 核心 API ===== */

/**
 * 将主题数据应用到页面
 * @param {Object} themeData - 主题对象
 * @param {Object} [options]
 * @param {boolean} [options.skipMermaid=false] - 跳过 Mermaid 刷新
 */
export async function applyTheme(themeData, options = {}) {
    const { skipMermaid = false } = options;
    const root = document.documentElement;

    // 1. 设置 base class
    if (themeData.base) {
        root.classList.toggle('dark-theme', themeData.base === 'dark');
    }

    // 2. 先清除之前主题可能残留的变量覆盖
    for (const props of Object.values(THEME_PROPERTIES)) {
        for (const varName of Object.keys(props)) {
            root.style.removeProperty(`--${varName}`);
            const rgbKey = RGB_TRIPLET_MAP[varName];
            if (rgbKey) root.style.removeProperty(`--${rgbKey}`);
        }
    }
    clearCustomCSS();

    // 3. 遍历所有 section 应用变量覆盖
    for (const section of Object.keys(THEME_PROPERTIES)) {
        const overrides = themeData[section];
        if (!overrides) continue;

        for (const [varName, value] of Object.entries(overrides)) {
            if (value == null || !Object.hasOwn(THEME_PROPERTIES[section], varName)) continue;
            root.style.setProperty(`--${varName}`, value);

            // 自动派生 RGB 三元组
            const rgbKey = RGB_TRIPLET_MAP[varName];
            if (rgbKey) {
                const triplet = toRgbTriplet(value);
                if (triplet) {
                    root.style.setProperty(`--${rgbKey}`, triplet);
                }
            }
        }
    }

    // 4. 自定义 CSS
    if (themeData.customCSS != null) {
        applyCustomCSS(themeData.customCSS);
    }

    // 5. Mermaid 图表主题刷新
    if (!skipMermaid) {
        const { failedCount } = await updateVisibleMermaidTheme();
        if (failedCount > 0) {
            eventBus.emit('ui:notification', {
                message: '部分 Mermaid 图表主题更新失败',
                type: 'warning'
            });
        }
    }
}

/**
 * 快照当前页面的所有主题变量值
 * @returns {Object} 可直接传给 applyTheme 的对象
 */
export function getCurrentSnapshot() {
    const computed = getComputedStyle(document.documentElement);
    const snapshot = {
        base: document.documentElement.classList.contains('dark-theme') ? 'dark' : 'light'
    };

    for (const [section, props] of Object.entries(THEME_PROPERTIES)) {
        snapshot[section] = {};
        for (const varName of Object.keys(props)) {
            const raw = computed.getPropertyValue(`--${varName}`).trim();
            if (raw) snapshot[section][varName] = raw;
        }
    }

    // 自定义 CSS
    const styleEl = document.getElementById(CUSTOM_CSS_STYLE_ID);
    snapshot.customCSS = styleEl?.textContent || '';

    return snapshot;
}

/**
 * 清除所有主题覆盖，回到 CSS 默认值
 */
export function resetTheme() {
    const root = document.documentElement;

    for (const props of Object.values(THEME_PROPERTIES)) {
        for (const varName of Object.keys(props)) {
            root.style.removeProperty(`--${varName}`);
            const rgbKey = RGB_TRIPLET_MAP[varName];
            if (rgbKey) root.style.removeProperty(`--${rgbKey}`);
        }
    }

    clearCustomCSS();
}

/**
 * 获取属性注册表（供编辑器 UI 枚举控件）
 */
export function getPropertyMeta() {
    return THEME_PROPERTIES;
}

/**
 * 设置单个主题属性（含 RGB 三元组同步）
 */
export function setThemeProperty(varName, value) {
    const root = document.documentElement;
    root.style.setProperty(`--${varName}`, value);

    const rgbKey = RGB_TRIPLET_MAP[varName];
    if (rgbKey) {
        const triplet = toRgbTriplet(value);
        if (triplet) root.style.setProperty(`--${rgbKey}`, triplet);
    }
}

/**
 * 移除单个主题属性覆盖（恢复 CSS 默认值）
 */
export function removeThemeProperty(varName) {
    const root = document.documentElement;
    root.style.removeProperty(`--${varName}`);

    const rgbKey = RGB_TRIPLET_MAP[varName];
    if (rgbKey) root.style.removeProperty(`--${rgbKey}`);
}

/**
 * 应用自定义 CSS（供编辑器直接调用）
 */
export { applyCustomCSS };

/**
 * 将主题变量缓存到 localStorage（用于 FOUC 防闪烁）
 * @param {Object} themeData
 */
export function cacheThemeToLocalStorage(themeData) {
    try {
        if (!themeData) {
            localStorage.removeItem('activeThemeId');
            localStorage.removeItem('activeThemeCache');
            return;
        }

        if (themeData.id) {
            localStorage.setItem('activeThemeId', themeData.id);
        }
        if (themeData.base) {
            localStorage.setItem('theme', themeData.base);
        }

        // 仅缓存覆盖值（非内置默认主题）
        if (themeData.builtin && (themeData.id === '__light__' || themeData.id === '__dark__')) {
            localStorage.removeItem('activeThemeCache');
            return;
        }

        const cache = {};
        for (const section of Object.keys(THEME_PROPERTIES)) {
            const overrides = themeData[section];
            if (!overrides) continue;
            for (const [k, v] of Object.entries(overrides)) {
                if (v != null) cache[k] = v;
            }
        }
        if (themeData.customCSS) cache.__customCSS = themeData.customCSS;

        localStorage.setItem('activeThemeCache', JSON.stringify(cache));
    } catch (e) {
        logger.error('缓存主题到 localStorage 失败:', e);
    }
}

/**
 * 从 localStorage 快速恢复主题缓存（同步，防 FOUC）
 * @returns {boolean} 是否应用了缓存
 */
export function restoreThemeFromCache() {
    const cacheStr = localStorage.getItem('activeThemeCache');
    if (!cacheStr) return false;

    try {
        const cache = JSON.parse(cacheStr);
        const root = document.documentElement;

        // 收集所有合法的变量名白名单
        const allowedKeys = new Set();
        for (const props of Object.values(THEME_PROPERTIES)) {
            for (const k of Object.keys(props)) allowedKeys.add(k);
        }

        for (const [key, value] of Object.entries(cache)) {
            if (key === '__customCSS') {
                const { css } = sanitizeCustomCSS(value);
                applyCustomCSS(css);
                continue;
            }
            // 白名单校验
            if (!allowedKeys.has(key)) continue;
            root.style.setProperty(`--${key}`, value);

            const rgbKey = RGB_TRIPLET_MAP[key];
            if (rgbKey) {
                const triplet = toRgbTriplet(value);
                if (triplet) root.style.setProperty(`--${rgbKey}`, triplet);
            }
        }

        return true;
    } catch (e) {
        logger.error('恢复主题缓存失败:', e);
        localStorage.removeItem('activeThemeCache');
        return false;
    }
}

/**
 * 获取当前活跃的主题 ID
 */
export function getActiveThemeId() {
    return localStorage.getItem('activeThemeId') || null;
}

/**
 * 查找内置主题
 */
export function getBuiltinTheme(id) {
    return BUILTIN_THEMES.find((t) => t.id === id) || null;
}
