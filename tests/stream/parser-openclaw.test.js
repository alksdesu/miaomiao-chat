/**
 * parser-openclaw.js 事件流处理器测试
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// 共享 StreamStats 实例方法 spy，使断言可跨实例工作
const statsSpies = {
    recordFirstToken: vi.fn(),
    recordTokens: vi.fn(),
    finalize: vi.fn(),
    recalculateTokenCount: vi.fn(),
    syncToGlobal: vi.fn(),
    getPartialData: vi.fn(() => ({})),
    getData: vi.fn(() => ({}))
};

// mock 依赖
vi.mock('../../js/core/events.js', () => ({
    eventBus: {
        emit: vi.fn(),
        on: vi.fn(),
        off: vi.fn()
    }
}));

vi.mock('../../js/core/state.js', () => ({
    state: {
        currentSessionId: 'test-session',
        isToolCallPending: false,
        selectedModel: 'test-model',
        currentAssistantMessage: null
    }
}));

vi.mock('../../js/stream/helpers.js', () => ({
    updateStreamingMessage: vi.fn(),
    renderFinalTextWithThinking: vi.fn(),
    renderFinalContentWithThinking: vi.fn()
}));

vi.mock('../../js/stream/stats.js', () => {
    class StreamStats {
        recordFirstToken(...args) {
            return statsSpies.recordFirstToken(...args);
        }
        recordTokens(...args) {
            return statsSpies.recordTokens(...args);
        }
        finalize(...args) {
            return statsSpies.finalize(...args);
        }
        recalculateTokenCount(...args) {
            return statsSpies.recalculateTokenCount(...args);
        }
        syncToGlobal(...args) {
            return statsSpies.syncToGlobal(...args);
        }
        getPartialData(...args) {
            return statsSpies.getPartialData(...args);
        }
        getData(...args) {
            return statsSpies.getData(...args);
        }
    }
    return {
        StreamStats,
        appendStreamStats: vi.fn(),
        resetStreamStats: vi.fn(),
        getCurrentStreamStatsData: vi.fn(() => ({})),
        renderStreamStatsFromData: vi.fn(() => ''),
        getStreamStatsHTML: vi.fn(() => ''),
        estimateTokenCount: vi.fn(() => 0)
    };
});

vi.mock('../../js/messages/sync.js', () => ({
    saveAssistantMessage: vi.fn(() => 0)
}));

vi.mock('../../js/messages/dom-sync.js', () => ({
    setCurrentMessageIndex: vi.fn()
}));

vi.mock('../../js/messages/parts-builder.js', () => ({
    buildPartsFromStreamingState: vi.fn(() => []),
    buildMetaFromStreamingState: vi.fn(() => ({})),
    buildPartsFromReply: vi.fn(() => []),
    buildMetaFromReply: vi.fn(() => ({}))
}));

vi.mock('../../js/api/format-converter.js', () => ({
    generateIdSet: vi.fn((id) => ({ openai: id, claude: id, gemini: id })),
    ensureIdMap: vi.fn(),
    getMappedId: vi.fn((part) => part?.id),
    extractThoughtSignature: vi.fn(),
    clearThoughtSignatures: vi.fn(),
    hasThoughtSignatures: vi.fn(() => false),
    clearProviderSpecificRawMeta: vi.fn(),
    clearForeignSignatures: vi.fn(),
    sanitizeMessageForExport: vi.fn((m) => m)
}));

vi.mock('../../js/utils/errors.js', () => ({
    renderHumanizedError: vi.fn(() => '<div>error</div>'),
    getHumanizedError: vi.fn(() => ({ title: '', detail: '' }))
}));

vi.mock('../../js/core/request-state-machine.js', () => ({
    RequestState: {
        IDLE: 'idle',
        SENDING: 'sending',
        STREAMING: 'streaming',
        TOOL_CALLING: 'tool_calling',
        AWAITING_CONTINUATION: 'awaiting_continuation',
        CANCELLING: 'cancelling',
        ERROR: 'error',
        COMPLETED: 'completed'
    },
    requestStateMachine: {
        transition: vi.fn(),
        forceReset: vi.fn(),
        getCurrent: vi.fn(() => 'idle')
    }
}));

vi.mock('../../js/stream/sink.js', async () => {
    const { updateStreamingMessage, renderFinalTextWithThinking } =
        await import('../../js/stream/helpers.js');
    const { saveAssistantMessage } = await import('../../js/messages/sync.js');
    const { setCurrentMessageIndex } = await import('../../js/messages/dom-sync.js');
    const { handleToolCallStream } = await import('../../js/tools/orchestrator.js');
    const { eventBus } = await import('../../js/core/events.js');

    class DefaultSink {
        constructor(sessionId = null) {
            this.sessionId = sessionId;
        }
        isBackground() {
            return false;
        }
        streamingUpdate(text, thinking) {
            updateStreamingMessage(text, thinking);
        }
        renderFinalContent() {}
        renderFinalText(text, thinking) {
            renderFinalTextWithThinking(text, thinking);
        }
        renderError() {}
        appendStats() {}
        commit(parts, meta, opts = {}) {
            const idx = saveAssistantMessage(parts, meta, { ...opts, sessionId: this.sessionId });
            setCurrentMessageIndex(idx);
            return idx;
        }
        commitError(parts, meta, opts, errorInfo) {
            const idx = saveAssistantMessage(parts, meta, {
                ...opts,
                sessionId: this.sessionId,
                isError: true,
                errorData: { code: errorInfo.errorCode, message: errorInfo.errorMessage },
                errorHtml: errorInfo.errorHtml
            });
            setCurrentMessageIndex(idx);
            eventBus.emit('stream:error', {
                errorCode: errorInfo.errorCode,
                errorMessage: errorInfo.errorMessage,
                partialContent: errorInfo.partialContent
            });
            return idx;
        }
        triggerToolCalls(toolCalls) {
            handleToolCallStream(toolCalls, {}).catch(() => {});
        }
        triggerPauseTurnResend() {}
    }

    class BufferedSink extends DefaultSink {
        isBackground() {
            return true;
        }
    }

    return { DefaultSink, BufferedSink };
});

vi.mock('../../js/api/openclaw.js', () => ({
    openclawClient: {
        url: 'ws://localhost:18789',
        token: 'test-token',
        completeRun: vi.fn(),
        failRun: vi.fn()
    }
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

vi.mock('../../js/tools/orchestrator.js', () => ({
    handleToolCallStream: vi.fn(() => Promise.resolve()),
    startPauseTurnContinuation: vi.fn(() => Promise.resolve()),
    abortToolExecution: vi.fn(),
    executeToolCalls: vi.fn(() => Promise.resolve()),
    writeToolResultsBackToState: vi.fn()
}));

import { handleOpenClawStream } from '../../js/stream/parser-openclaw.js';
import { state } from '../../js/core/state.js';
import { updateStreamingMessage } from '../../js/stream/helpers.js';
import { saveAssistantMessage } from '../../js/messages/sync.js';
import { openclawClient } from '../../js/api/openclaw.js';
import { eventBus } from '../../js/core/events.js';

beforeEach(() => {
    vi.clearAllMocks();
    statsSpies.recordFirstToken.mockClear();
    statsSpies.recordTokens.mockClear();
    statsSpies.finalize.mockClear();
    statsSpies.recalculateTokenCount.mockClear();
    statsSpies.syncToGlobal.mockClear();
    statsSpies.getPartialData.mockClear();
    statsSpies.getData.mockClear();
    state.currentSessionId = 'test-session';
    state.isToolCallPending = false;
});

// 辅助：从 eventBus.on 中获取注册的回调
function getHandler(eventName) {
    const calls = eventBus.on.mock.calls;
    const match = calls.find(([name]) => name === eventName);
    return match ? match[1] : null;
}

describe('handleOpenClawStream - 文本内容', () => {
    it('处理 chat-delta 文本事件', async () => {
        const promise = handleOpenClawStream('test-session');

        // 获取处理器
        const deltaHandler = getHandler('openclaw:chat-delta');
        const doneHandler = getHandler('openclaw:chat-done');

        expect(deltaHandler).not.toBeNull();
        expect(doneHandler).not.toBeNull();

        // 触发文本 delta
        deltaHandler({ delta: 'Hello', type: 'text' });
        deltaHandler({ delta: ' World', type: 'text' });

        // 完成
        doneHandler();

        await promise;

        expect(statsSpies.recordFirstToken).toHaveBeenCalled();
        expect(statsSpies.recordTokens).toHaveBeenCalledWith('Hello');
        expect(updateStreamingMessage).toHaveBeenCalled();
        expect(saveAssistantMessage).toHaveBeenCalled();
    });

    it('处理 thinking 类型 delta', async () => {
        const promise = handleOpenClawStream('test-session');

        const deltaHandler = getHandler('openclaw:chat-delta');
        const doneHandler = getHandler('openclaw:chat-done');

        deltaHandler({ delta: 'thinking step', type: 'thinking' });
        doneHandler();

        await promise;

        expect(statsSpies.recordTokens).toHaveBeenCalledWith('thinking step');
        expect(updateStreamingMessage).toHaveBeenCalled();
    });

    it('处理 reasoning 类型 delta', async () => {
        const promise = handleOpenClawStream('test-session');

        const deltaHandler = getHandler('openclaw:chat-delta');
        const doneHandler = getHandler('openclaw:chat-done');

        deltaHandler({ delta: 'reasoning...', type: 'reasoning' });
        doneHandler();

        await promise;

        expect(statsSpies.recordTokens).toHaveBeenCalledWith('reasoning...');
    });

    it('忽略 null payload', async () => {
        const promise = handleOpenClawStream('test-session');

        const deltaHandler = getHandler('openclaw:chat-delta');
        const doneHandler = getHandler('openclaw:chat-done');

        deltaHandler(null);
        doneHandler();

        await promise;
        // 不应崩溃
    });

    it('忽略空文本', async () => {
        const promise = handleOpenClawStream('test-session');

        const deltaHandler = getHandler('openclaw:chat-delta');
        const doneHandler = getHandler('openclaw:chat-done');

        deltaHandler({ delta: '', type: 'text' });
        doneHandler();

        await promise;

        expect(statsSpies.recordFirstToken).not.toHaveBeenCalled();
    });
});

describe('handleOpenClawStream - 完成', () => {
    it('完成后调用 completeRun', async () => {
        const promise = handleOpenClawStream('test-session');

        const deltaHandler = getHandler('openclaw:chat-delta');
        const doneHandler = getHandler('openclaw:chat-done');

        deltaHandler({ delta: 'response', type: 'text' });
        doneHandler();

        await promise;

        expect(openclawClient.completeRun).toHaveBeenCalledWith({ done: true });
        expect(statsSpies.finalize).toHaveBeenCalled();
    });

    it('完成后清理监听器', async () => {
        const promise = handleOpenClawStream('test-session');

        const doneHandler = getHandler('openclaw:chat-done');
        doneHandler();

        await promise;

        expect(eventBus.off).toHaveBeenCalled();
    });
});

describe('handleOpenClawStream - 错误处理', () => {
    it('处理错误事件', async () => {
        const promise = handleOpenClawStream('test-session');

        const errorHandler = getHandler('openclaw:error');
        errorHandler({ message: 'Connection lost', code: 'ws_error' });

        await expect(promise).rejects.toThrow('Connection lost');
        expect(openclawClient.failRun).toHaveBeenCalled();
    });

    it('错误前有内容时保存', async () => {
        const promise = handleOpenClawStream('test-session');

        const deltaHandler = getHandler('openclaw:chat-delta');
        const errorHandler = getHandler('openclaw:error');

        deltaHandler({ delta: 'partial', type: 'text' });
        errorHandler({ message: 'Boom' });

        await expect(promise).rejects.toThrow();
        expect(saveAssistantMessage).toHaveBeenCalled();
    });

    it('处理 null 错误 payload', async () => {
        const promise = handleOpenClawStream('test-session');

        const errorHandler = getHandler('openclaw:error');
        errorHandler(null);

        await expect(promise).rejects.toThrow('未知错误');
    });
});

describe('handleOpenClawStream - 工具调用', () => {
    it('处理 agent tool_call 事件', async () => {
        const { handleToolCallStream } = await import('../../js/tools/orchestrator.js');
        const promise = handleOpenClawStream('test-session');

        const agentHandler = getHandler('openclaw:agent-event');
        const doneHandler = getHandler('openclaw:chat-done');

        agentHandler({
            type: 'tool_call',
            data: { id: 'tc_1', name: 'search', arguments: '{"q":"test"}' }
        });
        doneHandler();

        await promise;

        expect(handleToolCallStream).toHaveBeenCalled();
    });

    it('处理 screen_capture 事件', async () => {
        const promise = handleOpenClawStream('test-session');

        const agentHandler = getHandler('openclaw:agent-event');
        const doneHandler = getHandler('openclaw:chat-done');

        agentHandler({ type: 'screen_capture', data: { image: 'base64data' } });
        doneHandler();

        await promise;

        expect(eventBus.emit).toHaveBeenCalledWith('openclaw:screen-capture', {
            image: 'base64data'
        });
    });

    it('忽略 null agent payload', async () => {
        const promise = handleOpenClawStream('test-session');

        const agentHandler = getHandler('openclaw:agent-event');
        const doneHandler = getHandler('openclaw:chat-done');

        agentHandler(null);
        doneHandler();

        await promise;
        // 不应崩溃
    });
});
