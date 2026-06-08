/**
 * indexeddb.js 测试
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../js/core/events.js', () => ({
    eventBus: { emit: vi.fn(), on: vi.fn(), off: vi.fn() }
}));

vi.mock('../../js/utils/logger.js', () => ({
    logger: { warn: vi.fn(), debug: vi.fn(), error: vi.fn(), info: vi.fn() }
}));

import {
    STORES,
    withDBLock,
    isLocalStorageAvailable,
    safeLocalStorageGet,
    safeLocalStorageSet,
    isIndexedDBAvailable,
    requestPersistentStorage,
    checkPersistentStorage,
    getDB,
    hasMessagesStore,
    hasSearchIndexStore,
    saveToStore,
    loadFromStore,
    deleteFromStore,
    loadAllFromStore
} from '../../js/state/indexeddb.js';

describe('indexeddb', () => {
    beforeEach(() => {
        localStorage.clear();
        vi.clearAllMocks();
    });

    // ========== STORES ==========
    describe('STORES', () => {
        it('包含所有存储名', () => {
            expect(STORES.SESSIONS).toBe('sessions');
            expect(STORES.CONFIG).toBe('config');
            expect(STORES.PREFERENCES).toBe('preferences');
            expect(STORES.QUICK_MESSAGES).toBe('quickMessages');
            expect(STORES.MCP_SERVERS).toBe('mcpServers');
            expect(STORES.MESSAGES).toBe('messages');
            expect(STORES.SEARCH_INDEXES).toBe('sessionSearchIndexes');
            expect(STORES.THEMES).toBe('themes');
        });
    });

    // ========== withDBLock ==========
    describe('withDBLock', () => {
        it('有 navigator.locks 时使用锁', async () => {
            const fn = vi.fn(() => 'result');
            // jsdom 可能没有 navigator.locks，手动 mock
            const origLocks = navigator.locks;
            Object.defineProperty(navigator, 'locks', {
                value: {
                    request: vi.fn((name, cb) => cb())
                },
                configurable: true
            });
            const result = await withDBLock('test-lock', fn);
            expect(fn).toHaveBeenCalled();
            Object.defineProperty(navigator, 'locks', {
                value: origLocks,
                configurable: true
            });
        });

        it('无 navigator.locks 时直接执行', async () => {
            const origLocks = navigator.locks;
            Object.defineProperty(navigator, 'locks', {
                value: undefined,
                configurable: true
            });
            const fn = vi.fn(() => 'direct');
            const result = await withDBLock('test', fn);
            expect(fn).toHaveBeenCalled();
            Object.defineProperty(navigator, 'locks', {
                value: origLocks,
                configurable: true
            });
        });
    });

    // ========== isLocalStorageAvailable ==========
    describe('isLocalStorageAvailable', () => {
        it('正常环境返回 true', () => {
            expect(isLocalStorageAvailable()).toBe(true);
        });
    });

    // ========== safeLocalStorageGet ==========
    describe('safeLocalStorageGet', () => {
        it('读取已有值', () => {
            localStorage.setItem('test-key', 'test-value');
            expect(safeLocalStorageGet('test-key')).toBe('test-value');
        });

        it('不存在返回 null', () => {
            expect(safeLocalStorageGet('nonexistent')).toBeNull();
        });
    });

    // ========== safeLocalStorageSet ==========
    describe('safeLocalStorageSet', () => {
        it('写入成功返回 true', () => {
            expect(safeLocalStorageSet('test-key', 'value')).toBe(true);
            expect(localStorage.getItem('test-key')).toBe('value');
        });
    });

    // ========== isIndexedDBAvailable ==========
    describe('isIndexedDBAvailable', () => {
        it('在 jsdom 中检测可用性', () => {
            // jsdom 可能有或没有 indexedDB
            const result = isIndexedDBAvailable();
            expect(typeof result).toBe('boolean');
        });
    });

    // ========== requestPersistentStorage ==========
    describe('requestPersistentStorage', () => {
        it('不支持时返回 false', async () => {
            const origStorage = navigator.storage;
            Object.defineProperty(navigator, 'storage', {
                value: undefined,
                configurable: true
            });
            const result = await requestPersistentStorage();
            expect(result).toBe(false);
            Object.defineProperty(navigator, 'storage', {
                value: origStorage,
                configurable: true
            });
        });

        it('支持时调用 persist', async () => {
            const origStorage = navigator.storage;
            Object.defineProperty(navigator, 'storage', {
                value: {
                    persist: vi.fn(() => Promise.resolve(true)),
                    persisted: vi.fn(() => Promise.resolve(true))
                },
                configurable: true
            });
            const result = await requestPersistentStorage();
            expect(result).toBe(true);
            Object.defineProperty(navigator, 'storage', {
                value: origStorage,
                configurable: true
            });
        });

        it('persist 失败返回 false', async () => {
            const origStorage = navigator.storage;
            Object.defineProperty(navigator, 'storage', {
                value: {
                    persist: vi.fn(() => Promise.reject(new Error('denied'))),
                    persisted: vi.fn(() => Promise.resolve(false))
                },
                configurable: true
            });
            const result = await requestPersistentStorage();
            expect(result).toBe(false);
            Object.defineProperty(navigator, 'storage', {
                value: origStorage,
                configurable: true
            });
        });
    });

    // ========== checkPersistentStorage ==========
    describe('checkPersistentStorage', () => {
        it('不支持时返回 false', async () => {
            const origStorage = navigator.storage;
            Object.defineProperty(navigator, 'storage', {
                value: undefined,
                configurable: true
            });
            const result = await checkPersistentStorage();
            expect(result).toBe(false);
            Object.defineProperty(navigator, 'storage', {
                value: origStorage,
                configurable: true
            });
        });

        it('已持久化返回 true', async () => {
            const origStorage = navigator.storage;
            Object.defineProperty(navigator, 'storage', {
                value: {
                    persisted: vi.fn(() => Promise.resolve(true))
                },
                configurable: true
            });
            const result = await checkPersistentStorage();
            expect(result).toBe(true);
            Object.defineProperty(navigator, 'storage', {
                value: origStorage,
                configurable: true
            });
        });

        it('检查失败返回 false', async () => {
            const origStorage = navigator.storage;
            Object.defineProperty(navigator, 'storage', {
                value: {
                    persisted: vi.fn(() => Promise.reject(new Error('err')))
                },
                configurable: true
            });
            const result = await checkPersistentStorage();
            expect(result).toBe(false);
            Object.defineProperty(navigator, 'storage', {
                value: origStorage,
                configurable: true
            });
        });
    });

    // ========== getDB ==========
    describe('getDB', () => {
        it('初始化前返回 null', () => {
            expect(getDB()).toBeNull();
        });
    });

    // ========== hasMessagesStore / hasSearchIndexStore ==========
    describe('hasMessagesStore / hasSearchIndexStore', () => {
        it('db 为 null 时返回 falsy', () => {
            expect(hasMessagesStore()).toBeFalsy();
            expect(hasSearchIndexStore()).toBeFalsy();
        });
    });

    // ========== saveToStore / loadFromStore / deleteFromStore / loadAllFromStore ==========
    describe('CRUD (db 未初始化)', () => {
        it('saveToStore 拒绝', async () => {
            await expect(saveToStore('sessions', 'key1', 'val')).rejects.toThrow('数据库未初始化');
        });

        it('loadFromStore 拒绝', async () => {
            await expect(loadFromStore('sessions', 'key1')).rejects.toThrow('数据库未初始化');
        });

        it('deleteFromStore 拒绝', async () => {
            await expect(deleteFromStore('sessions', 'key1')).rejects.toThrow('数据库未初始化');
        });

        it('loadAllFromStore 拒绝', async () => {
            await expect(loadAllFromStore('sessions')).rejects.toThrow('数据库未初始化');
        });
    });
});
