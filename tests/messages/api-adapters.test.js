/**
 * api-adapters.js 测试
 * 测试新格式 → OpenAI/Claude/Gemini 三种 API 请求格式的转换
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// mock 依赖
vi.mock('../../js/api/format-converter.js', () => ({
    getOrCreateMappedId: vi.fn((id, format) => `${format}_${id}`)
}));

vi.mock('../../js/utils/file-helpers.js', () => ({
    parseDataURL: vi.fn((url) => {
        if (!url || typeof url !== 'string') return null;
        const m = url.match(/^data:(.+?);base64,(.+)$/);
        if (!m) return null;
        return { mimeType: m[1], base64: m[2] };
    })
}));

import {
    toOpenAIMessages,
    toClaudeMessages,
    toGeminiContents
} from '../../js/messages/api-adapters.js';
import { PartType, MediaKind, Role } from '../../js/messages/schema.js';

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

// ========== toOpenAIMessages ==========

describe('toOpenAIMessages', () => {
    it('转换纯文本消息', () => {
        const msgs = [
            newMsg('user', [{ type: PartType.TEXT, text: 'hello' }]),
            newMsg('assistant', [{ type: PartType.TEXT, text: 'hi' }])
        ];
        const out = toOpenAIMessages(msgs);
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
        const out = toOpenAIMessages(msgs);
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
            newMsg('assistant', [{ type: PartType.TEXT, text: 'err2' }], { isError: true })
        ];
        const out = toOpenAIMessages(msgs);
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
        const out = toOpenAIMessages(msgs);
        expect(out[0].content).toBe('回答');
    });

    it('图片媒体转为 image_url', () => {
        const msgs = [
            newMsg('user', [
                { type: PartType.MEDIA, media: MediaKind.IMAGE, url: 'https://img.png' }
            ])
        ];
        const out = toOpenAIMessages(msgs);
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
        const out = toOpenAIMessages(msgs);
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
        const out = toOpenAIMessages(msgs);
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
        const out = toOpenAIMessages(msgs);
        // 音频非 base64，parseDataURL 返回 null，不会添加到 contentItems
        expect(out[0].content).toBe('');
    });

    it('文件 part 转为 file', () => {
        const msgs = [
            newMsg('user', [
                { type: PartType.FILE, name: 'doc.pdf', url: 'data:application/pdf;base64,abc' }
            ])
        ];
        const out = toOpenAIMessages(msgs);
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
        const out = toOpenAIMessages(msgs);
        // assistant 消息
        expect(out[0].role).toBe('assistant');
        expect(out[0].tool_calls).toHaveLength(1);
        expect(out[0].tool_calls[0].id).toBe('tc_1');
        expect(out[0].tool_calls[0].type).toBe('function');
        expect(out[0].tool_calls[0].function.name).toBe('search');
        expect(JSON.parse(out[0].tool_calls[0].function.arguments)).toEqual({ q: 'test' });

        // tool 结果消息
        expect(out[1].role).toBe('tool');
        expect(out[1].tool_call_id).toBe('tc_1');
        expect(out[1].content).toBe('找到了');
        expect(out[1]._toolName).toBe('search');
    });

    it('tool_call args 为字符串时直接使用', () => {
        const msgs = [
            newMsg('assistant', [
                { type: PartType.TOOL_CALL, id: 'tc_1', name: 'fn', args: '{"a":1}', result: null }
            ])
        ];
        const out = toOpenAIMessages(msgs);
        expect(out[0].tool_calls[0].function.arguments).toBe('{"a":1}');
    });

    it('tool_call 无结果不产生 tool 消息', () => {
        const msgs = [
            newMsg('assistant', [
                { type: PartType.TOOL_CALL, id: 'tc_1', name: 'fn', args: {}, result: null }
            ])
        ];
        const out = toOpenAIMessages(msgs);
        expect(out).toHaveLength(1); // 只有 assistant
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
        const out = toOpenAIMessages(msgs);
        expect(out[1].content).toBe('{"data":123}');
    });

    it('空 parts 产生空 content', () => {
        const msgs = [newMsg('assistant', [])];
        const out = toOpenAIMessages(msgs);
        expect(out[0].content).toBe('');
    });

    it('旧格式消息直接透传', () => {
        const msgs = [
            oldMsg({ role: 'user', content: '旧消息' }),
            oldMsg({ role: 'tool', tool_call_id: 'tc_1', content: '结果' })
        ];
        const out = toOpenAIMessages(msgs);
        expect(out[0]).toEqual({ role: 'user', content: '旧消息' });
        expect(out[1]).toEqual({ role: 'tool', tool_call_id: 'tc_1', content: '结果' });
    });

    it('旧格式保留 Responses API 字段', () => {
        const msgs = [
            oldMsg({
                role: 'assistant',
                type: 'function_call',
                id: 'fc_1',
                call_id: 'c1',
                name: 'fn',
                arguments: '{}'
            })
        ];
        const out = toOpenAIMessages(msgs);
        expect(out[0].type).toBe('function_call');
        expect(out[0].call_id).toBe('c1');
    });

    it('injectReasoning 在 assistant 消息前注入 reasoning item', () => {
        const msgs = [
            newMsg('assistant', [{ type: PartType.TEXT, text: '回答' }], {
                meta: { raw: { openai: { encryptedContent: 'enc_data', reasoningItemId: 'r_1' } } }
            })
        ];
        const out = toOpenAIMessages(msgs, { injectReasoning: true });
        expect(out).toHaveLength(2);
        expect(out[0].type).toBe('reasoning');
        expect(out[0].encrypted_content).toBe('enc_data');
        expect(out[0].id).toBe('r_1');
        expect(out[1].role).toBe('assistant');
    });

    it('injectReasoning 无 encryptedContent 时不注入', () => {
        const msgs = [newMsg('assistant', [{ type: PartType.TEXT, text: '回答' }])];
        const out = toOpenAIMessages(msgs, { injectReasoning: true });
        expect(out).toHaveLength(1);
    });
});

// ========== toClaudeMessages ==========

describe('toClaudeMessages', () => {
    it('纯文本消息简化为字符串', () => {
        const msgs = [
            newMsg('user', [{ type: PartType.TEXT, text: 'hello' }]),
            newMsg('assistant', [{ type: PartType.TEXT, text: 'hi' }])
        ];
        const out = toClaudeMessages(msgs);
        expect(out).toHaveLength(2);
        expect(out[0]).toEqual({ role: 'user', content: 'hello' });
        expect(out[1]).toEqual({ role: 'assistant', content: 'hi' });
    });

    it('过滤 system 消息', () => {
        const msgs = [
            newMsg(Role.SYSTEM, [{ type: PartType.TEXT, text: 'system' }]),
            newMsg('user', [{ type: PartType.TEXT, text: 'hello' }])
        ];
        const out = toClaudeMessages(msgs);
        expect(out).toHaveLength(1);
        expect(out[0].role).toBe('user');
    });

    it('跳过错误消息', () => {
        const msgs = [
            newMsg('assistant', [{ type: PartType.TEXT, text: 'err' }], {
                error: { message: 'fail' }
            })
        ];
        const out = toClaudeMessages(msgs);
        expect(out).toHaveLength(0);
    });

    it('thinking part 带签名时转换', () => {
        const msgs = [
            newMsg('assistant', [
                { type: PartType.THINKING, text: '思考', signature: 'sig_1' },
                { type: PartType.TEXT, text: '回答' }
            ])
        ];
        const out = toClaudeMessages(msgs);
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
        const out = toClaudeMessages(msgs);
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
        const out = toClaudeMessages(msgs);
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
        const out = toClaudeMessages(msgs);
        // 单条 text 被简化为字符串
        expect(out[0].content).toBe('[图片附件无法发送：仅支持 base64 格式]');
    });

    it('视频添加文本占位（单条简化为字符串）', () => {
        const msgs = [
            newMsg('user', [
                { type: PartType.MEDIA, media: MediaKind.VIDEO, url: 'data:video/mp4;base64,xxx' }
            ])
        ];
        const out = toClaudeMessages(msgs);
        expect(out[0].content).toBe('[视频附件已省略]');
    });

    it('音频添加文本占位（单条简化为字符串）', () => {
        const msgs = [
            newMsg('user', [
                { type: PartType.MEDIA, media: MediaKind.AUDIO, url: 'data:audio/wav;base64,xxx' }
            ])
        ];
        const out = toClaudeMessages(msgs);
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
        const out = toClaudeMessages(msgs);
        expect(out[0].content).toEqual([
            {
                type: 'document',
                source: { type: 'base64', media_type: 'application/pdf', data: 'pdfdata' }
            }
        ]);
    });

    it('非 PDF 文件被跳过', () => {
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
        const out = toClaudeMessages(msgs);
        // 非 PDF 被跳过，content 为空，添加空文本
        expect(out[0].content).toBe('');
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
        const out = toClaudeMessages(msgs);

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

    it('tool_call 无结果不产生 user 消息', () => {
        const msgs = [
            newMsg('assistant', [
                { type: PartType.TOOL_CALL, id: 'tc_1', name: 'fn', args: {}, result: null }
            ])
        ];
        const out = toClaudeMessages(msgs);
        expect(out).toHaveLength(1); // 只有 assistant
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
        const out = toClaudeMessages(msgs);
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
        const out = toClaudeMessages(msgs);
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
        const out = toClaudeMessages(msgs);
        const toolUse = out[0].content.find((c) => c.type === 'tool_use');
        expect(toolUse.input).toBe('invalid json');
    });

    it('空 parts 添加空文本', () => {
        const msgs = [newMsg('assistant', [])];
        const out = toClaudeMessages(msgs);
        expect(out[0].content).toBe('');
    });

    it('旧格式 role:tool 转为 user tool_result', () => {
        const msgs = [oldMsg({ role: 'tool', tool_call_id: 'tc_1', content: '结果' })];
        const out = toClaudeMessages(msgs);
        expect(out[0].role).toBe('user');
        expect(out[0].content[0].type).toBe('tool_result');
        expect(out[0].content[0].tool_use_id).toBe('claude_tc_1');
    });

    it('旧格式 assistant 带 tool_calls 转为 Claude tool_use', () => {
        const msgs = [
            oldMsg({
                role: 'assistant',
                content: '调用中',
                tool_calls: [{ id: 'tc_1', function: { name: 'search', arguments: '{"q":"a"}' } }]
            })
        ];
        const out = toClaudeMessages(msgs);
        expect(out[0].role).toBe('assistant');
        expect(out[0].content[0].type).toBe('text');
        expect(out[0].content[1].type).toBe('tool_use');
        expect(out[0].content[1].name).toBe('search');
    });

    it('旧格式 assistant 无 tool_calls 直接透传', () => {
        const msgs = [oldMsg({ role: 'assistant', content: '普通回答' })];
        const out = toClaudeMessages(msgs);
        expect(out[0]).toEqual({ role: 'assistant', content: '普通回答' });
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
        const out = toClaudeMessages(msgs);
        const toolResult = out[1].content[0];
        expect(toolResult.type).toBe('tool_result');
        expect(Array.isArray(toolResult.content)).toBe(true);
        expect(toolResult.content[0].type).toBe('text');
        expect(toolResult.content[1].type).toBe('image');
    });
});

// ========== toGeminiContents ==========

describe('toGeminiContents', () => {
    it('纯文本消息（role 映射）', () => {
        const msgs = [
            newMsg('user', [{ type: PartType.TEXT, text: 'hello' }]),
            newMsg('assistant', [{ type: PartType.TEXT, text: 'hi' }])
        ];
        const out = toGeminiContents(msgs);
        expect(out).toHaveLength(2);
        expect(out[0]).toEqual({ role: 'user', parts: [{ text: 'hello' }] });
        expect(out[1]).toEqual({ role: 'model', parts: [{ text: 'hi' }] });
    });

    it('过滤 system 消息', () => {
        const msgs = [
            newMsg(Role.SYSTEM, [{ type: PartType.TEXT, text: 'system' }]),
            newMsg('user', [{ type: PartType.TEXT, text: 'hello' }])
        ];
        const out = toGeminiContents(msgs);
        expect(out).toHaveLength(1);
    });

    it('跳过错误消息', () => {
        const msgs = [
            newMsg('assistant', [{ type: PartType.TEXT, text: 'err' }], {
                error: { message: 'fail' }
            })
        ];
        const out = toGeminiContents(msgs);
        expect(out).toHaveLength(0);
    });

    it('thinking part 转为 thought:true', () => {
        const msgs = [
            newMsg('assistant', [
                { type: PartType.THINKING, text: '思考中', signature: 'sig_1' },
                { type: PartType.TEXT, text: '回答' }
            ])
        ];
        const out = toGeminiContents(msgs);
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
        const out = toGeminiContents(msgs);
        expect(out[0].parts[0]).toEqual({
            inlineData: { mimeType: 'image/png', data: 'abc123' }
        });
    });

    it('非 base64 媒体被跳过', () => {
        const msgs = [
            newMsg('user', [
                { type: PartType.MEDIA, media: MediaKind.IMAGE, url: 'https://img.png' }
            ])
        ];
        const out = toGeminiContents(msgs);
        // 跳过后 parts 为空，添加 { text: '' }
        expect(out[0].parts).toEqual([{ text: '' }]);
    });

    it('文件 base64 转为 inlineData', () => {
        const msgs = [
            newMsg('user', [
                { type: PartType.FILE, name: 'doc.pdf', url: 'data:application/pdf;base64,pdfdata' }
            ])
        ];
        const out = toGeminiContents(msgs);
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
        const out = toGeminiContents(msgs);

        // model 消息
        expect(out[0].role).toBe('model');
        expect(out[0].parts[0]).toEqual({ text: '调用' });
        expect(out[0].parts[1].functionCall).toEqual({ name: 'search', args: { q: 'test' } });

        // user functionResponse
        expect(out[1].role).toBe('user');
        expect(out[1].parts[0].functionResponse.name).toBe('search');
        expect(out[1].parts[0].functionResponse.response.result).toBe('找到了');
    });

    it('tool_call 无结果不产生 user 消息', () => {
        const msgs = [
            newMsg('assistant', [
                { type: PartType.TOOL_CALL, id: 'tc_1', name: 'fn', args: {}, result: null }
            ])
        ];
        const out = toGeminiContents(msgs);
        expect(out).toHaveLength(1);
    });

    it('tool_call args 字符串解析为对象', () => {
        const msgs = [
            newMsg('assistant', [
                { type: PartType.TOOL_CALL, id: 'tc_1', name: 'fn', args: '{"a":1}', result: null }
            ])
        ];
        const out = toGeminiContents(msgs);
        expect(out[0].parts[0].functionCall.args).toEqual({ a: 1 });
    });

    it('tool_call args 无效 JSON 默认空对象', () => {
        const msgs = [
            newMsg('assistant', [
                { type: PartType.TOOL_CALL, id: 'tc_1', name: 'fn', args: 'invalid', result: null }
            ])
        ];
        const out = toGeminiContents(msgs);
        expect(out[0].parts[0].functionCall.args).toEqual({});
    });

    it('空 parts 添加空文本', () => {
        const msgs = [newMsg('assistant', [])];
        const out = toGeminiContents(msgs);
        expect(out[0].parts).toEqual([{ text: '' }]);
    });

    it('thoughtSignature 附加到 functionCall', () => {
        const msgs = [
            newMsg('assistant', [
                { type: PartType.THINKING, text: '思考', signature: 'sig_1' },
                { type: PartType.TOOL_CALL, id: 'tc_1', name: 'fn', args: {}, result: null }
            ])
        ];
        const out = toGeminiContents(msgs);
        expect(out[0].parts[1].functionCall).toBeDefined();
        expect(out[0].parts[1].thoughtSignature).toBe('sig_1');
    });

    it('旧格式 role:tool 转为 Gemini functionResponse', () => {
        const msgs = [oldMsg({ role: 'tool', _toolName: 'search', content: '{"result":"ok"}' })];
        const out = toGeminiContents(msgs);
        expect(out[0].role).toBe('user');
        expect(out[0].parts[0].functionResponse.name).toBe('search');
        expect(out[0].parts[0].functionResponse.response.result).toEqual({ result: 'ok' });
    });

    it('旧格式 assistant 带 tool_calls', () => {
        const msgs = [
            oldMsg({
                role: 'assistant',
                tool_calls: [{ function: { name: 'search', arguments: '{"q":"test"}' } }]
            })
        ];
        const out = toGeminiContents(msgs);
        expect(out[0].role).toBe('model');
        expect(out[0].parts[0].functionCall.name).toBe('search');
        expect(out[0].parts[0].functionCall.args).toEqual({ q: 'test' });
    });

    it('旧格式普通文本', () => {
        const msgs = [oldMsg({ role: 'assistant', content: '普通回答' })];
        const out = toGeminiContents(msgs);
        expect(out[0].role).toBe('model');
        expect(out[0].parts[0].text).toBe('普通回答');
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
        const out = toGeminiContents(msgs);
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
        const out = toGeminiContents(msgs);
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
        const out = toGeminiContents(msgs);
        const response = out[1].parts[0].functionResponse.response;
        expect(response.result).toBe('plain text');
    });

    it('Gemini 原生格式消息直接透传', () => {
        const nativeMsg = {
            role: 'model',
            parts: [{ functionCall: { name: 'fn', args: {} } }]
        };
        const out = toGeminiContents([nativeMsg]);
        expect(out[0]).toBe(nativeMsg);
    });
});
