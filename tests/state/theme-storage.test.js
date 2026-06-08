/**
 * state/theme-storage.js 主题存储测试
 * 测试 validateTheme 纯函数
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// mock 依赖
vi.mock('../../js/state/storage.js', () => ({
    getDB: vi.fn(() => null),
    initDB: vi.fn(async () => {}),
    withDBLock: vi.fn(async (name, fn) => fn())
}));

vi.mock('../../js/state/config.js', () => ({
    downloadJSON: vi.fn()
}));

vi.mock('../../js/utils/helpers.js', () => ({
    generateId: vi.fn((prefix) => `${prefix}_test123`)
}));

vi.mock('../../js/ui/theme-engine.js', () => ({
    THEME_PROPERTIES: {
        colors: {
            primary: '#000',
            secondary: '#fff',
            background: '#111'
        },
        fonts: {
            main: 'sans-serif'
        }
    },
    BUILTIN_THEMES: [
        { id: '__dark', name: 'Dark', base: 'dark' },
        { id: '__light', name: 'Light', base: 'light' }
    ],
    sanitizeCustomCSS: vi.fn((css) => ({
        css: css.substring(0, 1000),
        warnings: []
    }))
}));

import { validateTheme } from '../../js/state/theme-storage.js';

beforeEach(() => {
    vi.clearAllMocks();
});

describe('validateTheme', () => {
    it('验证有效的主题', () => {
        const result = validateTheme({
            name: 'My Theme',
            base: 'dark',
            colors: { primary: '#ff0000' }
        });

        expect(result.valid).toBe(true);
        expect(result.theme.name).toBe('My Theme');
        expect(result.theme.base).toBe('dark');
        expect(result.theme.colors.primary).toBe('#ff0000');
    });

    it('拒绝 null 输入', () => {
        const result = validateTheme(null);
        expect(result.valid).toBe(false);
        expect(result.warnings).toContain('无效的主题数据');
    });

    it('拒绝非对象输入', () => {
        const result = validateTheme('string');
        expect(result.valid).toBe(false);
    });

    it('拒绝无名称的主题', () => {
        const result = validateTheme({ base: 'dark' });
        expect(result.valid).toBe(false);
        expect(result.warnings[0]).toContain('名称');
    });

    it('拒绝空名称', () => {
        const result = validateTheme({ name: '', base: 'dark' });
        expect(result.valid).toBe(false);
    });

    it('拒绝非字符串名称', () => {
        const result = validateTheme({ name: 123, base: 'dark' });
        expect(result.valid).toBe(false);
    });

    it('修正无效的 base 为 dark', () => {
        const result = validateTheme({ name: 'Test', base: 'invalid' });
        expect(result.valid).toBe(true);
        expect(result.theme.base).toBe('dark');
        expect(result.warnings).toContainEqual(expect.stringContaining('base'));
    });

    it('截断过长的名称', () => {
        const longName = 'A'.repeat(100);
        const result = validateTheme({ name: longName, base: 'dark' });
        expect(result.theme.name.length).toBeLessThanOrEqual(64);
    });

    it('去除名称空白', () => {
        const result = validateTheme({ name: '  Test Theme  ', base: 'light' });
        expect(result.theme.name).toBe('Test Theme');
    });

    it('过滤未知属性并发出警告', () => {
        const result = validateTheme({
            name: 'Test',
            base: 'dark',
            colors: { primary: '#fff', unknownProp: 'value' }
        });

        expect(result.valid).toBe(true);
        expect(result.theme.colors.unknownProp).toBeUndefined();
        expect(result.warnings).toContainEqual(expect.stringContaining('unknownProp'));
    });

    it('保留合法颜色属性', () => {
        const result = validateTheme({
            name: 'Test',
            base: 'dark',
            colors: { primary: '#ff0000', secondary: '#00ff00' }
        });

        expect(result.theme.colors.primary).toBe('#ff0000');
        expect(result.theme.colors.secondary).toBe('#00ff00');
    });

    it('处理 customCSS', () => {
        const result = validateTheme({
            name: 'Test',
            base: 'dark',
            customCSS: '.my-class { color: red; }'
        });

        expect(result.valid).toBe(true);
        expect(result.theme.customCSS).toBeDefined();
    });

    it('无 customCSS 时默认空字符串', () => {
        const result = validateTheme({
            name: 'Test',
            base: 'dark'
        });

        expect(result.theme.customCSS).toBe('');
    });

    it('忽略非字符串 customCSS', () => {
        const result = validateTheme({
            name: 'Test',
            base: 'dark',
            customCSS: 123
        });

        expect(result.theme.customCSS).toBe('');
    });

    it('生成 id 和时间戳', () => {
        const result = validateTheme({
            name: 'Test',
            base: 'dark'
        });

        expect(result.theme.id).toBe('theme_test123');
        expect(result.theme.version).toBe(1);
        expect(result.theme.updatedAt).toBeGreaterThan(0);
    });

    it('保留已有 id', () => {
        const result = validateTheme({
            name: 'Test',
            base: 'dark',
            id: 'existing-id'
        });

        expect(result.theme.id).toBe('existing-id');
    });

    it('忽略未知的 section', () => {
        const result = validateTheme({
            name: 'Test',
            base: 'dark',
            unknownSection: { foo: 'bar' }
        });

        expect(result.valid).toBe(true);
        expect(result.theme.unknownSection).toBeUndefined();
    });

    it('base 为 light 时保留', () => {
        const result = validateTheme({ name: 'Light Theme', base: 'light' });
        expect(result.theme.base).toBe('light');
    });
});
