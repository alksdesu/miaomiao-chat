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
    handleMultiStreamResponses: vi.fn(),
    cleanupAfterSend: vi.fn(),
    classifyError: vi.fn((error) => ({ kind: 'generic', displayError: error })),
    dispatchErrorHandler: vi.fn(),
    stateMachine: {
        attach: vi.fn(() => true),
        owns: vi.fn(() => true),
        transition: vi.fn(() => true),
        transitionFor: vi.fn(() => true),
        isBusy: vi.fn(() => false),
        isRequestActive: vi.fn(() => false),
        settle: vi.fn(() => true),
        getState: vi.fn(() => 'idle'),
        forceReset: vi.fn(),
        requestId: null
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
    handleMultiStreamResponses: mocks.handleMultiStreamResponses
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
vi.mock('../../js/api/error-classifier.js', () => ({ classifyError: mocks.classifyError }));
vi.mock('../../js/api/error-handlers/index.js', () => ({
    dispatchErrorHandler: mocks.dispatchErrorHandler
}));
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

import { sendToAPI, initAPIHandler } from '../../js/api/handler.js';
import { eventBus } from '../../js/core/events.js';

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
    mocks.stateMachine.settle.mockReturnValue(true);
    mocks.stateMachine.isRequestActive.mockReturnValue(false);
    mocks.stateMachine.isBusy.mockReturnValue(false);
    mocks.stateMachine.requestId = null;
    mocks.registry.getById.mockReturnValue(null);
    mocks.registry.create.mockImplementation(() => mocks.task);
    mocks.classifyError.mockImplementation((error) => ({ kind: 'generic', displayError: error }));
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

describe('sendToAPI 统一错误处理与结束路径', () => {
    it('请求快照构造失败时建立占位并交给统一错误处理，不发请求', async () => {
        const error = new Error('透明背景仅支持 PNG 或 WebP 输出格式');
        mocks.context.task = null;
        mocks.context.setupError = error;

        const result = await sendToAPI();

        expect(result).toBeUndefined();
        expect(mocks.stateMachine.settle).toHaveBeenCalled();
        expect(mocks.stateMachine.transition).toHaveBeenCalledWith('sending', expect.any(Object));
        expect(mocks.resolvePlaceholder).toHaveBeenCalledWith(mocks.context);
        expect(mocks.sendFn).not.toHaveBeenCalled();
        expect(mocks.classifyError).toHaveBeenCalledWith(error, mocks.context);
        expect(mocks.dispatchErrorHandler).toHaveBeenCalledWith(
            { kind: 'generic', displayError: error },
            mocks.context
        );
        expect(mocks.cleanupAfterSend).toHaveBeenCalledWith(mocks.context, false);
    });

    it('建立占位时抛错同样走统一错误处理并收尾', async () => {
        mocks.context.task = null;
        mocks.resolvePlaceholder.mockImplementationOnce(() => {
            throw new Error('messagesArea 不存在');
        });

        await sendToAPI();

        expect(mocks.dispatchErrorHandler).toHaveBeenCalled();
        expect(mocks.cleanupAfterSend).toHaveBeenCalledWith(mocks.context, false);
    });

    it('状态机仍有请求时不静默放弃：提示用户并结束任务', async () => {
        mocks.context.task = null;
        mocks.stateMachine.settle.mockReturnValue(false);

        const result = await sendToAPI();

        expect(result).toBe(false);
        expect(mocks.stateMachine.transition).not.toHaveBeenCalled();
        expect(mocks.registry.finish).toHaveBeenCalledWith(mocks.task, 'error', {
            reason: 'state-transition-rejected'
        });
        expect(eventBus.emit).toHaveBeenCalledWith(
            'ui:notification',
            expect.objectContaining({ type: 'warning' })
        );
    });

    it('没有当前会话时提示而不创建任务', async () => {
        mocks.context.task = null;
        mocks.context.sessionId = null;

        const result = await sendToAPI();

        expect(result).toBe(false);
        expect(mocks.registry.create).not.toHaveBeenCalled();
        expect(eventBus.emit).toHaveBeenCalledWith(
            'ui:notification',
            expect.objectContaining({ type: 'error' })
        );
    });

    it('续作发出前任务已被取消：仍登记着的任务就地结束', async () => {
        mocks.task.abortController.abort();
        mocks.task.phase = 'continuation';
        mocks.task.isToolCallPending = true;
        mocks.stateMachine.isRequestActive.mockReturnValue(true);

        const result = await sendToAPI({ task: mocks.task });

        expect(result).toBe(false);
        expect(mocks.task.isToolCallPending).toBe(false);
        expect(mocks.stateMachine.transitionFor).toHaveBeenCalledWith(mocks.task, 'cancelled');
        expect(mocks.registry.finish).toHaveBeenCalledWith(mocks.task, 'cancelled', {
            reason: 'inactive-continuation'
        });
        expect(mocks.sendFn).not.toHaveBeenCalled();
    });

    it('多回复全部失败时不再按完成处理', async () => {
        mocks.context.task = null;
        mocks.context.replyCount = 3;
        mocks.handleMultiStreamResponses.mockImplementationOnce(async () => {
            mocks.task.phase = 'error';
        });

        const result = await sendToAPI();

        expect(result).toBe(false);
        expect(mocks.stateMachine.transitionFor).not.toHaveBeenCalledWith(mocks.task, 'completed');
        expect(mocks.cleanupAfterSend).toHaveBeenCalledWith(mocks.context, false);
    });
});

describe('initAPIHandler 兜底', () => {
    function handlerFor(eventName) {
        initAPIHandler();
        return eventBus.on.mock.calls.find(([name]) => name === eventName)[1];
    }

    function failErrorHandling() {
        mocks.context.task = null;
        mocks.resolvePlaceholder.mockImplementationOnce(() => {
            throw new Error('messagesArea 不存在');
        });
        mocks.dispatchErrorHandler.mockRejectedValueOnce(new Error('错误消息落库失败'));
    }

    it('sendToAPI 自身抛错时提示用户，并重置停在已结束任务上的状态机', async () => {
        failErrorHandling();
        mocks.stateMachine.isRequestActive.mockReturnValue(true);

        handlerFor('api:send-requested')();

        await vi.waitFor(() =>
            expect(mocks.stateMachine.forceReset).toHaveBeenCalledWith({ silent: true })
        );
        expect(eventBus.emit).toHaveBeenCalledWith(
            'ui:notification',
            expect.objectContaining({ type: 'error', message: '发送失败：错误消息落库失败' })
        );
    });

    it('状态机已属于仍在进行的请求时不重置', async () => {
        failErrorHandling();
        mocks.stateMachine.isRequestActive.mockReturnValue(true);
        mocks.registry.getById.mockReturnValue(createTask('streaming'));

        handlerFor('api:resend-requested')();

        await vi.waitFor(() =>
            expect(eventBus.emit).toHaveBeenCalledWith(
                'ui:notification',
                expect.objectContaining({ message: '发送失败：错误消息落库失败' })
            )
        );
        expect(mocks.stateMachine.forceReset).not.toHaveBeenCalled();
    });

    it('已结束任务迟到的流错误不改动状态机当前的请求', () => {
        mocks.stateMachine.requestId = 'request-new';
        mocks.stateMachine.isBusy.mockReturnValue(true);

        handlerFor('stream:error')({
            errorCode: 'network_error',
            errorMessage: 'socket hang up',
            requestId: 'request-old',
            sessionId: 'session-a'
        });

        expect(mocks.stateMachine.transition).not.toHaveBeenCalled();
        expect(mocks.stateMachine.transitionFor).not.toHaveBeenCalled();
    });

    it('状态机当前请求的流错误照常转为出错', () => {
        mocks.stateMachine.requestId = 'request-old';
        mocks.stateMachine.isBusy.mockReturnValue(true);

        handlerFor('stream:error')({
            errorCode: 'network_error',
            errorMessage: 'socket hang up',
            requestId: 'request-old',
            sessionId: 'session-a'
        });

        expect(mocks.stateMachine.transition).toHaveBeenCalledWith(
            'error',
            expect.objectContaining({
                error: { code: 'network_error', message: 'socket hang up' }
            })
        );
    });
});
