/**
 * utils/icons.js SVG 图标测试
 */
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';

import { icons, getIcon, createIcon, emojiToIcon, replaceEmojis } from '../../js/utils/icons.js';

describe('icons 对象', () => {
    it('包含所有必需图标', () => {
        expect(icons.tool).toBeDefined();
        expect(icons.search).toBeDefined();
        expect(icons.settings).toBeDefined();
        expect(icons.checkCircle).toBeDefined();
        expect(icons.xCircle).toBeDefined();
        expect(icons.loader).toBeDefined();
    });

    it('所有图标都是 SVG 字符串', () => {
        for (const [name, svg] of Object.entries(icons)) {
            expect(svg).toMatch(/^<svg/);
            expect(svg).toMatch(/<\/svg>$/);
        }
    });
});

describe('getIcon', () => {
    it('返回带尺寸的 SVG 字符串', () => {
        const svg = getIcon('tool');
        expect(svg).toContain('width="16"');
        expect(svg).toContain('height="16"');
        expect(svg).toContain('class="icon "');
    });

    it('自定义尺寸', () => {
        const svg = getIcon('search', { size: 24 });
        expect(svg).toContain('width="24"');
        expect(svg).toContain('height="24"');
    });

    it('自定义 className', () => {
        const svg = getIcon('settings', { className: 'my-icon' });
        expect(svg).toContain('class="icon my-icon"');
    });

    it('不存在的图标返回 tool 图标', () => {
        const svg = getIcon('nonexistent');
        expect(svg).toContain('<svg');
        expect(svg).toEqual(expect.stringContaining('width="16"'));
    });
});

describe('createIcon', () => {
    it('返回 SVG DOM 元素', () => {
        const el = createIcon('tool');
        expect(el).toBeTruthy();
        expect(el.tagName.toLowerCase()).toBe('svg');
    });

    it('设置正确的尺寸属性', () => {
        const el = createIcon('search', { size: 32 });
        expect(el.getAttribute('width')).toBe('32');
        expect(el.getAttribute('height')).toBe('32');
    });

    it('设置 className', () => {
        const el = createIcon('settings', { className: 'special' });
        expect(el.getAttribute('class')).toContain('special');
    });
});

describe('emojiToIcon', () => {
    it('映射 emoji 到图标名', () => {
        expect(emojiToIcon['🔧']).toBe('tool');
        expect(emojiToIcon['🔍']).toBe('search');
        expect(emojiToIcon['❌']).toBe('xCircle');
        expect(emojiToIcon['⚠️']).toBe('alertCircle');
    });
});

describe('replaceEmojis', () => {
    it('替换 emoji 为 SVG 图标', () => {
        const result = replaceEmojis('状态: 🔧 工具');
        expect(result).toContain('<svg');
        expect(result).not.toContain('🔧');
    });

    it('替换多个 emoji', () => {
        const result = replaceEmojis('🔧 和 🔍');
        expect(result).not.toContain('🔧');
        expect(result).not.toContain('🔍');
    });

    it('无 emoji 时原样返回，不再被空字符串 key 错误替换', () => {
        const result = replaceEmojis('ab');
        expect(result).toBe('ab');
    });

    it('传递选项到 getIcon', () => {
        const result = replaceEmojis('🔧', { size: 20 });
        expect(result).toContain('width="20"');
    });
});
