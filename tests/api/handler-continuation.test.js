// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    state: {
        currentSessionId: 'session-a',
        isToolCallPending: true,
        isSavingContinuation: false
    },
    sendToAPI: vi.fn(async () => true),
    registry: {
        owns: vi.fn(() => true),
        setPhase: vi.fn()
    },
    stateMachine: {
        owns: vi.fn(() => true),
        transitionFor: vi.fn(() => true),
        canTransition: vi.fn(() => true),
        transition: vi.fn(() => true)
    },
    setToolCallContinuation: vi.fn()
}));

vi.mock('../../js/core/state.js', () => ({ state: mocks.state }));
vi.mock('../../js/core/request-state-machine.js', () => ({
    requestStateMachine: mocks.stateMachine,
    RequestState: {
        CONTINUATION: 'continuation'
    }
}));
vi.mock('../../js/core/state-mutations.js', () => ({
    setToolCallContinuation: mocks.setToolCallContinuation
}));
vi.mock('../../js/utils/logger.js', () => ({
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));
vi.mock('../../js/core/request-task-registry.js', () => ({
    requestTaskRegistry: mocks.registry
}));
vi.mock('../../js/api/handler.js', () => ({ sendToAPI: mocks.sendToAPI }));

import { resendWithToolResults } from '../../js/api/handler-continuation.js';

function createTask() {
    return {
        id: 'request-a',
        sessionId: 'session-a',
        isDetached: false,
        isToolCallPending: true,
        isSavingContinuation: false
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    mocks.state.currentSessionId = 'session-a';
    mocks.state.isToolCallPending = true;
    mocks.state.isSavingContinuation = false;
    mocks.registry.owns.mockReturnValue(true);
    mocks.stateMachine.owns.mockReturnValue(true);
});

describe('resendWithToolResults', () => {
    it('前台 continuation 开始时清除上一轮工具 pending 投影', async () => {
        const task = createTask();
        const message = document.createElement('div');
        document.body.appendChild(message);

        await resendWithToolResults(message, task);

        expect(mocks.state.isToolCallPending).toBe(false);
        expect(mocks.setToolCallContinuation).toHaveBeenCalledWith(message, 'session-a');
        expect(mocks.sendToAPI).toHaveBeenCalledWith({ task });
        message.remove();
    });

    it('切回会话后改用任务当前的锚点，不复用已脱离页面的旧元素', async () => {
        const task = createTask();
        const staleMessage = document.createElement('div');
        const anchor = document.createElement('div');
        document.body.appendChild(anchor);
        task.messageElement = anchor;

        await resendWithToolResults(staleMessage, task);

        expect(mocks.setToolCallContinuation).toHaveBeenCalledWith(anchor, 'session-a');
        expect(mocks.stateMachine.transitionFor).toHaveBeenCalledWith(task, 'continuation', {
            assistantMessageEl: anchor
        });
        anchor.remove();
    });

    it('锚点都已脱离页面时不标记续作元素，交给占位符解析新建', async () => {
        const task = createTask();

        await resendWithToolResults(document.createElement('div'), task);

        expect(mocks.setToolCallContinuation).not.toHaveBeenCalled();
        expect(mocks.sendToAPI).toHaveBeenCalledWith({ task });
    });

    it('detach 窗口不清理当前会话的工具状态投影', async () => {
        const task = createTask();
        task.isDetached = true;

        await resendWithToolResults(null, task);

        expect(mocks.state.isToolCallPending).toBe(true);
        expect(mocks.setToolCallContinuation).not.toHaveBeenCalled();
    });
});
