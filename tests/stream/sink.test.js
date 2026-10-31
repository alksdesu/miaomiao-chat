/**
 * stream/sink.js DefaultSink 测试：续作挂起标记、并发等待提交、续作启动失败收口、续作轮错误改写目标
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../js/core/state.js', () => ({
    state: {
        currentSessionId: 'session-1',
        currentAssistantMessage: null,
        isToolCallPending: false,
        backgroundTasks: new Map(),
        sessions: []
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
vi.mock('../../js/core/request-state-machine.js', () => ({
    requestStateMachine: { transition: vi.fn(), transitionFor: vi.fn() },
    RequestState: { TOOL_CALLING: 'tool_calling', ERROR: 'error' }
}));
vi.mock('../../js/utils/logger.js', () => ({
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

import { DefaultSink } from '../../js/stream/sink.js';
import { state } from '../../js/core/state.js';
import { requestTaskRegistry } from '../../js/core/request-task-registry.js';
import { saveAssistantMessageAsync } from '../../js/messages/sync.js';
import { disposeStreamRenderSession } from '../../js/stream/helpers.js';
import {
    handleToolCallStream,
    startPauseTurnContinuation,
    finishToolTask
} from '../../js/tools/orchestrator.js';
import { splitContinuationErrorPlaceholder } from '../../js/api/placeholder-resolver.js';

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

function createTask(sessionId = 'session-1') {
    return requestTaskRegistry.create({ sessionId, abortController: new AbortController() });
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
    vi.clearAllMocks();
    requestTaskRegistry.clearForTests();
    state.currentSessionId = 'session-1';
    state.backgroundTasks = new Map();
});

describe('waitForCommits', () => {
    it('并发等待者都等到同一批提交完成，不会互相把待提交项移走', async () => {
        const sink = new DefaultSink('session-1', null);
        const commit = deferred();
        sink.pendingCommits.push(commit.promise);
        let firstDone = false;
        let secondDone = false;

        const first = sink.waitForCommits().then(() => (firstDone = true));
        const second = sink.waitForCommits().then(() => (secondDone = true));
        await flush();
        expect(firstDone).toBe(false);
        expect(secondDone).toBe(false);

        commit.resolve();
        await Promise.all([first, second]);
        expect(sink.pendingCommits).toEqual([]);
    });

    it('提交失败时每个等待者都收到错误', async () => {
        const sink = new DefaultSink('session-1', null);
        const commit = deferred();
        sink.pendingCommits.push(commit.promise);

        const first = sink.waitForCommits();
        const second = sink.waitForCommits();
        commit.reject(new Error('写入失败'));

        await expect(first).rejects.toThrow('写入失败');
        await expect(second).rejects.toThrow('写入失败');
        expect(sink.pendingCommits).toEqual([]);
    });

    it('等待期间新加入的提交不会被提前移走', async () => {
        const sink = new DefaultSink('session-1', null);
        const first = deferred();
        const second = deferred();
        sink.pendingCommits.push(first.promise);
        const waiting = sink.waitForCommits();
        sink.pendingCommits.push(second.promise);

        first.resolve();
        await waiting;
        expect(sink.pendingCommits).toEqual([second.promise]);
        second.resolve();
    });
});

describe('triggerPauseTurnResend', () => {
    it('同步挂起任务，续作在提交落库后才发起', async () => {
        const task = createTask();
        const sink = new DefaultSink('session-1', task);
        const commit = deferred();
        sink.pendingCommits.push(commit.promise);

        sink.triggerPauseTurnResend(null);

        expect(task.isToolCallPending).toBe(true);
        expect(task.phase).toBe('tool_calling');
        await flush();
        expect(startPauseTurnContinuation).not.toHaveBeenCalled();

        commit.resolve();
        await flush();
        expect(startPauseTurnContinuation).toHaveBeenCalledWith(null, 'session-1', task);
    });

    it('后台会话：handler 等待提交时不会抢走续作要等的提交，任务保持挂起', async () => {
        const task = createTask('session-2');
        requestTaskRegistry.detach(task);
        const sink = new DefaultSink('session-2', task);
        const commit = deferred();
        saveAssistantMessageAsync.mockReturnValueOnce(commit.promise);

        sink.commit([], {}, {});
        sink.triggerPauseTurnResend(null);
        let handlerDone = false;
        const handlerWait = sink.waitForCommits().then(() => (handlerDone = true));
        await flush();

        expect(handlerDone).toBe(false);
        expect(task.isToolCallPending).toBe(true);
        expect(requestTaskRegistry.isActive(task)).toBe(true);

        commit.resolve('saved');
        await handlerWait;
        await flush();
        expect(startPauseTurnContinuation).toHaveBeenCalledWith(null, 'session-2', task);
    });

    it('提交失败、续作没能发起时按出错结束任务', async () => {
        const task = createTask();
        const sink = new DefaultSink('session-1', task);
        const commit = deferred();
        sink.pendingCommits.push(commit.promise);
        const error = new Error('写入失败');

        sink.triggerPauseTurnResend(null);
        commit.reject(error);
        await flush();

        expect(startPauseTurnContinuation).not.toHaveBeenCalled();
        expect(finishToolTask).toHaveBeenCalledWith(task, 'error', error);
    });
});

describe('triggerToolCalls', () => {
    it('提交失败、工具流程没能启动时按出错结束任务', async () => {
        const task = createTask();
        const sink = new DefaultSink('session-1', task);
        const commit = deferred();
        sink.pendingCommits.push(commit.promise);
        const error = new Error('写入失败');

        sink.triggerToolCalls([{ id: 'tc_1', name: 'search', arguments: {} }]);
        expect(task.isToolCallPending).toBe(true);
        commit.reject(error);
        await flush();

        expect(handleToolCallStream).not.toHaveBeenCalled();
        expect(finishToolTask).toHaveBeenCalledWith(task, 'error', error);
    });
});

describe('beginErrorReply', () => {
    it('前台续作轮：取消残留渲染并把任务的渲染目标换成新建的占位元素', () => {
        const task = createTask();
        task.isSavingContinuation = true;
        const reused = { closest: () => reused };
        const errorMessageEl = { classList: { contains: () => true } };
        requestTaskRegistry.setAssistantElement(task, reused);
        splitContinuationErrorPlaceholder.mockReturnValueOnce(errorMessageEl);
        const sink = new DefaultSink('session-1', task);

        sink.beginErrorReply();

        expect(disposeStreamRenderSession).toHaveBeenCalledWith(task);
        expect(splitContinuationErrorPlaceholder).toHaveBeenCalledWith(reused);
        expect(task.assistantMessageEl).toBe(errorMessageEl);
    });

    it('非续作轮或后台会话不改写渲染目标', () => {
        const firstRound = createTask();
        new DefaultSink('session-1', firstRound).beginErrorReply();

        const background = createTask('session-2');
        background.isSavingContinuation = true;
        new DefaultSink('session-2', background).beginErrorReply();

        expect(splitContinuationErrorPlaceholder).not.toHaveBeenCalled();
    });
});
