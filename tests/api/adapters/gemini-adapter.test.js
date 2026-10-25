/**
 * gemini-adapter.js 测试
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
    state: { xmlToolCallingEnabled: false },
    elements: {}
}));

vi.mock('../../../js/providers/manager.js', () => ({
    getCurrentProvider: vi.fn(() => ({ apiFormat: 'gemini' }))
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

import { geminiAdapter } from '../../../js/api/adapters/gemini-adapter.js';
import { PartType, MediaKind, Role } from '../../../js/messages/schema.js';
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
    getCurrentProvider.mockReturnValue({ apiFormat: 'gemini' });
});

// ========== toGeminiContents ==========

describe('toGeminiContents', () => {
    it('纯文本消息（role 映射）', () => {
        const msgs = [
            newMsg('user', [{ type: PartType.TEXT, text: 'hello' }]),
            newMsg('assistant', [{ type: PartType.TEXT, text: 'hi' }])
        ];
        const out = geminiAdapter.partsToAPIMessages(msgs);
        expect(out).toHaveLength(2);
        expect(out[0]).toEqual({ role: 'user', parts: [{ text: 'hello' }] });
        expect(out[1]).toEqual({ role: 'model', parts: [{ text: 'hi' }] });
    });

    it('过滤 system 消息', () => {
        const msgs = [
            newMsg(Role.SYSTEM, [{ type: PartType.TEXT, text: 'system' }]),
            newMsg('user', [{ type: PartType.TEXT, text: 'hello' }])
        ];
        const out = geminiAdapter.partsToAPIMessages(msgs);
        expect(out).toHaveLength(1);
    });

    it('跳过错误消息', () => {
        const msgs = [
            newMsg('assistant', [{ type: PartType.TEXT, text: 'err' }], {
                error: { message: 'fail' }
            })
        ];
        const out = geminiAdapter.partsToAPIMessages(msgs);
        expect(out).toHaveLength(0);
    });

    it('thinking part 转为 thought:true', () => {
        const msgs = [
            newMsg('assistant', [
                { type: PartType.THINKING, text: '思考中', signature: 'sig_1' },
                { type: PartType.TEXT, text: '回答' }
            ])
        ];
        const out = geminiAdapter.partsToAPIMessages(msgs);
        expect(out[0].parts[0]).toEqual({ text: '思考中', thought: true });
        expect(out[0].parts[1]).toEqual({ text: '回答' });
        expect(out[0].thoughtSignature).toBe('sig_1');
    });

    it('媒体 base64 转为 inlineData', () => {
        const msgs = [
            newMsg('user', [
                {
                    type: PartType.MEDIA,
                    media: MediaKind.IMAGE,
                    url: 'data:image/png;base64,abc123'
                }
            ])
        ];
        const out = geminiAdapter.partsToAPIMessages(msgs);
        expect(out[0].parts[0]).toEqual({
            inlineData: { mimeType: 'image/png', data: 'abc123' }
        });
    });

    it('非 base64 媒体被跳过（源消息全 part 被跳过整条 continue，避免触发 Gemini INVALID_ARGUMENT）', () => {
        const msgs = [
            newMsg('user', [
                { type: PartType.MEDIA, media: MediaKind.IMAGE, url: 'https://img.png' }
            ])
        ];
        const out = geminiAdapter.partsToAPIMessages(msgs);
        expect(out).toHaveLength(0);
    });

    it('文件 base64 转为 inlineData', () => {
        const msgs = [
            newMsg('user', [
                { type: PartType.FILE, name: 'doc.pdf', url: 'data:application/pdf;base64,pdfdata' }
            ])
        ];
        const out = geminiAdapter.partsToAPIMessages(msgs);
        expect(out[0].parts[0]).toEqual({
            inlineData: { mimeType: 'application/pdf', data: 'pdfdata' }
        });
    });

    it('tool_call 转为 functionCall + user functionResponse', () => {
        const msgs = [
            newMsg('assistant', [
                { type: PartType.TEXT, text: '调用' },
                {
                    type: PartType.TOOL_CALL,
                    id: 'tc_1',
                    name: 'search',
                    args: { q: 'test' },
                    result: { content: '找到了' }
                }
            ])
        ];
        const out = geminiAdapter.partsToAPIMessages(msgs);

        // model 消息
        expect(out[0].role).toBe('model');
        expect(out[0].parts[0]).toEqual({ text: '调用' });
        expect(out[0].parts[1].functionCall).toEqual({ name: 'search', args: { q: 'test' } });

        // user functionResponse
        expect(out[1].role).toBe('user');
        expect(out[1].parts[0].functionResponse.name).toBe('search');
        expect(out[1].parts[0].functionResponse.response.result).toBe('找到了');
    });

    it('tool_call 无结果时仍产生占位 user.functionResponse（孤儿 functionCall 会触发 Gemini 400）', () => {
        const msgs = [
            newMsg('assistant', [
                { type: PartType.TOOL_CALL, id: 'tc_1', name: 'fn', args: {}, result: null }
            ])
        ];
        const out = geminiAdapter.partsToAPIMessages(msgs);
        expect(out).toHaveLength(2);
        expect(out[0].role).toBe('model');
        expect(out[1].role).toBe('user');
        expect(out[1].parts[0].functionResponse.name).toBe('fn');
    });

    it('tool_call args 字符串解析为对象', () => {
        const msgs = [
            newMsg('assistant', [
                { type: PartType.TOOL_CALL, id: 'tc_1', name: 'fn', args: '{"a":1}', result: null }
            ])
        ];
        const out = geminiAdapter.partsToAPIMessages(msgs);
        expect(out[0].parts[0].functionCall.args).toEqual({ a: 1 });
    });

    it('tool_call args 无效 JSON 默认空对象', () => {
        const msgs = [
            newMsg('assistant', [
                { type: PartType.TOOL_CALL, id: 'tc_1', name: 'fn', args: 'invalid', result: null }
            ])
        ];
        const out = geminiAdapter.partsToAPIMessages(msgs);
        expect(out[0].parts[0].functionCall.args).toEqual({});
    });

    it('空 parts 添加空文本', () => {
        const msgs = [newMsg('assistant', [])];
        const out = geminiAdapter.partsToAPIMessages(msgs);
        expect(out[0].parts).toEqual([{ text: '' }]);
    });

    it('thoughtSignature 附加到 functionCall', () => {
        const msgs = [
            newMsg('assistant', [
                { type: PartType.THINKING, text: '思考', signature: 'sig_1' },
                { type: PartType.TOOL_CALL, id: 'tc_1', name: 'fn', args: {}, result: null }
            ])
        ];
        const out = geminiAdapter.partsToAPIMessages(msgs);
        expect(out[0].parts[1].functionCall).toBeDefined();
        expect(out[0].parts[1].thoughtSignature).toBe('sig_1');
    });

    it('tool_result 带媒体', () => {
        const msgs = [
            newMsg('assistant', [
                {
                    type: PartType.TOOL_CALL,
                    id: 'tc_1',
                    name: 'gen_image',
                    args: {},
                    result: {
                        content: '生成完成',
                        media: [{ type: MediaKind.IMAGE, url: 'data:image/png;base64,imgdata' }]
                    }
                }
            ])
        ];
        const out = geminiAdapter.partsToAPIMessages(msgs);
        const response = out[1].parts[0].functionResponse.response;
        expect(response.parts).toBeDefined();
        expect(response.parts[0].text).toBe('生成完成');
        expect(response.parts[1].inlineData.data).toBe('imgdata');
    });

    it('tool_result 纯文本 JSON 解析', () => {
        const msgs = [
            newMsg('assistant', [
                {
                    type: PartType.TOOL_CALL,
                    id: 'tc_1',
                    name: 'fn',
                    args: {},
                    result: { content: '{"key":"value"}' }
                }
            ])
        ];
        const out = geminiAdapter.partsToAPIMessages(msgs);
        const response = out[1].parts[0].functionResponse.response;
        expect(response.result).toEqual({ key: 'value' });
    });

    it('tool_result 纯文本非 JSON', () => {
        const msgs = [
            newMsg('assistant', [
                {
                    type: PartType.TOOL_CALL,
                    id: 'tc_1',
                    name: 'fn',
                    args: {},
                    result: { content: 'plain text' }
                }
            ])
        ];
        const out = geminiAdapter.partsToAPIMessages(msgs);
        const response = out[1].parts[0].functionResponse.response;
        expect(response.result).toBe('plain text');
    });
});

// ========== parseApiResponse - Gemini 格式 ==========

describe('parseApiResponse - Gemini 格式', () => {
    it('返回 null 当 error 存在', () => {
        expect(geminiAdapter.parseResponse({ error: 'err' })).toBeNull();
    });

    it('candidates 为空时只带回结束原因', () => {
        expect(geminiAdapter.parseResponse({ candidates: [] })).toEqual({
            content: '',
            stop: null
        });
    });

    it('content.parts 缺失时只带回结束原因', () => {
        expect(geminiAdapter.parseResponse({ candidates: [{ content: {} }] })).toEqual({
            content: '',
            stop: null
        });
    });

    it('prompt 被拦截时带回 blockReason', () => {
        const result = geminiAdapter.parseResponse({
            promptFeedback: { blockReason: 'PROHIBITED_CONTENT', blockReasonMessage: '已拦截' }
        });
        expect(result).toEqual({
            content: '',
            stop: { kind: 'prompt_blocked', reason: 'PROHIBITED_CONTENT', detail: '已拦截' }
        });
    });

    it('候选被安全拦截且没有内容时带回 finishReason', () => {
        const result = geminiAdapter.parseResponse({
            candidates: [{ finishReason: 'SAFETY', finishMessage: '命中安全策略' }]
        });
        expect(result.stop).toEqual({
            kind: 'safety',
            reason: 'SAFETY',
            detail: '命中安全策略'
        });
    });

    it('有内容时附带归一后的结束原因', () => {
        const result = geminiAdapter.parseResponse({
            candidates: [{ content: { parts: [{ text: '截断' }] }, finishReason: 'MAX_TOKENS' }]
        });
        expect(result.content).toBe('截断');
        expect(result.stop).toEqual({ kind: 'max_tokens', reason: 'MAX_TOKENS' });
    });

    it('解析文本 parts', () => {
        const data = { candidates: [{ content: { parts: [{ text: 'hello gemini' }] } }] };
        const result = geminiAdapter.parseResponse(data);
        expect(result.content).toBe('hello gemini');
    });

    it('解析 functionCall (原生工具调用)', () => {
        const data = {
            candidates: [
                {
                    content: {
                        parts: [
                            {
                                functionCall: {
                                    id: 'fc_1',
                                    name: 'search',
                                    args: { q: 'test' }
                                }
                            }
                        ]
                    }
                }
            ]
        };
        const result = geminiAdapter.parseResponse(data);
        expect(result.hasToolCalls).toBe(true);
        expect(result.toolCalls[0].name).toBe('search');
    });

    it('解析 thought parts（思维链）', () => {
        const data = {
            candidates: [
                {
                    content: {
                        parts: [{ text: 'thinking...', thought: true }, { text: 'answer' }]
                    }
                }
            ]
        };
        const result = geminiAdapter.parseResponse(data);
        expect(result.thinkingContent).toBe('thinking...');
        expect(result.content).toBe('answer');
    });

    it('提取 thoughtSignature', () => {
        const data = {
            candidates: [
                {
                    content: {
                        parts: [{ text: 'hi', thoughtSignature: 'sig_abc' }]
                    }
                }
            ]
        };
        const result = geminiAdapter.parseResponse(data);
        expect(result.thoughtSignature).toBe('sig_abc');
    });

    it('提取 inlineData 图片', () => {
        const data = {
            candidates: [
                {
                    content: {
                        parts: [
                            {
                                inlineData: { mimeType: 'image/png', data: 'base64data' }
                            }
                        ]
                    }
                }
            ]
        };
        const result = geminiAdapter.parseResponse(data);
        expect(result.contentParts.some((p) => p.type === 'image_url')).toBe(true);
    });

    it('顶层 reasoning 字段回退', () => {
        const data = {
            candidates: [{ content: { parts: [{ text: 'answer' }] } }],
            reasoning: 'top-level reasoning'
        };
        const result = geminiAdapter.parseResponse(data);
        expect(result.thinkingContent).toBe('top-level reasoning');
    });
});

// ========== Stage 1: XML mode tool_call 跳过 native 输出 ==========

describe('to* 在 part.mode === xml 时跳过 native 工具调用块', () => {
    it('toGeminiContents 跳过 xml mode tool_call，不产生 functionCall/functionResponse', () => {
        const msgs = [
            newMsg('assistant', [
                { type: PartType.TEXT, text: '<tool_use>...</tool_use>' },
                {
                    type: PartType.TOOL_CALL,
                    id: 'tc_1',
                    name: 'fn',
                    args: { a: 1 },
                    state: 'done',
                    result: { content: 'ok' },
                    mode: 'xml'
                }
            ])
        ];
        const out = geminiAdapter.partsToAPIMessages(msgs);
        // model 消息（仅 text part）+ user 消息（<tool_use_result> 由 appendXmlToolResults 追加）
        expect(out).toHaveLength(2);
        expect(out[0].role).toBe('model');
        expect(out[0].parts.every((p) => !p.functionCall)).toBe(true);
        expect(out[1].role).toBe('user');
        expect(out[1].content).toContain('<tool_use_result>');
    });
});

// ========== 格式专属设置与请求定位 ==========

describe('captureFormatSettings', () => {
    const baseState = {
        geminiApiKeyInHeader: false,
        imageSize: '2K',
        geminiSystemPartsEnabled: false,
        geminiSystemParts: []
    };

    it('读取 API Key 传递方式与出图尺寸', () => {
        expect(
            geminiAdapter.captureFormatSettings({
                ...baseState,
                geminiApiKeyInHeader: true,
                imageSize: '4K'
            })
        ).toEqual({ apiKeyInHeader: true, imageSize: '4K', systemParts: null });
    });

    it('出图尺寸缺省为空字符串', () => {
        expect(
            geminiAdapter.captureFormatSettings({ ...baseState, imageSize: undefined }).imageSize
        ).toBe('');
    });

    it('多段 system parts 开启时过滤空段并替换模板变量', () => {
        const settings = geminiAdapter.captureFormatSettings({
            ...baseState,
            geminiSystemPartsEnabled: true,
            geminiSystemParts: [{ text: 'P1 {{char}}' }, { text: '   ' }, { text: 'P2' }]
        });
        expect(settings.systemParts).toEqual([{ text: 'P1 Assistant' }, { text: 'P2' }]);
    });

    it('开关关闭或全为空段时 systemParts 为 null', () => {
        expect(
            geminiAdapter.captureFormatSettings({
                ...baseState,
                geminiSystemParts: [{ text: 'P1' }]
            }).systemParts
        ).toBeNull();
        expect(
            geminiAdapter.captureFormatSettings({
                ...baseState,
                geminiSystemPartsEnabled: true,
                geminiSystemParts: [{ text: '' }]
            }).systemParts
        ).toBeNull();
    });
});

describe('API Key 传递与端点', () => {
    const profile = (overrides = {}) => ({
        streamEnabled: true,
        providerApiFormat: 'gemini',
        formatSettings: { apiKeyInHeader: false, imageSize: '', systemParts: null },
        ...overrides
    });

    it('query 模式：key 放在 URL，流式追加 alt=sse', () => {
        const requestProfile = profile();
        expect(geminiAdapter.buildHeaders('k1', { requestProfile })).toEqual({});
        expect(geminiAdapter.buildQueryString('k1', { requestProfile })).toBe('key=k1&alt=sse');
        expect(
            geminiAdapter.buildQueryString('k1', {
                requestProfile: profile({ streamEnabled: false })
            })
        ).toBe('key=k1');
    });

    it('header 模式：key 放在 x-goog-api-key，URL 只保留 alt=sse', () => {
        const formatSettings = { apiKeyInHeader: true, imageSize: '', systemParts: null };
        expect(
            geminiAdapter.buildHeaders('k1', { requestProfile: profile({ formatSettings }) })
        ).toEqual({ 'x-goog-api-key': 'k1' });
        expect(
            geminiAdapter.buildQueryString('k1', { requestProfile: profile({ formatSettings }) })
        ).toBe('alt=sse');
        expect(
            geminiAdapter.buildQueryString('k1', {
                requestProfile: profile({ formatSettings, streamEnabled: false })
            })
        ).toBe('');
    });

    it('原生 Gemini provider 拼接 models 路径并清理其他格式残留', () => {
        expect(
            geminiAdapter.resolveEndpoint(
                'https://example.com/v1/chat/completions',
                'gemini-3.8-flash',
                true,
                {},
                { requestProfile: profile() }
            )
        ).toBe('https://example.com/v1beta/models/gemini-3.8-flash:streamGenerateContent');
        expect(
            geminiAdapter.resolveEndpoint(
                'https://example.com/',
                'gemini-3.8-flash',
                false,
                {},
                {
                    requestProfile: profile()
                }
            )
        ).toBe('https://example.com/v1beta/models/gemini-3.8-flash:generateContent');
    });

    it('统一代理 provider 保持原端点，不读取当前全局 provider', () => {
        getCurrentProvider.mockReturnValue({ apiFormat: 'gemini' });
        expect(
            geminiAdapter.resolveEndpoint(
                'https://proxy.example.com/v1/chat/completions/',
                'gemini-3.8-flash',
                true,
                {},
                { requestProfile: profile({ providerApiFormat: 'openai' }) }
            )
        ).toBe('https://proxy.example.com/v1/chat/completions');
    });
});
