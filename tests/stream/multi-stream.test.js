/**
 * stream/multi-stream.js 多回复流测试
 * 测试 buildGeminiReplyParts 内部逻辑（通过集成测试覆盖）
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// mock 依赖
vi.mock('../../js/core/state.js', () => ({
    state: {
        replyCount: 2,
        currentAssistantMessage: {
            innerHTML: '',
            querySelector: vi.fn(() => null),
            appendChild: vi.fn()
        },
        apiFormat: 'openai',
        currentSessionId: 'session-1',
        sessions: [],
        backgroundTasks: new Map(),
        currentReplies: [],
        selectedReplyIndex: 0
    }
}));

// 状态机 _updateUI 读取按钮元素，测试环境不初始化真实 DOM 缓存
vi.mock('../../js/core/elements.js', () => ({ elements: {} }));

vi.mock('../../js/stream/stats.js', () => ({
    recordFirstToken: vi.fn(),
    recordTokens: vi.fn(),
    finalizeStreamStats: vi.fn(),
    getCurrentStreamStatsData: vi.fn(() => ({})),
    appendStreamStats: vi.fn()
}));

vi.mock('../../js/stream/helpers.js', () => ({
    updateStreamingMessage: vi.fn()
}));

vi.mock('../../js/messages/sync.js', () => ({
    saveAssistantMessageAsync: vi.fn(async () => 0)
}));

vi.mock('../../js/messages/dom-sync.js', () => ({
    setCurrentMessageIndex: vi.fn()
}));

vi.mock('../../js/messages/renderer.js', () => ({
    renderReplyWithSelector: vi.fn()
}));

vi.mock('../../js/utils/errors.js', async (importOriginal) => ({
    ...(await importOriginal()),
    renderHumanizedError: vi.fn(() => '<div>error</div>')
}));

vi.mock('../../js/api/factory.js', () => ({
    getSendFunction: vi.fn(() =>
        vi.fn(async () => ({
            ok: true,
            body: { getReader: () => createSimpleMockReader() }
        }))
    )
}));

// Stage 5 后 multi-stream 调 getAdapter 拿 streamParser，需要 mock 返回模拟 adapter
vi.mock('../../js/api/adapters/index.js', () => ({
    getAdapter: vi.fn(() => ({
        name: 'OpenAI Chat',
        streamParser: vi.fn(async (_reader, _sessionId, _sink, _signal) => ({
            collectReply: () => ({
                content: 'Hello',
                thinkingContent: null,
                contentParts: null,
                stats: { syncToGlobal: vi.fn(), getData: () => ({}) }
            })
        }))
    }))
}));

vi.mock('../../js/providers/manager.js', () => ({
    getCurrentProvider: vi.fn(() => ({ apiFormat: 'openai', name: 'OpenAI' })),
    getModelDisplayName: vi.fn(() => 'gpt-test')
}));

vi.mock('../../js/api/current.js', () => ({
    getCurrentProvider: vi.fn(() => ({ apiFormat: 'openai', name: 'OpenAI' })),
    getModelDisplayName: vi.fn(() => 'gpt-test'),
    getCurrentEndpoint: vi.fn(() => 'http://api.test'),
    getCurrentApiKey: vi.fn(() => 'key'),
    getCurrentModel: vi.fn(() => 'model'),
    getCurrentModelCapabilities: vi.fn(() => null),
    getCurrentActiveApiKey: vi.fn(() => 'key')
}));

vi.mock('../../js/api/request-pipeline.js', () => ({
    executeRequest: vi.fn()
}));

vi.mock('../../js/messages/parts-builder.js', async (importOriginal) => ({
    ...(await importOriginal()),
    buildPartsFromStreamingState: vi.fn(() => []),
    buildMetaFromStreamingState: vi.fn(() => ({})),
    buildCanonicalReplies: vi.fn((replies) =>
        replies.map((reply) => ({
            parts: reply.content ? [{ type: 'text', text: reply.content }] : [],
            meta: {},
            ts: 1,
            error: reply.isError ? { type: 'stream', message: reply.errorMessage || '' } : null
        }))
    )
}));

vi.mock('../../js/stream/sink.js', () => ({
    BufferedSink: vi.fn(
        class BufferedSinkMock {
            constructor() {
                this.errorInfo = null;
                this.skippedToolCalls = null;
                this.commit = vi.fn();
            }
        }
    )
}));

vi.mock('../../js/utils/media.js', () => ({
    isVideoMimeType: vi.fn(() => false),
    isAudioMimeType: vi.fn(() => false)
}));

function createSimpleMockReader() {
    const encoder = new TextEncoder();
    const lines = ['data: {"choices":[{"delta":{"content":"Hello"}}]}\n', 'data: [DONE]\n'];
    let idx = 0;
    return {
        read: vi.fn(async () => {
            if (idx >= lines.length) return { done: true, value: undefined };
            return { done: false, value: encoder.encode(lines[idx++]) };
        }),
        cancel: vi.fn(),
        releaseLock: vi.fn()
    };
}

import { handleMultiStreamResponses } from '../../js/stream/multi-stream.js';
import { state } from '../../js/core/state.js';
import { saveAssistantMessageAsync } from '../../js/messages/sync.js';
import { renderReplyWithSelector } from '../../js/messages/renderer.js';
import { renderHumanizedError } from '../../js/utils/errors.js';
import { appendStreamStats } from '../../js/stream/stats.js';
import { executeRequest } from '../../js/api/request-pipeline.js';
import { getAdapter } from '../../js/api/adapters/index.js';
import { requestTaskRegistry } from '../../js/core/request-task-registry.js';
import { requestStateMachine, RequestState } from '../../js/core/request-state-machine.js';

function makeCtx(overrides = {}) {
    const assistantMessageEl = document.createElement('div');
    const content = document.createElement('div');
    content.className = 'message-content';
    assistantMessageEl.appendChild(content);
    return {
        endpoint: 'http://api.test',
        apiKey: 'key',
        model: 'model',
        requestFormat: 'openai',
        adapter: getAdapter('openai'),
        abortController: new AbortController(),
        assistantMessageEl,
        sessionId: 'session-1',
        replyCount: state.replyCount,
        requestProfile: {
            modelDisplayName: 'model',
            providerName: 'Provider',
            streamEnabled: true,
            isXmlMode: false
        },
        ...overrides
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    requestTaskRegistry.clearForTests();
    state.replyCount = 2;
    state.currentAssistantMessage = {
        innerHTML: '',
        querySelector: vi.fn(() => null),
        appendChild: vi.fn()
    };
    state.currentReplies = [];
    state.selectedReplyIndex = 0;
});

describe('handleMultiStreamResponses - 成功流', () => {
    it('并行处理多个回复', async () => {
        executeRequest.mockImplementation(async () => ({
            ok: true,
            body: { getReader: () => createSimpleMockReader() }
        }));

        await handleMultiStreamResponses(makeCtx());

        expect(executeRequest).toHaveBeenCalledTimes(2);
        expect(appendStreamStats).toHaveBeenCalled();
        expect(state.currentReplies.length).toBeGreaterThan(0);
        expect(state.selectedReplyIndex).toBe(0);
        expect(saveAssistantMessageAsync).toHaveBeenCalled();
        expect(renderReplyWithSelector).toHaveBeenCalled();
    });

    it('单回复模式', async () => {
        state.replyCount = 1;
        executeRequest.mockImplementation(async () => ({
            ok: true,
            body: { getReader: () => createSimpleMockReader() }
        }));

        await handleMultiStreamResponses(makeCtx());

        expect(executeRequest).toHaveBeenCalledTimes(1);
        expect(saveAssistantMessageAsync).toHaveBeenCalled();
    });

    it('detach 窗口内按后台路径保存且不更新前台回复状态', async () => {
        executeRequest.mockImplementation(async () => ({
            ok: true,
            body: { getReader: () => createSimpleMockReader() }
        }));
        const task = requestTaskRegistry.create({
            sessionId: 'session-1',
            abortController: new AbortController()
        });
        task.isDetached = true;

        await handleMultiStreamResponses(makeCtx({ task }));

        expect(saveAssistantMessageAsync).toHaveBeenCalledWith(
            expect.any(Array),
            expect.any(Object),
            expect.objectContaining({ forceBackground: true })
        );
        expect(state.currentReplies).toEqual([]);
        requestTaskRegistry.finish(task, 'completed');
    });
});

describe('handleMultiStreamResponses - 所有请求失败', () => {
    it('所有请求 HTTP 错误', async () => {
        executeRequest.mockImplementation(async () => ({
            ok: false,
            status: 429,
            text: async () => JSON.stringify({ error: { message: 'Rate limit' } })
        }));

        await handleMultiStreamResponses(makeCtx());

        expect(renderHumanizedError).toHaveBeenCalled();
        expect(saveAssistantMessageAsync).toHaveBeenCalled();
    });

    it('所有请求网络错误', async () => {
        executeRequest.mockImplementation(async () => {
            throw new Error('Network error');
        });

        await handleMultiStreamResponses(makeCtx());

        expect(renderHumanizedError).toHaveBeenCalled();
    });
});

describe('handleMultiStreamResponses - 部分成功', () => {
    it('一个成功一个失败', async () => {
        let callCount = 0;
        executeRequest.mockImplementation(async () => {
            callCount++;
            if (callCount === 1) {
                return {
                    ok: true,
                    body: { getReader: () => createSimpleMockReader() }
                };
            }
            return {
                ok: false,
                status: 500,
                text: async () => JSON.stringify({ error: { message: 'Server error' } })
            };
        });

        await handleMultiStreamResponses(makeCtx());

        // 仍然应保存成功的回复
        expect(saveAssistantMessageAsync).toHaveBeenCalled();
    });
});

function makeStreamingAdapter(outcomes) {
    let call = 0;
    return {
        name: 'Test',
        streamParser: vi.fn(async (_reader, _sessionId, sink) => {
            const outcome = outcomes[call++];
            if (outcome.errorInfo) sink.errorInfo = outcome.errorInfo;
            return {
                collectReply: () => ({
                    content: outcome.content || '',
                    thinkingContent: null,
                    contentParts: null,
                    stop: outcome.stop || null,
                    stats: { syncToGlobal: vi.fn(), getData: () => ({}) }
                })
            };
        })
    };
}

function mockOkResponses() {
    executeRequest.mockImplementation(async () => ({
        ok: true,
        body: { getReader: () => createSimpleMockReader() }
    }));
}

describe('handleMultiStreamResponses - 默认选中与空回复', () => {
    it('第一个回复没有内容而失败时默认选中成功的回复', async () => {
        mockOkResponses();
        const adapter = makeStreamingAdapter([
            { errorInfo: { errorCode: 'safety', errorMessage: '回复被安全策略拦截' } },
            { content: 'World', stop: { kind: 'max_tokens', reason: 'length' } }
        ]);

        await handleMultiStreamResponses(makeCtx({ adapter }));

        expect(state.selectedReplyIndex).toBe(1);
        const [, , opts] = saveAssistantMessageAsync.mock.calls[0];
        expect(opts.selectedReplyIndex).toBe(1);
        expect(opts.isError).toBeUndefined();
        expect(renderReplyWithSelector).toHaveBeenCalledWith(
            expect.any(Array),
            1,
            expect.anything()
        );
        const { buildPartsFromStreamingState, buildMetaFromStreamingState } =
            await import('../../js/messages/parts-builder.js');
        expect(buildPartsFromStreamingState).toHaveBeenCalledWith(
            expect.objectContaining({ textContent: 'World' })
        );
        expect(buildMetaFromStreamingState).toHaveBeenCalledWith(
            expect.objectContaining({ stop: { kind: 'max_tokens', reason: 'length' } })
        );
    });

    it('全部回复都没有内容时落错误消息并汇总每个回复的原因', async () => {
        mockOkResponses();
        const adapter = makeStreamingAdapter([
            { errorInfo: { errorCode: 'safety', errorMessage: '回复被安全策略拦截（SAFETY）' } },
            { errorInfo: { errorCode: 'empty_reply', errorMessage: '模型没有生成任何内容' } }
        ]);

        await handleMultiStreamResponses(makeCtx({ adapter }));

        expect(renderReplyWithSelector).not.toHaveBeenCalled();
        const [parts, , opts] = saveAssistantMessageAsync.mock.calls[0];
        expect(parts).toEqual([]);
        expect(opts.isError).toBe(true);
        expect(opts.errorData.error.type).toBe('safety');
        expect(opts.errorData.error.message).toBe('回复被安全策略拦截（SAFETY）');
        expect(opts.errorData.error.allErrors).toEqual([
            expect.objectContaining({ stream: 1, type: 'safety' }),
            expect.objectContaining({ stream: 2, type: 'empty_reply' })
        ]);
    });

    it('全部失败但有部分内容时选中带内容的回复并标记错误', async () => {
        mockOkResponses();
        const adapter = makeStreamingAdapter([
            { errorInfo: { errorCode: 'safety', errorMessage: '拦截' } },
            {
                content: '部分内容',
                errorInfo: { errorCode: 'network_error', errorMessage: '连接中断' }
            }
        ]);

        await handleMultiStreamResponses(makeCtx({ adapter }));

        const [, , opts] = saveAssistantMessageAsync.mock.calls[0];
        expect(opts.selectedReplyIndex).toBe(1);
        expect(opts.isError).toBe(true);
        expect(opts.errorData).toEqual({ code: 'network_error', message: '连接中断' });
        expect(renderReplyWithSelector).toHaveBeenCalledWith(
            expect.any(Array),
            1,
            expect.anything()
        );
    });
});

function rejectOnAbort(signal) {
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
}

describe('handleMultiStreamResponses - 发送锁、连接超时与结束状态', () => {
    afterEach(() => {
        vi.useRealTimers();
        requestStateMachine.forceReset({ silent: true });
        requestTaskRegistry.clearForTests();
    });

    it('收到响应后进入 STREAMING，发送锁随之清除', async () => {
        mockOkResponses();
        const abortController = new AbortController();
        const task = requestTaskRegistry.create({ sessionId: 'session-1', abortController });
        requestStateMachine.forceReset({ silent: true });
        requestStateMachine.transition(RequestState.SENDING, {
            abortController,
            sessionId: 'session-1',
            requestId: task.id,
            timeoutMs: 1000
        });
        expect(requestStateMachine.sendLockTimeout).not.toBeNull();

        await handleMultiStreamResponses(makeCtx({ task, abortController }));

        expect(task.phase).toBe(RequestState.STREAMING);
        expect(requestStateMachine.getState()).toBe(RequestState.STREAMING);
        expect(requestStateMachine.sendLockTimeout).toBeNull();
    });

    it('单个请求连接超时只中止这一路，其余回复照常保存', async () => {
        vi.useFakeTimers();
        const signals = [];
        executeRequest.mockImplementation((_adapter, { signal }) => {
            signals.push(signal);
            if (signals.length === 1) {
                return Promise.resolve({
                    ok: true,
                    body: { getReader: () => createSimpleMockReader() }
                });
            }
            return rejectOnAbort(signal);
        });
        const ctx = makeCtx({ timeoutMs: 1000 });

        const pending = handleMultiStreamResponses(ctx);
        await vi.advanceTimersByTimeAsync(1000);
        await pending;

        expect(signals[0]).not.toBe(signals[1]);
        expect(signals[1].reason.name).toBe('TimeoutError');
        expect(signals[0].aborted).toBe(false);
        expect(ctx.abortController.signal.aborted).toBe(false);
        const [, , opts] = saveAssistantMessageAsync.mock.calls[0];
        expect(opts.isError).toBeUndefined();
    });

    it('连接阶段全部超时：错误保留超时原因，任务按出错结束', async () => {
        vi.useFakeTimers();
        executeRequest.mockImplementation((_adapter, { signal }) => rejectOnAbort(signal));
        const task = requestTaskRegistry.create({
            sessionId: 'session-1',
            abortController: new AbortController()
        });

        const pending = handleMultiStreamResponses(makeCtx({ task, timeoutMs: 2000 }));
        await vi.advanceTimersByTimeAsync(2000);
        await pending;

        const [, , opts] = saveAssistantMessageAsync.mock.calls[0];
        expect(opts.isError).toBe(true);
        expect(opts.errorData.error).toEqual(
            expect.objectContaining({ type: 'timeout', message: expect.stringContaining('2s') })
        );
        expect(task.phase).toBe(RequestState.ERROR);
    });

    it('网络错误保留原因而不是展开成空对象', async () => {
        executeRequest.mockImplementation(async () => {
            throw new TypeError('Failed to fetch');
        });

        await handleMultiStreamResponses(makeCtx());

        const [, , opts] = saveAssistantMessageAsync.mock.calls[0];
        expect(opts.errorData.error.message).toBe('Failed to fetch');
        expect(opts.errorData.allErrors[0].message).toBe('Failed to fetch');
    });

    it('连接阶段用户点停止：同时中止全部请求，按取消处理不落错误回复', async () => {
        executeRequest.mockImplementation((_adapter, { signal }) => rejectOnAbort(signal));
        const abortController = new AbortController();

        const pending = handleMultiStreamResponses(makeCtx({ abortController, timeoutMs: 60000 }));
        abortController.abort();

        await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        expect(saveAssistantMessageAsync).not.toHaveBeenCalled();
    });

    it('全部回复失败但有部分内容时任务按出错结束', async () => {
        mockOkResponses();
        const adapter = makeStreamingAdapter([
            { content: '部分', errorInfo: { errorCode: 'network_error', errorMessage: '中断' } },
            { errorInfo: { errorCode: 'safety', errorMessage: '拦截' } }
        ]);
        const task = requestTaskRegistry.create({
            sessionId: 'session-1',
            abortController: new AbortController()
        });

        await handleMultiStreamResponses(makeCtx({ adapter, task }));

        expect(task.phase).toBe(RequestState.ERROR);
    });

    it('有成功回复时任务不按出错结束', async () => {
        mockOkResponses();
        const adapter = makeStreamingAdapter([
            { errorInfo: { errorCode: 'safety', errorMessage: '拦截' } },
            { content: '成功' }
        ]);
        const task = requestTaskRegistry.create({
            sessionId: 'session-1',
            abortController: new AbortController()
        });

        await handleMultiStreamResponses(makeCtx({ adapter, task }));

        expect(task.phase).toBe(RequestState.STREAMING);
    });
});
