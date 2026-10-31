/**
 * stream/sink.js DefaultSink 测试：落库后释放回放内容、工具调用锚点
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    saveAssistantMessage: vi.fn(() => 3),
    saveAssistantMessageAsync: vi.fn(async () => 3),
    handleToolCallStream: vi.fn(async () => undefined)
}));

vi.mock('../../js/core/state.js', () => ({
    state: {
        currentSessionId: 'session-a',
        currentAssistantMessage: null,
        isToolCallPending: false,
        backgroundTasks: new Map(),
        sessions: []
    }
}));
vi.mock('../../js/core/events.js', () => ({
    eventBus: { emit: vi.fn(), on: vi.fn() }
}));
vi.mock('../../js/utils/logger.js', () => ({
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));
vi.mock('../../js/stream/helpers.js', () => ({
    updateStreamingMessage: vi.fn(),
    renderFinalContentWithThinking: vi.fn(),
    renderFinalTextWithThinking: vi.fn()
}));
vi.mock('../../js/stream/stats.js', () => ({
    appendStreamStats: vi.fn()
}));
vi.mock('../../js/messages/render-stop-notice.js', () => ({
    appendStopNotice: vi.fn()
}));
vi.mock('../../js/state/stream-snapshot.js', () => ({
    saveStreamSnapshotThrottled: vi.fn(),
    clearStreamSnapshot: vi.fn()
}));
vi.mock('../../js/messages/sync.js', () => ({
    saveAssistantMessage: mocks.saveAssistantMessage,
    saveAssistantMessageAsync: mocks.saveAssistantMessageAsync
}));
vi.mock('../../js/messages/dom-sync.js', () => ({
    setCurrentMessageIndex: vi.fn()
}));
vi.mock('../../js/tools/orchestrator.js', () => ({
    handleToolCallStream: mocks.handleToolCallStream,
    startPauseTurnContinuation: vi.fn(async () => undefined)
}));
vi.mock('../../js/core/request-state-machine.js', () => ({
    requestStateMachine: { transition: vi.fn(), transitionFor: vi.fn() },
    RequestState: { TOOL_CALLING: 'tool_calling', ERROR: 'error' }
}));

import { state } from '../../js/core/state.js';
import { requestTaskRegistry } from '../../js/core/request-task-registry.js';
import { DefaultSink } from '../../js/stream/sink.js';

const PARTS = [{ type: 'text', text: 'hello' }];
const ERROR_INFO = { errorCode: 'network', errorMessage: 'boom', errorHtml: '<div></div>' };

function createTask(sessionId = 'session-a') {
    return requestTaskRegistry.create({ sessionId, abortController: new AbortController() });
}

function createAssistantMessage() {
    const messageEl = document.createElement('div');
    messageEl.className = 'message assistant';
    const contentEl = document.createElement('div');
    contentEl.className = 'message-content';
    messageEl.appendChild(contentEl);
    document.body.appendChild(messageEl);
    return { messageEl, contentEl };
}

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

beforeEach(() => {
    vi.clearAllMocks();
    requestTaskRegistry.clearForTests();
    state.currentSessionId = 'session-a';
    state.currentAssistantMessage = null;
    state.isToolCallPending = false;
    state.backgroundTasks = new Map();
    mocks.saveAssistantMessage.mockReturnValue(3);
    mocks.saveAssistantMessageAsync.mockResolvedValue(3);
    document.body.replaceChildren();
});

describe('落库后释放切回会话用的回放内容', () => {
    it('前台落库后立即释放', () => {
        const task = createTask();
        const sink = new DefaultSink('session-a', task);
        sink.streamingUpdate('hello', 'thinking');
        expect(task.partialRender).toEqual({ textContent: 'hello', thinkingContent: 'thinking' });

        sink.commit(PARTS, {}, {});

        expect(task.partialRender).toBeNull();
    });

    it('前台错误落库后同样释放', () => {
        const task = createTask();
        const sink = new DefaultSink('session-a', task);
        sink.streamingUpdate('partial', '');

        sink.commitError(PARTS, {}, {}, ERROR_INFO);

        expect(task.partialRender).toBeNull();
    });

    it('后台落库要等写入完成才释放，切回时不会两头落空', async () => {
        const save = deferred();
        mocks.saveAssistantMessageAsync.mockReturnValueOnce(save.promise);
        const task = createTask();
        requestTaskRegistry.detach(task);
        state.currentSessionId = 'session-b';
        const sink = new DefaultSink('session-a', task);
        sink.streamingUpdate('hello', '');

        expect(sink.commit(PARTS, {}, {})).toBe(-1);
        await Promise.resolve();
        expect(task.partialRender).toEqual({ textContent: 'hello', thinkingContent: '' });

        save.resolve(3);
        await vi.waitFor(() => expect(task.partialRender).toBeNull());
    });

    it('后台写入失败也释放，不残留过期内容', async () => {
        const save = deferred();
        mocks.saveAssistantMessageAsync.mockReturnValueOnce(save.promise);
        const task = createTask();
        requestTaskRegistry.detach(task);
        state.currentSessionId = 'session-b';
        const sink = new DefaultSink('session-a', task);
        sink.streamingUpdate('partial', '');

        sink.commitError(PARTS, {}, {}, ERROR_INFO);
        save.reject(new Error('quota'));

        await vi.waitFor(() => expect(task.partialRender).toBeNull());
        await expect(sink.waitForCommits()).rejects.toThrow('quota');
    });

    it('写入完成前下一轮已开始流式时保留下一轮的内容', async () => {
        const save = deferred();
        mocks.saveAssistantMessageAsync.mockReturnValueOnce(save.promise);
        const task = createTask();
        requestTaskRegistry.detach(task);
        state.currentSessionId = 'session-b';
        const sink = new DefaultSink('session-a', task);
        sink.streamingUpdate('round 1', '');
        sink.commit(PARTS, {}, {});

        const nextRound = new DefaultSink('session-a', task);
        nextRound.streamingUpdate('round 2', '');
        save.resolve(3);
        await sink.waitForCommits();
        await Promise.resolve();

        expect(task.partialRender).toEqual({ textContent: 'round 2', thinkingContent: '' });
    });
});

describe('triggerToolCalls 锚点', () => {
    const toolCalls = [{ id: 'call_1', name: 'calculator', arguments: {} }];

    it('后台任务没有自己的锚点时不借用前台会话的元素', async () => {
        const foreground = createAssistantMessage();
        state.currentAssistantMessage = foreground.contentEl;
        const task = createTask('session-a');
        requestTaskRegistry.detach(task);
        state.currentSessionId = 'session-b';
        const sink = new DefaultSink('session-a', task);

        sink.triggerToolCalls(toolCalls);

        await vi.waitFor(() => expect(mocks.handleToolCallStream).toHaveBeenCalledTimes(1));
        expect(mocks.handleToolCallStream).toHaveBeenCalledWith(toolCalls, {
            assistantMessageEl: null,
            sourceSessionId: 'session-a',
            task
        });
        expect(state.isToolCallPending).toBe(false);
        expect(task.isToolCallPending).toBe(true);
    });

    it('任务有锚点时使用任务自己的元素', async () => {
        const own = createAssistantMessage();
        const foreground = createAssistantMessage();
        state.currentAssistantMessage = foreground.contentEl;
        const task = createTask('session-a');
        requestTaskRegistry.setAssistantElement(task, own.contentEl);
        const sink = new DefaultSink('session-a', task);

        sink.triggerToolCalls(toolCalls);

        await vi.waitFor(() => expect(mocks.handleToolCallStream).toHaveBeenCalledTimes(1));
        expect(mocks.handleToolCallStream.mock.calls[0][1].assistantMessageEl).toBe(own.messageEl);
    });

    it('没有任务的旧调用方仍读当前助手消息', async () => {
        const foreground = createAssistantMessage();
        state.currentAssistantMessage = foreground.contentEl;
        const sink = new DefaultSink('session-a', null);

        sink.triggerToolCalls(toolCalls);

        await vi.waitFor(() => expect(mocks.handleToolCallStream).toHaveBeenCalledTimes(1));
        expect(mocks.handleToolCallStream.mock.calls[0][1].assistantMessageEl).toBe(
            foreground.messageEl
        );
    });
});
