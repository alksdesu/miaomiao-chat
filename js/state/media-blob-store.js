import { getDB, hasMediaBlobStore, STORES, withDBLock } from './indexeddb.js';
import { logger } from '../utils/logger.js';

const objectUrlCache = new Map();

async function mapMessageParts(message, transform) {
    const mapParts = async (parts) => {
        if (!Array.isArray(parts)) return parts;
        return Promise.all(parts.map((part) => transform(part)));
    };

    const parts = await mapParts(message?.parts);
    let replies = message?.replies;
    if (Array.isArray(replies?.all)) {
        const all = await Promise.all(
            replies.all.map(async (reply) => ({
                ...reply,
                parts: await mapParts(reply?.parts)
            }))
        );
        replies = { ...replies, all };
    }
    return { ...message, parts, replies };
}

function messageHasMediaId(message) {
    if (message?.parts?.some((part) => part?.mediaId)) return true;
    return Boolean(
        message?.replies?.all?.some((reply) => reply?.parts?.some((part) => part?.mediaId))
    );
}

function collectMessageMediaIds(message, target) {
    for (const part of message?.parts || []) {
        if (part?.mediaId) target.add(part.mediaId);
    }
    for (const reply of message?.replies?.all || []) {
        for (const part of reply?.parts || []) {
            if (part?.mediaId) target.add(part.mediaId);
        }
    }
}

function messageHasDataUrl(message) {
    if (message?.parts?.some((part) => part?.url?.startsWith?.('data:'))) return true;
    return Boolean(
        message?.replies?.all?.some((reply) =>
            reply?.parts?.some((part) => part?.url?.startsWith?.('data:'))
        )
    );
}

function dataUrlToBlob(dataUrl) {
    const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUrl);
    if (!match) throw new TypeError('无效 Data URL');
    const mime = match[1] || 'application/octet-stream';
    if (!match[2]) return new Blob([decodeURIComponent(match[3])], { type: mime });
    const binary = atob(match[3]);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return new Blob([bytes], { type: mime });
}

async function createMediaId(dataUrl) {
    if (globalThis.crypto?.subtle) {
        const bytes = new TextEncoder().encode(dataUrl);
        const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
        return `media-${Array.from(new Uint8Array(digest), (byte) =>
            byte.toString(16).padStart(2, '0')
        ).join('')}`;
    }
    let hash = 2166136261;
    for (let index = 0; index < dataUrl.length; index += 1) {
        hash ^= dataUrl.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return `media-${(hash >>> 0).toString(16)}-${dataUrl.length}`;
}

function requestResult(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error);
    });
}

export async function storeDataUrlMedia(dataUrl) {
    if (!hasMediaBlobStore() || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) {
        return null;
    }
    const id = await createMediaId(dataUrl);
    const existing = await loadMediaBlob(id);
    if (existing) return { id, mime: existing.mime, size: existing.size };

    const blob = dataUrlToBlob(dataUrl);
    await withDBLock(
        `webchat-media-${id}`,
        () =>
            new Promise((resolve, reject) => {
                const transaction = getDB().transaction([STORES.MEDIA_BLOBS], 'readwrite');
                transaction.objectStore(STORES.MEDIA_BLOBS).put({
                    id,
                    blob,
                    mime: blob.type,
                    size: blob.size,
                    createdAt: Date.now(),
                    lastAccessed: Date.now()
                });
                transaction.oncomplete = () => resolve();
                transaction.onerror = () => reject(transaction.error);
            })
    );
    return { id, mime: blob.type, size: blob.size };
}

export async function loadMediaBlob(mediaId) {
    if (!hasMediaBlobStore() || !mediaId) return null;
    const transaction = getDB().transaction([STORES.MEDIA_BLOBS], 'readonly');
    return requestResult(transaction.objectStore(STORES.MEDIA_BLOBS).get(mediaId));
}

export async function acquireMediaObjectUrl(mediaId) {
    const cached = objectUrlCache.get(mediaId);
    if (cached) {
        cached.references += 1;
        return cached.url;
    }
    const record = await loadMediaBlob(mediaId);
    if (!record?.blob) return null;
    const url = URL.createObjectURL(record.blob);
    objectUrlCache.set(mediaId, { url, references: 1 });
    return url;
}

export function releaseMediaObjectUrl(mediaId) {
    const cached = objectUrlCache.get(mediaId);
    if (!cached) return false;
    cached.references -= 1;
    if (cached.references > 0) return false;
    URL.revokeObjectURL(cached.url);
    objectUrlCache.delete(mediaId);
    return true;
}

export function releaseAllMediaObjectUrls() {
    for (const cached of objectUrlCache.values()) URL.revokeObjectURL(cached.url);
    objectUrlCache.clear();
}

export function hasStoredMedia(message) {
    return messageHasMediaId(message);
}

