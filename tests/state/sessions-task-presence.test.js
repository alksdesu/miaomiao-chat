/**
 * sessions.js 与会话任务锁：任务期间持锁、落库后释放，其他标签页执行中不老化，对方结束后同步
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
    holdSessionTaskLock: vi.fn(() => true),
    refreshSessionTaskActivity: vi.fn(async () => false),
    loadSessionMessageWindow: vi.fn(() => Promise.resolve(null)),
    getCurrentSessionMessagesSnapshot: vi.fn(() => Promise.resolve([])),
    materializeSessionMessages: vi.fn((_sessionId, messages) => Promise.resolve(messages))
}));

vi.mock('../../js/state/session-task-presence.js', () => ({
    holdSessionTaskLock: mocks.holdSessionTaskLock,
    refreshSessionTaskActivity: mocks.refreshSessionTaskActivity
}));
vi.mock('../../js/core/state.js', () => ({
    state: {
        sessions: [],
        messages: [],
        currentSessionId: null,
        apiFormat: 'openai',
        storageMode: 'indexedDB',
        sessionDirty: false,
        isLoading: false,
        isSending: false,
        isSwitchingSession: false,
        editingElement: null,
        backgroundTasks: new Map(),
        currentAssistantMessage: null,
        prefillMessages: []
    }
}));
vi.mock('../../js/core/elements.js', () => ({
    isElementsInitialized: vi.fn(() => false)
}));
vi.mock('../../js/core/events.js', () => ({
    eventBus: { emit: vi.fn(), on: vi.fn() }
}));
vi.mock('../../js/state/storage.js', () => ({
    saveSessionToDB: vi.fn(() => Promise.resolve()),
    loadAllSessionsFromDB: vi.fn(() => Promise.resolve([])),
    deleteSessionFromDB: vi.fn(() => Promise.resolve()),
    migrateFromLocalStorage: vi.fn(() => Promise.resolve()),
    savePreference: vi.fn(() => Promise.resolve()),
    loadPreference: vi.fn(() => Promise.resolve(null)),
    loadSessionMessages: vi.fn(() => Promise.resolve(null)),
    loadSessionMetaFromDB: vi.fn(() => Promise.resolve(null)),
    saveSessionMessages: vi.fn(() => Promise.resolve()),
    saveSessionAtomic: vi.fn(() => Promise.resolve()),
    saveSessionSearchIndex: vi.fn(() => Promise.resolve()),
    saveEmergencySessionSnapshot: vi.fn(() => true),
    loadEmergencySessionSnapshot: vi.fn(() => null),
    clearEmergencySessionSnapshot: vi.fn(),
    SessionConflictError: class SessionConflictError extends Error {}
}));
vi.mock('../../js/utils/helpers.js', () => ({
    generateSessionId: vi.fn(() => 'session_test_123'),
    generateSessionName: vi.fn((content) => content || '新会话')
}));
vi.mock('../../js/messages/restore.js', () => ({
    renderSessionMessages: vi.fn()
}));
vi.mock('../../js/core/state-mutations.js', () => ({
    replaceAllMessages: vi.fn()
}));
vi.mock('../../js/core/request-state-machine.js', () => ({
    requestStateMachine: {
        isBusy: vi.fn(() => false),
        cancel: vi.fn(),
        forceReset: vi.fn(),
        clearSendLockTimeout: vi.fn(),
        detach: vi.fn(() => true),
        attach: vi.fn(() => true),
        owns: vi.fn(() => false),
        abortController: null
    }
}));
vi.mock('../../js/state/tab-sync.js', () => ({
    broadcastEvent: vi.fn()
}));
vi.mock('../../js/state/session-search-index.js', () => ({
    buildSessionSearchIndexAsync: vi.fn(() => Promise.resolve({}))
}));
vi.mock('../../js/state/session-message-repository.js', () => ({
    loadSessionMessageWindow: mocks.loadSessionMessageWindow,
    getCurrentSessionMessagesSnapshot: mocks.getCurrentSessionMessagesSnapshot,
    materializeSessionMessages: mocks.materializeSessionMessages
}));
vi.mock('../../js/messages/schema.js', () => ({
    getTextContent: vi.fn((msg) => msg?.content || ''),
    agePendingToolCallsInPlace: vi.fn(() => 0)
}));
vi.mock('../../js/state/video-persistence.js', () => ({
    replaceVideoDataUrlsDeep: vi.fn(() => Promise.resolve()),
    isElectronIpcAvailable: vi.fn(() => false),
    isAndroidFilesystemAvailable: vi.fn(() => false)
}));
vi.mock('../../js/utils/logger.js', () => ({
    logger: { warn: vi.fn(), debug: vi.fn(), error: vi.fn(), info: vi.fn() }
}));

import { state } from '../../js/core/state.js';
import { eventBus } from '../../js/core/events.js';
import { EVENTS } from '../../js/core/events-registry.js';
import { isElementsInitialized } from '../../js/core/elements.js';
import { requestTaskRegistry } from '../../js/core/request-task-registry.js';
import { replaceAllMessages } from '../../js/core/state-mutations.js';
import { agePendingToolCallsInPlace } from '../../js/messages/schema.js';
import { renderSessionMessages } from '../../js/messages/restore.js';
import { loadSessionMessages, saveSessionAtomic } from '../../js/state/storage.js';
import {
    debouncedSaveSession,
    reloadCurrentSessionMessages,
    switchToSession
} from '../../js/state/sessions.js';

// 模块级监听在 import 时注册，clearAllMocks 前先取出
const listeners = new Map(eventBus.on.mock.calls.map(([event, handler]) => [event, handler]));

function deferred() {
    let resolve;
    const promise = new Promise((res) => {
        resolve = res;
    });
    return { promise, resolve };
}

async function flushMicrotasks() {
    for (let i = 0; i < 30; i++) await Promise.resolve();
}

const pendingToolMessage = {
    id: 'a-tools',
    role: 'assistant',
    ts: 1,
    parts: [{ type: 'tool_call', id: 'call_1', name: 'bash', args: {}, state: 'pending' }]
};

beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    requestTaskRegistry.clearForTests();
    state.sessions = [
        { id: 's1', name: 'S1', updatedAt: 1 },
        { id: 's2', name: 'S2', updatedAt: 1 },
        { id: 's3', name: 'S3', updatedAt: 1 }
    ];
    state.messages = [];
    state.currentSessionId = 's1';
    state.sessionDirty = false;
    state.isSwitchingSession = false;
    state.editingIndex = null;
    state._lastKnownSessionUpdatedAt = new Map();
    mocks.refreshSessionTaskActivity.mockResolvedValue(false);
    mocks.getCurrentSessionMessagesSnapshot.mockImplementation(() =>
        Promise.resolve([...state.messages])
    );
    loadSessionMessages.mockResolvedValue({ messages: [pendingToolMessage] });
    document.body.innerHTML = '';
});

afterEach(() => {
    vi.useRealTimers();
});

describe('任务期间持有会话任务锁', () => {
    it('任务创建即持锁，任务结束后先把防抖中的保存落库再释放', async () => {
        const completion = deferred();
        const save = deferred();
        saveSessionAtomic.mockReturnValueOnce(save.promise);
        state.messages = [{ id: 'u1', role: 'user', content: 'hi' }];
        state.sessionDirty = true;
        debouncedSaveSession();

        listeners.get(EVENTS.REQUEST_TASK_CREATED)({
            task: { sessionId: 's1', completionPromise: completion.promise }
        });

        expect(mocks.holdSessionTaskLock).toHaveBeenCalledWith('s1', expect.any(Promise));
        let released = false;
        mocks.holdSessionTaskLock.mock.calls[0][1].then(() => {
            released = true;
        });

        completion.resolve({ phase: 'completed' });
        await flushMicrotasks();
        // 防抖定时器没走，任务结束时直接触发了保存
        expect(saveSessionAtomic).toHaveBeenCalledTimes(1);
        expect(released).toBe(false);

        save.resolve();
        await flushMicrotasks();
        expect(released).toBe(true);
    });

    it('缺少会话或完成信号的任务不持锁', () => {
        listeners.get(EVENTS.REQUEST_TASK_CREATED)({ task: { sessionId: 's1' } });
        listeners.get(EVENTS.REQUEST_TASK_CREATED)({});

        expect(mocks.holdSessionTaskLock).not.toHaveBeenCalled();
    });
});

describe('其他标签页执行中不老化未完成的工具调用', () => {
    it('切换会话时对方仍在执行：不老化，不标记待保存', async () => {
        mocks.refreshSessionTaskActivity.mockResolvedValue(true);

        await switchToSession('s2', false);

        expect(mocks.refreshSessionTaskActivity).toHaveBeenCalledWith('s2');
        expect(agePendingToolCallsInPlace).not.toHaveBeenCalled();
        expect(state.sessionDirty).toBe(false);
        expect(replaceAllMessages).toHaveBeenCalledWith([pendingToolMessage]);
    });

    it('切换会话时没有其他标签页在执行：照常老化', async () => {
        await switchToSession('s2', false);

        expect(agePendingToolCallsInPlace).toHaveBeenCalledWith(
            [pendingToolMessage],
            expect.objectContaining({ nowMs: expect.any(Number) })
        );
    });

    it('查询期间被新的切换打断时放弃本次切换', async () => {
        const slowQuery = deferred();
        mocks.refreshSessionTaskActivity.mockImplementation((sessionId) =>
            sessionId === 's2' ? slowQuery.promise : Promise.resolve(false)
        );
        const s3Messages = [{ id: 'a-s3', role: 'assistant', parts: [] }];
        loadSessionMessages.mockImplementation((sessionId) =>
            Promise.resolve({ messages: sessionId === 's3' ? s3Messages : [pendingToolMessage] })
        );

        const first = switchToSession('s2', false);
        await flushMicrotasks();
        const second = switchToSession('s3', false);
        slowQuery.resolve(true);
        await Promise.all([first, second]);

        expect(replaceAllMessages).toHaveBeenCalledTimes(1);
        expect(replaceAllMessages).toHaveBeenCalledWith(s3Messages);
        expect(state.currentSessionId).toBe('s3');
    });

    it('重载时对方仍在执行：不老化也不落库', async () => {
        mocks.refreshSessionTaskActivity.mockResolvedValue(true);
        agePendingToolCallsInPlace.mockReturnValue(1);

        const synced = await reloadCurrentSessionMessages();

        expect(synced).toBe(true);
        expect(agePendingToolCallsInPlace).not.toHaveBeenCalled();
        expect(saveSessionAtomic).not.toHaveBeenCalled();
        agePendingToolCallsInPlace.mockReturnValue(0);
    });

    it('本页自己有任务时不查询其他标签页', async () => {
        requestTaskRegistry.create({ sessionId: 's1', abortController: new AbortController() });

        await reloadCurrentSessionMessages({ discardLocalChanges: true });

        expect(mocks.refreshSessionTaskActivity).not.toHaveBeenCalled();
    });
});

describe('其他标签页的任务结束后同步', () => {
    const handleRemoteEnded = (payload) => listeners.get(EVENTS.SESSION_REMOTE_TASK_ENDED)(payload);

    it('当前会话没有本地改动时从存储重载', async () => {
        handleRemoteEnded({ sessionId: 's1' });
        await flushMicrotasks();

        expect(loadSessionMessages).toHaveBeenCalledWith('s1');
        expect(renderSessionMessages).toHaveBeenCalled();
    });

    it('不是当前会话或本页有该会话的任务时不处理', async () => {
        handleRemoteEnded({ sessionId: 's2' });
        requestTaskRegistry.create({ sessionId: 's1', abortController: new AbortController() });
        handleRemoteEnded({ sessionId: 's1' });
        await flushMicrotasks();

        expect(loadSessionMessages).not.toHaveBeenCalled();
    });

    it('有未保存改动时不重载，只按本页内容重绘最后一条助手消息', async () => {
        isElementsInitialized.mockReturnValue(true);
        state.sessionDirty = true;
        state.messages = [
            { id: 'u1', role: 'user', parts: [] },
            { id: 'a1', role: 'assistant', parts: [] }
        ];
        const messagesArea = document.createElement('div');
        messagesArea.id = 'messages';
        const messageEl = document.createElement('div');
        messageEl.className = 'message assistant';
        messageEl.dataset.messageId = 'a1';
        messagesArea.appendChild(messageEl);
        document.body.appendChild(messagesArea);

        handleRemoteEnded({ sessionId: 's1' });
        await flushMicrotasks();

        expect(loadSessionMessages).not.toHaveBeenCalled();
        expect(eventBus.emit).toHaveBeenCalledWith('message:content-updated', {
            messageEl,
            index: 1,
            role: 'assistant'
        });
        isElementsInitialized.mockReturnValue(false);
    });
});
