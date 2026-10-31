/**
 * api/error-handlers：续作轮出错不覆盖已有内容、后台错误提示带会话名
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
    state: {
        currentSessionId: 'session-1',
        currentAssistantMessage: null,
        backgroundTasks: new Map(),
        sessions: [{ id: 'session-2', name: '后台会话' }],
        isToolCallPending: false
    },
    saveAssistantMessageAsync: vi.fn(async () => 4),
    saveAssistantMessageToBackground: vi.fn(async () => false)
}));

vi.mock('../../js/core/state.js', () => ({
    state: mocks.state,
    elements: { messagesArea: null }
}));
vi.mock('../../js/core/events.js', () => ({ eventBus: { emit: vi.fn(), on: vi.fn() } }));
vi.mock('../../js/core/request-state-machine.js', () => ({
    requestStateMachine: {
        transition: vi.fn(),
        transitionFor: vi.fn(),
        cancel: vi.fn(),
        owns: vi.fn(() => true),
        abortController: null
    },
    RequestState: { ERROR: 'error', CANCELLED: 'cancelled' }
}));
vi.mock('../../js/core/state-mutations.js', () => ({
    clearToolCallContinuation: vi.fn(),
    clearImageRetry: vi.fn()
}));
vi.mock('../../js/messages/sync.js', () => ({
    saveAssistantMessageAsync: mocks.saveAssistantMessageAsync,
    saveAssistantMessageToBackground: mocks.saveAssistantMessageToBackground
}));
vi.mock('../../js/messages/dom-sync.js', () => ({ setCurrentMessageIndex: vi.fn() }));
vi.mock('../../js/utils/errors.js', () => ({
    renderHumanizedError: vi.fn(() => '<div class="error-humanized">错误</div>')
}));
vi.mock('../../js/utils/helpers.js', async (importOriginal) => ({
    ...(await importOriginal()),
    safeSetHTML: (element, html) => {
        element.innerHTML = html;
    }
}));
vi.mock('../../js/utils/logger.js', () => ({
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

import { handleGenericError } from '../../js/api/error-handlers/generic.js';
import { handleUserAbort } from '../../js/api/error-handlers/user-abort.js';
import { handleCrossSession } from '../../js/api/error-handlers/cross-session.js';
import { eventBus } from '../../js/core/events.js';
import { requestTaskRegistry } from '../../js/core/request-task-registry.js';

function createReusedMessage() {
    const message = document.createElement('div');
    message.className = 'message assistant';
    message.dataset.isContinuation = 'true';
    message.innerHTML = `
        <div class="message-content-wrapper">
            <div class="message-content">
                <p>上一轮的正文</p>
                <div class="tool-calls-group">工具调用</div>
                <div class="continuation-loading"></div>
            </div>
        </div>`;
    document.body.replaceChildren(message);
    return message;
}

function createContext(overrides = {}) {
    const task = requestTaskRegistry.create({
        sessionId: 'session-1',
        abortController: new AbortController()
    });
    return {
        sessionId: 'session-1',
        task,
        abortController: task.abortController,
        assistantMessageEl: createReusedMessage(),
        isContinuationMode: true,
        requestProfile: { modelDisplayName: 'model', providerName: 'Provider' },
        ...overrides
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    requestTaskRegistry.clearForTests();
    mocks.state.currentSessionId = 'session-1';
});

describe('handleGenericError 续作轮', () => {
    it('错误渲染到新建的占位元素，原消息的工具调用与正文保留', async () => {
        const ctx = createContext();
        const reused = ctx.assistantMessageEl;

        await handleGenericError({ displayError: new Error('boom') }, ctx);

        expect(reused.querySelector('.tool-calls-group')).not.toBeNull();
        expect(reused.querySelector('.error-humanized')).toBeNull();
        const errorMessageEl = reused.nextElementSibling;
        expect(errorMessageEl.querySelector('.error-humanized')).not.toBeNull();
        expect(ctx.task.assistantMessageEl).toBe(errorMessageEl);
        expect(mocks.saveAssistantMessageAsync).toHaveBeenCalledWith(
            [],
            expect.any(Object),
            expect.objectContaining({ isError: true })
        );
    });

    it('首轮请求照旧把错误写进占位元素', async () => {
        const ctx = createContext({ isContinuationMode: false });
        const placeholder = ctx.assistantMessageEl;

        await handleGenericError({ displayError: new Error('boom') }, ctx);

        expect(placeholder.querySelector('.error-humanized')).not.toBeNull();
        expect(placeholder.nextElementSibling).toBeNull();
    });
});

describe('handleUserAbort 续作轮', () => {
    it('没收到内容时只在末尾追加取消提示，不清空上一轮的内容', async () => {
        const ctx = createContext();
        const content = ctx.assistantMessageEl.querySelector('.message-content');

        await handleUserAbort({ isCrossSession: false, displayError: { name: 'AbortError' } }, ctx);

        expect(content.querySelector('.tool-calls-group')).not.toBeNull();
        expect(content.querySelector('.continuation-loading')).toBeNull();
        expect(content.lastElementChild.textContent).toContain('请求已取消');
    });

    it('首轮请求没收到内容时整体显示取消提示', async () => {
        const ctx = createContext({ isContinuationMode: false });
        const content = ctx.assistantMessageEl.querySelector('.message-content');

        await handleUserAbort({ isCrossSession: false, displayError: { name: 'AbortError' } }, ctx);

        expect(content.querySelector('.tool-calls-group')).toBeNull();
        expect(content.textContent).toContain('请求已取消');
    });
});

describe('handleCrossSession', () => {
    it('错误没能写回原会话时提示带会话名', async () => {
        const ctx = createContext({ sessionId: 'session-2', isContinuationMode: false });

        await handleCrossSession({ displayError: new Error('boom') }, ctx);

        expect(eventBus.emit).toHaveBeenCalledWith(
            'ui:notification',
            expect.objectContaining({ message: expect.stringContaining('「后台会话」') })
        );
    });
});
