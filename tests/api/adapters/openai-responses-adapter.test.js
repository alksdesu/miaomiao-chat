/**
 * openai-responses-adapter.js 测试
 * 从旧 api-adapters.test.js / tool-result-builder.test.js / response-parser.test.js 1:1 迁移
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

// mock 依赖
vi.mock('../../../js/api/format-converter.js', () => ({
    getMappedId: vi.fn((p, format) => `${format}_${p.id}`),
    generateIdSet: vi.fn((id) => ({
        openai: 'call_' + id,
        claude: 'toolu_' + id,
        gemini: 'gemini_' + id
    })),
    ensureIdMap: vi.fn(() => false)
}));

vi.mock('../../../js/utils/file-helpers.js', () => ({
    parseDataURL: vi.fn((url) => {
        if (!url || typeof url !== 'string') return null;
        const m = url.match(/^data:(.+?);base64,(.+)$/);
        if (!m) return null;
        return { mimeType: m[1], base64: m[2] };
    })
}));

vi.mock('../../../js/core/state.js', () => ({
    state: { xmlToolCallingEnabled: false }
}));

vi.mock('../../../js/providers/manager.js', () => ({
    getCurrentProvider: vi.fn(() => ({ apiFormat: 'openai-responses' }))
}));

vi.mock('../../../js/utils/markdown-image-parser.js', () => ({
    parseMarkdownImages: (text) => [{ type: 'text', text }]
}));

vi.mock('../../../js/tools/xml-formatter.js', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        extractXMLToolCalls: () => [],
        escapeXML: vi.fn((s) =>
            typeof s === 'string'
                ? s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                : ''
        )
    };
});

vi.mock('../../../js/stream/think-tag-parser.js', () => ({
    parseThinkTags: (text) => ({ displayText: text || '', thinkingContent: '' })
}));

vi.mock('../../../js/utils/media.js', () => ({
    isVideoMimeType: (mime) => mime?.startsWith('video/'),
    isAudioMimeType: (mime) => mime?.startsWith('audio/'),
    isVideoUrl: () => false
}));

import { openaiResponsesAdapter } from '../../../js/api/adapters/openai-responses-adapter.js';
import { PartType } from '../../../js/messages/schema.js';
import { state } from '../../../js/core/state.js';
import { getCurrentProvider } from '../../../js/providers/manager.js';

// 辅助：构建新格式消息
function newMsg(role, parts, opts = {}) {
    return {
        _schemaVersion: 1,
        role,
        parts,
        meta: opts.meta || {},
        error: opts.error || null,
        isError: opts.isError || false,
        ...opts
    };
}

// 辅助：构建旧格式消息（无 parts）
function oldMsg(fields) {
    return { ...fields };
}

const TOOL_CALLS = [{ id: 'tc_1', name: 'search', arguments: { q: 'test' } }];
const TOOL_RESULTS = [{ id: 'tc_1', name: 'search', result: { data: 'ok' }, isError: false }];

beforeEach(() => {
    state.xmlToolCallingEnabled = false;
    getCurrentProvider.mockReturnValue({ apiFormat: 'openai-responses' });
});

// ========== toOpenAIMessages (Responses) ==========

describe('toOpenAIMessages', () => {
    it('injectReasoning 在 assistant 消息前注入 reasoning item', () => {
        const msgs = [
            newMsg('assistant', [{ type: PartType.TEXT, text: '回答' }], {
                meta: { raw: { openai: { encryptedContent: 'enc_data', reasoningItemId: 'r_1' } } }
            })
        ];
        const out = openaiResponsesAdapter.partsToAPIMessages(msgs, { injectReasoning: true });
        expect(out).toHaveLength(2);
        expect(out[0].type).toBe('reasoning');
        expect(out[0].encrypted_content).toBe('enc_data');
        expect(out[0].id).toBe('r_1');
        expect(out[1].role).toBe('assistant');
    });

    it('injectReasoning 无 encryptedContent 时不注入', () => {
        const msgs = [newMsg('assistant', [{ type: PartType.TEXT, text: '回答' }])];
        const out = openaiResponsesAdapter.partsToAPIMessages(msgs, { injectReasoning: true });
        expect(out).toHaveLength(1);
    });
});

// ========== parseApiResponse - Responses API 格式 ==========

describe('parseApiResponse - Responses API 格式', () => {
    it('返回 null 当 error 存在', () => {
        expect(openaiResponsesAdapter.parseResponse({ error: 'err' })).toBeNull();
    });

    it('解析 message 类型 output', () => {
        const data = { output: [{ type: 'message', text: 'hi response' }] };
        const result = openaiResponsesAdapter.parseResponse(data);
        expect(result.content).toBe('hi response');
    });

    it('解析 output_text 快捷字段回退', () => {
        const data = { output_text: 'fallback text' };
        const result = openaiResponsesAdapter.parseResponse(data);
        expect(result.content).toBe('fallback text');
    });

    it('返回 null 当没有任何内容', () => {
        expect(openaiResponsesAdapter.parseResponse({ output: [] })).toBeNull();
    });

    it('解析 function_call 工具调用', () => {
        const data = {
            output: [
                {
                    type: 'function_call',
                    call_id: 'call_1',
                    name: 'search',
                    arguments: '{"q":"test"}'
                }
            ]
        };
        const result = openaiResponsesAdapter.parseResponse(data);
        expect(result.hasToolCalls).toBe(true);
        expect(result.toolCalls[0].arguments).toEqual({ q: 'test' });
    });

    it('解析 reasoning 类型 output', () => {
        const data = {
            output: [
                { type: 'reasoning', content: 'think about it' },
                { type: 'message', text: 'done' }
            ]
        };
        const result = openaiResponsesAdapter.parseResponse(data);
        expect(result.thinkingContent).toBe('think about it');
        expect(result.content).toBe('done');
    });

    it('提取 encrypted_content 签名', () => {
        const data = {
            output: [
                {
                    type: 'reasoning',
                    content: 'think',
                    encrypted_content: 'enc_xyz',
                    id: 'ri_1'
                },
                { type: 'message', text: 'answer' }
            ]
        };
        const result = openaiResponsesAdapter.parseResponse(data);
        expect(result.encryptedContent).toBe('enc_xyz');
        expect(result.reasoningItemId).toBe('ri_1');
    });

    it('解析 message.content 数组中的 output_text', () => {
        const data = {
            output: [
                {
                    type: 'message',
                    content: [{ type: 'output_text', text: 'from content array' }]
                }
            ]
        };
        const result = openaiResponsesAdapter.parseResponse(data);
        expect(result.content).toBe('from content array');
    });
});
