/**
 * IndexedDB 底层基础设施
 * 数据库初始化、版本升级、泛型 CRUD、存储检测
 */

import { eventBus } from '../core/events.js';
import { logger } from '../utils/logger.js';

// IndexedDB 配置
const DB_NAME = 'GeminiChatDB';
const DB_VERSION = 7; // 版本 7：新增文件夹存储

// 对象存储名称常量
export const STORES = {
    SESSIONS: 'sessions',
    CONFIG: 'config',
    PREFERENCES: 'preferences',
    QUICK_MESSAGES: 'quickMessages',
    MCP_SERVERS: 'mcpServers',
    MESSAGES: 'messages', // 版本 4：消息独立存储
    SEARCH_INDEXES: 'sessionSearchIndexes', // 版本 5：会话搜索索引
    THEMES: 'themes', // 版本 6：自定义主题
    FOLDERS: 'folders' // 版本 7：会话文件夹
};

let db = null;
let _versionChangePending = false;

/**
 * 跨标签页写入锁：防止多标签页并发覆盖 IndexedDB 数据
 * 使用 Web Locks API，不支持时降级为无锁
 */
export function withDBLock(lockName, fn) {
    if (navigator.locks) {
        return navigator.locks.request(lockName, fn);
    }
    return fn();
}

/**
 * 检测 IndexedDB 是否可用
 * 增强版：实际测试访问权限（处理跟踪保护）
 * @returns {boolean}
 */
export function isIndexedDBAvailable() {
    try {
        // 基础检查
        if (!('indexedDB' in window) || indexedDB === null) {
            return false;
        }

        // 实际测试访问（处理 Safari/Firefox 跟踪保护）
        // 尝试打开一个测试数据库
        const testRequest = indexedDB.open('test-db-availability');

        // 如果能创建请求对象，说明有访问权限
        if (testRequest) {
            // 立即关闭和删除测试数据库
            testRequest.onsuccess = () => {
                testRequest.result.close();
                indexedDB.deleteDatabase('test-db-availability');
            };
            testRequest.onerror = () => {
                // 静默处理错误
            };
            return true;
        }
        return false;
    } catch (e) {
        // SecurityError, QuotaExceededError 等都会被捕获
        logger.warn('IndexedDB 不可用（可能被跟踪保护阻止）:', e.name);
        return false;
    }
}

/**
 * 检测 localStorage 是否可用
 * 处理跟踪保护阻止 localStorage 的情况
 * @returns {boolean}
 */
export function isLocalStorageAvailable() {
    try {
        const testKey = '__ls_test__';
        localStorage.setItem(testKey, 'test');
        localStorage.removeItem(testKey);
        return true;
    } catch (e) {
        logger.warn('localStorage 不可用（可能被跟踪保护阻止）:', e.name);
        return false;
    }
}

/**
 * 安全的 localStorage 读取（处理跟踪保护）
 * @param {string} key - 键名
 * @returns {string|null} 值或null
 */
export function safeLocalStorageGet(key) {
    try {
        return localStorage.getItem(key);
    } catch (e) {
        logger.warn(`localStorage.getItem('${key}') 失败:`, e.name);
        return null;
    }
}

/**
 * 安全的 localStorage 写入（处理跟踪保护）
 * @param {string} key - 键名
 * @param {string} value - 值
 * @returns {boolean} 是否成功
 */
export function safeLocalStorageSet(key, value) {
    try {
        localStorage.setItem(key, value);
        return true;
    } catch (e) {
        logger.warn(`localStorage.setItem('${key}') 失败:`, e.name);
        return false;
    }
}

/**
 * 请求持久化存储（避免数据被清理）
 * 适用于 Electron, Android, iOS 等环境
 * @returns {Promise<boolean>} 是否成功获取持久化权限
 */
export async function requestPersistentStorage() {
    if (navigator.storage && navigator.storage.persist) {
        try {
            const isPersisted = await navigator.storage.persist();
            if (isPersisted) {
                logger.debug('已获取持久化存储权限（数据不会被自动清理）');
            } else {
                logger.warn('持久化存储权限被拒绝（Android/iOS 可能在 7 天后清理数据）');
                logger.debug('提示：定期访问应用可防止数据被清理');
            }
            return isPersisted;
        } catch (error) {
            logger.error('请求持久化存储失败:', error);
            return false;
        }
    } else {
        logger.debug('当前环境不支持持久化存储 API（可能是旧版浏览器）');
        return false;
    }
}

/**
 * 检查当前存储是否已持久化
 * @returns {Promise<boolean>} 是否已持久化
 */
export async function checkPersistentStorage() {
    if (navigator.storage && navigator.storage.persisted) {
        try {
            const isPersisted = await navigator.storage.persisted();
            return isPersisted;
        } catch (error) {
            logger.error('检查持久化状态失败:', error);
            return false;
        }
    }
    return false;
}

/**
 * 初始化 IndexedDB
 * @returns {Promise<IDBDatabase|null>} 数据库实例，失败时返回 null
 */
