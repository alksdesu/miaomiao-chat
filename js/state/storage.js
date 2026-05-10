/**
 * IndexedDB 存储管理
 * 处理会话数据的持久化
 */

import { eventBus } from '../core/events.js';
import { createSessionSearchIndexRecord } from './session-search-index.js';

// re-export indexeddb.js 底层基础设施
export {
    STORES,
    withDBLock,
    isIndexedDBAvailable,
    isLocalStorageAvailable,
    safeLocalStorageGet,
    safeLocalStorageSet,
    requestPersistentStorage,
    checkPersistentStorage,
    initDB,
    getDB,
    saveToStore,
    loadFromStore,
    deleteFromStore,
    loadAllFromStore,
    hasMessagesStore,
    hasSearchIndexStore
} from './indexeddb.js';

// re-export 偏好设置 API
export { savePreference, loadPreference, loadAllPreferences } from './preferences-storage.js';

// 内部使用的导入
import {
    STORES,
    withDBLock,
    initDB,
    getDB,
    hasMessagesStore,
    hasSearchIndexStore,
    saveToStore,
    loadFromStore
} from './indexeddb.js';
import { logger } from '../utils/logger.js';

const STORE_NAME = 'sessions';

/**
 * 保存单个会话到 IndexedDB
 * @param {Object} session - 会话对象
 * @returns {Promise<void>}
 */
export async function saveSessionToDB(session) {
    return withDBLock(`webchat-session-${session.id}`, async () => {
        if (!getDB()) {
            try {
                await initDB();
            } catch (_) {
                /* ignore */
            }
            if (!getDB()) throw new Error('数据库未初始化且重连失败');
        }
        return new Promise((resolve, reject) => {
            const transaction = getDB().transaction([STORE_NAME], 'readwrite');
            const store = transaction.objectStore(STORE_NAME);
            const request = store.put(session);

            request.onsuccess = () => resolve();
            request.onerror = () => {
                const error = request.error;
                logger.error('保存会话失败:', error);

                if (
                    error &&
                    (error.name === 'QuotaExceededError' ||
                        error.message?.includes('quota') ||
                        error.message?.includes('storage'))
                ) {
                    eventBus.emit('storage:quota-exceeded', {
                        message: '存储空间不足！请清理一些旧会话或浏览器数据'
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
                        message: '存储空间不足！请清理一些旧会话或浏览器数据'
                    });
                }
            };
        });
    });
}

/**
 * 从 IndexedDB 加载所有会话
 * @returns {Promise<Array>} 会话数组
 */
export async function loadAllSessionsFromDB() {
    if (!getDB()) {
        try {
            await initDB();
        } catch (_) {
            /* ignore */
        }
        if (!getDB()) throw new Error('数据库未初始化且重连失败');
    }
    return new Promise((resolve, reject) => {
        const transaction = getDB().transaction([STORE_NAME], 'readonly');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.getAll();

        request.onsuccess = () => {
            // v4+: sessions store 只包含元数据，直接返回
            // v3 兼容: 如果 session 还包含消息数据（尚未迁移），剥离后返回
            const sessions = request.result.map((s) => {
                if (s.messages) {
                    // 未迁移的 v3 数据，返回元数据视图（不修改原始对象）
                    return {
                        id: s.id,
                        name: s.name,
                        apiFormat: s.apiFormat,
                        createdAt: s.createdAt,
                        updatedAt: s.updatedAt,
                        customName: s.customName || false,
                        messageCount: (s.messages || []).length,
                        // 临时保留消息引用（v4 迁移前需要）
                        _pendingMessages: s.messages
                    };
                }
                return s;
            });
            // 按更新时间排序，最新的在前
            sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
            resolve(sessions);
        };
        request.onerror = () => {
            logger.error('加载会话失败:', request.error);
            reject(request.error);
        };
    });
}

/**
 * 从 IndexedDB 删除会话
 * @param {string} sessionId - 会话 ID
 * @returns {Promise<void>}
 */
