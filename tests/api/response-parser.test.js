/**
 * response-parser.js 响应解析器测试
 * 测试不同 API 格式的非流式响应解析
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// mock 依赖
vi.mock('../../js/core/state.js', () => ({
    state: { xmlToolCallingEnabled: false }
}));

vi.mock('../../js/utils/markdown-image-parser.js', () => ({
    parseMarkdownImages: (text) => [{ type: 'text', text }]
}));

vi.mock('../../js/tools/xml-formatter.js', () => ({
    extractXMLToolCalls: () => []
}));

vi.mock('../../js/stream/think-tag-parser.js', () => ({
    parseThinkTags: (text) => ({ displayText: text || '', thinkingContent: '' })
}));

vi.mock('../../js/utils/media.js', () => ({
    isVideoMimeType: (mime) => mime?.startsWith('video/'),
    isAudioMimeType: (mime) => mime?.startsWith('audio/'),
    isVideoUrl: () => false
}));

import { parseApiResponse } from '../../js/api/response-parser.js';
import { state } from '../../js/core/state.js';

beforeEach(() => {
    state.xmlToolCallingEnabled = false;
});

// ========== OpenAI 格式 ==========

describe('parseApiResponse - OpenAI 格式', () => {
    it('返回 null 当 choices 缺失', () => {
        expect(parseApiResponse({}, 'openai')).toBeNull();
    });

    it('返回 null 当 choices 为空数组', () => {
        expect(parseApiResponse({ choices: [] }, 'openai')).toBeNull();
    });

    it('解析字符串 content', () => {
        const data = { choices: [{ message: { content: 'Hello world' } }] };
        const result = parseApiResponse(data, 'openai');
        expect(result.content).toBe('Hello world');
    });

    it('解析数组 content 中的 text 部分', () => {
        const data = {
            choices: [{ message: { content: [{ type: 'text', text: 'test text' }] } }]
        };
        const result = parseApiResponse(data, 'openai');
        expect(result.content).toContain('test text');
    });

    it('返回 null 当 content 为 null 且无 image', () => {
        const data = { choices: [{ message: { content: null } }] };
        expect(parseApiResponse(data, 'openai')).toBeNull();
    });

    it('解析 message.image 回退', () => {
        const data = {
            choices: [{ message: { content: null, image: 'https://img.example.com/1.png' } }]
        };
        const result = parseApiResponse(data, 'openai');
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
        const result = parseApiResponse(data, 'openai');
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
        const result = parseApiResponse(data, 'openai');
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
        const result = parseApiResponse(data, 'openai');
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
        const result = parseApiResponse(data, 'openai');
        expect(result.contentParts.some((p) => p.type === 'image_url')).toBe(true);
    });
});

// ========== Claude 格式 ==========

describe('parseApiResponse - Claude 格式', () => {
    it('返回 null 当 error 存在', () => {
        expect(parseApiResponse({ error: 'bad' }, 'claude')).toBeNull();
    });

    it('返回 null 当 content 为空', () => {
        expect(parseApiResponse({ content: [] }, 'claude')).toBeNull();
    });

    it('解析文本块', () => {
        const data = { content: [{ type: 'text', text: 'hello claude' }] };
        const result = parseApiResponse(data, 'claude');
        expect(result.content).toBe('hello claude');
    });

    it('解析 thinking 块', () => {
        const data = {
            content: [
                { type: 'thinking', thinking: 'I need to think', signature: 'sig123' },
                { type: 'text', text: 'result' }
            ]
        };
        const result = parseApiResponse(data, 'claude');
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
        const result = parseApiResponse(data, 'claude');
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
        const result = parseApiResponse(data, 'claude');
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
        const result = parseApiResponse(data, 'claude');
        expect(result.contentParts.some((p) => p.type === 'image_url')).toBe(true);
    });

    it('解析 URL 图片块', () => {
        const data = {
            content: [
                { type: 'image', source: { type: 'url', url: 'https://example.com/img.png' } }
            ]
        };
        const result = parseApiResponse(data, 'claude');
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
        const result = parseApiResponse(data, 'claude');
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
        const result = parseApiResponse(data, 'claude');
        expect(result.contentParts.some((p) => p.type === 'server_tool_use')).toBe(true);
    });
});

// ========== Gemini 格式 ==========

describe('parseApiResponse - Gemini 格式', () => {
    it('返回 null 当 error 存在', () => {
        expect(parseApiResponse({ error: 'err' }, 'gemini')).toBeNull();
    });

    it('返回 null 当 candidates 为空', () => {
        expect(parseApiResponse({ candidates: [] }, 'gemini')).toBeNull();
    });

    it('返回 null 当 content.parts 缺失', () => {
        expect(parseApiResponse({ candidates: [{ content: {} }] }, 'gemini')).toBeNull();
    });

    it('解析文本 parts', () => {
        const data = { candidates: [{ content: { parts: [{ text: 'hello gemini' }] } }] };
        const result = parseApiResponse(data, 'gemini');
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
        const result = parseApiResponse(data, 'gemini');
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
        const result = parseApiResponse(data, 'gemini');
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
        const result = parseApiResponse(data, 'gemini');
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
        const result = parseApiResponse(data, 'gemini');
        expect(result.contentParts.some((p) => p.type === 'image_url')).toBe(true);
    });

    it('顶层 reasoning 字段回退', () => {
        const data = {
            candidates: [{ content: { parts: [{ text: 'answer' }] } }],
            reasoning: 'top-level reasoning'
        };
        const result = parseApiResponse(data, 'gemini');
        expect(result.thinkingContent).toBe('top-level reasoning');
    });
});

// ========== OpenAI Responses API 格式 ==========

describe('parseApiResponse - Responses API 格式', () => {
    it('返回 null 当 error 存在', () => {
        expect(parseApiResponse({ error: 'err' }, 'openai-responses')).toBeNull();
    });

    it('解析 message 类型 output', () => {
        const data = { output: [{ type: 'message', text: 'hi response' }] };
        const result = parseApiResponse(data, 'openai-responses');
        expect(result.content).toBe('hi response');
    });

    it('解析 output_text 快捷字段回退', () => {
        const data = { output_text: 'fallback text' };
        const result = parseApiResponse(data, 'openai-responses');
        expect(result.content).toBe('fallback text');
    });

    it('返回 null 当没有任何内容', () => {
        expect(parseApiResponse({ output: [] }, 'openai-responses')).toBeNull();
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
        const result = parseApiResponse(data, 'openai-responses');
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
        const result = parseApiResponse(data, 'openai-responses');
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
        const result = parseApiResponse(data, 'openai-responses');
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
        const result = parseApiResponse(data, 'openai-responses');
        expect(result.content).toBe('from content array');
    });
});

// ========== OpenClaw 格式 ==========

describe('parseApiResponse - OpenClaw 格式', () => {
    it('复用 OpenAI 解析', () => {
        const data = { choices: [{ message: { content: 'openclaw result' } }] };
        const result = parseApiResponse(data, 'openclaw');
        expect(result.content).toBe('openclaw result');
    });
});
