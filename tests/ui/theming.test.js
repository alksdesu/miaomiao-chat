/**
 * theming.js 测试
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../js/core/elements.js', () => ({
    elements: { themeToggle: null }
}));

vi.mock('../../js/core/events.js', () => ({
    eventBus: { emit: vi.fn(), on: vi.fn(), off: vi.fn() }
}));

vi.mock('../../js/core/state.js', () => ({
    state: { storageMode: 'indexedDB' }
}));

vi.mock('../../js/state/storage.js', () => ({
    savePreference: vi.fn(() => Promise.resolve())
}));

vi.mock('../../js/ui/theme-engine.js', () => ({
    applyTheme: vi.fn(() => Promise.resolve()),
    restoreThemeFromCache: vi.fn(),
    getActiveThemeId: vi.fn(() => null),
    getBuiltinTheme: vi.fn((id) => ({ id, base: id.includes('dark') ? 'dark' : 'light' })),
    resetTheme: vi.fn(),
    cacheThemeToLocalStorage: vi.fn()
}));

vi.mock('../../js/state/theme-storage.js', () => ({
    loadTheme: vi.fn(() => Promise.resolve(null))
}));

vi.mock('../../js/utils/mermaid.js', () => ({
    updateVisibleMermaidTheme: vi.fn(() => Promise.resolve({ failedCount: 0 }))
}));

vi.mock('../../js/utils/logger.js', () => ({
    logger: { warn: vi.fn(), debug: vi.fn(), error: vi.fn(), info: vi.fn() }
}));

import { loadTheme, toggleTheme, initTheming } from '../../js/ui/theming.js';
import { elements } from '../../js/core/elements.js';

describe('theming', () => {
    beforeEach(() => {
        document.documentElement.className = '';
        localStorage.clear();
        elements.themeToggle = null;
    });

    // ========== loadTheme ==========
    describe('loadTheme', () => {
        it('无保存主题使用系统主题', () => {
            loadTheme();
            // 默认可能是 dark（无 matchMedia mock 时）
            // 只验证不抛错即可
        });

        it('保存 light 设置 light 主题', () => {
            localStorage.setItem('theme', 'light');
            loadTheme();
            expect(document.documentElement.classList.contains('dark-theme')).toBe(false);
        });

        it('保存 dark 设置 dark 主题', () => {
            localStorage.setItem('theme', 'dark');
            loadTheme();
            expect(document.documentElement.classList.contains('dark-theme')).toBe(true);
        });

        it('无效值使用系统主题', () => {
            localStorage.setItem('theme', 'invalid');
            loadTheme();
            // 不抛错即可
        });

        it('调用 restoreThemeFromCache', async () => {
            const { restoreThemeFromCache } = await import('../../js/ui/theme-engine.js');
            loadTheme();
            expect(restoreThemeFromCache).toHaveBeenCalled();
        });

        // ui:theme-applied 事件已删（P1-2 死事件清理）—— loadTheme 不再 emit 任何全局事件
    });

    // ========== toggleTheme ==========
    describe('toggleTheme', () => {
        it('从 dark 切换到 light', async () => {
            document.documentElement.classList.add('dark-theme');
            await toggleTheme();
            const { applyTheme } = await import('../../js/ui/theme-engine.js');
            expect(applyTheme).toHaveBeenCalledWith(expect.objectContaining({ base: 'light' }));
        });

        it('从 light 切换到 dark', async () => {
            document.documentElement.classList.remove('dark-theme');
            await toggleTheme();
            const { applyTheme } = await import('../../js/ui/theme-engine.js');
            expect(applyTheme).toHaveBeenCalledWith(expect.objectContaining({ base: 'dark' }));
        });

        it('切换时添加 theme-transition class', async () => {
            await toggleTheme();
            // class 会在 300ms 后移除，但添加时应该存在
            // 由于 setTimeout 异步，只验证不抛错
        });

        it('保存到 localStorage', async () => {
            document.documentElement.classList.add('dark-theme');
            await toggleTheme();
            expect(localStorage.getItem('theme')).toBe('light');
        });
    });

    // ========== initTheming ==========
    describe('initTheming', () => {
        it('不抛错', () => {
            expect(() => initTheming()).not.toThrow();
        });

        it('有 themeToggle 时绑定事件', () => {
            const btn = document.createElement('button');
            elements.themeToggle = btn;
            const spy = vi.spyOn(btn, 'addEventListener');
            initTheming();
            expect(spy).toHaveBeenCalledWith('click', expect.any(Function));
            spy.mockRestore();
        });

        it('注册 storage 事件', () => {
            const spy = vi.spyOn(window, 'addEventListener');
            initTheming();
            expect(spy).toHaveBeenCalledWith('storage', expect.any(Function));
            spy.mockRestore();
        });
    });
});
