import { getDB, hasMessagePageStore, STORES, withDBLock } from './indexeddb.js';
import { logger } from '../utils/logger.js';
import { SCHEMA_VERSION } from '../messages/schema.js';
import { normalizeSessionRecord } from '../messages/compat/gateway.js';
import { CompatibilityStatus } from '../messages/compat/result.js';

export const MESSAGE_PAGE_SIZE = 100;
const PAGE_CACHE_LIMIT = 24;
const pageCache = new Map();

function getPageCacheKey(sessionId, pageIndex) {
    return `${sessionId}:${pageIndex}`;
}

function setCachedPage(key, page) {
    if (pageCache.has(key)) pageCache.delete(key);
    while (pageCache.size >= PAGE_CACHE_LIMIT) pageCache.delete(pageCache.keys().next().value);
    pageCache.set(key, page);
}

export function invalidateMessagePageCache(sessionId = null) {
    if (!sessionId) {
        pageCache.clear();
        return;
    }
    const prefix = `${sessionId}:`;
    for (const key of pageCache.keys()) {
        if (key.startsWith(prefix)) pageCache.delete(key);
    }
}

function summarizeMessage(message, index) {
    return {
        id: message?.id || null,
        role: message?.role || 'assistant',
        ts: message?.ts || null,
        index,
        isError: Boolean(message?.error),
        model: message?.meta?.model || null,
        provider: message?.meta?.provider || null
    };
}

export function paginateMessages(messages, pageSize = MESSAGE_PAGE_SIZE) {
    const source = Array.isArray(messages) ? messages : [];
    const size = Math.max(1, Number.parseInt(pageSize, 10) || MESSAGE_PAGE_SIZE);
    const pages = [];
    for (let start = 0; start < source.length; start += size) {
        pages.push(source.slice(start, start + size));
    }
    return pages;
}

export function putMessagePages(
    transaction,
    sessionId,
    messages,
    { updatedAt = Date.now(), pageSize = MESSAGE_PAGE_SIZE } = {}
) {
    if (!transaction || !sessionId) return null;
    invalidateMessagePageCache(sessionId);
    const compatibility = normalizeSessionRecord(
        { sessionId, messages },
        { source: 'message-page-write' }
    );
    if (compatibility.status === CompatibilityStatus.FAILED) {
        throw new Error(`会话 ${sessionId} 消息格式无法分页`);
    }
    const canonicalMessages = compatibility.messages;
    const pages = paginateMessages(canonicalMessages, pageSize);
    const generation = `${updatedAt}-${canonicalMessages.length}`;
    const pageStore = transaction.objectStore(STORES.MESSAGE_PAGES);
    const manifestStore = transaction.objectStore(STORES.MESSAGE_MANIFESTS);

    if (globalThis.IDBKeyRange?.bound) {
        const staleRange = globalThis.IDBKeyRange.bound(
            [sessionId, pages.length],
            [sessionId, Number.MAX_SAFE_INTEGER]
        );
        const staleRequest = pageStore.openKeyCursor(staleRange);
        staleRequest.onsuccess = () => {
            const cursor = staleRequest.result;
            if (!cursor) return;
            pageStore.delete(cursor.primaryKey);
            cursor.continue();
        };
    }

    pages.forEach((pageMessages, pageIndex) => {
        pageStore.put({
            sessionId,
            pageIndex,
            start: pageIndex * pageSize,
            messages: pageMessages,
            generation,
            messageSchemaVersion: SCHEMA_VERSION,
            updatedAt
        });
    });

    const manifest = {
        sessionId,
        messageCount: canonicalMessages.length,
        pageCount: pages.length,
        pageSize,
        generation,
        messageSchemaVersion: SCHEMA_VERSION,
        updatedAt,
        state: 'complete',
        migration: null,
        summaries: canonicalMessages.map(summarizeMessage)
    };
    manifestStore.put(manifest);
    return manifest;
}

export function deleteMessagePages(transaction, sessionId) {
    if (!transaction || !sessionId) return;
    transaction.objectStore(STORES.MESSAGE_MANIFESTS).delete(sessionId);
    const pageStore = transaction.objectStore(STORES.MESSAGE_PAGES);
    const request = pageStore
        .index('sessionId')
        .openKeyCursor(globalThis.IDBKeyRange.only(sessionId));
    request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        pageStore.delete(cursor.primaryKey);
        cursor.continue();
    };
}

export async function savePagedSessionMessages(sessionId, messages, options = {}) {
    if (!hasMessagePageStore()) return null;
    return withDBLock(
        `webchat-session-${sessionId}`,
        () =>
            new Promise((resolve, reject) => {
                const transaction = getDB().transaction(
                    [STORES.MESSAGE_PAGES, STORES.MESSAGE_MANIFESTS],
                    'readwrite'
                );
                const manifest = putMessagePages(transaction, sessionId, messages, options);
                transaction.oncomplete = () => resolve(manifest);
                transaction.onerror = () => reject(transaction.error);
                transaction.onabort = () =>
                    reject(transaction.error || new Error('分页消息写入中止'));
            })
    );
}

export async function loadMessageManifest(sessionId) {
    if (!hasMessagePageStore()) return null;
    return new Promise((resolve, reject) => {
        const transaction = getDB().transaction([STORES.MESSAGE_MANIFESTS], 'readonly');
        const request = transaction.objectStore(STORES.MESSAGE_MANIFESTS).get(sessionId);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error);
    });
}

