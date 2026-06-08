/**
 * markdown-image-parser.js 测试
 */
import { describe, it, expect } from 'vitest';

import {
    containsMarkdownImage,
    parseMarkdownImages,
    parseStreamingMarkdownImages,
    mergeTextParts
} from '../../js/utils/markdown-image-parser.js';

// ========== containsMarkdownImage ==========

describe('containsMarkdownImage', () => {
    it('包含 markdown 图片返回 true', () => {
        expect(containsMarkdownImage('text ![img](data:image/jpeg;base64,abc) more')).toBe(true);
    });

    it('包含 png 图片', () => {
        expect(containsMarkdownImage('![](data:image/png;base64,xyz)')).toBe(true);
    });

    it('不包含图片返回 false', () => {
        expect(containsMarkdownImage('just plain text')).toBe(false);
    });

    it('null 返回 false', () => {
        expect(containsMarkdownImage(null)).toBe(false);
    });

    it('空字符串返回 false', () => {
        expect(containsMarkdownImage('')).toBe(false);
    });

    it('数字返回 false', () => {
        expect(containsMarkdownImage(123)).toBe(false);
    });

    it('普通 markdown 链接不匹配', () => {
        expect(containsMarkdownImage('[link](https://example.com)')).toBe(false);
    });

    it('非 data URL 图片不匹配', () => {
        expect(containsMarkdownImage('![img](https://example.com/img.png)')).toBe(false);
    });
});

// ========== parseMarkdownImages ==========

describe('parseMarkdownImages', () => {
    it('纯文本原样返回', () => {
        const result = parseMarkdownImages('hello world');
        expect(result).toHaveLength(1);
        expect(result[0].type).toBe('text');
        expect(result[0].text).toBe('hello world');
    });

    it('null 返回空文本', () => {
        const result = parseMarkdownImages(null);
        expect(result).toHaveLength(1);
        expect(result[0].text).toBe('');
    });

    it('空字符串返回空文本', () => {
        const result = parseMarkdownImages('');
        expect(result).toHaveLength(1);
        expect(result[0].text).toBe('');
    });

    it('解析单个图片', () => {
        const text = 'before ![alt](data:image/png;base64,abc123) after';
        const result = parseMarkdownImages(text);
        expect(result).toHaveLength(3);
        expect(result[0]).toEqual({ type: 'text', text: 'before ' });
        expect(result[1].type).toBe('image_url');
        expect(result[1].url).toBe('data:image/png;base64,abc123');
        expect(result[1].alt).toBe('alt');
        expect(result[1].complete).toBe(true);
        expect(result[2]).toEqual({ type: 'text', text: ' after' });
    });

    it('解析多个图片', () => {
        const text = '![a](data:image/jpeg;base64,x) mid ![b](data:image/png;base64,y)';
        const result = parseMarkdownImages(text);
        expect(result.filter((p) => p.type === 'image_url')).toHaveLength(2);
    });

    it('无 alt 文本使用默认', () => {
        const text = '![](data:image/gif;base64,abc)';
        const result = parseMarkdownImages(text);
        expect(result[0].alt).toBe('Generated Image');
    });

    it('支持 webp', () => {
        const text = '![test](data:image/webp;base64,abc)';
        const result = parseMarkdownImages(text);
        expect(result[0].type).toBe('image_url');
    });

    it('支持 jpg', () => {
        const text = '![test](data:image/jpg;base64,abc)';
        const result = parseMarkdownImages(text);
        expect(result[0].type).toBe('image_url');
    });

    it('仅图片无前后文本', () => {
        const text = '![x](data:image/png;base64,abc)';
        const result = parseMarkdownImages(text);
        expect(result).toHaveLength(1);
        expect(result[0].type).toBe('image_url');
    });
});

// ========== parseStreamingMarkdownImages ==========

describe('parseStreamingMarkdownImages', () => {
    it('null chunk 返回空 parts', () => {
        const result = parseStreamingMarkdownImages(null, '');
        expect(result.parts).toHaveLength(0);
        expect(result.newBuffer).toBe('');
    });

    it('纯文本 chunk', () => {
        const result = parseStreamingMarkdownImages('hello world');
        expect(result.parts).toHaveLength(1);
        expect(result.parts[0].type).toBe('text');
        expect(result.newBuffer).toBe('');
    });

    it('完整图片 chunk', () => {
        const chunk = '![img](data:image/png;base64,abc)';
        const result = parseStreamingMarkdownImages(chunk);
        expect(result.parts.some((p) => p.type === 'image_url')).toBe(true);
        expect(result.newBuffer).toBe('');
    });

    it('不完整图片缓冲', () => {
        const chunk = 'text ![img](data:image/pn';
        const result = parseStreamingMarkdownImages(chunk);
        expect(result.newBuffer.length).toBeGreaterThan(0);
    });

    it('缓冲区合并完成图片', () => {
        const r1 = parseStreamingMarkdownImages('before ![img](data:image/pn');
        const r2 = parseStreamingMarkdownImages('g;base64,abc) after', r1.newBuffer);
        expect(r2.parts.some((p) => p.type === 'image_url')).toBe(true);
    });

    it('空 chunk 返回空', () => {
        const result = parseStreamingMarkdownImages('', 'buffer');
        expect(result.parts).toHaveLength(0);
        expect(result.newBuffer).toBe('buffer');
    });
});

// ========== mergeTextParts ==========

describe('mergeTextParts', () => {
    it('合并连续文本', () => {
        const parts = [
            { type: 'text', text: 'a' },
            { type: 'text', text: 'b' },
            { type: 'text', text: 'c' }
        ];
        const result = mergeTextParts(parts);
        expect(result).toHaveLength(1);
        expect(result[0].text).toBe('abc');
    });

    it('非文本部分不合并', () => {
        const parts = [
            { type: 'text', text: 'a' },
            { type: 'image_url', url: 'url' },
            { type: 'text', text: 'b' }
        ];
        const result = mergeTextParts(parts);
        expect(result).toHaveLength(3);
    });

    it('空数组返回原值', () => {
        expect(mergeTextParts([])).toEqual([]);
    });

    it('null 返回原值', () => {
        expect(mergeTextParts(null)).toBeNull();
    });

    it('非数组返回原值', () => {
        expect(mergeTextParts('not array')).toBe('not array');
    });

    it('单个元素不变', () => {
        const parts = [{ type: 'text', text: 'only' }];
        const result = mergeTextParts(parts);
        expect(result).toHaveLength(1);
        expect(result[0].text).toBe('only');
    });

    it('交替类型', () => {
        const parts = [
            { type: 'text', text: 'a' },
            { type: 'image_url', url: 'u1' },
            { type: 'text', text: 'b' },
            { type: 'text', text: 'c' },
            { type: 'image_url', url: 'u2' }
        ];
        const result = mergeTextParts(parts);
        expect(result).toHaveLength(4);
        expect(result[2].text).toBe('bc');
    });
});
