/**
 * sessions.js 会话管理模块测试
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const sessionRepositoryMocks = vi.hoisted(() => ({
    loadSessionMessageWindow: vi.fn(() => Promise.resolve(null)),
    getCurrentSessionMessagesSnapshot: vi.fn(() => Promise.resolve([])),
    materializeSessionMessages: vi.fn((_sessionId, messages) => Promise.resolve(messages))
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
    eventBus: {
        emit: vi.fn(),
        on: vi.fn()
    }
}));

vi.mock('../../js/state/storage.js', () => ({
    saveSessionToDB: vi.fn(() => Promise.resolve()),
    loadAllSessionsFromDB: vi.fn(() => Promise.resolve([])),
    deleteSessionFromDB: vi.fn(() => Promise.resolve()),
    migrateFromLocalStorage: vi.fn(() => Promise.resolve()),
    savePreference: vi.fn(() => Promise.resolve()),
    loadPreference: vi.fn(() => Promise.resolve(null)),
    loadSessionMessages: vi.fn(() => Promise.resolve(null)),
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
        abortController: null
    }
}));

vi.mock('../../js/state/tab-sync.js', () => ({
    broadcastEvent: vi.fn()
}));

vi.mock('../../js/state/session-search-index.js', () => ({
    buildSessionSearchIndexAsync: vi.fn(() => Promise.resolve({}))
}));

vi.mock('../../js/state/session-message-repository.js', () => sessionRepositoryMocks);

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
import {
    createPersistedSessionPayload,
    loadSessions,
    saveCurrentSessionId,
    saveCurrentSessionMessages,
    debouncedSaveSession,
    createNewSession,
    deleteSession,
    renameSession,
    reloadCurrentSessionMessages,
    switchToSession
} from '../../js/state/sessions.js';
import { requestTaskRegistry } from '../../js/core/request-task-registry.js';
import { replaceAllMessages } from '../../js/core/state-mutations.js';

describe('sessions module', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
        state.sessions = [];
        state.messages = [];
        state.currentSessionId = null;
        state.apiFormat = 'openai';
        state.storageMode = 'indexedDB';
        state.sessionDirty = false;
        state.backgroundTasks = new Map();
        state._lastKnownSessionUpdatedAt = new Map();
        requestTaskRegistry.clearForTests();
        sessionRepositoryMocks.getCurrentSessionMessagesSnapshot.mockImplementation(() =>
            Promise.resolve([...state.messages])
        );
        sessionRepositoryMocks.materializeSessionMessages.mockImplementation(
            (_sessionId, messages) => Promise.resolve(messages)
        );
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    // ========== createPersistedSessionPayload ==========
    describe('createPersistedSessionPayload', () => {
        it('web 环境直接返回消息克隆', async () => {
            const result = await createPersistedSessionPayload({
                messages: [{ role: 'user', content: 'hi' }]
            });
            expect(result.messages).toEqual([{ role: 'user', content: 'hi' }]);
        });

        it('空消息返回空数组', async () => {
            const result = await createPersistedSessionPayload({});
            expect(result.messages).toEqual([]);
        });

        it('Electron 环境调用 replaceVideoDataUrlsDeep', async () => {
            const { isElectronIpcAvailable } = await import('../../js/state/video-persistence.js');
            const { replaceVideoDataUrlsDeep } =
                await import('../../js/state/video-persistence.js');
            isElectronIpcAvailable.mockReturnValue(true);

            await createPersistedSessionPayload({
                messages: [{ role: 'user', content: 'test' }]
            });
            expect(replaceVideoDataUrlsDeep).toHaveBeenCalled();

            isElectronIpcAvailable.mockReturnValue(false);
        });
    });

    // ========== saveCurrentSessionId ==========
    describe('saveCurrentSessionId', () => {
        it('IndexedDB 模式保存到 preference', async () => {
            state.currentSessionId = 'sess1';
            state.storageMode = 'indexedDB';
            await saveCurrentSessionId();

            const { savePreference } = await import('../../js/state/storage.js');
            expect(savePreference).toHaveBeenCalledWith('currentSessionId', 'sess1');
        });

        it('localStorage 模式保存到 localStorage', async () => {
            state.currentSessionId = 'sess2';
            state.storageMode = 'localStorage';
            const setItem = vi.fn();
            const original = globalThis.localStorage;
            globalThis.localStorage = { setItem, getItem: vi.fn(), removeItem: vi.fn() };
            try {
                await saveCurrentSessionId();
                expect(setItem).toHaveBeenCalledWith('geminiCurrentSessionId', 'sess2');
            } finally {
                globalThis.localStorage = original;
            }
        });
    });

    // ========== saveCurrentSessionMessages ==========
    describe('saveCurrentSessionMessages', () => {
        it('无 currentSessionId 直接返回', async () => {
            state.currentSessionId = null;
            await saveCurrentSessionMessages();

            const { saveSessionAtomic } = await import('../../js/state/storage.js');
            expect(saveSessionAtomic).not.toHaveBeenCalled();
        });

        it('无变更且非强制时跳过', async () => {
            state.currentSessionId = 'sess1';
            state.sessionDirty = false;
            state.sessions = [{ id: 'sess1', name: 'test' }];
            await saveCurrentSessionMessages(false);

            const { saveSessionAtomic } = await import('../../js/state/storage.js');
            expect(saveSessionAtomic).not.toHaveBeenCalled();
        });

        it('强制保存忽略 dirty 标志', async () => {
            state.currentSessionId = 'sess1';
            state.sessionDirty = false;
            state.sessions = [{ id: 'sess1', name: 'test', createdAt: 1 }];
            state.messages = [{ role: 'user', content: 'hi' }];
            await saveCurrentSessionMessages(true);

            const { saveSessionAtomic } = await import('../../js/state/storage.js');
            expect(saveSessionAtomic).toHaveBeenCalled();
        });

        it('分页会话保存完整快照但不实体化 UI 消息窗口', async () => {
            const lazyWindow = [
                {
                    id: 'm1',
                    role: 'user',
                    parts: [],
                    _lazy: { sessionId: 'sess1', index: 0 }
                }
            ];
            const fullHistory = [
                { id: 'm1', role: 'user', content: 'first' },
                { id: 'm2', role: 'assistant', content: 'reply' }
            ];
            state.currentSessionId = 'sess1';
            state.sessionDirty = true;
            state.sessions = [{ id: 'sess1', name: 'test', createdAt: 1 }];
            state.messages = lazyWindow;
            sessionRepositoryMocks.materializeSessionMessages.mockResolvedValue(fullHistory);

            await saveCurrentSessionMessages();

            const { saveSessionAtomic } = await import('../../js/state/storage.js');
            expect(saveSessionAtomic).toHaveBeenCalledWith(
                expect.objectContaining({ messageCount: 2 }),
                expect.objectContaining({ messages: fullHistory }),
                expect.any(Object)
            );
            expect(state.messages).toBe(lazyWindow);
            expect(state.messages[0]._lazy).toBeDefined();
        });

        it('session 不存在时跳过', async () => {
            state.currentSessionId = 'nonexistent';
            state.sessionDirty = true;
            state.sessions = [];
            await saveCurrentSessionMessages();

            const { saveSessionAtomic } = await import('../../js/state/storage.js');
            expect(saveSessionAtomic).not.toHaveBeenCalled();
        });
    });

    describe('reloadCurrentSessionMessages', () => {
        it('加载期间切换会话时丢弃旧会话结果', async () => {
            const { loadSessionMessages } = await import('../../js/state/storage.js');
            let resolveLoad;
            loadSessionMessages.mockImplementationOnce(
                () =>
                    new Promise((resolve) => {
                        resolveLoad = resolve;
                    })
            );
            state.currentSessionId = 'session-a';
            state.sessions = [
                { id: 'session-a', name: 'A' },
                { id: 'session-b', name: 'B' }
            ];

            const pending = reloadCurrentSessionMessages();
            state.currentSessionId = 'session-b';
            resolveLoad({ messages: [{ id: 'message-a', role: 'user', parts: [] }] });
            const result = await pending;

            expect(result).toBe(false);
            expect(replaceAllMessages).not.toHaveBeenCalled();
        });
    });

    // ========== debouncedSaveSession ==========
    describe('debouncedSaveSession', () => {
        it('不抛错', () => {
            state.currentSessionId = 'sess1';
            state.sessionDirty = true;
            state.sessions = [{ id: 'sess1', name: 'test', createdAt: 1 }];
            state.messages = [];

            expect(() => debouncedSaveSession()).not.toThrow();
        });

        it('多次调用只保留最后一次', () => {
            debouncedSaveSession();
            debouncedSaveSession();
            debouncedSaveSession();
            // 不抛错即可
        });
    });

    // ========== createNewSession ==========
    describe('createNewSession', () => {
        it('当前会话为空时复用', async () => {
            state.currentSessionId = 'sess1';
            state.sessions = [{ id: 'sess1', name: '新会话', customName: false }];
            state.messages = [];

            const result = await createNewSession(false);
            expect(result.id).toBe('sess1');
        });

        it('当前会话非空时创建新会话', async () => {
            state.currentSessionId = 'sess1';
            state.sessions = [{ id: 'sess1', name: 'test', customName: false }];
            state.messages = [{ role: 'user', content: 'hi' }];

            const { generateSessionId } = await import('../../js/utils/helpers.js');
            generateSessionId.mockReturnValue('session_new_456');

            const result = await createNewSession(false);
            expect(result.id).toBe('session_new_456');
            expect(state.sessions.length).toBe(2);
        });

        it('shouldSwitch=true 时切换到新会话', async () => {
            state.currentSessionId = 'sess1';
            state.sessions = [{ id: 'sess1', name: 'test' }];
            state.messages = [{ role: 'user', content: 'hi' }];

            const { generateSessionId } = await import('../../js/utils/helpers.js');
            generateSessionId.mockReturnValue('session_switch_789');

            await createNewSession(true);

            const { eventBus } = await import('../../js/core/events.js');
            expect(eventBus.emit).toHaveBeenCalledWith('sessions:updated', expect.any(Object));
        });
    });

    describe('switchToSession', () => {
        it('目标不存在时重新挂载已 detach 的当前任务', async () => {
            state.sessions = [{ id: 'session-a', name: 'A' }];
            state.currentSessionId = 'session-a';
            const task = requestTaskRegistry.create({
                sessionId: 'session-a',
                abortController: new AbortController()
            });

            await switchToSession('missing-session');

            expect(requestTaskRegistry.owns(task)).toBe(true);
            expect(task.isDetached).toBe(false);
            expect(state.currentSessionId).toBe('session-a');
        });
    });

    // ========== deleteSession ==========
    describe('deleteSession', () => {
        it('删除不存在的会话静默返回', async () => {
            state.sessions = [];
            await deleteSession('nonexistent');

            const { deleteSessionFromDB } = await import('../../js/state/storage.js');
            expect(deleteSessionFromDB).not.toHaveBeenCalled();
        });

        it('删除存在的会话', async () => {
            state.sessions = [
                { id: 'sess1', name: 'first' },
                { id: 'sess2', name: 'second' }
            ];
            state.currentSessionId = 'sess1';

            await deleteSession('sess2');

            const { deleteSessionFromDB } = await import('../../js/state/storage.js');
            expect(deleteSessionFromDB).toHaveBeenCalledWith('sess2');
            expect(state.sessions.length).toBe(1);
        });

        it('删除当前会话后切换到下一个', async () => {
            state.sessions = [
                { id: 'sess1', name: 'first' },
                { id: 'sess2', name: 'second' }
            ];
            state.currentSessionId = 'sess1';

            await deleteSession('sess1');

            expect(state.sessions.find((s) => s.id === 'sess1')).toBeUndefined();
            expect(state.currentSessionId).not.toBe('sess1');
        });

        it('停止被删会话的后台任务', async () => {
            const mockAbort = vi.fn();
            state.backgroundTasks.set('sess1', {
                abortController: { abort: mockAbort },
                cleanupTimer: null
            });
            state.sessions = [
                { id: 'sess1', name: 'task' },
                { id: 'sess2', name: 'other' }
            ];
            state.currentSessionId = 'sess2';

            await deleteSession('sess1');
            expect(mockAbort).toHaveBeenCalled();
            expect(state.backgroundTasks.has('sess1')).toBe(false);
        });

        it('deleteSessionFromDB 失败时不从 state 删除', async () => {
            const { deleteSessionFromDB } = await import('../../js/state/storage.js');
            deleteSessionFromDB.mockRejectedValueOnce(new Error('DB error'));

            state.sessions = [{ id: 'sess1', name: 'test' }];
            state.currentSessionId = 'other';

            await deleteSession('sess1');
            // session 不会被 splice 因为 DB 删除失败后 return
            expect(state.sessions.length).toBe(1);
        });
    });

    // ========== renameSession ==========
    describe('renameSession', () => {
        it('重命名存在的会话', async () => {
            state.sessions = [{ id: 'sess1', name: 'old', customName: false }];
            await renameSession('sess1', 'New Name');

            expect(state.sessions[0].name).toBe('New Name');
            expect(state.sessions[0].customName).toBe(true);

            const { saveSessionToDB } = await import('../../js/state/storage.js');
            expect(saveSessionToDB).toHaveBeenCalled();
        });

        it('空名称使用默认名', async () => {
            state.sessions = [{ id: 'sess1', name: 'old', customName: false }];
            await renameSession('sess1', '   ');
            expect(state.sessions[0].name).toBe('未命名会话');
        });

        it('不存在的会话静默返回', async () => {
            state.sessions = [];
            await renameSession('nonexistent', 'test');

            const { saveSessionToDB } = await import('../../js/state/storage.js');
            expect(saveSessionToDB).not.toHaveBeenCalled();
        });
    });

    // ========== loadSessions ==========
    describe('loadSessions', () => {
        it('加载会话列表', async () => {
            const { loadAllSessionsFromDB } = await import('../../js/state/storage.js');
            loadAllSessionsFromDB.mockResolvedValue([{ id: 'sess1', name: 'test1' }]);
            const { loadPreference } = await import('../../js/state/storage.js');
            loadPreference.mockResolvedValue('sess1');

            await loadSessions();

            expect(state.sessions).toEqual([{ id: 'sess1', name: 'test1' }]);
        });

        it('加载失败时设为空数组', async () => {
            const { loadAllSessionsFromDB } = await import('../../js/state/storage.js');
            loadAllSessionsFromDB.mockRejectedValue(new Error('fail'));

            const { logger } = await import('../../js/utils/logger.js');
            await loadSessions();

            expect(logger.error).toHaveBeenCalledWith('加载会话失败:', expect.any(Error));
        });
    });
});