export async function deleteSessionFromDB(sessionId) {
    return withDBLock(`webchat-session-${sessionId}`, async () => {
        if (!getDB()) {
            try {
                await initDB();
            } catch (_) {
                /* ignore */
            }
            if (!getDB()) throw new Error('数据库未初始化且重连失败');
        }
        return new Promise((resolve, reject) => {
            const storeNames = [STORE_NAME];
            if (hasMessagesStore()) storeNames.push(STORES.MESSAGES);
            if (hasSearchIndexStore()) storeNames.push(STORES.SEARCH_INDEXES);

            const transaction = getDB().transaction(storeNames, 'readwrite');
            transaction.objectStore(STORE_NAME).delete(sessionId);
            if (hasMessagesStore()) {
                transaction.objectStore(STORES.MESSAGES).delete(sessionId);
            }
            if (hasSearchIndexStore())
                transaction.objectStore(STORES.SEARCH_INDEXES).delete(sessionId);

            transaction.oncomplete = () => resolve();
            transaction.onerror = () => {
                logger.error('删除会话失败:', transaction.error);
                reject(transaction.error);
            };
        });
    });
}

// ========== 消息分离存储 CRUD（v4） ==========

/**
 * 保存会话消息到独立的 messages store
 */
export async function saveSessionMessages(sessionId, data) {
    return withDBLock(`webchat-msg-${sessionId}`, async () => {
        if (!getDB()) {
            try {
                await initDB();
            } catch (_) {
                /* ignore */
            }
            if (!getDB()) throw new Error('数据库未初始化且重连失败');
        }
        return new Promise((resolve, reject) => {
            const messages = Array.isArray(data?.messages) ? data.messages : [];
            const searchIndex = createSessionSearchIndexRecord(
                sessionId,
                messages,
                data?.searchIndex || null
            );
            const storeNames = [STORES.MESSAGES];
            if (hasSearchIndexStore()) {
                storeNames.push(STORES.SEARCH_INDEXES);
            }

            const transaction = getDB().transaction(storeNames, 'readwrite');
            const messagesStore = transaction.objectStore(STORES.MESSAGES);
            messagesStore.put({ sessionId, messages });

            if (hasSearchIndexStore()) {
                transaction.objectStore(STORES.SEARCH_INDEXES).put(searchIndex);
            }

            transaction.oncomplete = () => {
                eventBus.emit('session-search:index-updated', {
                    sessionId,
                    searchIndex
                });
                resolve();
            };
            transaction.onerror = () => {
                const error = transaction.error;
                if (
                    error &&
                    (error.name === 'QuotaExceededError' || error.message?.includes('quota'))
                ) {
                    eventBus.emit('storage:quota-exceeded', { message: '存储空间不足！' });
                }
                reject(error);
            };
        });
    });
}

/**
 * 原子保存会话元数据 + 消息（单事务，两个 store）
 */
export async function saveSessionAtomic(sessionMeta, messagesData) {
    return withDBLock(`webchat-session-${sessionMeta.id}`, async () => {
        if (!getDB()) {
            try {
                await initDB();
            } catch (_) {
                /* ignore */
            }
            if (!getDB()) throw new Error('数据库未初始化且重连失败');
        }
        return new Promise((resolve, reject) => {
            const messages = Array.isArray(messagesData?.messages) ? messagesData.messages : [];
            const searchIndex = createSessionSearchIndexRecord(
                sessionMeta.id,
                messages,
                messagesData?.searchIndex || null
            );
            const storeNames = [STORE_NAME, STORES.MESSAGES];
            if (hasSearchIndexStore()) {
                storeNames.push(STORES.SEARCH_INDEXES);
            }

            const transaction = getDB().transaction(storeNames, 'readwrite');
            transaction.objectStore(STORES.MESSAGES).put({
                sessionId: sessionMeta.id,
                messages
            });
            transaction.objectStore(STORE_NAME).put(sessionMeta);

            if (hasSearchIndexStore()) {
                transaction.objectStore(STORES.SEARCH_INDEXES).put(searchIndex);
            }

            transaction.oncomplete = () => {
                eventBus.emit('session-search:index-updated', {
                    sessionId: sessionMeta.id,
                    searchIndex
                });
                resolve();
            };
            transaction.onerror = () => {
                const error = transaction.error;
                if (
                    error &&
                    (error.name === 'QuotaExceededError' || error.message?.includes('quota'))
                ) {
                    eventBus.emit('storage:quota-exceeded', { message: '存储空间不足！' });
                }
                reject(error);
            };
        });
    });
}

