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

vi.mock('../../../js/utils/platform.js', async (importOriginal) => ({
    ...(await importOriginal()),
    isElectron: vi.fn(() => false)
}));

import { claudeAdapter } from '../../../js/api/adapters/claude-adapter.js';
import { resolveModelProfile } from '../../../js/api/model-profiles.js';
import { isElectron } from '../../../js/utils/platform.js';
import { PartType, MediaKind, Role } from '../../../js/messages/schema.js';
import { state } from '../../../js/core/state.js';
import { getCurrentProvider } from '../../../js/providers/manager.js';
import {
    COMPUTER_HALT_MESSAGE,
    COMPUTER_MEMBER_PERMISSIONS
} from '../../../js/tools/computer-actions.js';

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
    isElectron.mockReturnValue(false);
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

    it('没有可发送内容的消息不输出（空消息与空白文本会被拒绝）', () => {
        const msgs = [
            newMsg('user', [{ type: PartType.TEXT, text: 'q' }]),
            newMsg('assistant', []),
            newMsg('assistant', [{ type: PartType.TEXT, text: '  ' }])
        ];
        const out = claudeAdapter.partsToAPIMessages(msgs);
        expect(out).toEqual([{ role: 'user', content: 'q' }]);
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

    it('工具集成员的 tool_use 与 tool_result 都带回 toolset_name，截图只回传图片', () => {
        const msgs = [
            newMsg('assistant', [
                {
                    type: PartType.TOOL_CALL,
                    id: 'tc_shot',
                    name: 'screenshot',
                    args: {},
                    toolsetName: 'computer',
                    state: 'done',
                    result: {
                        content: '',
                        media: [
                            {
                                type: MediaKind.IMAGE,
                                url: 'data:image/png;base64,SHOT',
                                mimeType: 'image/png'
                            }
                        ]
                    }
                }
            ])
        ];
        const out = claudeAdapter.partsToAPIMessages(msgs);
        const toolUse = out[0].content[0];
        expect(toolUse).toEqual({
            type: 'tool_use',
            id: 'claude_tc_shot',
            name: 'screenshot',
            input: {},
            toolset_name: 'computer'
        });
        expect(out[1].content[0]).toEqual({
            type: 'tool_result',
            tool_use_id: 'claude_tc_shot',
            toolset_name: 'computer',
            content: [
                { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'SHOT' } }
            ]
        });
    });

    it('未执行的工具集成员回复固定的中止文字并标记 is_error', () => {
        const msgs = [
            newMsg('assistant', [
                {
                    type: PartType.TOOL_CALL,
                    id: 'tc_halt',
                    name: 'type',
                    args: { text: 'x' },
                    toolsetName: 'computer',
                    state: 'error',
                    result: {
                        error: COMPUTER_HALT_MESSAGE,
                        is_error: true,
                        error_kind: 'not_executed'
                    }
                }
            ])
        ];
        const out = claudeAdapter.partsToAPIMessages(msgs);
        expect(out[1].content[0]).toEqual({
            type: 'tool_result',
            tool_use_id: 'claude_tc_halt',
            toolset_name: 'computer',
            content: COMPUTER_HALT_MESSAGE,
            is_error: true
        });
    });

    it('普通工具调用不带 toolset_name', () => {
        const msgs = [
            newMsg('assistant', [
                {
                    type: PartType.TOOL_CALL,
                    id: 'tc_plain',
                    name: 'search',
                    args: {},
                    state: 'done',
                    result: { content: 'ok' }
                }
            ])
        ];
        const out = claudeAdapter.partsToAPIMessages(msgs);
        expect(out[0].content[0]).not.toHaveProperty('toolset_name');
        expect(out[1].content[0]).not.toHaveProperty('toolset_name');
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

    it('content 为空时只带回结束原因', () => {
        expect(claudeAdapter.parseResponse({ content: [] })).toEqual({
            content: '',
            stop: null,
            pauseTurn: false
        });
    });

    it('拒答且没有内容时带回拒答原因与说明', () => {
        const result = claudeAdapter.parseResponse({
            content: [],
            stop_reason: 'refusal',
            stop_details: { category: 'cyber', explanation: '涉及攻击' }
        });
        expect(result).toEqual({
            content: '',
            stop: { kind: 'refusal', reason: 'refusal', detail: '涉及攻击' },
            pauseTurn: false
        });
    });

    it('有内容时附带归一后的结束原因', () => {
        const result = claudeAdapter.parseResponse({
            content: [{ type: 'text', text: '被截断的回' }],
            stop_reason: 'max_tokens'
        });
        expect(result.content).toBe('被截断的回');
        expect(result.stop).toEqual({ kind: 'max_tokens', reason: 'max_tokens' });
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

// ========== buildHeaders ==========

describe('buildHeaders', () => {
    const profile = (model) => resolveModelProfile('claude', model);

    it('基础认证与版本头', () => {
        expect(claudeAdapter.buildHeaders('sk-ant', { tools: [] })).toEqual({
            'x-api-key': 'sk-ant',
            'anthropic-version': '2023-06-01',
            'anthropic-dangerous-direct-browser-access': 'true'
        });
    });

    it('请求带 code_execution 工具时合并 beta 头', () => {
        const headers = claudeAdapter.buildHeaders('sk-ant', {
            tools: [{ type: 'code_execution_20250825', name: 'code_execution' }],
            requestProfile: { isXmlMode: false, profile: profile('claude-sonnet-4-5') }
        });
        expect(headers['anthropic-beta']).toBe(
            'code-execution-2025-08-25,advanced-tool-use-2025-11-20,files-api-2025-04-14'
        );
    });

    it('XML 模式下工具写进提示词，不带工具 beta', () => {
        const headers = claudeAdapter.buildHeaders('sk-ant', {
            tools: [{ type: 'code_execution_20250825', name: 'code_execution' }],
            requestProfile: { isXmlMode: true, profile: profile('claude-sonnet-4-5') }
        });
        expect(headers['anthropic-beta']).toBeUndefined();
    });

    it('computer 工具集不需要 beta 头', () => {
        const headers = claudeAdapter.buildHeaders('sk-ant', {
            tools: [{ type: 'computer_toolset_20260801' }],
            requestProfile: { isXmlMode: false, profile: profile('claude-opus-5-5') }
        });
        expect(headers['anthropic-beta']).toBeUndefined();
    });

    it('computer 工具的 beta 跟随能力表里的工具版本', () => {
        const headers = claudeAdapter.buildHeaders('sk-ant', {
            tools: [{ type: 'computer_20250124', name: 'computer' }],
            requestProfile: { isXmlMode: false, profile: profile('claude-haiku-4-5') }
        });
        expect(headers['anthropic-beta']).toBe('computer-use-2025-01-24');
    });

    it('思考配置带 block_binding 时附带对应 beta', () => {
        const headers = claudeAdapter.buildHeaders('sk-ant', {
            tools: [],
            requestProfile: {
                profile: profile('claude-opus-5-5'),
                thinkingCfg: {
                    thinking: {
                        type: 'adaptive',
                        block_binding: { prefix_mismatch_behavior: 'drop_block' }
                    }
                }
            }
        });
        expect(headers['anthropic-beta']).toBe('thinking-binding-controls-2026-08-01');
    });

    it('只看请求内容，不读全局开关', () => {
        state.codeExecutionEnabled = true;
        try {
            expect(
                claudeAdapter.buildHeaders('sk-ant', { tools: [] })['anthropic-beta']
            ).toBeUndefined();
        } finally {
            delete state.codeExecutionEnabled;
        }
    });
});

// ========== 按型号约束请求 ==========

describe('collectBuiltinTools 按型号选择 computer 工具版本', () => {
    const computerState = {
        computerUseEnabled: true,
        xmlToolCallingEnabled: false,
        computerUsePermissions: { bash: true, textEditor: true }
    };

    beforeEach(() => {
        isElectron.mockReturnValue(true);
    });

    it('旧型号使用 computer_20250124', () => {
        const tools = claudeAdapter.collectBuiltinTools(computerState, {
            profile: resolveModelProfile('claude', 'claude-sonnet-4-5')
        });
        expect(tools.map((tool) => tool.type)).toEqual([
            'computer_20250124',
            'bash_20250124',
            'text_editor_20250728'
        ]);
    });

    it('只接受 computer 工具集的型号声明工具集，不附带旧版 computer 工具', () => {
        const tools = claudeAdapter.collectBuiltinTools(computerState, {
            profile: resolveModelProfile('claude', 'claude-opus-5-5')
        });
        expect(tools).toEqual([
            { type: 'computer_toolset_20260801' },
            expect.objectContaining({ type: 'bash_20250124' }),
            expect.objectContaining({ type: 'text_editor_20250728' })
        ]);
    });

    it('权限里关掉的操作对应的工具集成员不下发', () => {
        const tools = claudeAdapter.collectBuiltinTools(
            {
                ...computerState,
                computerUsePermissions: { mouse: false, keyboard: true, screenshot: true }
            },
            { profile: resolveModelProfile('claude', 'claude-opus-5-5') }
        );
        const mouseMembers = Object.keys(COMPUTER_MEMBER_PERMISSIONS).filter(
            (member) => COMPUTER_MEMBER_PERMISSIONS[member] === 'mouse'
        );
        expect(tools[0]).toEqual({
            type: 'computer_toolset_20260801',
            configs: Object.fromEntries(mouseMembers.map((member) => [member, { enabled: false }]))
        });
    });

    it.each([
        ['claude-opus-5-5', 'computer_toolset_20260801'],
        ['claude-sonnet-4-5', 'computer_20250124']
    ])('%s 鼠标、键盘、截图权限全关时不声明 computer', (model, computerType) => {
        const tools = claudeAdapter.collectBuiltinTools(
            {
                ...computerState,
                computerUsePermissions: {
                    mouse: false,
                    keyboard: false,
                    screenshot: false,
                    bash: true,
                    textEditor: false
                }
            },
            { profile: resolveModelProfile('claude', model) }
        );
        expect(tools.map((tool) => tool.type)).not.toContain(computerType);
        expect(tools.map((tool) => tool.type)).toEqual(['bash_20250124']);
    });

    it('非 Electron 环境不附带 computer use 工具', () => {
        isElectron.mockReturnValue(false);
        expect(
            claudeAdapter.collectBuiltinTools(computerState, {
                profile: resolveModelProfile('claude', 'claude-sonnet-4-5')
            })
        ).toEqual([]);
    });
});

describe('collectBuiltinTools XML 模式', () => {
    it('XML 模式下不附带代码执行与联网搜索，并提示', () => {
        const notices = [];
        expect(
            claudeAdapter.collectBuiltinTools(
                { codeExecutionEnabled: true, webSearchEnabled: true, xmlToolCallingEnabled: true },
                { profile: resolveModelProfile('claude', 'claude-sonnet-5-5'), notices }
            )
        ).toEqual([]);
        expect(notices).toEqual([
            expect.objectContaining({
                key: 'xml.builtin-tools',
                message: expect.stringContaining('联网搜索、代码执行')
            })
        ]);
    });

    it('原生模式照常附带服务端工具', () => {
        const tools = claudeAdapter.collectBuiltinTools(
            { codeExecutionEnabled: true, webSearchEnabled: true, xmlToolCallingEnabled: false },
            { profile: resolveModelProfile('claude', 'claude-sonnet-5-5'), notices: [] }
        );
        expect(tools.map((tool) => tool.name)).toEqual(['code_execution', 'web_search']);
    });
});

describe('buildRequestBody 按型号约束', () => {
    const baseCtx = (model, overrides = {}) => ({
        messages: [{ role: 'user', content: 'hi' }],
        model,
        modelParams: { max_tokens: 1024 },
        thinkingCfg: null,
        systemCtx: {},
        prefill: null,
        tools: [],
        isXmlMode: false,
        profile: resolveModelProfile('claude', model),
        notices: [],
        state: { streamEnabled: true },
        ...overrides
    });

    it('不支持末尾 assistant 预填充的型号跳过收尾的 assistant 预填充并提示', () => {
        const ctx = baseCtx('claude-sonnet-5-5', {
            prefill: {
                opening: [],
                trailing: [
                    { role: 'user', content: '补充要求' },
                    { role: 'assistant', content: 'Sure' }
                ]
            }
        });
        const body = claudeAdapter.buildRequestBody(ctx);
        expect(body.messages.at(-1)).toEqual({ role: 'user', content: '补充要求' });
        expect(ctx.notices).toEqual([expect.objectContaining({ key: 'claude.assistant-prefill' })]);
    });

    it('支持预填充的型号保留原样', () => {
        const ctx = baseCtx('claude-haiku-4-5', {
            prefill: { opening: [], trailing: [{ role: 'assistant', content: 'Sure' }] }
        });
        expect(claudeAdapter.buildRequestBody(ctx).messages.at(-1)).toEqual({
            role: 'assistant',
            content: 'Sure'
        });
        expect(ctx.notices).toEqual([]);
    });

    it('旧版 computer 工具按回传截图的尺寸声明显示器', () => {
        const ctx = baseCtx('claude-sonnet-4-5', {
            tools: [
                {
                    type: 'computer_20250124',
                    name: 'computer',
                    display_width_px: 1920,
                    display_height_px: 1080,
                    display_number: 1
                },
                { type: 'bash_20250124', name: 'bash' }
            ],
            computerDisplay: { scaleFactor: 0.7447, width: 1429, height: 804 }
        });
        expect(claudeAdapter.buildRequestBody(ctx).tools).toEqual([
            {
                type: 'computer_20250124',
                name: 'computer',
                display_width_px: 1429,
                display_height_px: 804,
                display_number: 1
            },
            { type: 'bash_20250124', name: 'bash' }
        ]);
        expect(ctx.tools[0].display_width_px).toBe(1920);
    });

    it('取不到截图尺寸时保留占位尺寸', () => {
        const tool = {
            type: 'computer_20251124',
            name: 'computer',
            display_width_px: 1920,
            display_height_px: 1080,
            display_number: 1
        };
        const ctx = baseCtx('claude-opus-4-6', { tools: [tool], computerDisplay: null });
        expect(claudeAdapter.buildRequestBody(ctx).tools).toEqual([tool]);
    });

    it('工具集不声明显示器尺寸', () => {
        const ctx = baseCtx('claude-opus-5-5', {
            tools: [{ type: 'computer_toolset_20260801' }],
            computerDisplay: { scaleFactor: 0.7447, width: 1429, height: 804 }
        });
        expect(claudeAdapter.buildRequestBody(ctx).tools).toEqual([
            { type: 'computer_toolset_20260801' }
        ]);
    });

    it('只接受 computer 工具集的型号开启 Computer Use 时不再提示', () => {
        isElectron.mockReturnValue(true);
        const ctx = baseCtx('claude-opus-5-5', {
            tools: [{ type: 'computer_toolset_20260801' }],
            state: { streamEnabled: true, computerUseEnabled: true }
        });
        expect(claudeAdapter.buildRequestBody(ctx).tools).toEqual([
            { type: 'computer_toolset_20260801' }
        ]);
        expect(ctx.notices).toEqual([]);
    });
});

describe('parseResponse 工具集成员', () => {
    it('保留 toolset_name', () => {
        const result = claudeAdapter.parseResponse(
            {
                content: [
                    {
                        type: 'tool_use',
                        id: 'toolu_click',
                        name: 'left_click',
                        toolset_name: 'computer',
                        input: { coordinate: [1, 2] }
                    },
                    { type: 'tool_use', id: 'toolu_search', name: 'search', input: {} }
                ],
                stop_reason: 'tool_use'
            },
            { isXmlMode: false }
        );
        expect(result.toolCalls[0]).toMatchObject({
            name: 'left_click',
            arguments: { coordinate: [1, 2] },
            toolsetName: 'computer'
        });
        expect(result.toolCalls[1]).not.toHaveProperty('toolsetName');
    });
});

describe('parseResponse XML 模式来源', () => {
    it('未传 isXmlMode 时按原生协议解析，不读全局 XML 开关', () => {
        state.xmlToolCallingEnabled = true;
        const result = claudeAdapter.parseResponse({
            content: [{ type: 'tool_use', id: 'toolu_1', name: 'search', input: { q: 'x' } }],
            stop_reason: 'tool_use'
        });
        expect(result.hasToolCalls).toBe(true);
        expect(result.toolCalls[0].mode).toBe('native');
    });
});

describe('parseResponse 思考块完整落库', () => {
    it('非流式回复的 contentParts 带签名，redacted_thinking 按原顺序保留，并标记签名来源', () => {
        const result = claudeAdapter.parseResponse({
            content: [
                { type: 'thinking', thinking: '', signature: 'sig-omitted' },
                { type: 'redacted_thinking', data: 'ENC' },
                { type: 'tool_use', id: 'toolu_1', name: 'search', input: { q: 'x' } }
            ],
            stop_reason: 'tool_use'
        });
        expect(result.contentParts).toEqual([
            { type: 'thinking', text: '', signature: 'sig-omitted' },
            { type: 'redacted_thinking', data: 'ENC' }
        ]);
        expect(result.thinkingContent).toBeNull();
        expect(result.signatureFormat).toBe('claude');
        expect(result.hasToolCalls).toBe(true);
    });
});

describe('partsToAPIMessages 按本次声明的工具回放历史调用', () => {
    const toolsetCall = (id, name, args, result) => ({
        type: PartType.TOOL_CALL,
        id,
        name,
        args,
        state: 'done',
        result,
        toolsetName: 'computer'
    });
    const history = () => [
        newMsg('user', [{ type: PartType.TEXT, text: 'open settings' }]),
        newMsg('assistant', [
            { type: PartType.THINKING, text: '', signature: 'sig', signatureFormat: 'claude' },
            toolsetCall('a', 'left_click', { coordinate: [1, 2] }, { content: 'OK' }),
            toolsetCall(
                'b',
                'screenshot',
                {},
                {
                    content: '',
                    media: [{ type: MediaKind.IMAGE, url: 'data:image/png;base64,SHOT' }]
                }
            )
        ])
    ];

    it('本次声明了工具集：调用与结果都带 toolset_name，签名为空的思考块原样带回', () => {
        const out = claudeAdapter.partsToAPIMessages(history(), {
            declaredTools: [{ type: 'computer_toolset_20260801' }]
        });
        expect(out[1].content[0]).toEqual({ type: 'thinking', thinking: '', signature: 'sig' });
        expect(out[1].content[1]).toMatchObject({
            type: 'tool_use',
            name: 'left_click',
            toolset_name: 'computer'
        });
        expect(out[2].content.every((block) => block.toolset_name === 'computer')).toBe(true);
        expect(out[2].content[1].content).toEqual([
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'SHOT' } }
        ]);
    });

    it('本次只声明旧版 computer：改写为 computer + action，结果不带 toolset_name', () => {
        const out = claudeAdapter.partsToAPIMessages(history(), {
            declaredTools: [{ type: 'computer_20251124', name: 'computer' }]
        });
        expect(out[1].content[1]).toEqual({
            type: 'tool_use',
            id: 'claude_a',
            name: 'computer',
            input: { action: 'left_click', coordinate: [1, 2] }
        });
        expect(out[2].content.some((block) => 'toolset_name' in block)).toBe(false);
    });

    it('历史里的旧版 computer 调用在声明工具集的请求里改写为工具集成员', () => {
        const msgs = [
            newMsg('assistant', [
                {
                    type: PartType.TOOL_CALL,
                    id: 'c',
                    name: 'computer',
                    args: { action: 'type', text: 'hi' },
                    state: 'done',
                    result: { content: 'OK' }
                }
            ])
        ];
        const out = claudeAdapter.partsToAPIMessages(msgs, {
            declaredTools: [{ type: 'computer_toolset_20260801' }]
        });
        expect(out[0].content[0]).toEqual({
            type: 'tool_use',
            id: 'claude_c',
            name: 'type',
            input: { text: 'hi' },
            toolset_name: 'computer'
        });
        expect(out[1].content[0].toolset_name).toBe('computer');
    });

    it('本次没有声明 computer：工具集调用转成 XML 文本，截图跟在文本后面', () => {
        const out = claudeAdapter.partsToAPIMessages(history(), {
            declaredTools: [{ name: 'search', input_schema: { type: 'object' } }]
        });
        expect(out).toHaveLength(3);
        expect(out[1]).toEqual({
            role: 'assistant',
            content: [{ type: 'thinking', thinking: '', signature: 'sig' }]
        });
        expect(out[2].role).toBe('user');
        expect(out[2].content[0].text).toContain('<name>left_click</name>');
        expect(out[2].content[0].text).not.toContain('SHOT');
        expect(out[2].content[1]).toEqual({
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: 'SHOT' }
        });
    });

    it('本次没有任何原生工具（关闭工具或 XML 模式）：所有原生调用都转成 XML 文本', () => {
        const msgs = [
            newMsg('assistant', [
                {
                    type: PartType.TOOL_CALL,
                    id: 'x',
                    name: 'search',
                    args: { q: 'a' },
                    state: 'done',
                    result: { content: 'r' }
                },
                { type: PartType.TEXT, text: 'done', _turn: 1 }
            ])
        ];
        const out = claudeAdapter.partsToAPIMessages(msgs, { declaredTools: [] });
        expect(out.map((m) => m.role)).toEqual(['user', 'assistant']);
        expect(out[0].content).toContain('<tool_use_result>');
        expect(out[1]).toEqual({ role: 'assistant', content: 'done' });
        expect(JSON.stringify(out)).not.toContain('tool_use"');
    });

    it('没有传入声明时保持原有回放形态', () => {
        const out = claudeAdapter.partsToAPIMessages(history());
        expect(out[1].content[1]).toMatchObject({ name: 'left_click', toolset_name: 'computer' });
    });
});

describe('partsToAPIMessages 服务端工具', () => {
    const serverCall = (encrypted) => ({
        type: PartType.TOOL_CALL,
        id: 'srvtoolu_1',
        name: 'web_search',
        args: { query: 'paris' },
        state: 'done',
        server: true,
        result: {
            type: 'web_search_tool_result',
            content: [
                {
                    type: 'web_search_result',
                    title: 'Paris',
                    url: 'https://example.com',
                    ...(encrypted ? { encrypted_content: encrypted } : {})
                }
            ]
        }
    });

    it('声明了 web_search 且结果完整时原样回放', () => {
        const out = claudeAdapter.partsToAPIMessages([newMsg('assistant', [serverCall('ENC')])], {
            declaredTools: [{ type: 'web_search_20250305', name: 'web_search' }]
        });
        expect(out[0].content.map((block) => block.type)).toEqual([
            'server_tool_use',
            'web_search_tool_result'
        ]);
    });

    it('导入后缺少 encrypted_content 时转成文本', () => {
        const out = claudeAdapter.partsToAPIMessages([newMsg('assistant', [serverCall(null)])], {
            declaredTools: [{ type: 'web_search_20250305', name: 'web_search' }]
        });
        expect(out[0].content).toBe(
            '[web_search] {"query":"paris"}\n- Paris (https://example.com)'
        );
    });

    it('本次没有声明对应的服务端工具时转成文本', () => {
        const out = claudeAdapter.partsToAPIMessages([newMsg('assistant', [serverCall('ENC')])], {
            declaredTools: [{ name: 'search', input_schema: {} }]
        });
        expect(typeof out[0].content).toBe('string');
        expect(out[0].content).not.toContain('ENC');
    });
});

describe('partsToAPIMessages XML 模式按轮回放', () => {
    it('XML 调用的结果紧跟在对应那一轮之后，而不是整条消息末尾', () => {
        const msgs = [
            newMsg('assistant', [
                { type: PartType.TEXT, text: 'checking' },
                { type: PartType.TEXT, text: 'answer', _turn: 1 },
                {
                    type: PartType.TOOL_CALL,
                    id: 'x1',
                    name: 'search',
                    args: {},
                    mode: 'xml',
                    state: 'done',
                    result: { content: 'found' }
                }
            ])
        ];
        const out = claudeAdapter.partsToAPIMessages(msgs, { declaredTools: [] });
        expect(out.map((m) => m.role)).toEqual(['assistant', 'user', 'assistant']);
        expect(out[0].content).toBe('checking');
        expect(out[1].content).toContain('<result>found</result>');
        expect(out[2].content).toBe('answer');
    });
});

describe('parseResponse 非流式 XML 模式', () => {
    it('XML 调用从正文里拆出，思考块与签名照常落库', () => {
        const result = claudeAdapter.parseResponse(
            {
                content: [
                    { type: 'thinking', thinking: 'plan', signature: 'sig' },
                    {
                        type: 'text',
                        text: 'Checking.\n<tool_use>\n  <name>search</name>\n  <arguments>{}</arguments>\n</tool_use>'
                    }
                ],
                stop_reason: 'end_turn'
            },
            { isXmlMode: true }
        );
        expect(result.hasToolCalls).toBe(true);
        expect(result.toolCalls[0]).toMatchObject({ name: 'search', mode: 'xml' });
        expect(result.content).toBe('Checking.\n');
        expect(result.contentParts).toEqual([
            { type: 'thinking', text: 'plan', signature: 'sig' },
            { type: 'text', text: 'Checking.\n' }
        ]);
        expect(result.thinkingSignatures).toEqual(['sig']);
    });
});
