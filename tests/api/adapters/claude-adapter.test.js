/**
 * claude-adapter.js 测试
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
    getCurrentProvider: vi.fn(() => ({ apiFormat: 'claude' }))
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

import { claudeAdapter } from '../../../js/api/adapters/claude-adapter.js';
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
    getCurrentProvider.mockReturnValue({ apiFormat: 'claude' });
});

// ========== toClaudeMessages ==========

describe('toClaudeMessages', () => {
    it('纯文本消息简化为字符串', () => {
        const msgs = [
            newMsg('user', [{ type: PartType.TEXT, text: 'hello' }]),
            newMsg('assistant', [{ type: PartType.TEXT, text: 'hi' }])
        ];
        const out = claudeAdapter.partsToAPIMessages(msgs);
        expect(out).toHaveLength(2);
        expect(out[0]).toEqual({ role: 'user', content: 'hello' });
        expect(out[1]).toEqual({ role: 'assistant', content: 'hi' });
    });

    it('过滤 system 消息', () => {
        const msgs = [
            newMsg(Role.SYSTEM, [{ type: PartType.TEXT, text: 'system' }]),
            newMsg('user', [{ type: PartType.TEXT, text: 'hello' }])
        ];
        const out = claudeAdapter.partsToAPIMessages(msgs);
        expect(out).toHaveLength(1);
        expect(out[0].role).toBe('user');
    });

    it('跳过错误消息', () => {
        const msgs = [
            newMsg('assistant', [{ type: PartType.TEXT, text: 'err' }], {
                error: { message: 'fail' }
            })
        ];
        const out = claudeAdapter.partsToAPIMessages(msgs);
        expect(out).toHaveLength(0);
    });

    it('thinking part 带签名时转换', () => {
        const msgs = [
            newMsg('assistant', [
                { type: PartType.THINKING, text: '思考', signature: 'sig_1' },
                { type: PartType.TEXT, text: '回答' }
            ])
        ];
        const out = claudeAdapter.partsToAPIMessages(msgs);
        expect(out[0].content).toEqual([
            { type: 'thinking', thinking: '思考', signature: 'sig_1' },
            { type: 'text', text: '回答' }
        ]);
    });

    it('thinking part 无签名时被跳过', () => {
        const msgs = [
            newMsg('assistant', [
                { type: PartType.THINKING, text: '思考' },
                { type: PartType.TEXT, text: '回答' }
            ])
        ];
        const out = claudeAdapter.partsToAPIMessages(msgs);
        expect(out[0].content).toBe('回答');
    });

    it('图片 base64 转为 Claude image source', () => {
        const msgs = [
            newMsg('user', [
                {
                    type: PartType.MEDIA,
                    media: MediaKind.IMAGE,
                    url: 'data:image/png;base64,abc123'
                }
            ])
        ];
        const out = claudeAdapter.partsToAPIMessages(msgs);
        expect(out[0].content).toEqual([
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc123' } }
        ]);
    });

    it('图片非 base64 降级为文本占位（单条简化为字符串）', () => {
        const msgs = [
            newMsg('user', [
                { type: PartType.MEDIA, media: MediaKind.IMAGE, url: 'https://img.png' }
            ])
        ];
        const out = claudeAdapter.partsToAPIMessages(msgs);
        // 单条 text 被简化为字符串
        expect(out[0].content).toBe('[图片附件无法发送：仅支持 base64 格式]');
    });

    it('视频添加文本占位（单条简化为字符串）', () => {
        const msgs = [
            newMsg('user', [
                { type: PartType.MEDIA, media: MediaKind.VIDEO, url: 'data:video/mp4;base64,xxx' }
            ])
        ];
        const out = claudeAdapter.partsToAPIMessages(msgs);
        expect(out[0].content).toBe('[视频附件已省略]');
    });

    it('音频添加文本占位（单条简化为字符串）', () => {
        const msgs = [
            newMsg('user', [
                { type: PartType.MEDIA, media: MediaKind.AUDIO, url: 'data:audio/wav;base64,xxx' }
            ])
        ];
        const out = claudeAdapter.partsToAPIMessages(msgs);
        expect(out[0].content).toBe('[音频附件已省略]');
    });

    it('PDF 文件转为 document', () => {
        const msgs = [
            newMsg('user', [
                {
                    type: PartType.FILE,
                    name: 'doc.pdf',
                    mime: 'application/pdf',
                    url: 'data:application/pdf;base64,pdfdata'
                }
            ])
        ];
        const out = claudeAdapter.partsToAPIMessages(msgs);
        expect(out[0].content).toEqual([
            {
                type: 'document',
                source: { type: 'base64', media_type: 'application/pdf', data: 'pdfdata' }
            }
        ]);
    });

    it('非 PDF 二进制文件也转为 document（Claude 4 支持多 mime）', () => {
        const msgs = [
            newMsg('user', [
                {
                    type: PartType.FILE,
                    name: 'doc.txt',
                    mime: 'text/plain',
                    url: 'data:text/plain;base64,abc'
                }
            ])
        ];
        const out = claudeAdapter.partsToAPIMessages(msgs);
        expect(out[0].content).toEqual([
            { type: 'document', source: { type: 'base64', media_type: 'text/plain', data: 'abc' } }
        ]);
    });

    it('tool_call 拆分为 assistant content + user tool_result', () => {
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
        const out = claudeAdapter.partsToAPIMessages(msgs);

        // assistant 消息包含 text + tool_use
        expect(out[0].role).toBe('assistant');
        expect(out[0].content).toEqual([
            { type: 'text', text: '调用' },
            { type: 'tool_use', id: 'claude_tc_1', name: 'search', input: { q: 'test' } }
        ]);

        // user 消息包含 tool_result
        expect(out[1].role).toBe('user');
        expect(out[1].content[0].type).toBe('tool_result');
        expect(out[1].content[0].tool_use_id).toBe('claude_tc_1');
        expect(out[1].content[0].content).toBe('找到了');
    });

    it('tool_call 无结果时仍产生占位 user.tool_result（孤儿 tool_use 会触发 Claude 400）', () => {
        const msgs = [
            newMsg('assistant', [
                { type: PartType.TOOL_CALL, id: 'tc_1', name: 'fn', args: {}, result: null }
            ])
        ];
        const out = claudeAdapter.partsToAPIMessages(msgs);
        expect(out).toHaveLength(2);
        expect(out[0].role).toBe('assistant');
        expect(out[1].role).toBe('user');
        expect(out[1].content[0].type).toBe('tool_result');
        expect(out[1].content[0].content).toBe('Tool execution was interrupted');
    });

    it('server tool 转为 server_tool_use', () => {
        const msgs = [
            newMsg('assistant', [
                {
                    type: PartType.TOOL_CALL,
                    id: 'tc_1',
                    name: 'web_search',
                    args: { query: 'test' },
                    server: true,
                    result: { type: 'web_search_tool_result', content: [{ url: 'x' }] }
                }
            ])
        ];
        const out = claudeAdapter.partsToAPIMessages(msgs);
        expect(out[0].content[0].type).toBe('server_tool_use');
        expect(out[0].content[0].name).toBe('web_search');
        expect(out[0].content[1].type).toBe('web_search_tool_result');
    });

    it('tool_call args 字符串解析为对象', () => {
        const msgs = [
            newMsg('assistant', [
                { type: PartType.TOOL_CALL, id: 'tc_1', name: 'fn', args: '{"a":1}', result: null }
            ])
        ];
        const out = claudeAdapter.partsToAPIMessages(msgs);
        const toolUse = out[0].content.find((c) => c.type === 'tool_use');
        expect(toolUse.input).toEqual({ a: 1 });
    });

    it('tool_call args 无效 JSON 保持原值', () => {
        const msgs = [
            newMsg('assistant', [
                {
                    type: PartType.TOOL_CALL,
                    id: 'tc_1',
                    name: 'fn',
                    args: 'invalid json',
                    result: null
                }
            ])
        ];
        const out = claudeAdapter.partsToAPIMessages(msgs);
        const toolUse = out[0].content.find((c) => c.type === 'tool_use');
        expect(toolUse.input).toBe('invalid json');
    });

    it('空 parts 添加空文本', () => {
        const msgs = [newMsg('assistant', [])];
        const out = claudeAdapter.partsToAPIMessages(msgs);
        expect(out[0].content).toBe('');
    });

    it('_turn 标记的 continuation 消息按轮拆成独立 assistant + user(tool_result) 序列', () => {
        // 模拟 mergeContinuation 合并后的消息：第一轮 thinking_A + tool_use_X，第二轮 thinking_B + text_Y
        const msgs = [
            newMsg('user', [{ type: PartType.TEXT, text: 'q' }]),
            newMsg('assistant', [
                { type: PartType.THINKING, text: 'thinking_A', signature: 'sig_A' },
                { type: PartType.THINKING, text: 'thinking_B', signature: 'sig_B', _turn: 1 },
                { type: PartType.TEXT, text: 'final answer', _turn: 1 },
                {
                    type: PartType.TOOL_CALL,
                    id: 'tc_X',
                    name: 'search',
                    args: {},
                    result: { content: 'found' }
                }
            ])
        ];
        const out = claudeAdapter.partsToAPIMessages(msgs);
        // 应拆出: user, assistant(turn0), user(tool_result), assistant(turn1)
        expect(out).toHaveLength(4);
        expect(out[0].role).toBe('user');
        expect(out[1].role).toBe('assistant');
        expect(out[1].content[0].type).toBe('thinking');
        expect(out[1].content[0].thinking).toBe('thinking_A');
        expect(out[1].content[1].type).toBe('tool_use');
        expect(out[2].role).toBe('user');
        expect(out[2].content[0].type).toBe('tool_result');
        expect(out[2].content[0].content).toBe('found');
        expect(out[3].role).toBe('assistant');
        expect(out[3].content[0].type).toBe('thinking');
        expect(out[3].content[0].thinking).toBe('thinking_B');
        expect(out[3].content[1].type).toBe('text');
    });

    it('redacted_thinking part 转为 Claude redacted_thinking block', () => {
        const msgs = [
            newMsg('assistant', [
                {
                    type: PartType.THINKING,
                    text: '',
                    redacted: true,
                    data: 'encrypted_payload_abc'
                },
                { type: PartType.TEXT, text: 'visible answer' }
            ])
        ];
        const out = claudeAdapter.partsToAPIMessages(msgs);
        expect(out).toHaveLength(1);
        const content = out[0].content;
        expect(Array.isArray(content)).toBe(true);
        expect(content[0]).toEqual({ type: 'redacted_thinking', data: 'encrypted_payload_abc' });
        expect(content[1]).toEqual({ type: 'text', text: 'visible answer' });
    });

    it('_edited 标记的 thinking 不发往 Claude API（用户编辑后丢失原 signature）', () => {
        const msgs = [
            newMsg('assistant', [
                {
                    type: PartType.THINKING,
                    text: 'edited thinking content',
                    _edited: true
                },
                { type: PartType.TEXT, text: 'answer' }
            ])
        ];
        const out = claudeAdapter.partsToAPIMessages(msgs);
        const content = out[0].content;
        // _edited thinking 应该被跳过，content 只剩 text
        if (Array.isArray(content)) {
            expect(content.find((c) => c.type === 'thinking')).toBeUndefined();
            expect(content.find((c) => c.type === 'redacted_thinking')).toBeUndefined();
        } else {
            // 单 text part 简化为字符串
            expect(content).toBe('answer');
        }
    });

    it('旧 merged 消息（无 _turn 标记）多 thinking 启发式降级，只保留最后一个 thinking', () => {
        const msgs = [
            newMsg('assistant', [
                { type: PartType.THINKING, text: 'old_A', signature: 'sig_A' },
                { type: PartType.THINKING, text: 'old_B', signature: 'sig_B' },
                { type: PartType.TEXT, text: 'answer' }
            ])
        ];
        const out = claudeAdapter.partsToAPIMessages(msgs);
        // 单 assistant 消息，只保留最后一个 thinking
        expect(out).toHaveLength(1);
        const thinkings = out[0].content.filter((c) => c.type === 'thinking');
        expect(thinkings).toHaveLength(1);
        expect(thinkings[0].thinking).toBe('old_B');
    });

    it('tool_result 带媒体返回数组', () => {
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
        const out = claudeAdapter.partsToAPIMessages(msgs);
        const toolResult = out[1].content[0];
        expect(toolResult.type).toBe('tool_result');
        expect(Array.isArray(toolResult.content)).toBe(true);
        expect(toolResult.content[0].type).toBe('text');
        expect(toolResult.content[1].type).toBe('image');
    });
});

// ========== Stage 5a tool_result is_error transparent transmission ==========

describe('Stage 5a tool_result is_error transparent transmission', () => {
    it('adds is_error:true to tool_result block when part.state===error && part.result.is_error===true', () => {
        // 老化/迁移孤儿场景：part.state=error + result.is_error=true 必须透传到 Claude API
        // tool_result block 上，触发 Anthropic 错误恢复路径
        const msgs = [
            newMsg('assistant', [
                {
                    type: PartType.TOOL_CALL,
                    id: 'tc_err',
                    name: 'search',
                    args: { q: 'x' },
                    state: 'error',
                    result: {
                        error: '工具结果未保存',
                        is_error: true,
                        content: ''
                    }
                }
            ])
        ];
        const out = claudeAdapter.partsToAPIMessages(msgs);
        // assistant(tool_use) + user(tool_result)
        expect(out).toHaveLength(2);
        const toolResult = out[1].content[0];
        expect(toolResult.type).toBe('tool_result');
        expect(toolResult.tool_use_id).toBe('claude_tc_err');
        // 关键断言：is_error 透传
        expect(toolResult.is_error).toBe(true);
    });

    it('omits is_error field when part.state===done (normal success path unchanged)', () => {
        // 回归保护：正常 done 状态的 tool_result 不应该多出 is_error 字段
        const msgs = [
            newMsg('assistant', [
                {
                    type: PartType.TOOL_CALL,
                    id: 'tc_ok',
                    name: 'search',
                    args: { q: 'y' },
                    state: 'done',
                    result: { content: '正常结果' }
                }
            ])
        ];
        const out = claudeAdapter.partsToAPIMessages(msgs);
        expect(out).toHaveLength(2);
        const toolResult = out[1].content[0];
        expect(toolResult.type).toBe('tool_result');
        expect(toolResult.tool_use_id).toBe('claude_tc_ok');
        expect(toolResult.content).toBe('正常结果');
        // 关键断言：is_error 字段不存在
        expect('is_error' in toolResult).toBe(false);
    });

    it('fallback content uses TOOL_INTERRUPTED_MESSAGE constant when part.result is null', () => {
        // 中断/未执行场景：result=null，buildClaudeToolResultMessage 用 TOOL_INTERRUPTED_MESSAGE
        // 字符串兜底，避免 Claude API 收到 tool_use 后找不到配对 tool_result 触发 400。
        // 注意：is_error 仅在 p.result?.is_error===true 时才打，result=null 短路不打。
        const msgs = [
            newMsg('assistant', [
                {
                    type: PartType.TOOL_CALL,
                    id: 'tc_null',
                    name: 'search',
                    args: {},
                    state: 'error',
                    result: null
                }
            ])
        ];
        const out = claudeAdapter.partsToAPIMessages(msgs);
        // assistant(tool_use) + user(tool_result with fallback content)
        expect(out).toHaveLength(2);
        expect(out[0].role).toBe('assistant');
        const toolUse = out[0].content.find((b) => b.type === 'tool_use');
        expect(toolUse).toBeDefined();
        expect(toolUse.id).toBe('claude_tc_null');

        // user 消息的 tool_result content 走 TOOL_INTERRUPTED_MESSAGE 常量
        expect(out[1].role).toBe('user');
        const toolResult = out[1].content[0];
        expect(toolResult.type).toBe('tool_result');
        expect(toolResult.tool_use_id).toBe('claude_tc_null');
        expect(toolResult.content).toBe('Tool execution was interrupted');
        // result=null 时 is_error 不自动加（短路在 p.result?.is_error 上）
        expect('is_error' in toolResult).toBe(false);
    });
});

// ========== parseApiResponse - Claude 格式 ==========

describe('parseApiResponse - Claude 格式', () => {
    it('返回 null 当 error 存在', () => {
        expect(claudeAdapter.parseResponse({ error: 'bad' })).toBeNull();
    });

    it('返回 null 当 content 为空', () => {
        expect(claudeAdapter.parseResponse({ content: [] })).toBeNull();
    });

    it('解析文本块', () => {
        const data = { content: [{ type: 'text', text: 'hello claude' }] };
        const result = claudeAdapter.parseResponse(data);
        expect(result.content).toBe('hello claude');
    });

    it('解析 thinking 块', () => {
        const data = {
            content: [
                { type: 'thinking', thinking: 'I need to think', signature: 'sig123' },
                { type: 'text', text: 'result' }
            ]
        };
        const result = claudeAdapter.parseResponse(data);
        expect(result.thinkingContent).toBe('I need to think');
        expect(result.thinkingBlocks).toHaveLength(1);
        expect(result.thinkingSignatures).toEqual(['sig123']);
    });

    it('检测原生 tool_use + stop_reason', () => {
        const data = {
            content: [
                { type: 'text', text: 'Let me search' },
                { type: 'tool_use', id: 'tu_1', name: 'search', input: { query: 'test' } }
            ],
            stop_reason: 'tool_use'
        };
        const result = claudeAdapter.parseResponse(data);
        expect(result.hasToolCalls).toBe(true);
        expect(result.toolCalls).toHaveLength(1);
        expect(result.toolCalls[0].arguments).toEqual({ query: 'test' });
        expect(result.content).toBe('Let me search');
    });

    it('pauseTurn 标记', () => {
        const data = {
            content: [{ type: 'text', text: 'paused' }],
            stop_reason: 'pause_turn'
        };
        const result = claudeAdapter.parseResponse(data);
        expect(result.pauseTurn).toBe(true);
    });

    it('解析 base64 图片块', () => {
        const data = {
            content: [
                {
                    type: 'image',
                    source: { type: 'base64', media_type: 'image/png', data: 'abc123' }
                }
            ]
        };
        const result = claudeAdapter.parseResponse(data);
        expect(result.contentParts.some((p) => p.type === 'image_url')).toBe(true);
    });

    it('解析 URL 图片块', () => {
        const data = {
            content: [
                { type: 'image', source: { type: 'url', url: 'https://example.com/img.png' } }
            ]
        };
        const result = claudeAdapter.parseResponse(data);
        expect(result.contentParts.some((p) => p.url === 'https://example.com/img.png')).toBe(true);
    });

    it('解析视频块 (base64)', () => {
        const data = {
            content: [
                {
                    type: 'video',
                    source: { type: 'base64', media_type: 'video/mp4', data: 'viddata' }
                }
            ]
        };
        const result = claudeAdapter.parseResponse(data);
        expect(result.contentParts.some((p) => p.type === 'video_url')).toBe(true);
    });

    it('解析 server_tool_use 块', () => {
        const data = {
            content: [
                {
                    type: 'server_tool_use',
                    id: 'stu_1',
                    name: 'web_search',
                    input: { query: 'q' }
                }
            ]
        };
        const result = claudeAdapter.parseResponse(data);
        expect(result.contentParts.some((p) => p.type === 'server_tool_use')).toBe(true);
    });
});

// ========== Stage 1: XML mode tool_call 跳过 native 输出 ==========

describe('to* 在 part.mode === xml 时跳过 native 工具调用块', () => {
    it('toClaudeMessages 跳过 xml mode tool_call，不产生 tool_use/tool_result', () => {
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
        const out = claudeAdapter.partsToAPIMessages(msgs);
        // assistant 消息（XML 文本）+ user 消息（<tool_use_result> 由 appendXmlToolResults 追加）
        expect(out).toHaveLength(2);
        expect(out[0].role).toBe('assistant');
        expect(typeof out[0].content === 'string' || Array.isArray(out[0].content)).toBe(true);
        expect(out[1].role).toBe('user');
        expect(out[1].content).toContain('<tool_use_result>');
        // 不应包含 tool_use 类型 block
        if (Array.isArray(out[0].content)) {
            expect(out[0].content.some((b) => b.type === 'tool_use')).toBe(false);
        }
    });
});
