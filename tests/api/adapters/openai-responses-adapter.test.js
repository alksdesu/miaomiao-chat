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
import { PartType, MediaKind } from '../../../js/messages/schema.js';
import { resolveModelProfile } from '../../../js/api/model-profiles.js';
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

// ========== Responses 输入项格式 ==========

describe('partsToAPIMessages 输入项格式', () => {
    const phaseProfile = resolveModelProfile('openai-responses', 'gpt-5.5');
    const toolPart = (id, turn, extra = {}) => ({
        type: PartType.TOOL_CALL,
        id,
        name: 'get_weather',
        args: { city: 'Paris' },
        state: 'done',
        result: { content: 'Sunny' },
        responseItemId: `fc_${id}`,
        call_id: `call_${id}`,
        ...(turn ? { _turn: turn } : {}),
        ...extra
    });

    it('user 消息使用 input_text / input_image / input_file', () => {
        const out = openaiResponsesAdapter.partsToAPIMessages([
            newMsg('user', [
                { type: PartType.TEXT, text: '看图' },
                { type: PartType.MEDIA, media: MediaKind.IMAGE, url: 'data:image/png;base64,AAAA' },
                {
                    type: PartType.FILE,
                    name: 'a.pdf',
                    url: 'data:application/pdf;base64,JVBE',
                    encoding: 'base64'
                }
            ])
        ]);
        expect(out).toEqual([
            {
                role: 'user',
                content: [
                    { type: 'input_text', text: '看图' },
                    { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
                    {
                        type: 'input_file',
                        filename: 'a.pdf',
                        file_data: 'data:application/pdf;base64,JVBE'
                    }
                ]
            }
        ]);
    });

    it('只有一段文本时简化为字符串', () => {
        expect(
            openaiResponsesAdapter.partsToAPIMessages([
                newMsg('user', [{ type: PartType.TEXT, text: 'hi' }])
            ])
        ).toEqual([{ role: 'user', content: 'hi' }]);
    });

    it('assistant 消息只回放文本，生成的图片不进入输入', () => {
        const out = openaiResponsesAdapter.partsToAPIMessages([
            newMsg('assistant', [
                { type: PartType.TEXT, text: '这是图' },
                { type: PartType.MEDIA, media: MediaKind.IMAGE, url: 'data:image/png;base64,AAAA' },
                { type: PartType.TEXT, text: '还有说明' }
            ])
        ]);
        expect(out).toEqual([{ role: 'assistant', content: '这是图\n\n还有说明' }]);
    });

    it('支持 phase 的型号按轮次标注前言与最终回答', () => {
        const msg = newMsg(
            'assistant',
            [
                { type: PartType.TEXT, text: '我先查一下天气' },
                toolPart('w1'),
                { type: PartType.TEXT, text: '巴黎晴', _turn: 1 }
            ],
            {
                meta: {
                    raw: {
                        openai: {
                            reasoningItems: [
                                { id: 'rs_1', encrypted_content: 'enc_1', summary: [] }
                            ]
                        }
                    }
                }
            }
        );
        const out = openaiResponsesAdapter.partsToAPIMessages([msg], { profile: phaseProfile });
        expect(out).toEqual([
            { type: 'reasoning', id: 'rs_1', encrypted_content: 'enc_1', summary: [] },
            { role: 'assistant', content: '我先查一下天气', phase: 'commentary' },
            {
                type: 'function_call',
                id: 'fc_w1',
                call_id: 'call_w1',
                name: 'get_weather',
                arguments: '{"city":"Paris"}'
            },
            { type: 'function_call_output', call_id: 'call_w1', output: 'Sunny' },
            { role: 'assistant', content: '巴黎晴', phase: 'final_answer' }
        ]);
    });

    it('不支持 phase 的型号不带 phase 字段', () => {
        const out = openaiResponsesAdapter.partsToAPIMessages(
            [newMsg('assistant', [{ type: PartType.TEXT, text: '回答' }])],
            { profile: resolveModelProfile('openai-responses', 'my-proxy-model') }
        );
        expect(out).toEqual([{ role: 'assistant', content: '回答' }]);
    });

    it('只有 id 的推理项无法回放：跳过推理项且同轮 function_call 不带 item id', () => {
        const msg = newMsg('assistant', [toolPart('w1')], {
            meta: { raw: { openai: { reasoningItems: [{ id: 'rs_1', summary: [] }] } } }
        });
        const out = openaiResponsesAdapter.partsToAPIMessages([msg]);
        expect(out.some((item) => item.type === 'reasoning')).toBe(false);
        expect(out[0]).toEqual({
            type: 'function_call',
            call_id: 'call_w1',
            name: 'get_weather',
            arguments: '{"city":"Paris"}'
        });
    });

    it('没有文本的 assistant 轮次不产生空消息', () => {
        const out = openaiResponsesAdapter.partsToAPIMessages([
            newMsg('assistant', [
                { type: PartType.MEDIA, media: MediaKind.IMAGE, url: 'data:image/png;base64,AAAA' }
            ])
        ]);
        expect(out).toEqual([]);
    });
});

describe('Responses 请求体与内置工具', () => {
    it('内置工具使用服务端原生工具', () => {
        expect(
            openaiResponsesAdapter.collectBuiltinTools({
                codeExecutionEnabled: true,
                webSearchEnabled: true
            })
        ).toEqual([
            { type: 'code_interpreter', container: { type: 'auto' } },
            { type: 'web_search' }
        ]);
    });

    it('XML 模式下不附带服务端工具', () => {
        expect(
            openaiResponsesAdapter.collectBuiltinTools({
                codeExecutionEnabled: true,
                webSearchEnabled: true,
                xmlToolCallingEnabled: true
            })
        ).toEqual([]);
    });

    it('不在服务端保存对话，并请求加密推理内容', () => {
        const body = openaiResponsesAdapter.buildRequestBody({
            messages: [{ role: 'user', content: 'hi' }],
            model: 'gpt-5.5',
            modelParams: {},
            thinkingCfg: null,
            verbosityCfg: null,
            systemCtx: {},
            prefill: null,
            tools: [],
            isXmlMode: false,
            profile: resolveModelProfile('openai-responses', 'gpt-5.5'),
            notices: [],
            state: { streamEnabled: true }
        });
        expect(body.store).toBe(false);
        expect(body.include).toEqual(['reasoning.encrypted_content']);
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

    it('没有任何内容时只带回结束原因', () => {
        expect(openaiResponsesAdapter.parseResponse({ output: [] })).toEqual({
            content: '',
            stop: null
        });
    });

    it('推理耗尽 max_output_tokens 时带回原因', () => {
        const result = openaiResponsesAdapter.parseResponse({
            status: 'incomplete',
            incomplete_details: { reason: 'max_output_tokens' },
            output: [{ type: 'reasoning', id: 'rs_1', summary: [] }]
        });
        expect(result).toEqual({
            content: '',
            stop: { kind: 'max_tokens', reason: 'max_output_tokens' }
        });
    });

    it('incomplete 时不执行被截断的函数调用', () => {
        const result = openaiResponsesAdapter.parseResponse({
            status: 'incomplete',
            incomplete_details: { reason: 'max_output_tokens' },
            output: [{ type: 'function_call', call_id: 'c1', name: 'search', arguments: '{"q":' }]
        });
        expect(result.hasToolCalls).toBeUndefined();
        expect(result.stop.kind).toBe('max_tokens');
    });

    it('拒答内容按正文返回并标记 refusal', () => {
        const result = openaiResponsesAdapter.parseResponse({
            status: 'completed',
            output: [
                {
                    type: 'message',
                    content: [{ type: 'refusal', refusal: '无法协助' }]
                }
            ]
        });
        expect(result.content).toBe('无法协助');
        expect(result.stop).toEqual({ kind: 'refusal', reason: 'refusal' });
    });

    it('completed 时附带正常结束原因', () => {
        const result = openaiResponsesAdapter.parseResponse({
            status: 'completed',
            output: [{ type: 'message', content: [{ type: 'output_text', text: 'hi' }] }]
        });
        expect(result.stop).toEqual({ kind: 'end', reason: 'completed' });
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
