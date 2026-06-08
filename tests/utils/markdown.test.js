/**
 * markdown.js 测试
 * 缓存类和工具函数
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../js/utils/logger.js', () => ({
    logger: { warn: vi.fn(), debug: vi.fn(), error: vi.fn(), info: vi.fn() }
}));

vi.mock('../../js/utils/helpers.js', () => ({
    escapeHtml: vi.fn((s) => s.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')),
    extractBase64Images: vi.fn((text) => ({ text, images: [] })),
    restoreBase64Images: vi.fn((html) => html)
}));

vi.mock('../../js/utils/constants.js', () => ({
    MAX_MARKDOWN_LENGTH: 100000
}));

import {
    safeMarkedParse,
    clearMarkdownCache,
    getMarkdownCacheStats
} from '../../js/utils/markdown.js';

describe('markdown', () => {
    beforeEach(() => {
        clearMarkdownCache();
    });

    describe('safeMarkedParse', () => {
        it('marked 未加载时降级为纯文本', () => {
            // 在 jsdom 中 marked 未定义
            const result = safeMarkedParse('hello\nworld');
            expect(result).toContain('hello');
            expect(result).toContain('world');
        });

        it('HTML 标签被转义', () => {
            const result = safeMarkedParse('<script>alert(1)</script>');
            expect(result).not.toContain('<script>');
            expect(result).toContain('&lt;script&gt;');
        });

        it('marked 可用时解析 markdown', () => {
            // mock marked 和 DOMPurify
            globalThis.marked = {
                parse: vi.fn((text) => `<p>${text}</p>`)
            };
            globalThis.DOMPurify = {
                sanitize: vi.fn((html) => html)
            };

            clearMarkdownCache();
            const result = safeMarkedParse('hello world');
            expect(result).toBe('<p>hello world</p>');

            delete globalThis.marked;
            delete globalThis.DOMPurify;
        });

        it('缓存命中时返回缓存结果', () => {
            globalThis.marked = {
                parse: vi.fn((text) => `<p>${text}</p>`)
            };
            globalThis.DOMPurify = {
                sanitize: vi.fn((html) => html)
            };

            clearMarkdownCache();
            safeMarkedParse('cached text');
            const callCount = globalThis.marked.parse.mock.calls.length;
            safeMarkedParse('cached text');
            // 第二次不应再调用 marked.parse
            expect(globalThis.marked.parse.mock.calls.length).toBe(callCount);

            delete globalThis.marked;
            delete globalThis.DOMPurify;
        });

        it('DOMPurify 不可用时降级', () => {
            globalThis.marked = { parse: vi.fn((text) => text) };
            // DOMPurify 不存在

            clearMarkdownCache();
            const result = safeMarkedParse('test');
            // 应该降级为 escapeHtml
            expect(result).toBeTruthy();

            delete globalThis.marked;
        });

        it('marked.parse 抛错时降级', () => {
            globalThis.marked = {
                parse: vi.fn(() => {
                    throw new Error('parse error');
                })
            };
            globalThis.DOMPurify = {
                sanitize: vi.fn((html) => html)
            };

            clearMarkdownCache();
            const result = safeMarkedParse('broken');
            expect(result).toContain('broken');

            delete globalThis.marked;
            delete globalThis.DOMPurify;
        });
    });

    describe('clearMarkdownCache', () => {
        it('清除缓存', () => {
            clearMarkdownCache();
            const stats = getMarkdownCacheStats();
            expect(stats.size).toBe(0);
        });
    });

    describe('getMarkdownCacheStats', () => {
        it('返回 size 和 maxSize', () => {
            const stats = getMarkdownCacheStats();
            expect(typeof stats.size).toBe('number');
            expect(typeof stats.maxSize).toBe('number');
            expect(stats.maxSize).toBeGreaterThan(0);
        });
    });

    describe('LaTeX 提取', () => {
        it('块级公式 $$ 被提取', () => {
            globalThis.marked = {
                parse: vi.fn((text) => text)
            };
            globalThis.DOMPurify = {
                sanitize: vi.fn((html) => html)
            };

            clearMarkdownCache();
            const result = safeMarkedParse('text $$E=mc^2$$ more');
            // 公式应被替换为占位符然后还原（katex 未定义时为 fallback）
            expect(result).toBeTruthy();

            delete globalThis.marked;
            delete globalThis.DOMPurify;
        });

        it('行内公式 $ 被提取', () => {
            globalThis.marked = {
                parse: vi.fn((text) => text)
            };
            globalThis.DOMPurify = {
                sanitize: vi.fn((html) => html)
            };

            clearMarkdownCache();
            const result = safeMarkedParse('inline $x^2$ formula');
            expect(result).toBeTruthy();

            delete globalThis.marked;
            delete globalThis.DOMPurify;
        });

        it('货币 $100 不被当作公式', () => {
            globalThis.marked = {
                parse: vi.fn((text) => text)
            };
            globalThis.DOMPurify = {
                sanitize: vi.fn((html) => html)
            };

            clearMarkdownCache();
            const result = safeMarkedParse('cost is $100');
            // $100 不应该被当作公式处理
            expect(result).toBeTruthy();

            delete globalThis.marked;
            delete globalThis.DOMPurify;
        });
    });
});