/**
 * 从 messages store 加载指定会话的消息
 * @param {string} sessionId - 会话 ID
 * @returns {Promise<Object|null>} { messages } 或 null
 */
export async function loadSessionMessages(sessionId) {
    if (!getDB()) {
        try {
            await initDB();
        } catch (_) {
            /* ignore */
        }
        if (!getDB()) throw new Error('数据库未初始化且重连失败');
    }
    return new Promise((resolve, reject) => {
        const transaction = getDB().transaction([STORES.MESSAGES], 'readonly');
        const store = transaction.objectStore(STORES.MESSAGES);
        const request = store.get(sessionId);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error);
    });
}

/**
 * 保存指定会话的搜索索引
 * @param {string} sessionId - 会话 ID
 * @param {Object} searchIndex - 搜索索引
 */
export async function saveSessionSearchIndex(sessionId, searchIndex) {
    return withDBLock(`webchat-search-index-${sessionId}`, async () => {
        if (!getDB()) {
            try {
                await initDB();
            } catch (_) {
                /* ignore */
            }
            if (!getDB()) throw new Error('数据库未初始化且重连失败');
        }

        if (!hasSearchIndexStore()) {
            return;
        }

        const normalizedIndex = createSessionSearchIndexRecord(sessionId, null, searchIndex);

        return new Promise((resolve, reject) => {
            const transaction = getDB().transaction([STORES.SEARCH_INDEXES], 'readwrite');
            const store = transaction.objectStore(STORES.SEARCH_INDEXES);
            store.put(normalizedIndex);

            transaction.oncomplete = () => {
                eventBus.emit('session-search:index-updated', {
                    sessionId,
                    searchIndex: normalizedIndex
                });
                resolve();
            };
            transaction.onerror = () => reject(transaction.error);
        });
    });
}

/**
 * 加载全部会话搜索索引
 * @returns {Promise<Array>} 搜索索引记录数组
 */
export async function loadAllSessionSearchIndexes() {
    if (!getDB()) {
        try {
            await initDB();
        } catch (_) {
            /* ignore */
        }
        if (!getDB()) throw new Error('数据库未初始化且重连失败');
    }

    if (!hasSearchIndexStore()) {
        return [];
    }

    return new Promise((resolve, reject) => {
        const transaction = getDB().transaction([STORES.SEARCH_INDEXES], 'readonly');
        const store = transaction.objectStore(STORES.SEARCH_INDEXES);
        const request = store.getAll();
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error);
    });
}

/**
 * 删除指定会话的消息数据
 * @param {string} sessionId - 会话 ID
 */
