/**
 * theme-editor.js 测试
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../js/core/events.js', () => ({
    eventBus: { emit: vi.fn(), on: vi.fn(), off: vi.fn() }
}));

vi.mock('../../js/utils/helpers.js', () => ({
    escapeHtml: vi.fn((s) => s || ''),
    generateId: vi.fn(() => 'test_id')
}));

vi.mock('../../js/utils/dialogs.js', () => ({
    showInputDialog: vi.fn(() => Promise.resolve(null)),
    showConfirmDialog: vi.fn(() => Promise.resolve(false))
}));

vi.mock('../../js/ui/color-picker.js', () => ({
    openColorPicker: vi.fn(() => ({ destroy: vi.fn() }))
}));

vi.mock('../../js/ui/theme-engine.js', () => ({
    THEME_PROPERTIES: {
        colors: {
            'bg-main': { label: '主背景', group: '背景' },
            'text-primary': { label: '主文字', group: '文字' }
        },
        fonts: {
            'font-ui': { label: 'UI 字体', type: 'font' }
        },
        effects: {
            'radius-card': { label: '卡片圆角', type: 'size', unit: 'px', min: 0, max: 24 }
        },
        spacing: {
            'spacing-sm': { label: '小间距', type: 'size', unit: 'px' }
        },
        layout: {
            'sidebar-width': { label: '侧栏宽度', type: 'size', unit: 'px' }
        }
    },
    applyTheme: vi.fn(() => Promise.resolve()),
    getCurrentSnapshot: vi.fn(() => ({
        id: '__dark__',
        name: 'Dark',
        variables: {},
        customCSS: ''
    })),
    resetTheme: vi.fn(),
    cacheThemeToLocalStorage: vi.fn(),
    getActiveThemeId: vi.fn(() => null),
    getBuiltinTheme: vi.fn(() => ({ id: '__dark__', name: 'Dark', builtin: true })),
    setThemeProperty: vi.fn(),
    removeThemeProperty: vi.fn(),
    applyCustomCSS: vi.fn(),
    sanitizeCustomCSS: vi.fn((css) => ({ sanitized: css, removed: [] }))
}));

vi.mock('../../js/state/theme-storage.js', () => ({
    saveTheme: vi.fn(() => Promise.resolve()),
    loadTheme: vi.fn(() => Promise.resolve(null)),
    deleteTheme: vi.fn(() => Promise.resolve()),
    listThemes: vi.fn(() => Promise.resolve([])),
    exportThemeAsJSON: vi.fn(),
    importThemeFromFile: vi.fn(() => Promise.resolve({ theme: {}, warnings: [] }))
}));

vi.mock('../../js/utils/logger.js', () => ({
    logger: { warn: vi.fn(), debug: vi.fn(), error: vi.fn(), info: vi.fn() }
}));

import { openThemeEditor, closeThemeEditor, initThemeEditor } from '../../js/ui/theme-editor.js';

describe('theme-editor', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    // ========== initThemeEditor ==========
    describe('initThemeEditor', () => {
        it('modal 不存在静默返回', () => {
            document.body.innerHTML = '';
            expect(() => initThemeEditor()).not.toThrow();
        });
    });

    // ========== 完整生命周期测试 ==========
    it('初始化、打开、关闭完整流程', async () => {
        document.body.innerHTML = `
            <div id="theme-editor-modal" style="display:none">
                <div class="theme-editor-tabs">
                    <button data-tab="colors">颜色</button>
                    <button data-tab="fonts">字体</button>
                    <button data-tab="effects">效果</button>
                    <button data-tab="layout">布局</button>
                    <button data-tab="css">CSS</button>
                </div>
                <div class="theme-editor-body"></div>
                <button id="theme-save-btn"></button>
                <button id="theme-save-as-btn"></button>
                <button id="theme-delete-btn"></button>
                <button id="theme-import-btn"></button>
                <button id="theme-export-btn"></button>
                <select id="theme-preset-select"></select>
                <button class="close-theme-editor"></button>
            </div>
            <button id="theme-editor-toggle"></button>
        `;

        // 初始化
        expect(() => initThemeEditor()).not.toThrow();

        // 打开
        await openThemeEditor();
        const modal = document.getElementById('theme-editor-modal');
        expect(modal.style.display).toBe('flex');
        expect(modal.getAttribute('aria-hidden')).toBe('false');

        // 关闭（不 revert）
        closeThemeEditor(false);
        expect(modal.style.display).toBe('none');
        expect(modal.getAttribute('aria-hidden')).toBe('true');

        // 再次打开
        await openThemeEditor();
        expect(modal.style.display).toBe('flex');

        // ESC 关闭
        modal.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        expect(modal.style.display).toBe('none');

        // 再次打开然后用 close 按钮关闭
        await openThemeEditor();
        const closeBtn = document.querySelector('.close-theme-editor');
        closeBtn.click();
        expect(modal.style.display).toBe('none');

        document.body.innerHTML = '';
        document.body.style.overflow = '';
    });
});
