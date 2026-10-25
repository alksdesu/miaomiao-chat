/**
 * @vitest-environment jsdom
 *
 * parser-openai.js 流解析器测试
 * 测试 OpenAI Chat Completions 和 Responses API SSE 流式解析
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// mock 依赖
// vi.mock 被 hoist 到文件顶，class 必须定义在 factory 内部
vi.mock('../../js/stream/stats.js', () => {
    const recordFirstTokenMock = vi.fn();
    const recordTokensMock = vi.fn();
    class MockStreamStats {
        constructor() {
            this.requestStartTime = 0;
            this.firstTokenTime = 0;
            this.endTime = 0;
            this.tokenCount = 0;
            this.isFirstToken = true;
            this.recordFirstToken = recordFirstTokenMock;
            this.recordTokens = recordTokensMock;
        }
        finalize() {}
        recalculateTokenCount() {
            return 0;
        }
        getData() {
            return {};
        }
        getPartialData() {
            return {};
        }
        syncToGlobal() {}
    }
    return {
        StreamStats: MockStreamStats,
        estimateTokenCount: vi.fn(() => 0),
        recordFirstToken: recordFirstTokenMock,
        recordTokens: recordTokensMock,
        finalizeStreamStats: vi.fn(),
        resetStreamStats: vi.fn(),
        recalculateStreamTokenCount: vi.fn(),
        getCurrentStreamStatsData: vi.fn(() => ({})),
        getPartialStreamStatsData: vi.fn(() => ({})),
        getStreamStatsHTML: vi.fn(() => ''),
        renderStreamStatsFromData: vi.fn(() => ''),
        appendStreamStats: vi.fn()
    };
});

vi.mock('../../js/stream/helpers.js', () => ({
    updateStreamingMessage: vi.fn(),
    renderFinalTextWithThinking: vi.fn(),
    renderFinalContentWithThinking: vi.fn(),
    cleanupAllIncompleteImages: vi.fn()
}));

vi.mock('../../js/messages/sync.js', () => ({
    saveAssistantMessage: vi.fn(() => 0)
}));

vi.mock('../../js/api/current.js', () => ({
    getCurrentProvider: vi.fn(() => ({ name: 'test-provider', apiFormat: 'openai' })),
    getModelDisplayName: vi.fn((modelId) => modelId || 'test-model'),
    getCurrentEndpoint: vi.fn(() => ''),
    getCurrentApiKey: vi.fn(() => ''),
    getCurrentModel: vi.fn(() => 'test-model')
}));

vi.mock('../../js/messages/dom-sync.js', () => ({
    setCurrentMessageIndex: vi.fn()
}));

vi.mock('../../js/core/events.js', () => ({
    eventBus: { emit: vi.fn(), on: vi.fn() }
}));

vi.mock('../../js/core/state.js', () => ({
    state: {
        xmlToolCallingEnabled: false,
        currentSessionId: 'test-session',
        isToolCallPending: false,
        currentAssistantMessage: null
    }
}));

vi.mock('../../js/core/request-state-machine.js', () => ({
    requestStateMachine: { transition: vi.fn(), forceReset: vi.fn() },
    RequestState: { TOOL_CALLING: 'TOOL_CALLING' }
}));

vi.mock('../../js/utils/errors.js', () => ({
    renderHumanizedError: vi.fn(() => '<div>error</div>')
}));

vi.mock('../../js/utils/markdown-image-parser.js', () => ({
    parseStreamingMarkdownImages: vi.fn((text, buffer) => ({
        parts: text ? [{ type: 'text', text }] : [],
        newBuffer: buffer || ''
    }))
}));

vi.mock('../../js/tools/orchestrator.js', () => ({
    handleToolCallStream: vi.fn(() => Promise.resolve()),
    startPauseTurnContinuation: vi.fn(() => Promise.resolve())
}));

vi.mock('../../js/stream/openai-tool-accumulator.js', () => ({
    createToolCallAccumulator: vi.fn(() => ({
        processDelta: vi.fn(),
        getCompletedCalls: vi.fn(() => []),
        clear: vi.fn()
    }))
}));

vi.mock('../../js/stream/think-tag-parser.js', () => {
    class MockThinkTagParser {
        processDelta(text) {
            return { displayText: text, thinkingDelta: '' };
        }
        flush() {
            return { displayText: '', thinkingDelta: '' };
        }
    }
    return { ThinkTagParser: MockThinkTagParser };
});

vi.mock('../../js/tools/xml-formatter.js', () => {
    class MockXMLStreamAccumulator {
        processDelta(delta) {
            return { hasToolCalls: false, displayText: delta, error: null };
        }
        getCompletedCalls() {
            return [];
        }
    }
    return { XMLStreamAccumulator: MockXMLStreamAccumulator };
});

import { parseOpenAIStream } from '../../js/stream/parser-openai.js';
import { state } from '../../js/core/state.js';
import { recordFirstToken, recordTokens } from '../../js/stream/stats.js';
import { updateStreamingMessage } from '../../js/stream/helpers.js';
import { eventBus } from '../../js/core/events.js';
import { saveAssistantMessage } from '../../js/messages/sync.js';

// 辅助：创建模拟 reader
function createMockReader(lines) {
    const encoder = new TextEncoder();
    let idx = 0;
    return {
        read: vi.fn(async () => {
            if (idx >= lines.length) return { done: true, value: undefined };
            const line = lines[idx++];
            return { done: false, value: encoder.encode(line + '\n') };
        }),
        cancel: vi.fn(async () => {}),
        releaseLock: vi.fn()
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    state.xmlToolCallingEnabled = false;
    state.currentSessionId = 'test-session';
    state.isToolCallPending = false;
});

// ========== Chat Completions 格式 ==========

describe('parseOpenAIStream - Chat Completions', () => {
    it('解析普通文本 delta', async () => {
        const reader = createMockReader([
            'data: {"choices":[{"delta":{"content":"Hello"}}]}',
            'data: {"choices":[{"delta":{"content":" world"}}]}',
            'data: [DONE]'
        ]);

        await parseOpenAIStream(reader, 'openai');

        expect(recordFirstToken).toHaveBeenCalled();
        expect(recordTokens).toHaveBeenCalledWith('Hello');
        expect(recordTokens).toHaveBeenCalledWith(' world');
        expect(updateStreamingMessage).toHaveBeenCalled();
        expect(saveAssistantMessage).toHaveBeenCalled();
    });

    it('解析 reasoning_content 思维链', async () => {
        const reader = createMockReader([
            'data: {"choices":[{"delta":{"reasoning_content":"thinking..."}}]}',
            'data: {"choices":[{"delta":{"content":"answer"}}]}',
            'data: [DONE]'
        ]);

        await parseOpenAIStream(reader, 'openai');

        expect(recordTokens).toHaveBeenCalledWith('thinking...');
        expect(recordTokens).toHaveBeenCalledWith('answer');
    });

    it('忽略非 data: 前缀行', async () => {
        const reader = createMockReader([
            ':comment line',
            'event: ping',
            'data: {"choices":[{"delta":{"content":"ok"}}]}',
            'data: [DONE]'
        ]);

        await parseOpenAIStream(reader, 'openai');

        expect(recordTokens).toHaveBeenCalledWith('ok');
    });

    it('处理 data: [DONE] 终止信号', async () => {
        const reader = createMockReader([
            'data: {"choices":[{"delta":{"content":"test"}}]}',
            'data: [DONE]'
        ]);

        await parseOpenAIStream(reader, 'openai');

        expect(saveAssistantMessage).toHaveBeenCalled();
    });

    it('处理空 delta 对象', async () => {
        const reader = createMockReader(['data: {"choices":[{"delta":{}}]}', 'data: [DONE]']);

        await parseOpenAIStream(reader, 'openai');
        // 不应崩溃
        expect(saveAssistantMessage).toHaveBeenCalled();
    });

    it('处理 JSON 解析错误', async () => {
        const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const reader = createMockReader([
            'data: {invalid json}',
            'data: {"choices":[{"delta":{"content":"ok"}}]}',
            'data: [DONE]'
        ]);

        await parseOpenAIStream(reader, 'openai');

        expect(consoleSpy).toHaveBeenCalled();
        expect(recordTokens).toHaveBeenCalledWith('ok');
        consoleSpy.mockRestore();
    });

    it('处理流中错误事件', async () => {
        const reader = createMockReader([
            'data: {"error":{"code":429,"message":"Rate limit exceeded"}}'
        ]);

        await parseOpenAIStream(reader, 'openai');

        expect(eventBus.emit).toHaveBeenCalledWith(
            'ui:notification',
            expect.objectContaining({ type: 'error' })
        );
        expect(reader.cancel).toHaveBeenCalled();
    });

    it('流中错误且尚未收到内容时也落错误消息', async () => {
        const reader = createMockReader([
            'data: {"error":{"code":"rate_limit_exceeded","message":"Rate limit exceeded"}}'
        ]);

        await parseOpenAIStream(reader, 'openai');

        const [parts, , opts] = saveAssistantMessage.mock.calls[0];
        expect(parts).toEqual([]);
        expect(opts.isError).toBe(true);
        expect(opts.errorData.code).toBe('rate_limit_exceeded');
    });

    it('处理 finish_reason stop', async () => {
        const reader = createMockReader([
            'data: {"choices":[{"delta":{"content":"hello"},"finish_reason":null}]}',
            'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
            'data: [DONE]'
        ]);

        await parseOpenAIStream(reader, 'openai');

        expect(saveAssistantMessage).toHaveBeenCalled();
    });

    it('处理 content 数组（多模态）', async () => {
        const reader = createMockReader([
            'data: {"choices":[{"delta":{"content":[{"type":"text","text":"img result"}]}}]}',
            'data: [DONE]'
        ]);

        await parseOpenAIStream(reader, 'openai');

        expect(recordFirstToken).toHaveBeenCalled();
    });

    it('处理服务器错误代码 503', async () => {
        const reader = createMockReader([
            'data: {"error":{"code":503,"message":"Service unavailable"}}'
        ]);

        await parseOpenAIStream(reader, 'openai');

        expect(eventBus.emit).toHaveBeenCalledWith(
            'ui:notification',
            expect.objectContaining({
                message: expect.stringContaining('503')
            })
        );
    });

    it('处理服务器内部错误 500', async () => {
        const reader = createMockReader([
            'data: {"error":{"code":500,"message":"Internal server error"}}'
        ]);

        await parseOpenAIStream(reader, 'openai');

        expect(eventBus.emit).toHaveBeenCalledWith(
            'ui:notification',
            expect.objectContaining({
                message: expect.stringContaining('服务器内部错误')
            })
        );
    });
});

// ========== Responses API 格式 ==========

describe('parseOpenAIStream - Responses API', () => {
    it('解析 response.output_text.delta 事件', async () => {
        const reader = createMockReader([
            'data: {"type":"response.output_text.delta","delta":"Hello"}',
            'data: {"type":"response.output_text.delta","delta":" World"}',
            'data: [DONE]'
        ]);

        await parseOpenAIStream(reader, 'openai-responses');

        expect(recordFirstToken).toHaveBeenCalled();
        expect(recordTokens).toHaveBeenCalledWith('Hello');
        expect(recordTokens).toHaveBeenCalledWith(' World');
    });

    it('解析 response.reasoning.delta 事件', async () => {
        const reader = createMockReader([
            'data: {"type":"response.reasoning.delta","delta":"thinking step"}',
            'data: [DONE]'
        ]);

        await parseOpenAIStream(reader, 'openai-responses');

        expect(recordTokens).toHaveBeenCalledWith('thinking step');
    });

    it('解析 response.reasoning_summary.delta 事件', async () => {
        const reader = createMockReader([
            'data: {"type":"response.reasoning_summary.delta","delta":"summary"}',
            'data: [DONE]'
        ]);

        await parseOpenAIStream(reader, 'openai-responses');

        expect(recordTokens).toHaveBeenCalledWith('summary');
    });

    it('处理 function_call 工具调用', async () => {
        const reader = createMockReader([
            'data: {"type":"response.output_item.added","item":{"type":"function_call","call_id":"call_1","name":"search"},"output_index":0}',
            'data: {"type":"response.function_call_arguments.delta","delta":"{\\"q\\":\\"test\\"}","output_index":0}',
            'data: {"type":"response.function_call_arguments.done","arguments":"{\\"q\\":\\"test\\"}","output_index":0}',
            'data: {"type":"response.completed","response":{"output":[]}}'
        ]);

        await parseOpenAIStream(reader, 'openai-responses');
        // 工具调用应被处理，不应崩溃
    });

    it('处理 response.completed 事件中的 output_text', async () => {
        const reader = createMockReader([
            'data: {"type":"response.completed","response":{"output_text":"Final answer","output":[]}}'
        ]);

        await parseOpenAIStream(reader, 'openai-responses');

        expect(recordFirstToken).toHaveBeenCalled();
    });

    it('处理 response.completed 中的 encrypted_content', async () => {
        const reader = createMockReader([
            'data: {"type":"response.completed","response":{"output":[{"type":"reasoning","encrypted_content":"enc_data","id":"item_1"}]}}'
        ]);

        await parseOpenAIStream(reader, 'openai-responses');

        expect(saveAssistantMessage).toHaveBeenCalled();
        const meta = saveAssistantMessage.mock.calls[0][1];
        const reasoningItems = meta?.raw?.openai?.reasoningItems || [];
        expect(reasoningItems).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    encrypted_content: 'enc_data',
                    id: 'item_1'
                })
            ])
        );
    });

    it('处理 response.done 事件', async () => {
        const reader = createMockReader([
            'data: {"type":"response.output_text.delta","delta":"text"}',
            'data: {"type":"response.done","response":{"output":[]}}'
        ]);

        await parseOpenAIStream(reader, 'openai-responses');

        expect(saveAssistantMessage).toHaveBeenCalled();
    });

    it('处理 Responses API 兜底 output_text 无 type', async () => {
        const reader = createMockReader(['data: {"output_text":"fallback text"}', 'data: [DONE]']);

        await parseOpenAIStream(reader, 'openai-responses');

        expect(saveAssistantMessage).toHaveBeenCalled();
    });

    it('处理 Responses API 兜底 output[] 数组', async () => {
        const reader = createMockReader([
            'data: {"output":[{"type":"message","text":"from output array"}]}',
            'data: [DONE]'
        ]);

        await parseOpenAIStream(reader, 'openai-responses');

        expect(recordFirstToken).toHaveBeenCalled();
    });

    it('处理 output[] 中 reasoning 类型', async () => {
        const reader = createMockReader([
            'data: {"output":[{"type":"reasoning","content":"deep thought"}]}',
            'data: [DONE]'
        ]);

        await parseOpenAIStream(reader, 'openai-responses');

        expect(recordTokens).toHaveBeenCalledWith('deep thought');
    });

    it('处理 output[] 中 function_call 类型', async () => {
        const reader = createMockReader([
            'data: {"output":[{"type":"function_call","call_id":"fc_1","name":"tool","arguments":"{}"}]}',
            'data: [DONE]'
        ]);

        await parseOpenAIStream(reader, 'openai-responses');
        // 不应崩溃
    });
});

// ========== 结束原因 ==========

describe('parseOpenAIStream - 结束原因', () => {
    it('Chat finish_reason length 时正常落库并记录截断', async () => {
        const reader = createMockReader([
            'data: {"choices":[{"delta":{"content":"被截断的回"},"finish_reason":null}]}',
            'data: {"choices":[{"delta":{},"finish_reason":"length"}]}',
            'data: [DONE]'
        ]);

        await parseOpenAIStream(reader, 'openai');

        const [parts, meta, opts] = saveAssistantMessage.mock.calls[0];
        expect(parts).toEqual([expect.objectContaining({ type: 'text', text: '被截断的回' })]);
        expect(meta.stop).toEqual({ kind: 'max_tokens', reason: 'length' });
        expect(opts.isError).toBeUndefined();
    });

    it('Chat 拒答文本按正文展示并记录 refusal', async () => {
        const reader = createMockReader([
            'data: {"choices":[{"delta":{"refusal":"无法"},"finish_reason":null}]}',
            'data: {"choices":[{"delta":{"refusal":"协助"},"finish_reason":null}]}',
            'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
            'data: [DONE]'
        ]);

        await parseOpenAIStream(reader, 'openai');

        const [parts, meta, opts] = saveAssistantMessage.mock.calls[0];
        expect(parts).toEqual([expect.objectContaining({ type: 'text', text: '无法协助' })]);
        expect(meta.stop).toEqual({ kind: 'refusal', reason: 'refusal' });
        expect(opts.isError).toBeUndefined();
    });

    it('Chat 被内容过滤且没有内容时按拦截落错误消息', async () => {
        const reader = createMockReader([
            'data: {"choices":[{"delta":{},"finish_reason":"content_filter"}]}',
            'data: [DONE]'
        ]);

        await parseOpenAIStream(reader, 'openai');

        const [parts, , opts] = saveAssistantMessage.mock.calls[0];
        expect(parts).toEqual([]);
        expect(opts.isError).toBe(true);
        expect(opts.errorData.code).toBe('safety');
        expect(opts.errorData.message).toContain('（content_filter）');
    });

    it('Responses incomplete 且有内容时记录截断原因', async () => {
        const reader = createMockReader([
            'data: {"type":"response.output_text.delta","delta":"被截断"}',
            'data: {"type":"response.incomplete","response":{"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"output":[]}}'
        ]);

        await parseOpenAIStream(reader, 'openai-responses');

        const [, meta, opts] = saveAssistantMessage.mock.calls[0];
        expect(meta.stop).toEqual({ kind: 'max_tokens', reason: 'max_output_tokens' });
        expect(opts.isError).toBeUndefined();
    });

    it('Responses incomplete 时不执行被截断的函数调用，没有正文按截断落错误', async () => {
        const reader = createMockReader([
            'data: {"type":"response.output_item.added","item":{"type":"function_call","call_id":"call_1","name":"search"},"output_index":0}',
            'data: {"type":"response.function_call_arguments.delta","delta":"{\\"q\\":","output_index":0}',
            'data: {"type":"response.incomplete","response":{"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"output":[]}}'
        ]);

        await parseOpenAIStream(reader, 'openai-responses');

        expect(saveAssistantMessage).toHaveBeenCalledTimes(1);
        const [, , opts] = saveAssistantMessage.mock.calls[0];
        expect(opts.toolCalls).toBeUndefined();
        expect(opts.isError).toBe(true);
        expect(opts.errorData.code).toBe('max_tokens');
    });

    it('Responses 拒答增量按正文展示并记录 refusal', async () => {
        const reader = createMockReader([
            'data: {"type":"response.refusal.delta","delta":"无法协助"}',
            'data: {"type":"response.completed","response":{"status":"completed","output":[]}}'
        ]);

        await parseOpenAIStream(reader, 'openai-responses');

        const [parts, meta] = saveAssistantMessage.mock.calls[0];
        expect(parts).toEqual([expect.objectContaining({ type: 'text', text: '无法协助' })]);
        expect(meta.stop).toEqual({ kind: 'refusal', reason: 'refusal' });
    });

    it('Responses completed 时记录正常结束', async () => {
        const reader = createMockReader([
            'data: {"type":"response.output_text.delta","delta":"hi"}',
            'data: {"type":"response.completed","response":{"status":"completed","output":[]}}'
        ]);

        await parseOpenAIStream(reader, 'openai-responses');

        expect(saveAssistantMessage.mock.calls[0][1].stop).toEqual({
            kind: 'end',
            reason: 'completed'
        });
    });

    it('Responses failed 事件走流内错误处理', async () => {
        const reader = createMockReader([
            'data: {"type":"response.output_text.delta","delta":"部分"}',
            'data: {"type":"response.failed","response":{"status":"failed","error":{"code":"server_error","message":"上游故障"}}}'
        ]);

        await parseOpenAIStream(reader, 'openai-responses');

        expect(eventBus.emit).toHaveBeenCalledWith(
            'ui:notification',
            expect.objectContaining({ type: 'error', message: expect.stringContaining('上游故障') })
        );
        expect(reader.cancel).toHaveBeenCalled();
        const [, , opts] = saveAssistantMessage.mock.calls[0];
        expect(opts.isError).toBe(true);
        expect(opts.errorData.code).toBe('server_error');
    });

    it('Responses error 事件走流内错误处理', async () => {
        const reader = createMockReader([
            'data: {"type":"error","code":"rate_limit_exceeded","message":"请求过多"}'
        ]);

        await parseOpenAIStream(reader, 'openai-responses');

        expect(eventBus.emit).toHaveBeenCalledWith(
            'ui:notification',
            expect.objectContaining({ type: 'error', message: expect.stringContaining('请求过多') })
        );
        expect(reader.cancel).toHaveBeenCalled();
    });

    it('增量未收到函数调用时从终态补齐全部调用', async () => {
        const reader = createMockReader([
            'data: {"type":"response.completed","response":{"status":"completed","output":[{"type":"function_call","call_id":"c1","name":"a","arguments":"{}"},{"type":"function_call","call_id":"c2","name":"b","arguments":"{}"}]}}'
        ]);

        await parseOpenAIStream(reader, 'openai-responses');

        const [, , opts] = saveAssistantMessage.mock.calls[0];
        expect(opts.toolCalls.map((tc) => tc.name)).toEqual(['a', 'b']);
    });
});
