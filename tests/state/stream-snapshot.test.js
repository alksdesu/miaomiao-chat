import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    saveToStore: vi.fn(),
    deleteFromStore: vi.fn(async () => undefined),
    loadAllFromStore: vi.fn(async () => []),
    withDBLock: vi.fn((_name, fn) => fn()),
    getCurrentProvider: vi.fn(() => ({ name: 'Current Provider' })),
    getModelDisplayName: vi.fn(() => 'Current Model'),
    probeTabs: vi.fn(async () => new Set()),
    saveAssistantMessageToBackground: vi.fn(async () => undefined)
}));

vi.mock('../../js/core/state.js', () => ({
    state: { selectedModel: 'current-model', sessions: [] }
}));
vi.mock('../../js/state/indexeddb.js', () => ({
    STORES: { STREAM_SNAPSHOTS: 'streamSnapshots' },
    getDB: vi.fn(() => ({
        objectStoreNames: { contains: () => true }
    })),
    saveToStore: mocks.saveToStore,
    deleteFromStore: mocks.deleteFromStore,
    loadAllFromStore: mocks.loadAllFromStore,
    withDBLock: mocks.withDBLock
}));
vi.mock('../../js/api/current.js', () => ({
    getCurrentProvider: mocks.getCurrentProvider,
    getModelDisplayName: mocks.getModelDisplayName
}));
vi.mock('../../js/state/tab-sync.js', () => ({
    getTabId: () => 'tab-self',
    probeTabs: mocks.probeTabs
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

beforeEach(() => {
    vi.clearAllMocks();
    mocks.saveToStore.mockResolvedValue(undefined);
    mocks.deleteFromStore.mockResolvedValue(undefined);
    mocks.loadAllFromStore.mockResolvedValue([]);
    mocks.probeTabs.mockResolvedValue(new Set());
    state.sessions = [];
});

describe('stream snapshot request ownership', () => {
    it('清理会等待在途写入完成，避免完成后残留快照', async () => {
        let resolveWrite;
        mocks.saveToStore.mockReturnValueOnce(
            new Promise((resolve) => {
                resolveWrite = resolve;
            })
        );

        saveStreamSnapshotThrottled('session-a', 'partial', '', 'request-pending-write', {
            modelDisplayName: 'Snapshot Model',
            providerName: 'Snapshot Provider'
        });
        clearStreamSnapshot('session-a', 'request-pending-write');

        expect(mocks.deleteFromStore).not.toHaveBeenCalled();
        resolveWrite();
        await vi.waitFor(() => expect(mocks.deleteFromStore).toHaveBeenCalledTimes(1));
        expect(mocks.getCurrentProvider).not.toHaveBeenCalled();
        expect(mocks.saveToStore).toHaveBeenCalledWith(
            'streamSnapshots',
            'session-a:request-pending-write',
            expect.objectContaining({
                model: 'Snapshot Model',
                provider: 'Snapshot Provider'
            })
        );
    });

    it('已清理的 requestId 不接受迟到的流式回调重建快照', () => {
        clearStreamSnapshot('session-a', 'request-closed');

        saveStreamSnapshotThrottled('session-a', 'late partial', '', 'request-closed', {
            modelDisplayName: 'Model',
            providerName: 'Provider'
        });

        expect(mocks.saveToStore).not.toHaveBeenCalled();
    });
});

describe('快照写入者与心跳', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('快照记录写入者标签页和心跳时间', () => {
        saveStreamSnapshotThrottled('session-owner', 'partial', '', 'request-owner', PROFILE);

        expect(mocks.saveToStore).toHaveBeenCalledWith(
            'streamSnapshots',
            'session-owner:request-owner',
            expect.objectContaining({
                ownerTabId: 'tab-self',
                heartbeatAt: expect.any(Number)
            })
        );
        clearStreamSnapshot('session-owner', 'request-owner');
    });

    it('生成停顿时定时补写心跳，节流窗口内的流式写入不重复写，清理后停止', () => {
        vi.useFakeTimers();
        saveStreamSnapshotThrottled('session-hb', 'partial', '', 'request-hb', PROFILE);
        const firstWrite = mocks.saveToStore.mock.calls[0][2];

        vi.advanceTimersByTime(1000);
        saveStreamSnapshotThrottled('session-hb', 'partial more', '', 'request-hb', PROFILE);
        expect(mocks.saveToStore).toHaveBeenCalledTimes(1);

        vi.advanceTimersByTime(19000);
        expect(mocks.saveToStore).toHaveBeenCalledTimes(2);
        expect(mocks.saveToStore.mock.calls[1][2]).toEqual({
            ...firstWrite,
            heartbeatAt: firstWrite.heartbeatAt + 20000
        });

        clearStreamSnapshot('session-hb', 'request-hb');
        vi.advanceTimersByTime(60000);
        expect(mocks.saveToStore).toHaveBeenCalledTimes(2);
    });

    it('近期刚有流式写入的快照不额外补写心跳', () => {
        vi.useFakeTimers();
        saveStreamSnapshotThrottled('session-busy', 'a', '', 'request-busy', PROFILE);
        vi.advanceTimersByTime(16000);
        saveStreamSnapshotThrottled('session-busy', 'ab', '', 'request-busy', PROFILE);
        expect(mocks.saveToStore).toHaveBeenCalledTimes(2);

        vi.advanceTimersByTime(4000);
        expect(mocks.saveToStore).toHaveBeenCalledTimes(2);

        clearStreamSnapshot('session-busy', 'request-busy');
    });
});

function snapshotRecord(key, overrides = {}) {
    const sessionId = key.split(':')[0];
    return {
        key,
        value: {
            streaming: true,
            sessionId,
            textContent: `partial of ${key}`,
            thinkingContent: '',
            requestId: key.split(':')[1] || null,
            model: 'Model',
            provider: 'Provider',
            ts: 1,
            ...overrides
        }
    };
}

describe('recoverStreamSnapshots 写入者存活判断', () => {
    beforeEach(() => {
        state.sessions = [{ id: 'session-a' }, { id: 'session-b' }, { id: 'session-own' }];
    });

    it('多个标签页同时启动时在同一把锁里串行恢复', async () => {
        await recoverStreamSnapshots();

        expect(mocks.withDBLock).toHaveBeenCalledWith(
            'webchat-stream-snapshot-recovery',
            expect.any(Function)
        );
    });

    it('没有写入者信息的旧快照照旧恢复并删除，不做存活探测', async () => {
        mocks.loadAllFromStore.mockResolvedValueOnce([snapshotRecord('session-a:legacy')]);

        await recoverStreamSnapshots();

        expect(mocks.probeTabs).not.toHaveBeenCalled();
        expect(mocks.saveAssistantMessageToBackground).toHaveBeenCalledWith(
            'session-a',
            [{ type: 'text', text: 'partial of session-a:legacy' }],
            expect.objectContaining({ model: 'Model' }),
            expect.objectContaining({ isError: true })
        );
        expect(mocks.deleteFromStore).toHaveBeenCalledWith('streamSnapshots', 'session-a:legacy');
    });

    it('心跳新鲜且回应探测的写入者仍在生成，快照原样保留', async () => {
        mocks.loadAllFromStore.mockResolvedValueOnce([
            snapshotRecord('session-a:live', { ownerTabId: 'tab-other', heartbeatAt: Date.now() })
        ]);
        mocks.probeTabs.mockResolvedValueOnce(new Set(['tab-other']));

        await recoverStreamSnapshots();

        expect(mocks.probeTabs).toHaveBeenCalledWith(['tab-other']);
        expect(mocks.saveAssistantMessageToBackground).not.toHaveBeenCalled();
        expect(mocks.deleteFromStore).not.toHaveBeenCalled();
    });

    it('心跳新鲜但不回应探测的写入者已关闭，快照照常恢复', async () => {
        mocks.loadAllFromStore.mockResolvedValueOnce([
            snapshotRecord('session-a:closed', {
                ownerTabId: 'tab-closed',
                heartbeatAt: Date.now()
            })
        ]);
        mocks.probeTabs.mockResolvedValueOnce(new Set());

        await recoverStreamSnapshots();

        expect(mocks.saveAssistantMessageToBackground).toHaveBeenCalledTimes(1);
        expect(mocks.deleteFromStore).toHaveBeenCalledWith('streamSnapshots', 'session-a:closed');
    });

    it('心跳过期的写入者不探测直接恢复', async () => {
        mocks.loadAllFromStore.mockResolvedValueOnce([
            snapshotRecord('session-a:stale', {
                ownerTabId: 'tab-other',
                heartbeatAt: Date.now() - HEARTBEAT_STALE_MS - 1000
            })
        ]);

        await recoverStreamSnapshots();

        expect(mocks.probeTabs).not.toHaveBeenCalled();
        expect(mocks.deleteFromStore).toHaveBeenCalledWith('streamSnapshots', 'session-a:stale');
    });

    it('无法探测时按心跳判断，心跳新鲜的快照保留', async () => {
        mocks.loadAllFromStore.mockResolvedValueOnce([
            snapshotRecord('session-a:fresh', { ownerTabId: 'tab-other', heartbeatAt: Date.now() }),
            snapshotRecord('session-b:legacy')
        ]);
        mocks.probeTabs.mockResolvedValueOnce(null);

        await recoverStreamSnapshots();

        expect(mocks.deleteFromStore).toHaveBeenCalledTimes(1);
        expect(mocks.deleteFromStore).toHaveBeenCalledWith('streamSnapshots', 'session-b:legacy');
    });

    it('本页仍在写的快照不恢复，已结束的本页快照照常恢复', async () => {
        saveStreamSnapshotThrottled('session-own', 'mine', '', 'request-open', PROFILE);
        const now = Date.now();
        mocks.loadAllFromStore.mockResolvedValueOnce([
            snapshotRecord('session-own:request-open', {
                ownerTabId: 'tab-self',
                heartbeatAt: now
            }),
            snapshotRecord('session-own:request-done', { ownerTabId: 'tab-self', heartbeatAt: now })
        ]);

        await recoverStreamSnapshots();

        expect(mocks.probeTabs).not.toHaveBeenCalled();
        expect(mocks.deleteFromStore).toHaveBeenCalledTimes(1);
        expect(mocks.deleteFromStore).toHaveBeenCalledWith(
            'streamSnapshots',
            'session-own:request-done'
        );
        clearStreamSnapshot('session-own', 'request-open');
    });
});
