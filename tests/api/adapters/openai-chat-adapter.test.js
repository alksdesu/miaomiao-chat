/**
 * openai-chat-adapter.js 测试
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
    getCurrentProvider: vi.fn(() => ({ apiFormat: 'openai' }))
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

import { openaiChatAdapter } from '../../../js/api/adapters/openai-chat-adapter.js';
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
    getCurrentProvider.mockReturnValue({ apiFormat: 'openai' });
});

// ========== toOpenAIMessages ==========

describe('toOpenAIMessages', () => {
    it('转换纯文本消息', () => {
        const msgs = [
            newMsg('user', [{ type: PartType.TEXT, text: 'hello' }]),
            newMsg('assistant', [{ type: PartType.TEXT, text: 'hi' }])
        ];
        const out = openaiChatAdapter.partsToAPIMessages(msgs);
        expect(out).toHaveLength(2);
        expect(out[0]).toEqual({ role: 'user', content: 'hello' });
        expect(out[1]).toEqual({ role: 'assistant', content: 'hi' });
    });

    it('多个文本 part 合并为数组', () => {
        const msgs = [
            newMsg('user', [
                { type: PartType.TEXT, text: 'a' },
                { type: PartType.TEXT, text: 'b' }
            ])
        ];
        const out = openaiChatAdapter.partsToAPIMessages(msgs);
        expect(out[0].content).toEqual([
            { type: 'text', text: 'a' },
            { type: 'text', text: 'b' }
        ]);
    });

    it('跳过错误消息', () => {
        const msgs = [
            newMsg('assistant', [{ type: PartType.TEXT, text: 'ok' }]),
            newMsg('assistant', [{ type: PartType.TEXT, text: 'err' }], {
                error: { message: 'fail' }
            }),
            newMsg('assistant', [{ type: PartType.TEXT, text: 'err2' }], {
                error: { message: 'fail again' }
            })
        ];
        const out = openaiChatAdapter.partsToAPIMessages(msgs);
        expect(out).toHaveLength(1);
        expect(out[0].content).toBe('ok');
    });

    it('thinking part 被忽略', () => {
        const msgs = [
            newMsg('assistant', [
                { type: PartType.THINKING, text: '思考中', signature: 'sig' },
                { type: PartType.TEXT, text: '回答' }
            ])
        ];
        const out = openaiChatAdapter.partsToAPIMessages(msgs);
        expect(out[0].content).toBe('回答');
    });

    it('图片媒体转为 image_url', () => {
        const msgs = [
            newMsg('user', [
                { type: PartType.MEDIA, media: MediaKind.IMAGE, url: 'https://img.png' }
            ])
        ];
        const out = openaiChatAdapter.partsToAPIMessages(msgs);
        expect(out[0].content).toEqual([
            { type: 'image_url', image_url: { url: 'https://img.png' } }
        ]);
    });

    it('视频媒体转为 video_url', () => {
        const msgs = [
            newMsg('user', [
                {
                    type: PartType.MEDIA,
                    media: MediaKind.VIDEO,
                    url: 'https://vid.mp4',
                    mime: 'video/mp4'
                }
            ])
        ];
        const out = openaiChatAdapter.partsToAPIMessages(msgs);
        expect(out[0].content).toEqual([
            { type: 'video_url', video_url: { url: 'https://vid.mp4', mime_type: 'video/mp4' } }
        ]);
    });

    it('音频媒体转为 input_audio (base64)', () => {
        const msgs = [
            newMsg('user', [
                { type: PartType.MEDIA, media: MediaKind.AUDIO, url: 'data:audio/wav;base64,AAAA' }
            ])
        ];
        const out = openaiChatAdapter.partsToAPIMessages(msgs);
        expect(out[0].content).toEqual([
            { type: 'input_audio', input_audio: { data: 'AAAA', format: 'wav' } }
        ]);
    });

    it('音频非 base64 格式被跳过', () => {
        const msgs = [
            newMsg('user', [
                { type: PartType.MEDIA, media: MediaKind.AUDIO, url: 'https://audio.mp3' }
            ])
        ];
        const out = openaiChatAdapter.partsToAPIMessages(msgs);
        // 音频非 base64，parseDataURL 返回 null，不会添加到 contentItems
        expect(out[0].content).toBe('');
    });

    it('文件 part 转为 file', () => {
        const msgs = [
            newMsg('user', [
                { type: PartType.FILE, name: 'doc.pdf', url: 'data:application/pdf;base64,abc' }
            ])
        ];
        const out = openaiChatAdapter.partsToAPIMessages(msgs);
        expect(out[0].content).toEqual([
            {
                type: 'file',
                file: { filename: 'doc.pdf', file_data: 'data:application/pdf;base64,abc' }
            }
        ]);
    });

    it('tool_call 拆分为 assistant.tool_calls + tool 消息', () => {
        const msgs = [
            newMsg('assistant', [
                { type: PartType.TEXT, text: '调用工具' },
                {
                    type: PartType.TOOL_CALL,
                    id: 'tc_1',
                    name: 'search',
                    args: { q: 'test' },
                    result: { content: '找到了' }
                }
            ])
        ];
        const out = openaiChatAdapter.partsToAPIMessages(msgs);
        // assistant 消息（tool_call_id 走 getMappedId(p,'openai')，mock 返回 'openai_tc_1'）
        expect(out[0].role).toBe('assistant');
        expect(out[0].tool_calls).toHaveLength(1);
        expect(out[0].tool_calls[0].id).toBe('openai_tc_1');
        expect(out[0].tool_calls[0].type).toBe('function');
        expect(out[0].tool_calls[0].function.name).toBe('search');
        expect(JSON.parse(out[0].tool_calls[0].function.arguments)).toEqual({ q: 'test' });

        // tool 结果消息（tool_call_id 同走 getMappedId 保证配对）
        expect(out[1].role).toBe('tool');
        expect(out[1].tool_call_id).toBe('openai_tc_1');
        expect(out[1].content).toBe('找到了');
        expect(out[1]._toolName).toBe('search');
    });

    it('tool_call args 为字符串时直接使用', () => {
        const msgs = [
            newMsg('assistant', [
                { type: PartType.TOOL_CALL, id: 'tc_1', name: 'fn', args: '{"a":1}', result: null }
            ])
        ];
        const out = openaiChatAdapter.partsToAPIMessages(msgs);
        expect(out[0].tool_calls[0].function.arguments).toBe('{"a":1}');
    });

    it('tool_call 无结果时仍产生占位 tool 消息（孤儿 tool_use 会触发 OpenAI 400）', () => {
        const msgs = [
            newMsg('assistant', [
                { type: PartType.TOOL_CALL, id: 'tc_1', name: 'fn', args: {}, result: null }
            ])
        ];
        const out = openaiChatAdapter.partsToAPIMessages(msgs);
        expect(out).toHaveLength(2);
        expect(out[0].role).toBe('assistant');
        expect(out[0].tool_calls).toHaveLength(1);
        expect(out[1].role).toBe('tool');
        expect(out[1].content).toBe('Tool execution was interrupted');
    });

    it('tool_call result.content 为对象时 JSON.stringify', () => {
        const msgs = [
            newMsg('assistant', [
                {
                    type: PartType.TOOL_CALL,
                    id: 'tc_1',
                    name: 'fn',
                    args: {},
                    result: { content: { data: 123 } }
                }
            ])
        ];
        const out = openaiChatAdapter.partsToAPIMessages(msgs);
        expect(out[1].content).toBe('{"data":123}');
    });

    it('空 parts 产生空 content', () => {
        const msgs = [newMsg('assistant', [])];
        const out = openaiChatAdapter.partsToAPIMessages(msgs);
        expect(out[0].content).toBe('');
    });
});

// ========== parseApiResponse - OpenAI 格式 ==========

describe('parseApiResponse - OpenAI 格式', () => {
    it('返回 null 当 choices 缺失', () => {
        expect(openaiChatAdapter.parseResponse({})).toBeNull();
    });

    it('返回 null 当 choices 为空数组', () => {
        expect(openaiChatAdapter.parseResponse({ choices: [] })).toBeNull();
    });

    it('解析字符串 content', () => {
        const data = { choices: [{ message: { content: 'Hello world' } }] };
        const result = openaiChatAdapter.parseResponse(data);
        expect(result.content).toBe('Hello world');
    });

    it('解析数组 content 中的 text 部分', () => {
        const data = {
            choices: [{ message: { content: [{ type: 'text', text: 'test text' }] } }]
        };
        const result = openaiChatAdapter.parseResponse(data);
        expect(result.content).toContain('test text');
    });

    it('返回 null 当 content 为 null 且无 image', () => {
        const data = { choices: [{ message: { content: null } }] };
        expect(openaiChatAdapter.parseResponse(data)).toBeNull();
    });

    it('解析 message.image 回退', () => {
        const data = {
            choices: [{ message: { content: null, image: 'https://img.example.com/1.png' } }]
        };
        const result = openaiChatAdapter.parseResponse(data);
        expect(result).not.toBeNull();
        expect(result.contentParts.some((p) => p.url === 'https://img.example.com/1.png')).toBe(
            true
        );
    });

    it('检测原生 tool_calls（非 XML 模式）', () => {
        const data = {
            choices: [
                {
                    message: {
                        content: '',
                        tool_calls: [
                            {
                                id: 'tc_1',
                                function: { name: 'search', arguments: '{"q":"test"}' }
                            }
                        ]
                    },
                    finish_reason: 'tool_calls'
                }
            ]
        };
        const result = openaiChatAdapter.parseResponse(data);
        expect(result.hasToolCalls).toBe(true);
        expect(result.toolCalls).toHaveLength(1);
        expect(result.toolCalls[0].name).toBe('search');
        expect(result.toolCalls[0].arguments).toEqual({ q: 'test' });
    });

    it('tool_calls 参数解析失败时回退为空对象', () => {
        const data = {
            choices: [
                {
                    message: {
                        content: '',
                        tool_calls: [
                            { id: 'tc_1', function: { name: 'fn', arguments: 'not-json' } }
                        ]
                    },
                    finish_reason: 'tool_calls'
                }
            ]
        };
        const result = openaiChatAdapter.parseResponse(data);
        expect(result.toolCalls[0].arguments).toEqual({});
    });

    it('原生 reasoning_content 优先于 <think> 标签', () => {
        const data = {
            choices: [
                {
                    message: {
                        content: 'answer',
                        reasoning_content: 'native reasoning'
                    }
                }
            ]
        };
        const result = openaiChatAdapter.parseResponse(data);
        expect(result.thinkingContent).toBe('native reasoning');
    });

    it('解析 content 数组中的 image_url', () => {
        const data = {
            choices: [
                {
                    message: {
                        content: [
                            { type: 'text', text: 'look' },
                            { type: 'image_url', image_url: { url: 'https://img/1.png' } }
                        ]
                    }
                }
            ]
        };
        const result = openaiChatAdapter.parseResponse(data);
        expect(result.contentParts.some((p) => p.type === 'image_url')).toBe(true);
    });
});

// ========== Stage 1: XML mode tool_call 跳过 native 输出 ==========

describe('to* 在 part.mode === xml 时跳过 native 工具调用块', () => {
    it('toOpenAIMessages 跳过 xml mode tool_call，不产生 tool_calls/tool 消息', () => {
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
        const out = openaiChatAdapter.partsToAPIMessages(msgs);
        // assistant 消息（无 tool_calls 字段）+ user 消息（<tool_use_result> 由 appendXmlToolResults 追加）
        expect(out).toHaveLength(2);
        expect(out[0].role).toBe('assistant');
        expect(out[0].tool_calls).toBeUndefined();
        expect(out[0].content).toContain('<tool_use>');
        expect(out[1].role).toBe('user');
        expect(out[1].content).toContain('<tool_use_result>');
    });

    it('native mode tool_call 行为不变 (回归用例)', () => {
        const msgs = [
            newMsg('assistant', [
                { type: PartType.TEXT, text: '调用' },
                {
                    type: PartType.TOOL_CALL,
                    id: 'tc_1',
                    name: 'fn',
                    args: { a: 1 },
                    state: 'done',
                    result: { content: 'ok' },
                    mode: 'native'
                }
            ])
        ];
        const out = openaiChatAdapter.partsToAPIMessages(msgs);
        // assistant + tool 两条消息
        expect(out).toHaveLength(2);
        expect(out[0].tool_calls).toHaveLength(1);
        expect(out[1].role).toBe('tool');
    });

    it('缺失 mode 字段视为 native (历史消息兼容)', () => {
        const msgs = [
            newMsg('assistant', [
                {
                    type: PartType.TOOL_CALL,
                    id: 'tc_1',
                    name: 'fn',
                    args: { a: 1 },
                    state: 'done',
                    result: { content: 'ok' }
                    // 无 mode 字段
                }
            ])
        ];
        const out = openaiChatAdapter.partsToAPIMessages(msgs);
        // 缺失 mode 不触发 XML 跳过，正常产生 tool_calls
        expect(out[0].tool_calls).toHaveLength(1);
    });
});
