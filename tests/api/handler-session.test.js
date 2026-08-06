import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    state: {
        currentSessionId: 'session-a',
        apiFormat: 'openai',
        currentProviderId: 'provider-a'
    },
    task: null,
    context: null,
    sendFn: vi.fn(),
    resolvePlaceholder: vi.fn(),
    handleStreamResponse: vi.fn(),
    cleanupAfterSend: vi.fn(),
    stateMachine: {
        attach: vi.fn(() => true),
        owns: vi.fn(() => true),
        transition: vi.fn(() => true),
        transitionFor: vi.fn(() => true),
        isBusy: vi.fn(() => false)
    },
    registry: {
        owns: vi.fn((task) => task === mocks.task),
        isActive: vi.fn((task) => task === mocks.task && !task.isDetached),
        create: vi.fn(),
        setAbortController: vi.fn((task, controller) => {
            task.abortController = controller;
            return true;
        }),
        setAssistantElement: vi.fn((task, element) => {
            task.assistantMessageEl = element;
            return true;
        }),
        setPhase: vi.fn((task, phase) => {
            task.phase = phase;
            return true;
        }),
        finish: vi.fn(),
        getById: vi.fn(),
        getBySession: vi.fn()
    }
}));

vi.mock('../../js/core/state.js', () => ({ state: mocks.state }));
vi.mock('../../js/core/events.js', () => ({
    eventBus: { emit: vi.fn(), on: vi.fn() }
}));
vi.mock('../../js/core/request-state-machine.js', () => ({
    requestStateMachine: mocks.stateMachine,
    RequestState: {
        IDLE: 'idle',
        SENDING: 'sending',
        STREAMING: 'streaming',
        TOOL_CALLING: 'tool_calling',
        CONTINUATION: 'continuation',
        COMPLETED: 'completed',
        ERROR: 'error',
        CANCELLED: 'cancelled'
    }
}));
vi.mock('../../js/core/request-task-registry.js', () => ({
    requestTaskRegistry: mocks.registry
}));
vi.mock('../../js/api/factory.js', () => ({
    getSendFunction: vi.fn(() => mocks.sendFn)
}));
vi.mock('../../js/stream/stats.js', () => ({
    StreamStats: class StreamStats {}
}));
vi.mock('../../js/stream/multi-stream.js', () => ({
    handleMultiStreamResponses: vi.fn()
}));
vi.mock('../../js/utils/logger.js', () => ({
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));
vi.mock('../../js/api/handler-context.js', () => ({
    createHandlerContext: vi.fn(() => mocks.context)
}));
vi.mock('../../js/api/placeholder-resolver.js', () => ({
    resolvePlaceholder: mocks.resolvePlaceholder
}));
vi.mock('../../js/api/error-classifier.js', () => ({ classifyError: vi.fn() }));
vi.mock('../../js/api/error-handlers/index.js', () => ({ dispatchErrorHandler: vi.fn() }));
vi.mock('../../js/api/handler-non-stream.js', () => ({ handleNonStreamResponse: vi.fn() }));
vi.mock('../../js/api/handler-stream-entry.js', () => ({
    handleStreamResponse: mocks.handleStreamResponse
}));
vi.mock('../../js/api/handler-http-error.js', () => ({ handleHttpErrorResponse: vi.fn() }));
vi.mock('../../js/api/handler-cleanup.js', () => ({
    cleanupAfterSend: mocks.cleanupAfterSend
}));
vi.mock('../../js/api/handler-cancel.js', () => ({ cancelCurrentRequest: vi.fn() }));
vi.mock('../../js/api/handler-continuation.js', () => ({ resendWithToolResults: vi.fn() }));
vi.mock('../../js/api/current.js', () => ({
    getCurrentEndpoint: vi.fn(),
    getCurrentApiKey: vi.fn(),
    getCurrentModel: vi.fn()
}));

import { sendToAPI } from '../../js/api/handler.js';

function createTask(phase = 'sending') {
    return {
        id: 'request-a',
        sessionId: 'session-a',
        phase,
        abortController: new AbortController(),
        assistantMessageEl: null,
        isDetached: false,
        isToolCallPending: false,
        isSavingContinuation: false
    };
}

function createContext(task) {
    return {
        task,
        sessionId: task.sessionId,
        endpoint: 'https://example.test/v1/chat',
        apiKey: 'key',
        model: 'model',
        requestFormat: 'openai',
        adapter: { name: 'OpenAI', supportsMultiStream: true, supportsMultipleReplies: true },
        abortController: new AbortController(),
        timeoutMs: 60000,
        timeoutId: null,
        assistantMessageEl: null,
        requestProfile: { modelDisplayName: 'model', providerName: 'Provider' },
        streamEnabled: true,
        replyCount: 1
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    mocks.state.currentSessionId = 'session-a';
    mocks.task = createTask();
    mocks.context = createContext(mocks.task);
    mocks.sendFn.mockResolvedValue({ ok: true, status: 200 });
    mocks.registry.owns.mockImplementation((task) => task === mocks.task);
    mocks.registry.isActive.mockImplementation(
        (task) => task === mocks.task && !task.abortController.signal.aborted
    );
    mocks.stateMachine.attach.mockReturnValue(true);
    mocks.stateMachine.owns.mockReturnValue(true);
    mocks.stateMachine.transition.mockReturnValue(true);
    mocks.stateMachine.transitionFor.mockReturnValue(true);
});

describe('sendToAPI 跨会话任务投影', () => {
    it('图片重试保持 SENDING 时只重绑控制器，不做 SENDING 自转换', async () => {
        await sendToAPI({ task: mocks.task });

        expect(mocks.stateMachine.attach).toHaveBeenCalledWith(mocks.task, null);
        expect(mocks.stateMachine.transitionFor).not.toHaveBeenCalledWith(
            mocks.task,
            'sending',
            expect.any(Object)
        );
        expect(mocks.handleStreamResponse).toHaveBeenCalled();
    });

    it('detach 窗口不恢复状态机或创建前台占位符', async () => {
        mocks.task.isDetached = true;

        await sendToAPI({ task: mocks.task });

        expect(mocks.stateMachine.attach).not.toHaveBeenCalled();
        expect(mocks.resolvePlaceholder).not.toHaveBeenCalled();
        expect(mocks.sendFn).toHaveBeenCalled();
    });
});
