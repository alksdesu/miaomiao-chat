/**
 * sessions.js 与侧栏失败标记：启动恢复的时机与删除会话时的清除
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

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
        prefillMessages: [],
        _lastKnownSessionUpdatedAt: new Map()
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
    SessionConflictError: class SessionConflictError extends Error {}
}));

vi.mock('../../js/state/session-failure-marks.js', () => ({
    restoreSessionFailureMarks: vi.fn(() => Promise.resolve())
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
import { eventBus } from '../../js/core/events.js';
import {
    loadAllSessionsFromDB,
    loadPreference,
    deleteSessionFromDB
} from '../../js/state/storage.js';
import { restoreSessionFailureMarks } from '../../js/state/session-failure-marks.js';
import { logger } from '../../js/utils/logger.js';
import { loadSessions, deleteSession } from '../../js/state/sessions.js';
import { requestTaskRegistry } from '../../js/core/request-task-registry.js';

function failureChangeEvents() {
    return eventBus.emit.mock.calls.filter(([name]) => name === 'session:failure-changed');
}

describe('sessions.js 失败标记', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        requestTaskRegistry.clearForTests();
        state.backgroundTasks.clear();
        state.sessions = [];
        state.currentSessionId = null;
        state.isSwitchingSession = false;
        restoreSessionFailureMarks.mockImplementation(() => Promise.resolve());
        loadAllSessionsFromDB.mockImplementation(() => Promise.resolve([]));
        loadPreference.mockImplementation(() => Promise.resolve(null));
        deleteSessionFromDB.mockImplementation(() => Promise.resolve());
    });

    describe('loadSessions', () => {
        beforeEach(() => {
            loadAllSessionsFromDB.mockImplementation(() =>
                Promise.resolve([
                    { id: 'sess1', name: 'first' },
                    { id: 'sess2', name: 'second' }
                ])
            );
            loadPreference.mockImplementation((key) =>
                Promise.resolve(key === 'currentSessionId' ? 'sess1' : null)
            );
        });

        it('切换到启动会话之前恢复，启动会话随即清除并同步，其余会话保留', async () => {
            restoreSessionFailureMarks.mockImplementation(async (ids) => {
                requestTaskRegistry.restoreFailures(ids);
            });

            await loadSessions();

            expect(restoreSessionFailureMarks).toHaveBeenCalledWith(['sess1', 'sess2']);
            expect(restoreSessionFailureMarks.mock.invocationCallOrder[0]).toBeLessThan(
                sessionRepositoryMocks.loadSessionMessageWindow.mock.invocationCallOrder[0]
            );
            expect(state.currentSessionId).toBe('sess1');
            expect(requestTaskRegistry.hasFailure('sess1')).toBe(false);
            expect(requestTaskRegistry.hasFailure('sess2')).toBe(true);
            expect(failureChangeEvents()).toEqual([
                ['session:failure-changed', { sessionId: 'sess1', failed: false }]
            ]);
        });

        it('恢复出错只告警，会话照常加载', async () => {
            restoreSessionFailureMarks.mockImplementation(() =>
                Promise.reject(new Error('storage down'))
            );

            await loadSessions();

            expect(logger.warn).toHaveBeenCalledWith(
                '[Session] 侧栏失败标记恢复出错:',
                expect.any(Error)
            );
            expect(state.currentSessionId).toBe('sess1');
        });

        it('库里没有会话时按空列表恢复，残留记录全部剔除', async () => {
            loadAllSessionsFromDB.mockImplementation(() => Promise.resolve([]));

            await loadSessions();

            expect(restoreSessionFailureMarks).toHaveBeenCalledWith([]);
        });
    });

    describe('deleteSession', () => {
        beforeEach(() => {
            state.sessions = [
                { id: 'sess1', name: 'first' },
                { id: 'sess2', name: 'second' }
            ];
            state.currentSessionId = 'sess1';
            requestTaskRegistry.restoreFailures(['sess2']);
            eventBus.emit.mockClear();
        });

        it('删除会话时清除它的失败标记并同步', async () => {
            await deleteSession('sess2');

            expect(requestTaskRegistry.hasFailure('sess2')).toBe(false);
            expect(failureChangeEvents()).toEqual([
                ['session:failure-changed', { sessionId: 'sess2', failed: false }]
            ]);
        });

        it('数据库删除失败时保留标记', async () => {
            deleteSessionFromDB.mockImplementation(() => Promise.reject(new Error('DB error')));

            await deleteSession('sess2');

            expect(requestTaskRegistry.hasFailure('sess2')).toBe(true);
            expect(failureChangeEvents()).toEqual([]);
        });
    });
});
