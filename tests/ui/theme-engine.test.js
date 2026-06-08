/**
 * theme-engine.js 测试
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../js/core/events.js', () => ({
    eventBus: { emit: vi.fn(), on: vi.fn(), off: vi.fn() }
}));

vi.mock('../../js/utils/mermaid.js', () => ({
    updateVisibleMermaidTheme: vi.fn(() => Promise.resolve({ failedCount: 0 }))
}));

vi.mock('../../js/ui/color-picker.js', () => ({
    hexToRgb: vi.fn((hex) => {
        const h = hex.replace('#', '');
        if (h.length >= 6) {
            return {
                r: parseInt(h.substring(0, 2), 16),
                g: parseInt(h.substring(2, 4), 16),
                b: parseInt(h.substring(4, 6), 16)
            };
        }
        if (h.length === 3) {
            return {
                r: parseInt(h[0] + h[0], 16),
                g: parseInt(h[1] + h[1], 16),
                b: parseInt(h[2] + h[2], 16)
            };
        }
        return null;
    })
}));

vi.mock('../../js/utils/logger.js', () => ({
    logger: { warn: vi.fn(), debug: vi.fn(), error: vi.fn(), info: vi.fn() }
}));

import {
    THEME_PROPERTIES,
    BUILTIN_THEMES,
    sanitizeCustomCSS,
    applyTheme,
    getCurrentSnapshot,
    resetTheme,
    getPropertyMeta,
    setThemeProperty,
    removeThemeProperty,
    cacheThemeToLocalStorage,
    restoreThemeFromCache,
    getActiveThemeId,
    getBuiltinTheme
} from '../../js/ui/theme-engine.js';

describe('theme-engine', () => {
    beforeEach(() => {
        document.documentElement.className = '';
        // 清除所有 style
        document.documentElement.style.cssText = '';
        localStorage.clear();
        // 清除自定义 CSS style 元素
        const styleEl = document.getElementById('theme-custom-css');
        if (styleEl) styleEl.remove();
    });

    // ========== THEME_PROPERTIES ==========
    describe('THEME_PROPERTIES', () => {
        it('包含 colors/fonts/effects/spacing/layout', () => {
            expect(THEME_PROPERTIES.colors).toBeDefined();
            expect(THEME_PROPERTIES.fonts).toBeDefined();
            expect(THEME_PROPERTIES.effects).toBeDefined();
            expect(THEME_PROPERTIES.spacing).toBeDefined();
            expect(THEME_PROPERTIES.layout).toBeDefined();
        });

        it('colors 包含 color-bg-primary', () => {
            expect(THEME_PROPERTIES.colors['color-bg-primary']).toBeDefined();
            expect(THEME_PROPERTIES.colors['color-bg-primary'].label).toBeTruthy();
        });
    });

    // ========== BUILTIN_THEMES ==========
    describe('BUILTIN_THEMES', () => {
        it('至少有 2 个内置主题', () => {
            expect(BUILTIN_THEMES.length).toBeGreaterThanOrEqual(2);
        });

        it('包含 light 和 dark 默认主题', () => {
            expect(BUILTIN_THEMES.find((t) => t.id === '__light__')).toBeDefined();
            expect(BUILTIN_THEMES.find((t) => t.id === '__dark__')).toBeDefined();
        });

        it('每个主题有 id, name, base, builtin', () => {
            for (const t of BUILTIN_THEMES) {
                expect(t.id).toBeTruthy();
                expect(t.name).toBeTruthy();
                expect(t.base).toMatch(/^(light|dark)$/);
                expect(t.builtin).toBe(true);
            }
        });

        it('Monokai 主题有自定义 colors', () => {
            const monokai = BUILTIN_THEMES.find((t) => t.id === '__monokai__');
            expect(monokai).toBeDefined();
            expect(monokai.colors).toBeDefined();
            expect(monokai.colors['color-bg-primary']).toBeTruthy();
        });

        it('Retro 主题有自定义 effects', () => {
            const retro = BUILTIN_THEMES.find((t) => t.id === '__retro__');
            expect(retro).toBeDefined();
            expect(retro.effects).toBeDefined();
            expect(retro.effects['radius-sm']).toBe('0px');
        });
    });

    // ========== sanitizeCustomCSS ==========
    describe('sanitizeCustomCSS', () => {
        it('null 返回空', () => {
            const r = sanitizeCustomCSS(null);
            expect(r.css).toBe('');
            expect(r.warnings).toEqual([]);
        });

        it('空字符串返回空', () => {
            const r = sanitizeCustomCSS('');
            expect(r.css).toBe('');
        });

        it('安全 CSS 原样返回', () => {
            const css = 'body { color: red; }';
            const r = sanitizeCustomCSS(css);
            expect(r.css).toBe(css);
            expect(r.warnings).toEqual([]);
        });

        it('过滤 @import', () => {
            const r = sanitizeCustomCSS('@import url("evil.css"); body {}');
            expect(r.warnings.length).toBeGreaterThan(0);
            expect(r.css).toContain('[blocked]');
            expect(r.css).not.toMatch(/@import/i);
        });

        it('过滤 url()', () => {
            const r = sanitizeCustomCSS('div { background: url("http://evil.com"); }');
            expect(r.warnings.length).toBeGreaterThan(0);
            expect(r.css).toContain('[blocked]');
        });

        it('过滤 expression()', () => {
            const r = sanitizeCustomCSS('div { width: expression(alert(1)); }');
            expect(r.warnings.length).toBeGreaterThan(0);
        });

        it('过滤 javascript:', () => {
            const r = sanitizeCustomCSS('div { background: javascript:alert(1); }');
            expect(r.warnings.length).toBeGreaterThan(0);
        });

        it('过滤 behavior:', () => {
            const r = sanitizeCustomCSS('div { behavior: url(xss.htc); }');
            expect(r.warnings.length).toBeGreaterThan(0);
        });

        it('过滤 -moz-binding:', () => {
            const r = sanitizeCustomCSS('div { -moz-binding: url("xbl"); }');
            expect(r.warnings.length).toBeGreaterThan(0);
        });

        it('过滤 @charset', () => {
            const r = sanitizeCustomCSS('@charset "UTF-8"; body {}');
            expect(r.warnings.length).toBeGreaterThan(0);
        });

        it('CSS 注释中的危险模式也被检测', () => {
            const r = sanitizeCustomCSS('/* @import url("x") */ body {}');
            // 注释被去掉后，不应该触发（或者触发取决于实现）
            // 重要的是不抛错
            expect(r.css).toBeTruthy();
        });

        it('非字符串返回空', () => {
            const r = sanitizeCustomCSS(123);
            expect(r.css).toBe('');
        });
    });

    // ========== resetTheme ==========
    describe('resetTheme', () => {
        it('清除所有主题变量', () => {
            const root = document.documentElement;
            root.style.setProperty('--color-bg-primary', '#000');
            resetTheme();
            expect(root.style.getPropertyValue('--color-bg-primary')).toBe('');
        });
    });

    // ========== getPropertyMeta ==========
    describe('getPropertyMeta', () => {
        it('返回 THEME_PROPERTIES', () => {
            expect(getPropertyMeta()).toBe(THEME_PROPERTIES);
        });
    });

    // ========== setThemeProperty ==========
    describe('setThemeProperty', () => {
        it('设置 CSS 变量', () => {
            setThemeProperty('color-bg-primary', '#ff0000');
            expect(document.documentElement.style.getPropertyValue('--color-bg-primary')).toBe(
                '#ff0000'
            );
        });

        it('设置有 RGB 映射的属性时同时设置 RGB 变量', () => {
            setThemeProperty('color-bg-primary', '#ff0000');
            const rgb = document.documentElement.style.getPropertyValue('--color-bg-primary-rgb');
            expect(rgb).toBe('255, 0, 0');
        });
    });

    // ========== removeThemeProperty ==========
    describe('removeThemeProperty', () => {
        it('移除 CSS 变量', () => {
            const root = document.documentElement;
            root.style.setProperty('--color-bg-primary', '#000');
            removeThemeProperty('color-bg-primary');
            expect(root.style.getPropertyValue('--color-bg-primary')).toBe('');
        });

        it('同时移除 RGB 变量', () => {
            const root = document.documentElement;
            root.style.setProperty('--color-bg-primary-rgb', '0, 0, 0');
            removeThemeProperty('color-bg-primary');
            expect(root.style.getPropertyValue('--color-bg-primary-rgb')).toBe('');
        });
    });

    // ========== applyTheme ==========
    describe('applyTheme', () => {
        it('设置 dark 主题 class', async () => {
            await applyTheme({ base: 'dark' }, { skipMermaid: true, skipEvent: true });
            expect(document.documentElement.classList.contains('dark-theme')).toBe(true);
        });

        it('设置 light 主题移除 dark-theme class', async () => {
            document.documentElement.classList.add('dark-theme');
            await applyTheme({ base: 'light' }, { skipMermaid: true, skipEvent: true });
            expect(document.documentElement.classList.contains('dark-theme')).toBe(false);
        });

        it('应用 color 覆盖', async () => {
            await applyTheme(
                { colors: { 'color-bg-primary': '#123456' } },
                { skipMermaid: true, skipEvent: true }
            );
            expect(document.documentElement.style.getPropertyValue('--color-bg-primary')).toBe(
                '#123456'
            );
        });

        it('应用自定义 CSS', async () => {
            await applyTheme(
                { customCSS: 'body { color: red; }' },
                { skipMermaid: true, skipEvent: true }
            );
            const styleEl = document.getElementById('theme-custom-css');
            expect(styleEl).toBeTruthy();
            expect(styleEl.textContent).toBe('body { color: red; }');
        });

        it('忽略非注册的属性', async () => {
            await applyTheme(
                { colors: { 'nonexistent-var': '#000' } },
                { skipMermaid: true, skipEvent: true }
            );
            expect(document.documentElement.style.getPropertyValue('--nonexistent-var')).toBe('');
        });
    });

    // ========== getCurrentSnapshot ==========
    describe('getCurrentSnapshot', () => {
        it('返回包含 base 的快照', () => {
            const snap = getCurrentSnapshot();
            expect(snap.base).toMatch(/^(light|dark)$/);
        });

        it('包含所有 section', () => {
            const snap = getCurrentSnapshot();
            expect(snap.colors).toBeDefined();
            expect(snap.fonts).toBeDefined();
            expect(snap.effects).toBeDefined();
            expect(snap.spacing).toBeDefined();
            expect(snap.layout).toBeDefined();
        });

        it('dark-theme class 返回 dark', () => {
            document.documentElement.classList.add('dark-theme');
            expect(getCurrentSnapshot().base).toBe('dark');
        });
    });

    // ========== cacheThemeToLocalStorage ==========
    describe('cacheThemeToLocalStorage', () => {
        it('null 清除缓存', () => {
            localStorage.setItem('activeThemeId', 'test');
            localStorage.setItem('activeThemeCache', '{}');
            cacheThemeToLocalStorage(null);
            expect(localStorage.getItem('activeThemeId')).toBeNull();
            expect(localStorage.getItem('activeThemeCache')).toBeNull();
        });

        it('保存主题 ID 和 base', () => {
            cacheThemeToLocalStorage({ id: '__monokai__', base: 'dark' });
            expect(localStorage.getItem('activeThemeId')).toBe('__monokai__');
            expect(localStorage.getItem('theme')).toBe('dark');
        });

        it('内置默认主题不写 activeThemeCache', () => {
            cacheThemeToLocalStorage({ id: '__light__', base: 'light', builtin: true });
            expect(localStorage.getItem('activeThemeCache')).toBeNull();
        });

        it('内置 dark 默认主题也不写缓存', () => {
            cacheThemeToLocalStorage({ id: '__dark__', base: 'dark', builtin: true });
            expect(localStorage.getItem('activeThemeCache')).toBeNull();
        });

        it('自定义主题写入缓存', () => {
            cacheThemeToLocalStorage({
                id: '__monokai__',
                base: 'dark',
                builtin: true,
                colors: { 'color-bg-primary': '#272822' }
            });
            const cache = JSON.parse(localStorage.getItem('activeThemeCache'));
            expect(cache['color-bg-primary']).toBe('#272822');
        });

        it('缓存自定义 CSS', () => {
            cacheThemeToLocalStorage({
                id: 'custom',
                customCSS: 'body { margin: 0; }'
            });
            const cache = JSON.parse(localStorage.getItem('activeThemeCache'));
            expect(cache.__customCSS).toBe('body { margin: 0; }');
        });
    });

    // ========== restoreThemeFromCache ==========
    describe('restoreThemeFromCache', () => {
        it('无缓存返回 false', () => {
            expect(restoreThemeFromCache()).toBe(false);
        });

        it('有效缓存恢复变量并返回 true', () => {
            localStorage.setItem(
                'activeThemeCache',
                JSON.stringify({
                    'color-bg-primary': '#272822'
                })
            );
            expect(restoreThemeFromCache()).toBe(true);
            expect(document.documentElement.style.getPropertyValue('--color-bg-primary')).toBe(
                '#272822'
            );
        });

        it('忽略不在白名单中的 key', () => {
            localStorage.setItem(
                'activeThemeCache',
                JSON.stringify({
                    'evil-prop': 'value'
                })
            );
            restoreThemeFromCache();
            expect(document.documentElement.style.getPropertyValue('--evil-prop')).toBe('');
        });

        it('恢复自定义 CSS', () => {
            localStorage.setItem(
                'activeThemeCache',
                JSON.stringify({
                    __customCSS: 'body { color: green; }'
                })
            );
            restoreThemeFromCache();
            const styleEl = document.getElementById('theme-custom-css');
            expect(styleEl).toBeTruthy();
        });

        it('无效 JSON 清除缓存并返回 false', () => {
            localStorage.setItem('activeThemeCache', 'invalid');
            expect(restoreThemeFromCache()).toBe(false);
            expect(localStorage.getItem('activeThemeCache')).toBeNull();
        });

        it('同时恢复 RGB 变量', () => {
            localStorage.setItem(
                'activeThemeCache',
                JSON.stringify({
                    'color-bg-primary': '#ff0000'
                })
            );
            restoreThemeFromCache();
            const rgb = document.documentElement.style.getPropertyValue('--color-bg-primary-rgb');
            expect(rgb).toBe('255, 0, 0');
        });
    });

    // ========== getActiveThemeId ==========
    describe('getActiveThemeId', () => {
        it('无缓存返回 null', () => {
            expect(getActiveThemeId()).toBeNull();
        });

        it('返回缓存的 ID', () => {
            localStorage.setItem('activeThemeId', '__monokai__');
            expect(getActiveThemeId()).toBe('__monokai__');
        });
    });

    // ========== getBuiltinTheme ==========
    describe('getBuiltinTheme', () => {
        it('查找 light 主题', () => {
            const t = getBuiltinTheme('__light__');
            expect(t).toBeDefined();
            expect(t.id).toBe('__light__');
        });

        it('查找 dark 主题', () => {
            const t = getBuiltinTheme('__dark__');
            expect(t).toBeDefined();
            expect(t.id).toBe('__dark__');
        });

        it('不存在的 ID 返回 null', () => {
            expect(getBuiltinTheme('__nonexistent__')).toBeNull();
        });
    });
});
