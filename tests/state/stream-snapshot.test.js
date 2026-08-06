import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    saveToStore: vi.fn(),
    deleteFromStore: vi.fn(async () => undefined),
    loadAllFromStore: vi.fn(async () => []),
    getCurrentProvider: vi.fn(() => ({ name: 'Current Provider' })),
    getModelDisplayName: vi.fn(() => 'Current Model')
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
    loadAllFromStore: mocks.loadAllFromStore
}));
vi.mock('../../js/api/current.js', () => ({
    getCurrentProvider: mocks.getCurrentProvider,
    getModelDisplayName: mocks.getModelDisplayName
}));
vi.mock('../../js/utils/logger.js', () => ({
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

import {
    clearStreamSnapshot,
    saveStreamSnapshotThrottled
} from '../../js/state/stream-snapshot.js';

beforeEach(() => {
    vi.clearAllMocks();
    mocks.deleteFromStore.mockResolvedValue(undefined);
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