export function initDB() {
    return new Promise((resolve) => {
        // 增强降级处理：检测 IndexedDB 可用性
        if (!isIndexedDBAvailable()) {
            logger.warn('IndexedDB 不可用，将使用 localStorage 降级模式');
            resolve(null);
            return;
        }

        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onerror = () => {
            logger.error('IndexedDB 打开失败:', request.error);
            // 降级处理：不抛出错误，返回 null
            logger.warn('IndexedDB 初始化失败，将使用 localStorage 降级模式');
            resolve(null);
        };

        request.onsuccess = () => {
            db = request.result;
            logger.debug(`IndexedDB 初始化成功（版本 ${DB_VERSION}）`);

            // 其他标签页升级数据库版本时，关闭当前连接避免阻塞
            db.onversionchange = () => {
                _versionChangePending = true;
                db.close();
                db = null;
                eventBus.emit('ui:notification', {
                    message: '检测到新版本，请刷新页面',
                    type: 'warning',
                    duration: 0
                });
            };

            // 监听连接关闭，自动重连（版本升级导致的关闭除外）
            db.onclose = () => {
                if (_versionChangePending) return;
                logger.warn('IndexedDB 连接已关闭，尝试重新连接...');
                db = null;
                initDB().catch((e) => logger.error('IndexedDB 重连失败:', e));
            };

            resolve(db);
        };

        request.onupgradeneeded = (event) => {
            const database = event.target.result;
            const oldVersion = event.oldVersion;
            const newVersion = event.newVersion;

            logger.debug(`升级 IndexedDB: v${oldVersion} → v${newVersion}`);

            // 版本 1: 创建会话存储
            if (oldVersion < 1) {
                if (!database.objectStoreNames.contains(STORES.SESSIONS)) {
                    const store = database.createObjectStore(STORES.SESSIONS, { keyPath: 'id' });
                    store.createIndex('updatedAt', 'updatedAt', { unique: false });
                    logger.debug('创建对象存储: sessions');
                }
            }

            // 版本 2: 创建配置、偏好设置、快捷消息存储
            if (oldVersion < 2) {
                // 创建配置存储
                if (!database.objectStoreNames.contains(STORES.CONFIG)) {
                    database.createObjectStore(STORES.CONFIG, { keyPath: 'key' });
                    logger.debug('创建对象存储: config');
                }

                // 创建偏好设置存储
                if (!database.objectStoreNames.contains(STORES.PREFERENCES)) {
                    database.createObjectStore(STORES.PREFERENCES, { keyPath: 'key' });
                    logger.debug('创建对象存储: preferences');
                }

                // 创建快捷消息存储
                if (!database.objectStoreNames.contains(STORES.QUICK_MESSAGES)) {
                    const qmStore = database.createObjectStore(STORES.QUICK_MESSAGES, {
                        keyPath: 'id'
                    });
                    qmStore.createIndex('category', 'category', { unique: false });
                    qmStore.createIndex('updatedAt', 'updatedAt', { unique: false });
                    logger.debug('创建对象存储: quickMessages');
                }
            }

            // 版本 3: 创建 MCP 服务器存储
            if (oldVersion < 3) {
                if (!database.objectStoreNames.contains(STORES.MCP_SERVERS)) {
                    const mcpStore = database.createObjectStore(STORES.MCP_SERVERS, {
                        keyPath: 'id'
                    });
                    mcpStore.createIndex('type', 'type', { unique: false });
                    mcpStore.createIndex('enabled', 'enabled', { unique: false });
                    mcpStore.createIndex('updatedAt', 'updatedAt', { unique: false });
                    logger.debug('创建对象存储: mcpServers');
                }
            }

            // 版本 4: 消息分离存储（从 session 中提取消息到独立 store）
            if (oldVersion < 4) {
                if (!database.objectStoreNames.contains(STORES.MESSAGES)) {
                    const msgStore = database.createObjectStore(STORES.MESSAGES, {
                        keyPath: 'sessionId'
                    });
                    msgStore.createIndex('updatedAt', 'updatedAt', { unique: false });
                    logger.debug('创建对象存储: messages');
                }
                // 数据迁移在 onupgradeneeded 完成后由 migrateSessionsToV4 执行
            }

            // 版本 5: 会话搜索索引独立存储
            if (oldVersion < 5) {
                if (!database.objectStoreNames.contains(STORES.SEARCH_INDEXES)) {
                    const searchStore = database.createObjectStore(STORES.SEARCH_INDEXES, {
                        keyPath: 'sessionId'
                    });
                    searchStore.createIndex('updatedAt', 'updatedAt', { unique: false });
                    logger.debug('创建对象存储: sessionSearchIndexes');
                }
            }

            // 版本 6: 自定义主题存储
            if (oldVersion < 6) {
                if (!database.objectStoreNames.contains(STORES.THEMES)) {
                    const themeStore = database.createObjectStore(STORES.THEMES, { keyPath: 'id' });
                    themeStore.createIndex('updatedAt', 'updatedAt', { unique: false });
                    logger.debug('创建对象存储: themes');
                }
            }

            // 版本 7: 会话文件夹存储
            if (oldVersion < 7) {
                if (!database.objectStoreNames.contains(STORES.FOLDERS)) {
                    const folderStore = database.createObjectStore(STORES.FOLDERS, {
                        keyPath: 'id'
                    });
                    folderStore.createIndex('order', 'order', { unique: false });
                    logger.debug('创建对象存储: folders');
                }
            }
        };
    });
}

