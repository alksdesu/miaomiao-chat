/**
 * helpers.js 工具函数测试
 * escapeHtml 依赖 document.createElement（浏览器 API），这里直接测纯函数部分
 */
// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../js/utils/logger.js', () => ({
    logger: { warn: vi.fn(), debug: vi.fn(), error: vi.fn(), info: vi.fn() }
}));

import {
    generateId,
    generateMessageId,
    generateSessionId,
    generateSessionName,
    detectImageFormat,
    extractBase64Images,
    restoreBase64Images,
    escapeHtml,
    safeSetHTML
} from '../../js/utils/helpers.js';

// ========== generateId ==========

describe('generateId', () => {
    it('默认前缀为 id', () => {
        const id = generateId();
        expect(id).toMatch(/^id_\d+_[a-z0-9]+$/);
    });

    it('自定义前缀', () => {
        const id = generateId('tool');
        expect(id.startsWith('tool_')).toBe(true);
    });

    it('每次生成不同 ID', () => {
        const a = generateId();
        const b = generateId();
        expect(a).not.toBe(b);
    });
});

// ========== generateMessageId ==========

describe('generateMessageId', () => {
    it('格式为 msg_ 前缀', () => {
        expect(generateMessageId()).toMatch(/^msg_\d+_[a-z0-9]+$/);
    });
});

// ========== generateSessionId ==========

describe('generateSessionId', () => {
    it('格式为 session_ 前缀', () => {
        expect(generateSessionId()).toMatch(/^session_\d+_[a-z0-9]+$/);
    });
});

// ========== generateSessionName ==========

describe('generateSessionName', () => {
    it('空内容返回默认名', () => {
        expect(generateSessionName('')).toBe('新会话');
        expect(generateSessionName(null)).toBe('新会话');
    });

    it('短内容直接返回', () => {
        expect(generateSessionName('Hello')).toBe('Hello');
    });

    it('超长内容截断并加省略号', () => {
        const long = '这是一段非常长的中文文本用来测试会话名称截断功能是否正常工作';
        const name = generateSessionName(long, 10);
        expect(name.length).toBeLessThanOrEqual(14); // 10 + '...'
    });
});

// ========== detectImageFormat ==========

describe('detectImageFormat', () => {
    it('检测 PNG', () => {
        const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0]);
        expect(detectImageFormat(bytes)).toEqual({ mime: 'image/png', ext: 'png' });
    });

    it('检测 JPEG', () => {
        const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
        expect(detectImageFormat(bytes)).toEqual({ mime: 'image/jpeg', ext: 'jpg' });
    });

    it('检测 GIF', () => {
        const bytes = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0, 0, 0, 0, 0, 0, 0, 0]);
        expect(detectImageFormat(bytes)).toEqual({ mime: 'image/gif', ext: 'gif' });
    });

    it('检测 WebP', () => {
        const bytes = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
        expect(detectImageFormat(bytes)).toEqual({ mime: 'image/webp', ext: 'webp' });
    });

    it('未知格式默认 PNG', () => {
        const bytes = new Uint8Array([0x00, 0x00, 0x00, 0x00]);
        expect(detectImageFormat(bytes)).toEqual({ mime: 'image/png', ext: 'png' });
    });
});

// ========== extractBase64Images ==========

describe('extractBase64Images', () => {
    it('提取 base64 图片并替换为占位符', () => {
        const input = '看图 ![cat](data:image/png;base64,abc123) 结束';
        const { text, images } = extractBase64Images(input);
        expect(images).toHaveLength(1);
        expect(images[0].alt).toBe('cat');
        expect(images[0].dataUrl).toBe('data:image/png;base64,abc123');
        expect(text).toContain('<!--IMG_PLACEHOLDER_0-->');
        expect(text).not.toContain('data:image');
    });

    it('无图片原样返回', () => {
        const { text, images } = extractBase64Images('普通文本');
        expect(text).toBe('普通文本');
        expect(images).toHaveLength(0);
    });

    it('提取多张图片', () => {
        const input = '![a](data:image/png;base64,AAA) mid ![b](data:image/jpeg;base64,BBB)';
        const { text, images } = extractBase64Images(input);
        expect(images).toHaveLength(2);
        expect(text).toContain('<!--IMG_PLACEHOLDER_0-->');
        expect(text).toContain('<!--IMG_PLACEHOLDER_1-->');
    });
});