export async function resolveMessageMediaForDisplay(message) {
    if (!hasStoredMedia(message)) return { message, mediaIds: [] };
    const mediaIds = [];
    const resolvedMessage = await mapMessageParts(message, async (part) => {
        if (!part?.mediaId) return part;
        const url = await acquireMediaObjectUrl(part.mediaId);
        if (!url) return part;
        mediaIds.push(part.mediaId);
        return { ...part, url };
    });
    return { message: resolvedMessage, mediaIds };
}

async function blobToDataUrl(blob) {
    if (typeof blob?.arrayBuffer === 'function') {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let binary = '';
        const chunkSize = 32 * 1024;
        for (let offset = 0; offset < bytes.length; offset += chunkSize) {
            binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
        }
        return `data:${blob.type || 'application/octet-stream'};base64,${btoa(binary)}`;
    }
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
    });
}

export async function resolveMessagesMediaForApi(messages) {
    return Promise.all(
        messages.map(async (message) => {
            if (!hasStoredMedia(message)) return message;
            return mapMessageParts(message, async (part) => {
                if (!part?.mediaId || part.url) return part;
                const record = await loadMediaBlob(part.mediaId);
                if (!record?.blob) {
                    throw new Error(`媒体数据缺失: ${part.mediaId}`);
                }
                return { ...part, url: await blobToDataUrl(record.blob) };
            });
        })
    );
}

export async function externalizeMessagesMedia(messages) {
    if (!hasMediaBlobStore()) return { messages, mediaIds: [] };
    const mediaIds = new Set();
    const output = [];
    for (const message of messages) {
        collectMessageMediaIds(message, mediaIds);
        if (!messageHasDataUrl(message)) {
            output.push(message);
            continue;
        }
        const externalizedMessage = await mapMessageParts(message, async (part) => {
            if (typeof part?.url !== 'string' || !part.url.startsWith('data:')) {
                return part;
            }
            try {
                const stored = await storeDataUrlMedia(part.url);
                if (!stored) {
                    return part;
                }
                mediaIds.add(stored.id);
                const externalized = {
                    ...part,
                    mediaId: stored.id,
                    mime: part.mime || stored.mime
                };
                delete externalized.url;
                return externalized;
            } catch (error) {
                logger.warn('[MediaBlobStore] 媒体外置失败，保留原数据:', error);
                return part;
            }
        });
        output.push(externalizedMessage);
    }
    return { messages: output, mediaIds: Array.from(mediaIds) };
}

export async function updateSessionMediaReferences(sessionId, mediaIds) {
    if (!hasMediaBlobStore() || !sessionId) return;
    await withDBLock(
        `webchat-media-refs-${sessionId}`,
        () =>
            new Promise((resolve, reject) => {
                const transaction = getDB().transaction([STORES.MEDIA_REFS], 'readwrite');
                putSessionMediaReferences(transaction, sessionId, mediaIds);
                transaction.oncomplete = () => resolve();
                transaction.onerror = () => reject(transaction.error);
            })
    );
}

export function putSessionMediaReferences(transaction, sessionId, mediaIds) {
    if (!transaction || !sessionId) return;
    const ids = Array.from(new Set(mediaIds || []));
    const store = transaction.objectStore(STORES.MEDIA_REFS);
    const request = store.index('sessionId').openKeyCursor(globalThis.IDBKeyRange.only(sessionId));
    request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
            const updatedAt = Date.now();
            ids.forEach((mediaId) => store.put({ sessionId, mediaId, updatedAt }));
            return;
        }
        store.delete(cursor.primaryKey);
        cursor.continue();
    };
}

export function deleteSessionMediaReferences(transaction, sessionId) {
    if (!transaction || !sessionId) return;
    const store = transaction.objectStore(STORES.MEDIA_REFS);
    const request = store.index('sessionId').openKeyCursor(globalThis.IDBKeyRange.only(sessionId));
    request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        store.delete(cursor.primaryKey);
        cursor.continue();
    };
}

export async function cleanupOrphanedMedia({ graceMs = 24 * 60 * 60 * 1000 } = {}) {
    if (!hasMediaBlobStore()) return 0;
    const cutoff = Date.now() - graceMs;
    return new Promise((resolve, reject) => {
        let removed = 0;
        const transaction = getDB().transaction(
            [STORES.MEDIA_REFS, STORES.MEDIA_BLOBS],
            'readwrite'
        );
        const refsRequest = transaction.objectStore(STORES.MEDIA_REFS).getAll();
        refsRequest.onsuccess = () => {
            const referenced = new Set((refsRequest.result || []).map((ref) => ref.mediaId));
            const cursorRequest = transaction.objectStore(STORES.MEDIA_BLOBS).openCursor();
            cursorRequest.onsuccess = () => {
                const cursor = cursorRequest.result;
                if (!cursor) return;
                const record = cursor.value;
                if (!referenced.has(record.id) && (record.createdAt || 0) < cutoff) {
                    cursor.delete();
                    removed += 1;
                }
                cursor.continue();
            };
        };
        transaction.oncomplete = () => resolve(removed);
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
    });
}
