// @vitest-environment jsdom
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';

let db;
let repository;

function createVersion8Database(messages) {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open('GeminiChatDB', 8);
        request.onupgradeneeded = () => {
            const store = request.result.createObjectStore('messages', {
                keyPath: 'sessionId'
            });
            store.put({ sessionId: 'legacy-session', messages, updatedAt: 123 });
        };
        request.onsuccess = () => {
            request.result.close();
            resolve();
        };
        request.onerror = () => reject(request.error);
    });
}

describe('IndexedDB v8 升级', () => {
    const messages = Array.from({ length: 205 }, (_, index) => ({
        id: `m${index}`,
        role: index % 2 ? 'assistant' : 'user',
        ts: index,
        parts: [{ type: 'text', text: `message ${index}` }]
    }));

    beforeAll(async () => {
        globalThis.indexedDB = new IDBFactory();
        globalThis.IDBKeyRange = IDBKeyRange;
        Object.defineProperty(window, 'indexedDB', {
            value: globalThis.indexedDB,
            configurable: true
        });
        Object.defineProperty(navigator, 'locks', {
            value: undefined,
            configurable: true
        });

        await createVersion8Database(messages);
        const indexeddbModule = await import('../../js/state/indexeddb.js');
        db = await indexeddbModule.initDB();
        repository = await import('../../js/state/message-page-repository.js');
    });

    afterAll(() => db?.close());

    it('创建分页和媒体存储并保留旧消息', async () => {
        expect(Array.from(db.objectStoreNames)).toEqual(
            expect.arrayContaining([
                'messages',
                'messagePages',
                'messageManifests',
                'mediaBlobs',
                'mediaRefs'
            ])
        );

        const result = await repository.migrateSessionMessagesToPages('legacy-session');
        expect(result).toEqual({ migrated: 1, skipped: 0, errors: [] });

        const manifest = await repository.loadMessageManifest('legacy-session');
        expect(manifest).toMatchObject({
            messageCount: 205,
            pageCount: 3,
            state: 'complete'
        });
        const range = await repository.loadSessionMessageRange('legacy-session', 95, 105);
        expect(range.messages.map((message) => message.id)).toEqual(
            Array.from({ length: 10 }, (_, offset) => `m${95 + offset}`)
        );

        const legacyRecord = await new Promise((resolve, reject) => {
            const request = db
                .transaction(['messages'], 'readonly')
                .objectStore('messages')
                .get('legacy-session');
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        expect(legacyRecord.messages).toHaveLength(205);
    });

    it('完整迁移可重复执行且不会重写分页', async () => {
        const result = await repository.migrateMessagesToPages();
        expect(result).toEqual({ migrated: 0, skipped: 1, errors: [] });
    });

    it('检测缺页后从旧消息记录恢复', async () => {
        const transaction = db.transaction(['messagePages'], 'readwrite');
        transaction.objectStore('messagePages').delete(['legacy-session', 1]);
        await new Promise((resolve, reject) => {
            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(transaction.error);
        });
        repository.invalidateMessagePageCache('legacy-session');

        const result = await repository.migrateMessagesToPages();
        expect(result).toEqual({ migrated: 1, skipped: 0, errors: [] });
        const restored = await repository.loadSessionMessageRange('legacy-session', 100, 101);
        expect(restored.messages[0].id).toBe('m100');
    });

    it('消息数量缩小时删除多余旧页面', async () => {
        await repository.savePagedSessionMessages('legacy-session', [messages[0]], {
            updatedAt: 456
        });

        const firstPage = await repository.loadMessagePage('legacy-session', 0);
        expect(firstPage.messages).toHaveLength(1);
        expect(firstPage.messages[0]).toMatchObject({
            id: 'm0',
            role: 'user',
            parts: [{ type: 'text', text: 'message 0' }]
        });
        expect(firstPage.messages[0].ts).toBeGreaterThan(0);
        expect(await repository.loadMessagePage('legacy-session', 1)).toBeNull();
        expect(await repository.loadMessagePage('legacy-session', 2)).toBeNull();
    });
});
