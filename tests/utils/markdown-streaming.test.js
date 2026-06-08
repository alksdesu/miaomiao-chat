/**
 * safeMarkedParse 流式态分支测试（P0-5 改动覆盖）
 * 覆盖 isStreaming 选项的预补全 / 缓存隔离 / 分块短路 / 向后兼容 / remend 自定义标签保护
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../js/utils/logger.js', () => ({
    logger: { warn: vi.fn(), debug: vi.fn(), error: vi.fn(), info: vi.fn() }
}));

vi.mock('../../js/utils/helpers.js', () => ({
    escapeHtml: vi.fn((s) =>
        String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
    ),
    extractBase64Images: vi.fn((text) => ({ text, images: [] })),
    restoreBase64Images: vi.fn((html) => html)
}));

// 测试目的：观测流式态分块短路，调小 MAX_MARKDOWN_LENGTH 而不需要构造 100k 字符串
vi.mock('../../js/utils/constants.js', () => ({
    MAX_MARKDOWN_LENGTH: 20
}));

// 用 vi.mock 包住 remend，便于断言流式态确实走了预补全管线
vi.mock('../../js/vendor/remend.js', () => ({
    // 默认实现：原样返回（被各用例 mockImplementation 覆盖）
    default: vi.fn((text) => text)
}));

import { safeMarkedParse, clearMarkdownCache } from '../../js/utils/markdown.js';
import remend from '../../js/vendor/remend.js';

beforeEach(() => {
    clearMarkdownCache();
    vi.clearAllMocks();
    // 默认让 remend 原样返回，单个用例可重写
    remend.mockImplementation((text) => text);

    globalThis.marked = {
        parse: vi.fn((text) => `<p>${text}</p>`)
    };
    globalThis.DOMPurify = {
        sanitize: vi.fn((html) => html),
        removed: []
    };
});

describe('safeMarkedParse - isStreaming 分支', () => {
    it('isStreaming:true 调用 remend 预补全半截 **bold**', () => {
        // 模拟 remend 真实行为：把未闭合 **bold 补全为 **bold**
        remend.mockImplementation((text) => {
            if (text.endsWith('**bold')) return text + '**';
            return text;
        });

        const result = safeMarkedParse('hello **bold', { isStreaming: true });

        expect(remend).toHaveBeenCalledTimes(1);
        // remend 必须收到 htmlTags:false + images:false 选项
        expect(remend).toHaveBeenCalledWith('hello **bold', { htmlTags: false, images: false });
        // 补全后传给 marked.parse 的文本应是闭合版
        expect(globalThis.marked.parse).toHaveBeenCalledWith('hello **bold**');
        expect(result).toBe('<p>hello **bold**</p>');
    });

    it('isStreaming:true 不写 markdownCache，连续两次相同输入都走 marked.parse', () => {
        const sameText = 'streaming half **partial';

        safeMarkedParse(sameText, { isStreaming: true });
        safeMarkedParse(sameText, { isStreaming: true });

        // 流式态半成品不入 LRU，避免污染稳定态条目；第二次必须重新 parse
        expect(globalThis.marked.parse).toHaveBeenCalledTimes(2);
    });

    it('isStreaming:true 时超长文本走单块，不进分块循环', () => {
        // 文本长度 80 > MAX_MARKDOWN_LENGTH(20=mock 值)，稳定态会分 4+ 块，流式态强制单块
        const longText = 'a'.repeat(80);

        safeMarkedParse(longText, { isStreaming: true });

        // 流式态：分块循环被短路，marked.parse 只调用 1 次（单块路径）
        expect(globalThis.marked.parse).toHaveBeenCalledTimes(1);
        expect(globalThis.marked.parse).toHaveBeenCalledWith(longText);
    });

    it('isStreaming:false（默认）不调 remend，超长文本走分块路径（向后兼容）', () => {
        const longText = 'a'.repeat(80); // > MAX_MARKDOWN_LENGTH(20)

        safeMarkedParse(longText); // 默认参数

        expect(remend).not.toHaveBeenCalled();
        // 稳定态：分块路径会多次调 marked.parse（80/20 ≈ 4 块）
        expect(globalThis.marked.parse.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it('remend 在 htmlTags:false 模式不补全 <think>/<tool_use> 半截标签', () => {
        // 用真实 remend 模块验证 htmlTags:false 的语义（不再 mock，直接 import 真实实现）
        vi.doUnmock('../../js/vendor/remend.js');

        // 动态导入真实 remend
        return import('../../js/vendor/remend.js').then(({ default: realRemend }) => {
            const thinkHalf = 'some text <think';
            const toolHalf = 'foo <tool_use';

            // 关闭 htmlTags 处理 → remend 不剥离/补全 HTML 半截
            const resultThink = realRemend(thinkHalf, { htmlTags: false, images: false });
            const resultTool = realRemend(toolHalf, { htmlTags: false, images: false });

            // 关键断言：业务自定义标签的半截开口符必须原样保留，等流式后续 chunk 补全
            expect(resultThink).toContain('<think');
            expect(resultTool).toContain('<tool_use');

            // 反证：默认 htmlTags 开启会把半截 <think 截掉
            const stripped = realRemend(thinkHalf);
            expect(stripped).not.toContain('<think');
        });
    });
});
