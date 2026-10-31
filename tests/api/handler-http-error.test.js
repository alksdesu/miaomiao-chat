/**
 * api/handler-http-error.js：错误响应体保留服务端原因、续作轮错误单独成条
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
    state: {
        currentSessionId: 'session-1',
        currentAssistantMessage: null,
        backgroundTasks: new Map(),
        sessions: []
    },
    saveAssistantMessageAsync: vi.fn(async () => 2),
    renderHumanizedError: vi.fn(() => '<div class="error-humanized">错误</div>')
}));

vi.mock('../../js/core/state.js', () => ({
    state: mocks.state,
    elements: { messagesArea: null }
}));
vi.mock('../../js/core/events.js', () => ({ eventBus: { emit: vi.fn(), on: vi.fn() } }));
vi.mock('../../js/core/request-state-machine.js', () => ({
    requestStateMachine: { transition: vi.fn(), transitionFor: vi.fn(), sessionId: null },
    RequestState: { ERROR: 'error' }
}));
vi.mock('../../js/core/state-mutations.js', () => ({
    clearToolCallContinuation: vi.fn(),
    clearImageRetry: vi.fn()
}));
vi.mock('../../js/messages/sync.js', () => ({
    saveAssistantMessageAsync: mocks.saveAssistantMessageAsync,
    saveAssistantMessageToBackground: vi.fn(async () => true)
}));
vi.mock('../../js/messages/dom-sync.js', () => ({ setCurrentMessageIndex: vi.fn() }));
vi.mock('../../js/utils/errors.js', async (importOriginal) => ({
    ...(await importOriginal()),
    renderHumanizedError: mocks.renderHumanizedError
}));
vi.mock('../../js/utils/helpers.js', async (importOriginal) => ({
    ...(await importOriginal()),
    safeSetHTML: (element, html) => {
        element.innerHTML = html;
    }
}));
vi.mock('../../js/api/image-retry.js', () => ({
    attemptImageCompressionRetry: vi.fn(async () => false),
    resetAllImageRetryState: vi.fn()
}));
vi.mock('../../js/utils/logger.js', () => ({
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

import { handleHttpErrorResponse } from '../../js/api/handler-http-error.js';
import { requestTaskRegistry } from '../../js/core/request-task-registry.js';

function textResponse(status, body) {
    return { status, text: async () => body };
}

function createContext(isContinuationMode = false) {
    const message = document.createElement('div');
    message.className = 'message assistant';
    if (isContinuationMode) message.dataset.isContinuation = 'true';
    message.innerHTML = '<div class="message-content"><p>上一轮的正文</p></div>';
    document.body.replaceChildren(message);
    return {
        sessionId: 'session-1',
        task: requestTaskRegistry.create({
            sessionId: 'session-1',
            abortController: new AbortController()
        }),
        assistantMessageEl: message,
        isContinuationMode,
        requestProfile: { modelDisplayName: 'model', providerName: 'Provider' }
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    requestTaskRegistry.clearForTests();
});

describe('handleHttpErrorResponse 错误响应体', () => {
    it('JSON 错误体原样交给错误展示', async () => {
        const body = { error: { message: 'max_tokens: 64000 > 32000' } };

        await handleHttpErrorResponse(textResponse(400, JSON.stringify(body)), createContext());

        expect(mocks.renderHumanizedError).toHaveBeenCalledWith(body, 400);
    });

    it('代理返回的纯文本作为原因保留', async () => {
        await handleHttpErrorResponse(
            textResponse(400, 'Bad Request: model not found\n'),
            createContext()
        );

        expect(mocks.renderHumanizedError).toHaveBeenCalledWith(
            { error: { message: 'Bad Request: model not found' } },
            400
        );
    });

    it('HTML 错误页只保留状态码', async () => {
        await handleHttpErrorResponse(
            textResponse(502, '<html><body>Bad gateway</body></html>'),
            createContext()
        );

        expect(mocks.renderHumanizedError).toHaveBeenCalledWith(
            { error: { message: 'HTTP 502' } },
            502
        );
    });
});

describe('handleHttpErrorResponse 续作轮', () => {
    it('错误渲染到新建的占位元素，上一轮的内容保留', async () => {
        const ctx = createContext(true);
        const reused = ctx.assistantMessageEl;

        await handleHttpErrorResponse(textResponse(500, '{"error":{"message":"oops"}}'), ctx);

        expect(reused.querySelector('.message-content').textContent).toContain('上一轮的正文');
        expect(reused.querySelector('.error-humanized')).toBeNull();
        expect(reused.nextElementSibling.querySelector('.error-humanized')).not.toBeNull();
        expect(mocks.saveAssistantMessageAsync).toHaveBeenCalledWith(
            [],
            expect.any(Object),
            expect.objectContaining({ isError: true })
        );
    });
});