export async function deleteSessionMessages(sessionId) {
    if (!getDB()) {
        try {
            await initDB();
        } catch (_) {
            /* ignore */
        }
        if (!getDB()) throw new Error('数据库未初始化且重连失败');
    }
    return new Promise((resolve, reject) => {
        const transaction = getDB().transaction([STORES.MESSAGES], 'readwrite');
        const store = transaction.objectStore(STORES.MESSAGES);
        const request = store.delete(sessionId);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}

/**
 * v4 数据迁移：将 sessions store 中嵌入的消息提取到 messages store
 * 在 initDB 成功后调用
 */
export async function migrateSessionsToV4() {
    if (!getDB() || !hasMessagesStore()) return;

    return new Promise((resolve, reject) => {
        const storeNames = [STORES.SESSIONS, STORES.MESSAGES];
        if (hasSearchIndexStore()) {
            storeNames.push(STORES.SEARCH_INDEXES);
        }

        const transaction = getDB().transaction(storeNames, 'readwrite');
        const sessionsStore = transaction.objectStore(STORES.SESSIONS);
        const messagesStore = transaction.objectStore(STORES.MESSAGES);
        const searchStore = hasSearchIndexStore()
            ? transaction.objectStore(STORES.SEARCH_INDEXES)
            : null;

        const request = sessionsStore.openCursor();
        let migratedCount = 0;

        request.onsuccess = (event) => {
            const cursor = event.target.result;
            if (!cursor) {
                if (migratedCount > 0) {
                    logger.debug(`[v4 迁移] 完成，迁移了 ${migratedCount} 个会话的消息`);
                }
                resolve(migratedCount);
                return;
            }

            const session = cursor.value;

            // 只迁移还包含消息数据的 session
            if (session.messages && session.messages.length > 0) {
                // 写入 messages store
                messagesStore.put({
                    sessionId: session.id,
                    messages: session.messages
                });

                if (searchStore) {
                    searchStore.put(createSessionSearchIndexRecord(session.id, session.messages));
                }

                // 从 session 中移除消息，只保留元数据
                const metaSession = {
                    id: session.id,
                    name: session.name,
                    apiFormat: session.apiFormat,
                    createdAt: session.createdAt,
                    updatedAt: session.updatedAt,
                    customName: session.customName || false,
                    messageCount: (session.messages || []).length
                };
                cursor.update(metaSession);
                migratedCount++;
            } else if (!session.messageCount && session.messageCount !== 0) {
                // 已迁移但没有 messageCount 字段的 session，补充字段
                session.messageCount = 0;
                cursor.update(session);
            }

            cursor.continue();
        };

        request.onerror = () => reject(request.error);
        transaction.onerror = () => reject(transaction.error);
    });
}

/**
 * 从 localStorage 迁移数据到 IndexedDB
 * @returns {Promise<Array|null>} 迁移的会话数组或 null
 */
export async function migrateFromLocalStorage() {
    const saved = localStorage.getItem('geminiChatSessions');
    if (saved) {
        try {
            const sessions = JSON.parse(saved);
            logger.debug(`正在迁移 ${sessions.length} 个会话到 IndexedDB...`);

            for (const session of sessions) {
                await saveSessionToDB(session);
            }

            // 迁移成功后删除 localStorage 数据
            localStorage.removeItem('geminiChatSessions');
            logger.debug('迁移完成，已清除 localStorage 中的旧数据');

            return sessions;
        } catch (e) {
            logger.error('迁移失败:', e);
        }
    }
    return null;
}

// ========== 配置存储 API ==========

/**
 * 保存当前配置
 * @param {Object} config - 配置对象
 * @returns {Promise<void>}
 */
export async function saveConfig(config) {
    return saveToStore(STORES.CONFIG, 'current', config);
}

/**
 * 加载当前配置
 * @returns {Promise<Object|null>} 配置对象
 */
export async function loadConfig() {
    return loadFromStore(STORES.CONFIG, 'current');
}

/**
 * 保存已保存的配置列表
 * @param {Array} configs - 配置数组
 * @returns {Promise<void>}
 */
export async function saveSavedConfigs(configs) {
    return saveToStore(STORES.CONFIG, 'saved_configs', configs);
}

/**
 * 加载已保存的配置列表
 * @returns {Promise<Array|null>} 配置数组
 */
export async function loadSavedConfigs() {
    return loadFromStore(STORES.CONFIG, 'saved_configs');
}

// ========== 快捷消息存储 API ==========

/**
 * 保存快捷消息
 * @param {Object} message - 快捷消息对象
 * @returns {Promise<void>}
 */
export async function saveQuickMessage(message) {
    return new Promise((resolve, reject) => {
        if (!getDB()) {
            reject(new Error('数据库未初始化'));
            return;
        }

        try {
            const transaction = getDB().transaction([STORES.QUICK_MESSAGES], 'readwrite');
            const store = transaction.objectStore(STORES.QUICK_MESSAGES);
            const request = store.put(message);

            request.onsuccess = () => resolve();
            request.onerror = () => {
                logger.error('保存快捷消息失败:', request.error);
                reject(request.error);
            };
        } catch (error) {
            logger.error('保存快捷消息异常:', error);
            reject(error);
        }
    });
}

/**
 * 加载所有快捷消息
 * @returns {Promise<Array>} 快捷消息数组
 */
export async function loadAllQuickMessages() {
    return new Promise((resolve, reject) => {
        if (!getDB()) {
            reject(new Error('数据库未初始化'));
            return;
        }

        try {
            const transaction = getDB().transaction([STORES.QUICK_MESSAGES], 'readonly');
            const store = transaction.objectStore(STORES.QUICK_MESSAGES);
            const request = store.getAll();

            request.onsuccess = () => {
                const messages = request.result || [];
                // 按更新时间排序
                messages.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
                resolve(messages);
            };
            request.onerror = () => {
                logger.error('加载快捷消息失败:', request.error);
                reject(request.error);
            };
        } catch (error) {
            logger.error('加载快捷消息异常:', error);
            reject(error);
        }
    });
}

/**
 * 删除快捷消息
 * @param {string} id - 快捷消息 ID
 * @returns {Promise<void>}
 */
export async function deleteQuickMessage(id) {
    return new Promise((resolve, reject) => {
        if (!getDB()) {
            reject(new Error('数据库未初始化'));
            return;
        }

        try {
            const transaction = getDB().transaction([STORES.QUICK_MESSAGES], 'readwrite');
            const store = transaction.objectStore(STORES.QUICK_MESSAGES);
            const request = store.delete(id);

            request.onsuccess = () => resolve();
            request.onerror = () => {
                logger.error('删除快捷消息失败:', request.error);
                reject(request.error);
            };
        } catch (error) {
            logger.error('删除快捷消息异常:', error);
            reject(error);
        }
    });
}

// ========================================
// MCP 服务器存储 API（版本 3 新增）
// ========================================

/**
 * 保存单个 MCP 服务器到 IndexedDB
 * @param {Object} server - MCP 服务器对象
 * @returns {Promise<void>}
 */
export async function saveMCPServer(server) {
    return new Promise((resolve, reject) => {
        if (!getDB()) {
            reject(new Error('数据库未初始化'));
            return;
        }

        const serverData = { ...server, updatedAt: Date.now() };

        try {
            const transaction = getDB().transaction([STORES.MCP_SERVERS], 'readwrite');
            const store = transaction.objectStore(STORES.MCP_SERVERS);
            const request = store.put(serverData);

            // 监听请求成功
            request.onsuccess = () => {
                logger.debug(`[Storage] 保存 MCP 服务器: ${server.id}`);
                resolve();
            };

            // 监听请求错误
            request.onerror = () => {
                logger.error('[Storage] 保存 MCP 服务器失败:', request.error);
                reject(request.error);
            };

            // 监听事务错误（事务级别的错误）
            transaction.onerror = () => {
                logger.error('[Storage] 事务错误:', transaction.error);
                reject(transaction.error);
            };

            // 监听事务中止
            transaction.onabort = () => {
                logger.error('[Storage] 事务被中止');
                reject(new Error('事务被中止'));
            };
        } catch (error) {
            logger.error('[Storage] 保存 MCP 服务器异常:', error);
            reject(error);
        }
    });
}

/**
 * 从 IndexedDB 加载所有 MCP 服务器
 * @returns {Promise<Array>} MCP 服务器数组
 */
export async function loadAllMCPServers() {
    return new Promise((resolve, reject) => {
        if (!getDB()) {
            reject(new Error('数据库未初始化'));
            return;
        }

        try {
            const transaction = getDB().transaction([STORES.MCP_SERVERS], 'readonly');
            const store = transaction.objectStore(STORES.MCP_SERVERS);
            const request = store.getAll();

            request.onsuccess = () => {
                // 按更新时间排序，最新的在前
                const servers = request.result.sort(
                    (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)
                );
                logger.debug(`[Storage] 加载 ${servers.length} 个 MCP 服务器`);
                resolve(servers);
            };
            request.onerror = () => {
                logger.error('[Storage] 加载 MCP 服务器失败:', request.error);
                reject(request.error);
            };
        } catch (error) {
            logger.error('[Storage] 加载 MCP 服务器异常:', error);
            reject(error);
        }
    });
}

/**
 * 从 IndexedDB 加载单个 MCP 服务器
 * @param {string} serverId - 服务器 ID
 * @returns {Promise<Object|null>} MCP 服务器对象或 null
 */
export async function loadMCPServer(serverId) {
    return new Promise((resolve, reject) => {
        if (!getDB()) {
            reject(new Error('数据库未初始化'));
            return;
        }

        try {
            const transaction = getDB().transaction([STORES.MCP_SERVERS], 'readonly');
            const store = transaction.objectStore(STORES.MCP_SERVERS);
            const request = store.get(serverId);

            request.onsuccess = () => {
                resolve(request.result || null);
            };
            request.onerror = () => {
                logger.error('[Storage] 加载 MCP 服务器失败:', request.error);
                reject(request.error);
            };
        } catch (error) {
            logger.error('[Storage] 加载 MCP 服务器异常:', error);
            reject(error);
        }
    });
}

/**
 * 从 IndexedDB 删除 MCP 服务器
 * @param {string} serverId - 服务器 ID
 * @returns {Promise<void>}
 */
export async function deleteMCPServer(serverId) {
    return new Promise((resolve, reject) => {
        if (!getDB()) {
            reject(new Error('数据库未初始化'));
            return;
        }

        try {
            const transaction = getDB().transaction([STORES.MCP_SERVERS], 'readwrite');
            const store = transaction.objectStore(STORES.MCP_SERVERS);
            const request = store.delete(serverId);

            request.onsuccess = () => {
                logger.debug(`[Storage] 删除 MCP 服务器: ${serverId}`);
                resolve();
            };
            request.onerror = () => {
                logger.error('[Storage] 删除 MCP 服务器失败:', request.error);
                reject(request.error);
            };

            // 监听事务错误
            transaction.onerror = () => {
                logger.error('[Storage] 事务错误:', transaction.error);
                reject(transaction.error);
            };

            // 监听事务中止
            transaction.onabort = () => {
                logger.error('[Storage] 事务被中止');
                reject(new Error('事务被中止'));
            };
        } catch (error) {
            logger.error('[Storage] 删除 MCP 服务器异常:', error);
            reject(error);
        }
    });
}

/**
 * 批量保存 MCP 服务器到 IndexedDB
 * @param {Array} servers - MCP 服务器数组
 * @returns {Promise<void>}
 */
export async function saveAllMCPServers(servers) {
    return new Promise((resolve, reject) => {
        if (!getDB()) {
            reject(new Error('数据库未初始化'));
            return;
        }

        try {
            const transaction = getDB().transaction([STORES.MCP_SERVERS], 'readwrite');
            const store = transaction.objectStore(STORES.MCP_SERVERS);

            // 批量写入
            servers.forEach((server) => {
                const serverData = { ...server, updatedAt: Date.now() };
                store.put(serverData);
            });

            transaction.oncomplete = () => {
                logger.debug(`[Storage] 批量保存 ${servers.length} 个 MCP 服务器`);
                resolve();
            };
            transaction.onerror = () => {
                logger.error('[Storage] 批量保存 MCP 服务器失败:', transaction.error);
                reject(transaction.error);
            };
        } catch (error) {
            logger.error('[Storage] 批量保存 MCP 服务器异常:', error);
            reject(error);
        }
    });
}

/**
 * 从 localStorage 迁移 MCP 服务器到 IndexedDB（一次性操作）
 * @returns {Promise<number>} 迁移的服务器数量
 */
export async function migrateMCPServersFromLocalStorage() {
    const MIGRATION_LOCK_KEY = 'mcpMigrationLock';
    const MIGRATION_COMPLETE_KEY = 'mcpMigrationComplete';

    // 检查是否已完成迁移
    if (localStorage.getItem(MIGRATION_COMPLETE_KEY) === 'true') {
        logger.debug('[Storage] MCP 服务器迁移已完成，跳过');
        return 0;
    }

    // 防止多标签页同时迁移
    const lock = localStorage.getItem(MIGRATION_LOCK_KEY);
    if (lock) {
        const lockTime = parseInt(lock, 10);
        const now = Date.now();
        // 如果锁超过30秒，认为是死锁，清除
        if (now - lockTime < 30000) {
            logger.debug('[Storage] 其他标签页正在迁移，跳过');
            return 0;
        } else {
            logger.warn('[Storage] 检测到迁移死锁，清除锁');
            localStorage.removeItem(MIGRATION_LOCK_KEY);
        }
    }

    // 检查是否有需要迁移的数据
    const saved = localStorage.getItem('mcpServers');
    if (!saved) {
        logger.debug('[Storage] 没有需要迁移的 MCP 服务器数据');
        localStorage.setItem(MIGRATION_COMPLETE_KEY, 'true');
        return 0;
    }

    // 设置迁移锁
    localStorage.setItem(MIGRATION_LOCK_KEY, Date.now().toString());

    try {
        const servers = JSON.parse(saved);

        if (!Array.isArray(servers) || servers.length === 0) {
            logger.debug('[Storage] MCP 服务器数据为空，无需迁移');
            localStorage.setItem(MIGRATION_COMPLETE_KEY, 'true');
            localStorage.removeItem(MIGRATION_LOCK_KEY);
            return 0;
        }

        // 执行迁移
        await saveAllMCPServers(servers);

        // 迁移成功后删除 localStorage 数据
        localStorage.removeItem('mcpServers');
        localStorage.setItem(MIGRATION_COMPLETE_KEY, 'true');
        localStorage.removeItem(MIGRATION_LOCK_KEY);

        logger.debug(`[Storage] 成功迁移 ${servers.length} 个 MCP 服务器到 IndexedDB`);
        return servers.length;
    } catch (error) {
        // 迁移失败，保留原数据，移除锁
        localStorage.removeItem(MIGRATION_LOCK_KEY);
        logger.error('[Storage] MCP 服务器迁移失败（原数据已保留）:', error);
        throw error;
    }
}

/**
 * 更新 MCP 服务器
 * @param {string} serverId - 服务器 ID
 * @param {Object} updates - 更新的字段
 * @returns {Promise<void>}
 */
export async function updateMCPServer(serverId, updates) {
    if (!getDB()) {
        throw new Error('数据库未初始化');
    }

    // 先加载现有服务器
    const existingServer = await loadMCPServer(serverId);
    if (!existingServer) {
        throw new Error(`MCP 服务器不存在: ${serverId}`);
    }

    // 合并更新
    const updatedServer = {
        ...existingServer,
        ...updates,
        id: serverId, // 确保 ID 不变
        updatedAt: Date.now()
    };

    // 保存更新后的服务器
    await saveMCPServer(updatedServer);
    logger.debug(`[Storage] 更新 MCP 服务器: ${serverId}`);
}
