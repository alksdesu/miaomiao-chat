import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    state: {
        currentSessionId: 'session-a',
        isLoading: true,
        isSending: false,
        isToolCallPending: true,
        currentAssistantMessage: null
    },
    elements: {
        cancelRequestButton: { style: { display: 'inline-flex' } }
    },
    task: null,
    projected: false,
    stateMachine: {
        getState: vi.fn(() => 'streaming'),
        owns: vi.fn(() => mocks.projected),
        attach: vi.fn((task) => {
            if (task.abortController.signal.aborted) return false;
            mocks.projected = true;
            return true;
        }),
        cancel: vi.fn(() => {
            mocks.task.abortController.abort();
            return true;
        }),
        forceReset: vi.fn()
    },
    registry: {
        getBySession: vi.fn(() => mocks.task),
        isActive: vi.fn(() => true),
        abort: vi.fn((task) => {
            if (!task.abortController.signal.aborted) task.abortController.abort();
            task.toolAbortController?.abort();
            return true;
        }),
        setPhase: vi.fn((task, phase) => {
            task.phase = phase;
            return true;
        })
    },
    abortToolExecution: vi.fn(),
    clearToolCallContinuation: vi.fn(),
    clearImageRetry: vi.fn()
}));

vi.mock('../../js/core/state.js', () => ({ state: mocks.state, elements: mocks.elements }));
vi.mock('../../js/core/request-state-machine.js', () => ({
    requestStateMachine: mocks.stateMachine,
    RequestState: {
        IDLE: 'idle',
        STREAMING: 'streaming',
        COMPLETED: 'completed',
        ERROR: 'error',
        CANCELLED: 'cancelled'
    }
}));
vi.mock('../../js/core/state-mutations.js', () => ({
    clearToolCallContinuation: mocks.clearToolCallContinuation,
    clearImageRetry: mocks.clearImageRetry
}));
vi.mock('../../js/tools/orchestrator.js', () => ({
    abortToolExecution: mocks.abortToolExecution
}));
vi.mock('../../js/utils/logger.js', () => ({
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));
vi.mock('../../js/core/request-task-registry.js', () => ({
    requestTaskRegistry: mocks.registry
}));

import { cancelCurrentRequest } from '../../js/api/handler-cancel.js';

beforeEach(async () => {
    await Promise.resolve();
    vi.clearAllMocks();
    mocks.projected = false;
    mocks.task = {
        id: 'request-a',
        sessionId: 'session-a',
        phase: 'streaming',
        abortController: new AbortController(),
        toolAbortController: new AbortController(),
        assistantMessageEl: null,
        isToolCallPending: true
    };
    mocks.registry.getBySession.mockReturnValue(mocks.task);
    mocks.registry.isActive.mockReturnValue(true);
    mocks.stateMachine.getState.mockReturnValue('streaming');
});

describe('cancelCurrentRequest', () => {
    it('状态机投影丢失时先 attach 再中止任务', async () => {
        expect(cancelCurrentRequest()).toBe(true);

        expect(mocks.stateMachine.attach).toHaveBeenCalledWith(mocks.task, null);
        expect(mocks.stateMachine.cancel).toHaveBeenCalled();
        expect(mocks.registry.abort).toHaveBeenCalledWith(mocks.task);
        expect(mocks.registry.setPhase).toHaveBeenCalledWith(mocks.task, 'cancelled');
        expect(mocks.task.abortController.signal.aborted).toBe(true);
        await Promise.resolve();
    });

    it('结束状态不会再次触发非法 cancel 转换', async () => {
        mocks.registry.isActive.mockReturnValue(false);
        mocks.stateMachine.getState.mockReturnValue('cancelled');

        expect(cancelCurrentRequest()).toBe(false);

        expect(mocks.stateMachine.cancel).not.toHaveBeenCalled();
        await Promise.resolve();
    });
});
