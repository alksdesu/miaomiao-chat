import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    saveToStore: vi.fn(async () => undefined),
    deleteFromStore: vi.fn(async () => undefined),
    loadAllFromStore: vi.fn(async () => []),
    probeTabs: vi.fn(async () => new Set()),
    saveAssistantMessageToBackground: vi.fn(async () => undefined),
    isHoldingSessionTaskLock: vi.fn(() => false),
    queryActiveLockNames: vi.fn(async () => null)
}));

vi.mock('../../js/core/state.js', () => ({
    state: { selectedModel: 'current-model', sessions: [] }
}));
vi.mock('../../js/state/indexeddb.js', () => ({
    STORES: { STREAM_SNAPSHOTS: 'streamSnapshots' },
    getDB: vi.fn(() => ({ objectStoreNames: { contains: () => true } })),
    saveToStore: mocks.saveToStore,
    deleteFromStore: mocks.deleteFromStore,
    loadAllFromStore: mocks.loadAllFromStore,
    withDBLock: vi.fn((_name, fn) => fn())
}));
vi.mock('../../js/api/current.js', () => ({
    getCurrentProvider: vi.fn(() => ({ name: 'Current Provider' })),
    getModelDisplayName: vi.fn(() => 'Current Model')
}));
vi.mock('../../js/state/tab-sync.js', () => ({
    getTabId: () => 'tab-self',
    probeTabs: mocks.probeTabs
}));
vi.mock('../../js/state/session-task-presence.js', () => ({
    getSessionTaskLockName: (sessionId, tabId = 'tab-self') =>
        `webchat-session-task:${sessionId}:${tabId}`,
    isHoldingSessionTaskLock: mocks.isHoldingSessionTaskLock,
    queryActiveLockNames: mocks.queryActiveLockNames
}));
vi.mock('../../js/messages/sync.js', () => ({
    saveAssistantMessageToBackground: mocks.saveAssistantMessageToBackground
}));
vi.mock('../../js/messages/parts-builder.js', () => ({
    buildPartsFromStreamingState: vi.fn(({ textContent }) => [{ type: 'text', text: textContent }])
}));
vi.mock('../../js/messages/schema.js', () => ({
    createMeta: vi.fn((meta) => meta)
}));
vi.mock('../../js/utils/errors.js', () => ({
    renderHumanizedError: vi.fn(() => '<div class="stream-error"></div>')
}));
vi.mock('../../js/utils/logger.js', () => ({
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

import { state } from '../../js/core/state.js';
import {
    clearStreamSnapshot,
    recoverStreamSnapshots,
    saveStreamSnapshotThrottled
} from '../../js/state/stream-snapshot.js';

const PROFILE = { modelDisplayName: 'Snapshot Model', providerName: 'Snapshot Provider' };
const HEARTBEAT_STALE_MS = 3 * 60 * 1000;
const OTHER_TAB_LOCK = 'webchat-session-task:session-a:tab-other';

function snapshotRecord(key, overrides = {}) {
    return {
        key,
        value: {
            streaming: true,
            sessionId: key.split(':')[0],
            textContent: `partial of ${key}`,
            thinkingContent: '',
            model: 'Model',
            provider: 'Provider',
            ts: 1,
            ...overrides
        }
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadAllFromStore.mockResolvedValue([]);
    mocks.probeTabs.mockResolvedValue(new Set());
    mocks.isHoldingSessionTaskLock.mockReturnValue(false);
    mocks.queryActiveLockNames.mockResolvedValue(null);
    state.sessions = [{ id: 'session-a' }, { id: 'session-b' }];
});

describe('快照记录写入者的会话任务锁', () => {
    it('本页持有会话任务锁时快照带上锁名', () => {
        mocks.isHoldingSessionTaskLock.mockReturnValue(true);

        saveStreamSnapshotThrottled('session-a', 'partial', '', 'request-1:1', PROFILE);

        expect(mocks.isHoldingSessionTaskLock).toHaveBeenCalledWith('session-a');
        expect(mocks.saveToStore).toHaveBeenCalledWith(
            'streamSnapshots',
            'session-a:request-1:1',
            expect.objectContaining({
                taskLockName: 'webchat-session-task:session-a:tab-self'
            })
        );
        clearStreamSnapshot('session-a', 'request-1:1');
    });

    it('没有持锁（Web Locks 不可用）时不写锁名', () => {
        saveStreamSnapshotThrottled('session-a', 'partial', '', 'request-2:1', PROFILE);

        expect(mocks.saveToStore.mock.calls[0][2]).not.toHaveProperty('taskLockName');
        clearStreamSnapshot('session-a', 'request-2:1');
    });
});

describe('同一任务各轮各写一份快照', () => {
    it('续作轮在上一轮清理后仍能写入，清理只影响自己那一轮', async () => {
        saveStreamSnapshotThrottled('session-a', 'round one', '', 'request-3:1', PROFILE);
        clearStreamSnapshot('session-a', 'request-3:1');
        saveStreamSnapshotThrottled('session-a', 'round two', '', 'request-3:2', PROFILE);

        expect(mocks.saveToStore).toHaveBeenCalledTimes(2);
        expect(mocks.saveToStore.mock.calls[1][1]).toBe('session-a:request-3:2');
        expect(mocks.saveToStore.mock.calls[1][2]).toEqual(
            expect.objectContaining({ textContent: 'round two' })
        );
        await vi.waitFor(() =>
            expect(mocks.deleteFromStore).toHaveBeenCalledWith(
                'streamSnapshots',
                'session-a:request-3:1'
            )
        );
        expect(mocks.deleteFromStore).not.toHaveBeenCalledWith(
            'streamSnapshots',
            'session-a:request-3:2'
        );

        clearStreamSnapshot('session-a', 'request-3:2');
        saveStreamSnapshotThrottled('session-a', 'late frame', '', 'request-3:2', PROFILE);
        expect(mocks.saveToStore).toHaveBeenCalledTimes(2);
    });
});

describe('recoverStreamSnapshots 按会话任务锁判断写入者', () => {
    it('写入者被冻结（心跳早已过期）但锁仍被持有：快照保留，不做探测', async () => {
        mocks.loadAllFromStore.mockResolvedValueOnce([
            snapshotRecord('session-a:frozen', {
                ownerTabId: 'tab-other',
                heartbeatAt: Date.now() - HEARTBEAT_STALE_MS * 10,
                taskLockName: OTHER_TAB_LOCK
            })
        ]);
        mocks.queryActiveLockNames.mockResolvedValueOnce(new Set([OTHER_TAB_LOCK]));

        await recoverStreamSnapshots();

        expect(mocks.probeTabs).not.toHaveBeenCalled();
        expect(mocks.saveAssistantMessageToBackground).not.toHaveBeenCalled();
        expect(mocks.deleteFromStore).not.toHaveBeenCalled();
    });

    it('锁已释放（标签页关闭或崩溃）：即使心跳还新鲜也直接恢复，不做探测', async () => {
        mocks.loadAllFromStore.mockResolvedValueOnce([
            snapshotRecord('session-a:closed', {
                ownerTabId: 'tab-other',
                heartbeatAt: Date.now(),
                taskLockName: OTHER_TAB_LOCK
            })
        ]);
        mocks.queryActiveLockNames.mockResolvedValueOnce(new Set());

        await recoverStreamSnapshots();

        expect(mocks.probeTabs).not.toHaveBeenCalled();
        expect(mocks.saveAssistantMessageToBackground).toHaveBeenCalledTimes(1);
        expect(mocks.deleteFromStore).toHaveBeenCalledWith('streamSnapshots', 'session-a:closed');
    });

    it('无法查询锁时退回心跳与探测', async () => {
        mocks.loadAllFromStore.mockResolvedValueOnce([
            snapshotRecord('session-a:fallback', {
                ownerTabId: 'tab-other',
                heartbeatAt: Date.now(),
                taskLockName: OTHER_TAB_LOCK
            })
        ]);
        mocks.probeTabs.mockResolvedValueOnce(new Set(['tab-other']));

        await recoverStreamSnapshots();

        expect(mocks.probeTabs).toHaveBeenCalledWith(['tab-other']);
        expect(mocks.deleteFromStore).not.toHaveBeenCalled();
    });

    it('没有锁名的快照仍按心跳与探测判断', async () => {
        mocks.loadAllFromStore.mockResolvedValueOnce([
            snapshotRecord('session-a:heartbeat', {
                ownerTabId: 'tab-other',
                heartbeatAt: Date.now()
            })
        ]);
        mocks.queryActiveLockNames.mockResolvedValueOnce(new Set());
        mocks.probeTabs.mockResolvedValueOnce(new Set(['tab-other']));

        await recoverStreamSnapshots();

        expect(mocks.probeTabs).toHaveBeenCalledWith(['tab-other']);
        expect(mocks.deleteFromStore).not.toHaveBeenCalled();
    });
});

describe('recoverStreamSnapshots 处理旧版本写入的快照', () => {
    it('最近仍有写入的旧快照视为那个标签页可能还在生成，本次不恢复', async () => {
        mocks.loadAllFromStore.mockResolvedValueOnce([
            snapshotRecord('session-a:legacy-live', { ts: Date.now() - 30 * 1000 })
        ]);

        await recoverStreamSnapshots();

        expect(mocks.probeTabs).not.toHaveBeenCalled();
        expect(mocks.saveAssistantMessageToBackground).not.toHaveBeenCalled();
        expect(mocks.deleteFromStore).not.toHaveBeenCalled();
    });

    it('超过心跳窗口没有写入的旧快照照常恢复', async () => {
        mocks.loadAllFromStore.mockResolvedValueOnce([
            snapshotRecord('session-a:legacy-stale', {
                ts: Date.now() - HEARTBEAT_STALE_MS - 1000
            })
        ]);

        await recoverStreamSnapshots();

        expect(mocks.saveAssistantMessageToBackground).toHaveBeenCalledWith(
            'session-a',
            [{ type: 'text', text: 'partial of session-a:legacy-stale' }],
            expect.objectContaining({ model: 'Model' }),
            expect.objectContaining({ isError: true })
        );
        expect(mocks.deleteFromStore).toHaveBeenCalledWith(
            'streamSnapshots',
            'session-a:legacy-stale'
        );
    });
});