/**
 * 获取数据库实例（用于高级操作）
 * @returns {IDBDatabase|null}
 */
export function getDB() {
    return db;
}

/**
 * 检查 messages store 是否存在（v4 迁移是否完成）
 */
export function hasMessagesStore() {
    return db && db.objectStoreNames.contains(STORES.MESSAGES);
}

/**
 * 检查搜索索引 store 是否存在
 */
export function hasSearchIndexStore() {
    return db && db.objectStoreNames.contains(STORES.SEARCH_INDEXES);
}

// ========== 通用存储 API ==========

/**
 * 通用保存函数（带配额检测）
 * @param {string} storeName - 对象存储名称
 * @param {string} key - 键
 * @param {any} value - 值
 * @returns {Promise<void>}
 */
export async function saveToStore(storeName, key, value) {
    return new Promise((resolve, reject) => {
        if (!db) {
            reject(new Error('数据库未初始化'));
            return;
        }

        try {
            const transaction = db.transaction([storeName], 'readwrite');
            const store = transaction.objectStore(storeName);
            const data = { key, value, updatedAt: Date.now() };
            const request = store.put(data);

            request.onsuccess = () => resolve();
            request.onerror = () => {
                const error = request.error;
                logger.error(`保存到 ${storeName} 失败:`, error);

                // 配额检测
                if (
                    error &&
                    (error.name === 'QuotaExceededError' ||
                        error.message?.includes('quota') ||
                        error.message?.includes('storage'))
                ) {
                    eventBus.emit('storage:quota-exceeded', {
                        message: `IndexedDB 存储空间不足（${storeName}）`
                    });
                }
                reject(error);
            };

            transaction.onerror = (event) => {
                const error = event.target.error;
                if (
                    error &&
                    (error.name === 'QuotaExceededError' || error.message?.includes('quota'))
                ) {
                    eventBus.emit('storage:quota-exceeded', {
                        message: `IndexedDB 存储空间不足（${storeName}）`
                    });
                }
            };
        } catch (error) {
            logger.error(`保存到 ${storeName} 异常:`, error);
            reject(error);
        }
    });
}

/**
 * 通用加载函数
 * @param {string} storeName - 对象存储名称
 * @param {string} key - 键
 * @returns {Promise<any|null>} 值，不存在时返回 null
 */
export async function loadFromStore(storeName, key) {
    return new Promise((resolve, reject) => {
        if (!db) {
            reject(new Error('数据库未初始化'));
            return;
        }

        try {
            const transaction = db.transaction([storeName], 'readonly');
            const store = transaction.objectStore(storeName);
            const request = store.get(key);

            request.onsuccess = () => {
                const result = request.result;
                resolve(result ? result.value : null);
            };
            request.onerror = () => {
                logger.error(`从 ${storeName} 加载失败:`, request.error);
                reject(request.error);
            };
        } catch (error) {
            logger.error(`从 ${storeName} 加载异常:`, error);
            reject(error);
        }
    });
}

/**
 * 通用删除函数
 * @param {string} storeName - 对象存储名称
 * @param {string} key - 键
 * @returns {Promise<void>}
 */
export async function deleteFromStore(storeName, key) {
    return new Promise((resolve, reject) => {
        if (!db) {
            reject(new Error('数据库未初始化'));
            return;
        }

        try {
            const transaction = db.transaction([storeName], 'readwrite');
            const store = transaction.objectStore(storeName);
            const request = store.delete(key);

            request.onsuccess = () => resolve();
            request.onerror = () => {
                logger.error(`从 ${storeName} 删除失败:`, request.error);
                reject(request.error);
            };
        } catch (error) {
            logger.error(`从 ${storeName} 删除异常:`, error);
            reject(error);
        }
    });
}

/**
 * 加载对象存储中的所有数据
 * @param {string} storeName - 对象存储名称
 * @returns {Promise<Array>} 所有数据
 */
export async function loadAllFromStore(storeName) {
    return new Promise((resolve, reject) => {
        if (!db) {
            reject(new Error('数据库未初始化'));
            return;
        }

        try {
            const transaction = db.transaction([storeName], 'readonly');
            const store = transaction.objectStore(storeName);
            const request = store.getAll();

            request.onsuccess = () => {
                resolve(request.result || []);
            };
            request.onerror = () => {
                logger.error(`从 ${storeName} 加载所有数据失败:`, request.error);
                reject(request.error);
            };
        } catch (error) {
            logger.error(`从 ${storeName} 加载所有数据异常:`, error);
            reject(error);
        }
    });
}