// ========== generateSessionName 补充 ==========

describe('generateSessionName 补充', () => {
    it('去除特殊字符', () => {
        const name = generateSessionName('hello! @world#');
        expect(name).not.toContain('!');
        expect(name).not.toContain('@');
    });

    it('合并换行', () => {
        const name = generateSessionName('hello\n\nworld');
        expect(name).not.toContain('\n');
    });

    it('纯特殊字符返回默认', () => {
        expect(generateSessionName('!@#$%^&*()')).toBe('新会话');
    });

    it('英文长文本空格处截断', () => {
        const content = 'hello world this is a long content for testing truncation';
        const name = generateSessionName(content, 20);
        expect(name).toMatch(/\.\.\.$/);
        expect(name.length).toBeLessThanOrEqual(23);
    });

    it('中文长文本截断', () => {
        const content = '这是一段很长的中文文本用来测试截断的功能是否正常工作';
        const name = generateSessionName(content, 10);
        expect(name.length).toBeLessThanOrEqual(14);
    });

    it('混合中英文截断', () => {
        const content = '你好world这是一个很长的内容用于测试截断功能是否正常工作';
        const name = generateSessionName(content, 15);
        expect(name.length).toBeLessThanOrEqual(18);
    });
});

// ========== restoreBase64Images ==========

describe('restoreBase64Images', () => {
    it('还原占位符为 img 标签', () => {
        const images = [{ alt: 'cat', dataUrl: 'data:image/png;base64,abc123' }];
        const html = 'before <!--IMG_PLACEHOLDER_0--> after';
        const result = restoreBase64Images(html, images);
        expect(result).toContain('<img');
        expect(result).toContain('src="data:image/png;base64,abc123"');
        expect(result).toContain('alt="cat"');
        expect(result).not.toContain('<!--IMG_PLACEHOLDER_0-->');
    });

    it('还原多张图片', () => {
        const images = [
            { alt: 'a', dataUrl: 'data:image/png;base64,AAA' },
            { alt: 'b', dataUrl: 'data:image/jpeg;base64,BBB' }
        ];
        const html = '<!--IMG_PLACEHOLDER_0--> mid <!--IMG_PLACEHOLDER_1-->';
        const result = restoreBase64Images(html, images);
        expect(result).toContain('AAA');
        expect(result).toContain('BBB');
    });

    it('空 alt 使用默认值', () => {
        const images = [{ alt: '', dataUrl: 'data:image/png;base64,x' }];
        const html = '<!--IMG_PLACEHOLDER_0-->';
        const result = restoreBase64Images(html, images);
        expect(result).toContain('Generated image');
    });

    it('空图片数组原样返回', () => {
        const html = 'no images here';
        expect(restoreBase64Images(html, [])).toBe('no images here');
    });
});

// ========== escapeHtml ==========

describe('escapeHtml', () => {
    it('转义 HTML 特殊字符', () => {
        const result = escapeHtml('<script>alert("xss")</script>');
        expect(result).not.toContain('<script>');
        expect(result).toContain('&lt;');
    });

    it('null 返回空字符串', () => {
        expect(escapeHtml(null)).toBe('');
    });

    it('undefined 返回空字符串', () => {
        expect(escapeHtml(undefined)).toBe('');
    });

    it('数字转为字符串', () => {
        expect(escapeHtml(42)).toBe('42');
    });

    it('纯文本原样返回', () => {
        expect(escapeHtml('hello world')).toBe('hello world');
    });

    it('转义 & 符号', () => {
        expect(escapeHtml('a & b')).toContain('&amp;');
    });
});

// ========== safeSetHTML ==========

describe('safeSetHTML', () => {
    it('DOMPurify 不可用时降级为 textContent', () => {
        const el = document.createElement('div');
        safeSetHTML(el, '<b>bold</b>');
        // 因为 DOMPurify 在测试环境中未加载，应降级
        expect(el.textContent).toBe('<b>bold</b>');
    });

    it('DOMPurify 可用时使用 sanitize', () => {
        const el = document.createElement('div');
        globalThis.DOMPurify = {
            sanitize: vi.fn((html) => '<b>clean</b>')
        };
        safeSetHTML(el, '<b>bold</b><script>evil</script>');
        expect(el.innerHTML).toBe('<b>clean</b>');
        expect(globalThis.DOMPurify.sanitize).toHaveBeenCalled();
        delete globalThis.DOMPurify;
    });
});
