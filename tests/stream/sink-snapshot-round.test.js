/**
 * 流式快照按请求轮次分键：DefaultSink 与流式入口、请求收尾的兜底清理用同一轮的快照 ID
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../js/core/state.js', () => ({
    state: {
        currentSessionId: 'session-1',
        currentAssistantMessage: null,
        isToolCallPending: false,
        backgroundTasks: new Map(),
        sessions: [],
        _imageCompressionRetriedSessions: new Set()
    }
}));
vi.mock('../../js/core/events.js', () => ({
    eventBus: { emit: vi.fn(), on: vi.fn() }
}));
vi.mock('../../js/stream/helpers.js', () => ({
    updateStreamingMessage: vi.fn(),
    renderFinalContentWithThinking: vi.fn(),
    renderFinalTextWithThinking: vi.fn(),
    disposeStreamRenderSession: vi.fn()
}));
vi.mock('../../js/stream/stats.js', () => ({ appendStreamStats: vi.fn() }));
vi.mock('../../js/messages/render-stop-notice.js', () => ({ appendStopNotice: vi.fn() }));
vi.mock('../../js/state/stream-snapshot.js', () => ({
    saveStreamSnapshotThrottled: vi.fn(),
    clearStreamSnapshot: vi.fn()
}));
vi.mock('../../js/messages/sync.js', () => ({
    saveAssistantMessage: vi.fn(() => 0),
    saveAssistantMessageAsync: vi.fn()
}));
vi.mock('../../js/messages/dom-sync.js', () => ({ setCurrentMessageIndex: vi.fn() }));
vi.mock('../../js/tools/orchestrator.js', () => ({
    handleToolCallStream: vi.fn(() => Promise.resolve()),
    startPauseTurnContinuation: vi.fn(() => Promise.resolve()),
    finishToolTask: vi.fn()
}));
vi.mock('../../js/api/placeholder-resolver.js', () => ({
    splitContinuationErrorPlaceholder: vi.fn()
}));
vi.mock('../../js/api/image-retry.js', () => ({ resetAllImageRetryState: vi.fn() }));
vi.mock('../../js/core/request-state-machine.js', () => ({
    requestStateMachine: { transition: vi.fn(), transitionFor: vi.fn() },
    RequestState: {
        TOOL_CALLING: 'tool_calling',
        COMPLETED: 'completed',
        CANCELLED: 'cancelled',
        ERROR: 'error'
    }
}));
vi.mock('../../js/utils/logger.js', () => ({
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

import { DefaultSink } from '../../js/stream/sink.js';
import { handleStreamResponse } from '../../js/api/handler-stream-entry.js';
import { cleanupAfterSend } from '../../js/api/handler-cleanup.js';
import { state } from '../../js/core/state.js';
import { requestTaskRegistry } from '../../js/core/request-task-registry.js';
import {
    saveStreamSnapshotThrottled,
    clearStreamSnapshot
} from '../../js/state/stream-snapshot.js';

const PROFILE = { modelDisplayName: 'Model', providerName: 'Provider' };

function createTask(sessionId = 'session-1') {
    const task = requestTaskRegistry.create({ sessionId, abortController: new AbortController() });
    task.requestProfile = PROFILE;
    return task;
}

beforeEach(() => {
    vi.clearAllMocks();
    requestTaskRegistry.clearForTests();
    state.currentSessionId = 'session-1';
    state.backgroundTasks = new Map();
});

describe('DefaultSink 按轮次写入与清理快照', () => {
    it('同一任务的两轮各用自己的快照 ID', () => {
        const task = createTask();
        const firstRound = new DefaultSink('session-1', task, `${task.id}:1`);
        const continuation = new DefaultSink('session-1', task, `${task.id}:2`);

        firstRound.streamingUpdate('round one', '');
        firstRound.commit([{ type: 'text', text: 'round one' }], {}, {});
        continuation.streamingUpdate('round two', '');

        expect(saveStreamSnapshotThrottled).toHaveBeenNthCalledWith(
            1,
            'session-1',
            'round one',
            '',
            `${task.id}:1`,
            PROFILE
        );
        expect(clearStreamSnapshot).toHaveBeenCalledWith('session-1', `${task.id}:1`);
        expect(saveStreamSnapshotThrottled).toHaveBeenNthCalledWith(
            2,
            'session-1',
            'round two',
            '',
            `${task.id}:2`,
            PROFILE
        );
        expect(clearStreamSnapshot).not.toHaveBeenCalledWith('session-1', `${task.id}:2`);
    });

    it('未指定快照 ID 时按任务 ID，没有任务时为空', () => {
        const task = createTask();

        expect(new DefaultSink('session-1', task).snapshotRequestId).toBe(task.id);
        expect(new DefaultSink('session-1', null).snapshotRequestId).toBeNull();
    });
});

describe('流式入口与请求收尾', () => {
    it('流式入口把本轮快照 ID 交给 sink', async () => {
        const task = createTask();
        let receivedSink = null;
        const ctx = {
            adapter: {
                streamParser: vi.fn(async (_reader, _sessionId, sink) => {
                    receivedSink = sink;
                })
            },
            requestFormat: 'openai',
            abortController: new AbortController(),
            sessionId: 'session-1',
            task,
            snapshotRequestId: `${task.id}:3`
        };

        await handleStreamResponse({ body: { getReader: () => ({}) } }, ctx);

        expect(receivedSink.snapshotRequestId).toBe(`${task.id}:3`);
    });

    it('兜底清理用本轮快照 ID，缺省时按任务 ID', () => {
        const task = createTask();

        cleanupAfterSend(
            { sessionId: 'session-1', timeoutId: null, task, snapshotRequestId: `${task.id}:2` },
            true
        );
        cleanupAfterSend({ sessionId: 'session-1', timeoutId: null, task }, true);

        expect(clearStreamSnapshot).toHaveBeenNthCalledWith(1, 'session-1', `${task.id}:2`);
        expect(clearStreamSnapshot).toHaveBeenNthCalledWith(2, 'session-1', task.id);
    });
});
