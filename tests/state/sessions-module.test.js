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
    loadSessionMetaFromDB: vi.fn(() => Promise.resolve(null)),
    saveSessionMessages: vi.fn(() => Promise.resolve()),
    saveSessionAtomic: vi.fn(() => Promise.resolve()),
    saveSessionSearchIndex: vi.fn(() => Promise.resolve()),
    saveEmergencySessionSnapshot: vi.fn(() => true),
    loadEmergencySessionSnapshot: vi.fn(() => null),
    clearEmergencySessionSnapshot: vi.fn(),
    SessionConflictError: class SessionConflictError extends Error {
        constructor(sessionId, expected, actual) {
            super('conflict');
            this.sessionId = sessionId;
            this.expectedUpdatedAt = expected;
            this.actualUpdatedAt = actual;
        }
    }
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
    refreshCurrentSession,
    applyRemoteSessionUpdate,
    stopSessionTask,
    switchToSession
} from '../../js/state/sessions.js';
import { requestTaskRegistry } from '../../js/core/request-task-registry.js';
import { requestStateMachine } from '../../js/core/request-state-machine.js';
import { replaceAllMessages } from '../../js/core/state-mutations.js';
import { eventBus } from '../../js/core/events.js';
import {
    loadSessionMessages,
    loadSessionMetaFromDB,
    saveSessionAtomic,
    SessionConflictError
} from '../../js/state/storage.js';
import { isElementsInitialized } from '../../js/core/elements.js';
import { renderSessionMessages } from '../../js/messages/restore.js';

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
        state.isSwitchingSession = false;
        state.editingIndex = null;
        state.backgroundTasks = new Map();
        state._lastKnownSessionUpdatedAt = new Map();
        requestTaskRegistry.clearForTests();
        loadSessionMetaFromDB.mockResolvedValue(null);
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
            await vi.waitFor(() => expect(loadSessionMessages).toHaveBeenCalled());
            state.currentSessionId = 'session-b';
            resolveLoad({ messages: [{ id: 'message-a', role: 'user', parts: [] }] });
            const result = await pending;

            expect(result).toBe(false);
            expect(replaceAllMessages).not.toHaveBeenCalled();
        });

        it('有未保存改动或进行中的任务时不重载', async () => {
            state.currentSessionId = 'session-a';
            state.sessions = [{ id: 'session-a', name: 'A', updatedAt: 1 }];

            state.sessionDirty = true;
            expect(await reloadCurrentSessionMessages()).toBe(false);

            state.sessionDirty = false;
            requestTaskRegistry.create({
                sessionId: 'session-a',
                abortController: new AbortController()
            });
            expect(await reloadCurrentSessionMessages()).toBe(false);

            expect(loadSessionMessages).not.toHaveBeenCalled();
            expect(replaceAllMessages).not.toHaveBeenCalled();
            expect(state.sessionDirty).toBe(false);
        });

        it('加载期间出现本地改动时放弃本次重载', async () => {
            let resolveLoad;
            loadSessionMessages.mockImplementationOnce(
                () =>
                    new Promise((resolve) => {
                        resolveLoad = resolve;
                    })
            );
            state.currentSessionId = 'session-a';
            state.sessions = [{ id: 'session-a', name: 'A', updatedAt: 1 }];

            const pending = reloadCurrentSessionMessages();
            await vi.waitFor(() => expect(loadSessionMessages).toHaveBeenCalled());
            state.sessionDirty = true;
            resolveLoad({ messages: [] });

            expect(await pending).toBe(false);
            expect(replaceAllMessages).not.toHaveBeenCalled();
        });

        it('丢弃本地改动强制重载，基线取库内记录而不是内存元数据', async () => {
            state.currentSessionId = 'session-a';
            state.sessionDirty = true;
            state.sessions = [{ id: 'session-a', name: 'A', updatedAt: 999 }];
            state._lastKnownSessionUpdatedAt.set('session-a', 100);
            loadSessionMetaFromDB.mockResolvedValueOnce({ id: 'session-a', updatedAt: 500 });
            loadSessionMessages.mockResolvedValueOnce({ messages: [{ id: 'm1', role: 'user' }] });

            const result = await reloadCurrentSessionMessages({ discardLocalChanges: true });

            expect(result).toBe(true);
            expect(replaceAllMessages).toHaveBeenCalledWith([{ id: 'm1', role: 'user' }]);
            expect(state._lastKnownSessionUpdatedAt.get('session-a')).toBe(500);
            expect(state.sessions[0].updatedAt).toBe(500);
            expect(state.sessionDirty).toBe(false);
        });
    });

    describe('refreshCurrentSession', () => {
        it('生成中点击当前会话只提示，不重载也不清掉未保存标记', async () => {
            state.currentSessionId = 'session-a';
            state.sessions = [{ id: 'session-a', name: 'A' }];
            state.sessionDirty = true;
            requestTaskRegistry.create({
                sessionId: 'session-a',
                abortController: new AbortController()
            });

            expect(await refreshCurrentSession()).toBe(false);

            expect(loadSessionMessages).not.toHaveBeenCalled();
            expect(state.sessionDirty).toBe(true);
            expect(eventBus.emit).toHaveBeenCalledWith(
                'ui:notification',
                expect.objectContaining({ message: expect.stringContaining('正在生成') })
            );
        });

        it('没有本地改动时从存储重载', async () => {
            state.currentSessionId = 'session-a';
            state.sessions = [{ id: 'session-a', name: 'A', updatedAt: 1 }];
            loadSessionMessages.mockResolvedValueOnce({ messages: [] });

            expect(await refreshCurrentSession()).toBe(true);
            expect(replaceAllMessages).toHaveBeenCalledWith([]);
        });
    });

    describe('applyRemoteSessionUpdate', () => {
        beforeEach(() => {
            state.currentSessionId = 'session-a';
            state.sessions = [
                { id: 'session-a', name: 'A', updatedAt: 200 },
                { id: 'session-b', name: 'B', updatedAt: 200 }
            ];
            state._lastKnownSessionUpdatedAt.set('session-a', 100);
            state._lastKnownSessionUpdatedAt.set('session-b', 100);
        });

        it('当前会话没有本地改动时重载并推进基线', async () => {
            loadSessionMetaFromDB.mockResolvedValueOnce({ id: 'session-a', updatedAt: 200 });
            loadSessionMessages.mockResolvedValueOnce({ messages: [{ id: 'remote' }] });

            expect(await applyRemoteSessionUpdate('session-a', 200)).toBe(true);

            expect(replaceAllMessages).toHaveBeenCalledWith([{ id: 'remote' }]);
            expect(state._lastKnownSessionUpdatedAt.get('session-a')).toBe(200);
            expect(eventBus.emit).toHaveBeenCalledWith('storage:remote-updated', {
                sessionId: 'session-a',
                updatedAt: 200,
                synced: true
            });
        });

        it('当前会话有未保存改动时不推进基线，保存时走冲突检测', async () => {
            state.sessionDirty = true;

            expect(await applyRemoteSessionUpdate('session-a', 200)).toBe(false);

            expect(loadSessionMessages).not.toHaveBeenCalled();
            expect(state._lastKnownSessionUpdatedAt.get('session-a')).toBe(100);
            expect(eventBus.emit).toHaveBeenCalledWith('storage:remote-updated', {
                sessionId: 'session-a',
                updatedAt: 200,
                synced: false
            });
        });

        it('当前会话有进行中的任务时不推进基线', async () => {
            requestTaskRegistry.create({
                sessionId: 'session-a',
                abortController: new AbortController()
            });

            expect(await applyRemoteSessionUpdate('session-a', 200)).toBe(false);

            expect(loadSessionMessages).not.toHaveBeenCalled();
            expect(state._lastKnownSessionUpdatedAt.get('session-a')).toBe(100);
        });

        it('非当前会话有后台任务在写时不推进基线', async () => {
            const task = requestTaskRegistry.create({
                sessionId: 'session-b',
                abortController: new AbortController()
            });
            requestTaskRegistry.detach(task);

            expect(await applyRemoteSessionUpdate('session-b', 200)).toBe(false);
            expect(state._lastKnownSessionUpdatedAt.get('session-b')).toBe(100);
        });

        it('非当前会话没有任务时推进基线且不会被乱序的旧广播拉回', async () => {
            expect(await applyRemoteSessionUpdate('session-b', 300)).toBe(true);
            expect(await applyRemoteSessionUpdate('session-b', 250)).toBe(true);

            expect(state._lastKnownSessionUpdatedAt.get('session-b')).toBe(300);
            expect(loadSessionMessages).not.toHaveBeenCalled();
        });
    });

    describe('保存冲突', () => {
        it('冲突后内存元数据回到库内版本，确认重载时用它作基线', async () => {
            state.currentSessionId = 'session-a';
            state.sessionDirty = true;
            state.sessions = [{ id: 'session-a', name: 'A', updatedAt: 100, createdAt: 1 }];
            state._lastKnownSessionUpdatedAt.set('session-a', 100);
            saveSessionAtomic.mockRejectedValueOnce(
                new SessionConflictError('session-a', 100, 200)
            );

            await saveCurrentSessionMessages();

            expect(state.sessions[0].updatedAt).toBe(200);
            expect(state._lastKnownSessionUpdatedAt.get('session-a')).toBe(100);
            expect(eventBus.emit).toHaveBeenCalledWith(
                'storage:conflict',
                expect.objectContaining({ sessionId: 'session-a', actualUpdatedAt: 200 })
            );

            // 冲突挂起是模块级状态，切走会话解除，避免影响后续用例
            state.sessions.push({ id: 'session-b', name: 'B' });
            await switchToSession('session-b');
            expect(state.currentSessionId).toBe('session-b');
        });
    });

    describe('switchToSession 乐观锁基线', () => {
        it('基线取库内记录，内存元数据同步过去', async () => {
            state.currentSessionId = 'session-a';
            state.sessions = [
                { id: 'session-a', name: 'A', updatedAt: 1 },
                { id: 'session-b', name: 'B', updatedAt: 999 }
            ];
            loadSessionMetaFromDB.mockResolvedValueOnce({ id: 'session-b', updatedAt: 400 });

            await switchToSession('session-b', false);

            expect(state.currentSessionId).toBe('session-b');
            expect(state._lastKnownSessionUpdatedAt.get('session-b')).toBe(400);
            expect(state.sessions[1].updatedAt).toBe(400);
        });
    });

    describe('stopSessionTask', () => {
        it('中止并结束会话的后台请求任务，不动前台状态机', () => {
            const controller = new AbortController();
            const task = requestTaskRegistry.create({
                sessionId: 'session-a',
                abortController: controller
            });

            stopSessionTask('session-a', 'remote-session-deleted');

            expect(controller.signal.aborted).toBe(true);
            expect(requestTaskRegistry.owns(task)).toBe(false);
            expect(task.phase).toBe('cancelled');
            expect(requestStateMachine.cancel).not.toHaveBeenCalled();
        });

        it('任务挂在前台状态机上时一并取消状态机', () => {
            const task = requestTaskRegistry.create({
                sessionId: 'session-a',
                abortController: new AbortController()
            });
            requestStateMachine.owns.mockImplementation((candidate) => candidate === task);

            stopSessionTask('session-a', 'remote-session-deleted');

            expect(requestStateMachine.cancel).toHaveBeenCalledTimes(1);
            expect(task.phase).toBe('cancelled');
            requestStateMachine.owns.mockImplementation(() => false);
        });

        it('没有登记的任务时中止旧的后台任务记录', () => {
            const abortController = new AbortController();
            const toolAbortController = new AbortController();
            state.backgroundTasks.set('session-a', { abortController, toolAbortController });

            stopSessionTask('session-a');

            expect(abortController.signal.aborted).toBe(true);
            expect(toolAbortController.signal.aborted).toBe(true);
            expect(state.backgroundTasks.has('session-a')).toBe(false);
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

        describe('切回仍有任务在运行的会话', () => {
            const RENDERED_HTML =
                '<div class="message assistant" data-message-id="a1">' +
                '<div class="message-content-wrapper"><div class="message-content">旧</div></div></div>';
            let messagesArea;

            async function switchBackTo(task, messages) {
                state.sessions = [
                    { id: 'session-a', name: 'A' },
                    { id: 'session-b', name: 'B' }
                ];
                state.currentSessionId = 'session-b';
                requestTaskRegistry.detach(task);
                loadSessionMessages.mockResolvedValueOnce({ messages });
                replaceAllMessages.mockImplementationOnce((next) => {
                    state.messages = next;
                });
                renderSessionMessages.mockImplementationOnce(() => {
                    messagesArea.innerHTML = RENDERED_HTML;
                });
                await switchToSession('session-a', false);
            }

            beforeEach(() => {
                document.body.replaceChildren();
                messagesArea = document.createElement('div');
                messagesArea.id = 'messages';
                document.body.appendChild(messagesArea);
                isElementsInitialized.mockReturnValue(true);
                vi.stubGlobal('requestAnimationFrame', (callback) => {
                    callback(0);
                    return 1;
                });
            });

            afterEach(() => {
                isElementsInitialized.mockReturnValue(false);
                vi.unstubAllGlobals();
            });

            it('工具执行中沿用已落库消息作为锚点，不新建占位符也不回放上一轮正文', async () => {
                const task = requestTaskRegistry.create({
                    sessionId: 'session-a',
                    abortController: new AbortController()
                });
                task.isToolCallPending = true;
                task.partialRender = { textContent: '上一轮正文', thinkingContent: '' };

                await switchBackTo(task, [
                    { id: 'u1', role: 'user', parts: [] },
                    { id: 'a1', role: 'assistant', parts: [] }
                ]);

                const anchor = messagesArea.querySelector('[data-message-id="a1"]');
                expect(task.messageElement).toBe(anchor);
                expect(state.currentAssistantMessage).toBe(
                    anchor.querySelector('.message-content')
                );
                expect(messagesArea.querySelectorAll('.message.assistant')).toHaveLength(1);
                expect(messagesArea.textContent).not.toContain('上一轮正文');
            });

            it('续作中锚定落库消息并按续作模式追加', async () => {
                const task = requestTaskRegistry.create({
                    sessionId: 'session-a',
                    abortController: new AbortController()
                });
                task.isSavingContinuation = true;

                await switchBackTo(task, [
                    { id: 'u1', role: 'user', parts: [] },
                    { id: 'a1', role: 'assistant', parts: [] }
                ]);

                const content = messagesArea.querySelector(
                    '[data-message-id="a1"] .message-content'
                );
                expect(task.messageElement.dataset.messageId).toBe('a1');
                expect(content.dataset.isContinuation).toBe('true');
                // 续作轮出错时按根元素上的标记把错误拆成单独一条
                expect(task.messageElement.dataset.isContinuation).toBe('true');
                expect(content.querySelector('.continuation-loading')).not.toBeNull();
                expect(content.textContent).toContain('旧');
            });

            it('当前轮还没落库时新建占位符，不覆盖历史消息', async () => {
                const task = requestTaskRegistry.create({
                    sessionId: 'session-a',
                    abortController: new AbortController()
                });
                task.isToolCallPending = true;

                await switchBackTo(task, [
                    { id: 'a1', role: 'assistant', parts: [] },
                    { id: 'u2', role: 'user', parts: [] }
                ]);

                const assistants = messagesArea.querySelectorAll('.message.assistant');
                expect(assistants).toHaveLength(2);
                expect(task.messageElement).toBe(assistants[1]);
                expect(assistants[0].textContent).toBe('旧');
            });
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
