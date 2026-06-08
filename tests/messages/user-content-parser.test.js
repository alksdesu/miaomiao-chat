/**
 * user-content-parser.js 测试
 * 测试 parseUserContent 各种输入格式
 */
import { describe, it, expect } from 'vitest';

import { parseUserContent } from '../../js/messages/user-content-parser.js';

// ========== 字符串输入 ==========

describe('parseUserContent - 字符串输入', () => {
    it('普通字符串作为 text 返回', () => {
        const result = parseUserContent('hello world');
        expect(result.text).toBe('hello world');
        expect(result.images).toHaveLength(0);
    });

    it('空字符串', () => {
        const result = parseUserContent('');
        expect(result.text).toBe('');
        expect(result.images).toHaveLength(0);
    });

    it('多行字符串', () => {
        const result = parseUserContent('line1\nline2\nline3');
        expect(result.text).toBe('line1\nline2\nline3');
    });

    it('特殊字符', () => {
        const result = parseUserContent('<script>alert("xss")</script>');
        expect(result.text).toBe('<script>alert("xss")</script>');
    });
});

// ========== 数组输入 - 纯文本 ==========

describe('parseUserContent - 数组纯文本', () => {
    it('单个 text 部分', () => {
        const result = parseUserContent([{ type: 'text', text: 'hello' }]);
        expect(result.text).toBe('hello');
        expect(result.images).toHaveLength(0);
    });

    it('多个 text 部分用换行连接', () => {
        const result = parseUserContent([
            { type: 'text', text: 'first' },
            { type: 'text', text: 'second' }
        ]);
        expect(result.text).toBe('first\nsecond');
    });

    it('text 为空字符串', () => {
        const result = parseUserContent([{ type: 'text', text: '' }]);
        expect(result.text).toBe('');
    });

    it('text 为 undefined', () => {
        const result = parseUserContent([{ type: 'text' }]);
        expect(result.text).toBe('');
    });
});

// ========== 数组输入 - OpenAI 图片 ==========

describe('parseUserContent - OpenAI 图片', () => {
    it('解析 image_url 类型', () => {
        const result = parseUserContent([
            { type: 'text', text: 'look' },
            { type: 'image_url', image_url: { url: 'https://example.com/img.png' } }
        ]);
        expect(result.text).toBe('look');
        expect(result.images).toHaveLength(1);
        expect(result.images[0].category).toBe('image');
        expect(result.images[0].data).toBe('https://example.com/img.png');
    });

    it('image_url 无 url 字段不添加', () => {
        const result = parseUserContent([{ type: 'image_url', image_url: {} }]);
        expect(result.images).toHaveLength(0);
    });

    it('image_url 的 image_url 为 null', () => {
        const result = parseUserContent([{ type: 'image_url' }]);
        expect(result.images).toHaveLength(0);
    });

    it('base64 data URL 图片', () => {
        const result = parseUserContent([
            {
                type: 'image_url',
                image_url: { url: 'data:image/png;base64,abc123' }
            }
        ]);
        expect(result.images[0].data).toBe('data:image/png;base64,abc123');
    });
});

// ========== 数组输入 - Claude 图片 ==========

describe('parseUserContent - Claude 图片', () => {
    it('解析 image + source 类型', () => {
        const result = parseUserContent([
            {
                type: 'image',
                source: { data: 'base64data', media_type: 'image/jpeg' }
            }
        ]);
        expect(result.images).toHaveLength(1);
        expect(result.images[0].data).toBe('data:image/jpeg;base64,base64data');
        expect(result.images[0].type).toBe('image/jpeg');
        expect(result.images[0].category).toBe('image');
    });

    it('image 无 source.data 不添加', () => {
        const result = parseUserContent([{ type: 'image', source: {} }]);
        expect(result.images).toHaveLength(0);
    });

    it('image 默认 MIME 类型', () => {
        const result = parseUserContent([{ type: 'image', source: { data: 'abc' } }]);
        expect(result.images[0].type).toBe('image/*');
    });
});

// ========== 数组输入 - OpenAI PDF ==========

describe('parseUserContent - OpenAI PDF', () => {
    it('解析 file 类型 PDF', () => {
        const result = parseUserContent([
            {
                type: 'file',
                file: { file_data: 'data:application/pdf;base64,pdfdata', filename: 'doc.pdf' }
            }
        ]);
        expect(result.images).toHaveLength(1);
        expect(result.images[0].category).toBe('pdf');
        expect(result.images[0].name).toBe('doc.pdf');
    });

    it('file 无 filename 使用默认名', () => {
        const result = parseUserContent([{ type: 'file', file: { file_data: 'pdfdata' } }]);
        expect(result.images[0].name).toBe('已上传PDF');
    });

    it('file 无 file_data 不添加', () => {
        const result = parseUserContent([{ type: 'file', file: {} }]);
        expect(result.images).toHaveLength(0);
    });
});

// ========== 数组输入 - Claude PDF ==========

describe('parseUserContent - Claude PDF', () => {
    it('解析 document 类型', () => {
        const result = parseUserContent([
            {
                type: 'document',
                source: { data: 'pdfbase64', media_type: 'application/pdf' }
            }
        ]);
        expect(result.images).toHaveLength(1);
        expect(result.images[0].category).toBe('pdf');
        expect(result.images[0].data).toBe('data:application/pdf;base64,pdfbase64');
    });

    it('document 默认 MIME 类型', () => {
        const result = parseUserContent([{ type: 'document', source: { data: 'abc' } }]);
        expect(result.images[0].type).toBe('application/pdf');
    });
});

// ========== 混合内容 ==========

describe('parseUserContent - 混合内容', () => {
    it('文本 + 图片 + PDF 混合', () => {
        const result = parseUserContent([
            { type: 'text', text: 'Analyze this' },
            { type: 'image_url', image_url: { url: 'https://img.com/1.jpg' } },
            {
                type: 'file',
                file: { file_data: 'pdfdata', filename: 'report.pdf' }
            }
        ]);
        expect(result.text).toBe('Analyze this');
        expect(result.images).toHaveLength(2);
        expect(result.images[0].category).toBe('image');
        expect(result.images[1].category).toBe('pdf');
    });

    it('未知类型被忽略', () => {
        const result = parseUserContent([
            { type: 'text', text: 'hello' },
            { type: 'unknown_type', data: 'something' }
        ]);
        expect(result.text).toBe('hello');
        expect(result.images).toHaveLength(0);
    });

    it('空数组', () => {
        const result = parseUserContent([]);
        expect(result.text).toBe('');
        expect(result.images).toHaveLength(0);
    });
});

// ========== 边界情况 ==========

describe('parseUserContent - 边界情况', () => {
    it('非字符串非数组输入', () => {
        const result = parseUserContent(null);
        expect(result.text).toBe('');
        expect(result.images).toHaveLength(0);
    });

    it('数字输入', () => {
        const result = parseUserContent(123);
        expect(result.text).toBe('');
    });

    it('布尔输入', () => {
        const result = parseUserContent(true);
        expect(result.text).toBe('');
    });
});
