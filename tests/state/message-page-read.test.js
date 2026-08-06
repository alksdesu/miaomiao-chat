import { beforeEach, describe, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => ({
    manifest: null,
    pages: new Map(),
    gets: []
}));

function createRequest(result) {
    const request = { result: undefined, error: null, onsuccess: null, onerror: null };
    queueMicrotask(() => {
        request.result = result;
        request.onsuccess?.();
    });
    return request;
}

vi.mock('../../js/state/indexeddb.js', () => ({
    STORES: {
        MESSAGES: 'messages',
        MESSAGE_PAGES: 'messagePages',
        MESSAGE_MANIFESTS: 'messageManifests'
    },
    hasMessagePageStore: () => true,
    withDBLock: (_name, callback) => callback(),
    getDB: () => ({
        transaction: () => ({
            objectStore: (name) => ({
                get: (key) => {
                    storage.gets.push({ name, key });
                    return createRequest(
                        name === 'messageManifests'
                            ? storage.manifest
                            : storage.pages.get(JSON.stringify(key))
                    );
                }
            })
        })
    })
}));

vi.mock('../../js/utils/logger.js', () => ({
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

import {
    invalidateMessagePageCache,
    loadSessionMessageRange
} from '../../js/state/message-page-repository.js';
import { SCHEMA_VERSION, createMessage, textPart } from '../../js/messages/schema.js';

function setManifest(overrides = {}) {
    storage.manifest = {
        sessionId: 'session-1',
        messageCount: 1,
        pageCount: 1,
        pageSize: 100,
        generation: 'generation-1',
        messageSchemaVersion: SCHEMA_VERSION,
        state: 'complete',
        summaries: [],
        ...overrides
    };
}

function setPage(overrides = {}) {
    storage.pages.set(JSON.stringify(['session-1', 0]), {
        sessionId: 'session-1',
        pageIndex: 0,
        generation: 'generation-1',
        messageSchemaVersion: SCHEMA_VERSION,
        messages: [createMessage('user', [textPart('hello')], { id: 'm1', ts: 1 })],
        ...overrides
    });
}

describe('message page version gate', () => {
    beforeEach(() => {
        storage.manifest = null;
        storage.pages.clear();
        storage.gets.length = 0;
        invalidateMessagePageCache();
    });

    it('当前版本 manifest 与 page 直接读取', async () => {
        setManifest();
        setPage();

        const result = await loadSessionMessageRange('session-1', 0, 1);

        expect(result.messages[0].parts[0].text).toBe('hello');
        expect(storage.gets).toEqual([
            { name: 'messageManifests', key: 'session-1' },
            { name: 'messagePages', key: ['session-1', 0] }
        ]);
    });

    it('无版本 manifest 回退传统消息记录', async () => {
        setManifest({ messageSchemaVersion: undefined });
        setPage();

        expect(await loadSessionMessageRange('session-1', 0, 1)).toBeNull();
        expect(storage.gets).toEqual([{ name: 'messageManifests', key: 'session-1' }]);
    });

    it('page 版本与 manifest 不一致时拒绝读取', async () => {
        setManifest();
        setPage({ messageSchemaVersion: 0 });

        expect(await loadSessionMessageRange('session-1', 0, 1)).toBeNull();
    });

    it('page generation 与 manifest 不一致时拒绝读取', async () => {
        setManifest();
        setPage({ generation: 'stale-generation' });

        expect(await loadSessionMessageRange('session-1', 0, 1)).toBeNull();
    });
});
