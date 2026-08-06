// @vitest-environment jsdom
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { Blob as NodeBlob } from 'node:buffer';

let db;
let indexeddbModule;
let mediaStore;
let storage;

function waitForTransaction(transaction) {
    return new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
    });
}

async function clearMediaStores() {
    const transaction = db.transaction(['mediaBlobs', 'mediaRefs'], 'readwrite');
    transaction.objectStore('mediaBlobs').clear();
    transaction.objectStore('mediaRefs').clear();
    await waitForTransaction(transaction);
}

async function getAll(storeName) {
    return new Promise((resolve, reject) => {
        const request = db.transaction([storeName], 'readonly').objectStore(storeName).getAll();
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error);
    });
}

describe('media-blob-store', () => {
    beforeAll(async () => {
        globalThis.indexedDB = new IDBFactory();
        globalThis.IDBKeyRange = IDBKeyRange;
        globalThis.Blob = NodeBlob;
        Object.defineProperty(window, 'Blob', { value: NodeBlob, configurable: true });
        Object.defineProperty(window, 'indexedDB', {
            value: globalThis.indexedDB,
            configurable: true
        });
        Object.defineProperty(navigator, 'locks', {
            value: undefined,
            configurable: true
        });
        Object.defineProperty(URL, 'createObjectURL', {
            value: vi.fn(() => 'blob:media-preview'),
            configurable: true
        });
        Object.defineProperty(URL, 'revokeObjectURL', {
            value: vi.fn(),
            configurable: true
        });

        indexeddbModule = await import('../../js/state/indexeddb.js');
        db = await indexeddbModule.initDB();
        mediaStore = await import('../../js/state/media-blob-store.js');
        storage = await import('../../js/state/storage.js');
    });

    beforeEach(async () => {
        mediaStore.releaseAllMediaObjectUrls();
        await clearMediaStores();
        vi.clearAllMocks();
    });

    afterAll(() => {
        mediaStore.releaseAllMediaObjectUrls();
        db?.close();
    });

    it('外置 Data URL，并为 API 和界面恢复媒体内容', async () => {
        const dataUrl = 'data:image/png;base64,aGVsbG8=';
        const source = [
            {
                id: 'm1',
                parts: [{ type: 'media', media: 'image', mime: 'image/png', url: dataUrl }]
            }
        ];

        const externalized = await mediaStore.externalizeMessagesMedia(source);
        const persistedPart = externalized.messages[0].parts[0];

        expect(persistedPart.url).toBeUndefined();
        expect(persistedPart.mediaId).toMatch(/^media-/);
        expect(source[0].parts[0].url).toBe(dataUrl);
        expect(await mediaStore.loadMediaBlob(persistedPart.mediaId)).toMatchObject({
            mime: 'image/png',
            size: 5
        });

        const apiMessages = await mediaStore.resolveMessagesMediaForApi(externalized.messages);
        expect(apiMessages[0].parts[0].url).toBe(dataUrl);

        const displayed = await mediaStore.resolveMessageMediaForDisplay(externalized.messages[0]);
        expect(displayed.message.parts[0].url).toBe('blob:media-preview');
        expect(displayed.mediaIds).toEqual([persistedPart.mediaId]);

        await mediaStore.acquireMediaObjectUrl(persistedPart.mediaId);
        expect(mediaStore.releaseMediaObjectUrl(persistedPart.mediaId)).toBe(false);
        expect(mediaStore.releaseMediaObjectUrl(persistedPart.mediaId)).toBe(true);
        expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:media-preview');
    });

    it('媒体记录缺失时阻止发送不完整请求', async () => {
        await expect(
            mediaStore.resolveMessagesMediaForApi([
                {
                    id: 'missing',
                    parts: [{ type: 'media', media: 'image', mediaId: 'media-missing' }]
                }
            ])
        ).rejects.toThrow('媒体数据缺失: media-missing');
    });

    it('外置并恢复多回复分支中的媒体', async () => {
        const dataUrl = 'data:image/png;base64,cmVwbHk=';
        const source = [
            {
                id: 'multi',
                parts: [{ type: 'text', text: 'selected' }],
                replies: {
                    selected: 0,
                    all: [
                        {
                            parts: [
                                { type: 'media', media: 'image', mime: 'image/png', url: dataUrl }
                            ]
                        }
                    ]
                }
            }
        ];

        const externalized = await mediaStore.externalizeMessagesMedia(source);
        const persistedPart = externalized.messages[0].replies.all[0].parts[0];
        expect(persistedPart.url).toBeUndefined();
        expect(persistedPart.mediaId).toMatch(/^media-/);

        const apiMessages = await mediaStore.resolveMessagesMediaForApi(externalized.messages);
        expect(apiMessages[0].replies.all[0].parts[0].url).toBe(dataUrl);

        const displayed = await mediaStore.resolveMessageMediaForDisplay(externalized.messages[0]);
        expect(displayed.message.replies.all[0].parts[0].url).toBe('blob:media-preview');
        expect(displayed.mediaIds).toEqual([persistedPart.mediaId]);
    });

    it('会话原子保存同步替换媒体引用并清理孤儿', async () => {
        const firstUrl = 'data:image/png;base64,Zmlyc3Q=';
        const secondUrl = 'data:image/png;base64,c2Vjb25k';
        const session = {
            id: 'session-media',
            name: 'media',
            createdAt: 1,
            updatedAt: 2,
            messageCount: 2
        };

        await storage.saveSessionAtomic(session, {
            messages: [
                {
                    id: 'm1',
                    parts: [{ type: 'media', media: 'image', url: firstUrl }]
                },
                {
                    id: 'm2',
                    parts: [{ type: 'media', media: 'image', url: secondUrl }]
                }
            ]
        });

        const initialRefs = await getAll('mediaRefs');
        expect(initialRefs).toHaveLength(2);
        expect(await getAll('mediaBlobs')).toHaveLength(2);

        await storage.saveSessionAtomic(
            { ...session, updatedAt: 3, messageCount: 1 },
            {
                messages: [
                    {
                        id: 'm2',
                        parts: [{ type: 'media', media: 'image', url: secondUrl }]
                    }
                ]
            },
            { expectedUpdatedAt: 2 }
        );

        const currentRefs = await getAll('mediaRefs');
        expect(currentRefs).toHaveLength(1);
        expect(initialRefs.map((ref) => ref.mediaId)).toContain(currentRefs[0].mediaId);
        expect(await mediaStore.cleanupOrphanedMedia({ graceMs: -1 })).toBe(1);
        expect(await getAll('mediaBlobs')).toHaveLength(1);
    });

    it('删除消息存储时同步移除会话媒体引用', async () => {
        await storage.saveSessionAtomic(
            {
                id: 'session-delete',
                name: 'delete',
                createdAt: 1,
                updatedAt: 1,
                messageCount: 1
            },
            {
                messages: [
                    {
                        id: 'm1',
                        parts: [
                            {
                                type: 'media',
                                media: 'image',
                                url: 'data:image/png;base64,ZGVsZXRl'
                            }
                        ]
                    }
                ]
            }
        );

        expect(await getAll('mediaRefs')).toHaveLength(1);
        await storage.deleteSessionMessages('session-delete');
        expect(await getAll('mediaRefs')).toEqual([]);
    });

    it('没有 Data URL 时保留消息对象引用并收集已有媒体 ID', async () => {
        const message = {
            id: 'existing-media',
            parts: [{ type: 'media', media: 'image', mediaId: 'media-existing' }]
        };

        const result = await mediaStore.externalizeMessagesMedia([message]);

        expect(result.messages[0]).toBe(message);
        expect(result.mediaIds).toEqual(['media-existing']);
    });
});