export async function loadMessagePage(sessionId, pageIndex) {
    if (!hasMessagePageStore()) return null;
    const cacheKey = getPageCacheKey(sessionId, pageIndex);
    if (pageCache.has(cacheKey)) {
        const cached = pageCache.get(cacheKey);
        pageCache.delete(cacheKey);
        pageCache.set(cacheKey, cached);
        return cached;
    }
    return new Promise((resolve, reject) => {
        const transaction = getDB().transaction([STORES.MESSAGE_PAGES], 'readonly');
        const request = transaction.objectStore(STORES.MESSAGE_PAGES).get([sessionId, pageIndex]);
        request.onsuccess = () => {
            const page = request.result || null;
            if (page) setCachedPage(cacheKey, page);
            resolve(page);
        };
        request.onerror = () => reject(request.error);
    });
}

export async function loadSessionMessageRange(sessionId, start = 0, end = Infinity) {
    const manifest = await loadMessageManifest(sessionId);
    if (
        !manifest ||
        manifest.state !== 'complete' ||
        manifest.messageSchemaVersion !== SCHEMA_VERSION
    ) {
        return null;
    }
    const rangeStart = Math.max(0, Number.parseInt(start, 10) || 0);
    const rangeEnd = Math.max(
        rangeStart,
        Math.min(
            manifest.messageCount,
            Number.isFinite(end) ? Math.ceil(end) : manifest.messageCount
        )
    );
    if (rangeStart >= rangeEnd) return { messages: [], manifest, start: rangeStart, end: rangeEnd };

    const firstPage = Math.floor(rangeStart / manifest.pageSize);
    const lastPage = Math.floor((rangeEnd - 1) / manifest.pageSize);
    const pages = await Promise.all(
        Array.from({ length: lastPage - firstPage + 1 }, (_, offset) =>
            loadMessagePage(sessionId, firstPage + offset)
        )
    );
    if (
        pages.some(
            (page) =>
                !page ||
                page.generation !== manifest.generation ||
                page.messageSchemaVersion !== SCHEMA_VERSION
        )
    ) {
        return null;
    }

    const joined = pages.flatMap((page) => page.messages || []);
    const sliceStart = rangeStart - firstPage * manifest.pageSize;
    return {
        messages: joined.slice(sliceStart, sliceStart + (rangeEnd - rangeStart)),
        manifest,
        start: rangeStart,
        end: rangeEnd
    };
}

export async function loadAllPagedSessionMessages(sessionId) {
    const manifest = await loadMessageManifest(sessionId);
    if (!manifest) return null;
    return loadSessionMessageRange(sessionId, 0, manifest.messageCount);
}

async function isMessageRecordMigrated(record) {
    const count = Array.isArray(record?.messages) ? record.messages.length : 0;
    const existing = await loadMessageManifest(record.sessionId);
    let complete =
        existing?.state === 'complete' &&
        existing.messageSchemaVersion === SCHEMA_VERSION &&
        existing.messageCount === count &&
        existing.summaries?.length === count;
    if (complete) {
        const stored = await loadSessionMessageRange(record.sessionId, 0, count);
        complete = stored?.messages?.length === count;
    }
    return complete;
}

async function migrateMessageRecord(record) {
    if (await isMessageRecordMigrated(record)) return false;
    const compatibility = normalizeSessionRecord(record, {
        sessionId: record.sessionId,
        declaredVersion: record.messageSchemaVersion,
        source: 'message-page-migration'
    });
    await savePagedSessionMessages(record.sessionId, compatibility.messages, {
        updatedAt: record.updatedAt || Date.now()
    });
    return true;
}

export async function migrateSessionMessagesToPages(sessionId) {
    if (!hasMessagePageStore() || !sessionId) return { migrated: 0, skipped: 0, errors: [] };
    const record = await new Promise((resolve, reject) => {
        const transaction = getDB().transaction([STORES.MESSAGES], 'readonly');
        const request = transaction.objectStore(STORES.MESSAGES).get(sessionId);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error);
    });
    if (!record) return { migrated: 0, skipped: 0, errors: [] };
    try {
        const migrated = await migrateMessageRecord(record);
        return {
            migrated: migrated ? 1 : 0,
            skipped: migrated ? 0 : 1,
            errors: []
        };
    } catch (error) {
        logger.error(`[MessagePages] 迁移会话 ${sessionId} 失败:`, error);
        return { migrated: 0, skipped: 0, errors: [{ sessionId, error }] };
    }
}

export async function migrateMessagesToPages() {
    if (!hasMessagePageStore()) return { migrated: 0, skipped: 0, errors: [] };
    const records = await new Promise((resolve, reject) => {
        const transaction = getDB().transaction([STORES.MESSAGES], 'readonly');
        const request = transaction.objectStore(STORES.MESSAGES).getAll();
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error);
    });

    const result = { migrated: 0, skipped: 0, errors: [] };
    for (const record of records) {
        try {
            if (!(await migrateMessageRecord(record))) {
                result.skipped += 1;
                continue;
            }
            result.migrated += 1;
        } catch (error) {
            result.errors.push({ sessionId: record.sessionId, error });
            logger.error(`[MessagePages] 迁移会话 ${record.sessionId} 失败:`, error);
        }
    }
    return result;
}
