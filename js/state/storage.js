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
    loadFromStore,
    safeLocalStorageGet,
    safeLocalStorageSet
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
            let txAborted = false;

            // 仅在 transaction.oncomplete 才算真正落盘
            request.onerror = (event) => {
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
                event.preventDefault?.();
                reject(error);
            };

            transaction.oncomplete = () => {
                if (!txAborted) resolve();
            };
            transaction.onerror = (event) => {
                const error = event.target.error;
                logger.error('保存会话事务错误:', error);
                reject(error || new Error('Session transaction error'));
            };
            transaction.onabort = () => {
                txAborted = true;
                const error = transaction.error;
                logger.error('保存会话事务 abort:', error);
                reject(error || new Error('Session transaction aborted'));
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
            // v3 兼容: 如果 session 还包含消息数据（尚未迁移），解构剥离 messages 但保留所有其他字段
            // 白名单写法会永久丢失 prefillSnapshot/folderId/monitorEnabled 等用户扩展字段
            const sessions = request.result.map((s) => {
                if (s.messages) {
                    const { messages, ...meta } = s;
                    return {
                        ...meta,
                        customName: meta.customName || false,
                        messageCount: messages.length,
                        // 临时保留消息引用（v4 迁移前需要）
                        _pendingMessages: messages
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
 * 多 tab 写入冲突：另一 tab 已在本 tab 上次同步后改写过该 session。
 * saveSessionAtomic 抛出此 error 让上游 saveCurrentSessionMessages 触发 storage:conflict
 * 让 UI 提示用户「另一 tab 已更新此会话，是否丢弃本地改动重新加载」
 */
export class SessionConflictError extends Error {
    constructor(sessionId, expected, actual) {
        super(
            `Session ${sessionId} updatedAt mismatch: expected ${expected}, found ${actual} in IDB`
        );
        this.name = 'SessionConflictError';
        this.sessionId = sessionId;
        this.expectedUpdatedAt = expected;
        this.actualUpdatedAt = actual;
    }
}

/**
 * 原子保存会话元数据 + 消息（单事务，两个 store）
 *
 * @param {Object} sessionMeta - session 元数据，含 id/updatedAt 等
 * @param {Object} messagesData - { messages, searchIndex? }
 * @param {Object} [opts]
 * @param {number|null} [opts.expectedUpdatedAt]
 *     乐观锁：写入前先读现存 sessionMeta.updatedAt 与此值比对，不匹配抛 SessionConflictError。
 *     null/undefined = 不做乐观锁检查（首次保存或显式覆盖路径）
 * @param {boolean} [opts.skipSearchIndex]
 *     跳过搜索索引构建与写入，由调用方延迟重建；读取端 isSessionSearchIndexUsable 对
 *     messageCount 不匹配的陈旧索引会自动重建，一致性有兜底
 */
export async function saveSessionAtomic(sessionMeta, messagesData, opts = {}) {
    const { expectedUpdatedAt = null, skipSearchIndex = false } = opts;
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
            const searchIndex = skipSearchIndex
                ? null
                : createSessionSearchIndexRecord(
                      sessionMeta.id,
                      messages,
                      messagesData?.searchIndex || null
                  );
            const useSearchStore = !skipSearchIndex && hasSearchIndexStore();
            const storeNames = [STORE_NAME, STORES.MESSAGES];
            if (useSearchStore) {
                storeNames.push(STORES.SEARCH_INDEXES);
            }

            // 同事务内 get → compare → put：让 IDB 自身的 readwrite 隔离保证 read-modify-write
            // 原子性，跨 tab 抢占场景下另一 tab 的 commit 不会插入到我们的 get 与 put 之间
            const transaction = getDB().transaction(storeNames, 'readwrite');
            let conflictError = null;

            const sessionStore = transaction.objectStore(STORE_NAME);
            const messagesStore = transaction.objectStore(STORES.MESSAGES);
            const searchStore = useSearchStore
                ? transaction.objectStore(STORES.SEARCH_INDEXES)
                : null;

            const proceedWithWrite = () => {
                messagesStore.put({ sessionId: sessionMeta.id, messages });
                sessionStore.put(sessionMeta);
                if (searchStore) searchStore.put(searchIndex);
            };

            if (expectedUpdatedAt != null) {
                const getReq = sessionStore.get(sessionMeta.id);
                getReq.onsuccess = () => {
                    const existing = getReq.result || null;
                    if (existing && existing.updatedAt !== expectedUpdatedAt) {
                        conflictError = new SessionConflictError(
                            sessionMeta.id,
                            expectedUpdatedAt,
                            existing.updatedAt
                        );
                        transaction.abort();
                        return;
                    }
                    proceedWithWrite();
                };
                getReq.onerror = () => {
                    // get 失败让 tx.onerror 接管
                };
            } else {
                proceedWithWrite();
            }

            transaction.oncomplete = () => {
                if (searchIndex) {
                    eventBus.emit('session-search:index-updated', {
                        sessionId: sessionMeta.id,
                        searchIndex
                    });
                }
                resolve();
            };
            transaction.onerror = () => {
                if (conflictError) {
                    reject(conflictError);
                    return;
                }
                const error = transaction.error;
                if (
                    error &&
                    (error.name === 'QuotaExceededError' || error.message?.includes('quota'))
                ) {
                    eventBus.emit('storage:quota-exceeded', { message: '存储空间不足！' });
                }
                reject(error);
            };
            transaction.onabort = () => {
                if (conflictError) reject(conflictError);
                else reject(transaction.error || new Error('Transaction aborted'));
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

                // 解构剥离 messages 但保留所有用户扩展字段（prefillSnapshot/folderId/monitorEnabled 等）
                const { messages: _migMsgs, ...metaSession } = session;
                metaSession.customName = metaSession.customName || false;
                metaSession.messageCount = _migMsgs.length;
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

// ========== 会话应急槽（IDB 写入失败时的 localStorage 兜底） ==========

const EMERGENCY_SESSION_KEY = 'webchatEmergencySession';
// localStorage 5MB 配额：base64 媒体动辄数 MB，超过该长度的 data: URL 一律裁掉只保文本
const EMERGENCY_DATA_URL_MAX_LENGTH = 4096;
const EMERGENCY_FALLBACK_MESSAGE_COUNT = 30;

function stripLargeDataUrls(value) {
    if (typeof value === 'string') {
        return value.startsWith('data:') && value.length > EMERGENCY_DATA_URL_MAX_LENGTH
            ? ''
            : value;
    }
    if (Array.isArray(value)) {
        return value.map(stripLargeDataUrls);
    }
    if (value && typeof value === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value)) {
            out[k] = stripLargeDataUrls(v);
        }
        return out;
    }
    return value;
}

/**
 * 把保存失败的当前会话写入 localStorage 应急槽（单槽覆盖写，仅存最近一个会话）
 * @param {Object} sessionMeta - 会话元数据
 * @param {Array} messages - 消息数组
 * @returns {boolean} 是否写入成功
 */
export function saveEmergencySessionSnapshot(sessionMeta, messages) {
    if (!sessionMeta?.id) return false;
    try {
        const strippedMessages = stripLargeDataUrls(Array.isArray(messages) ? messages : []);
        const payload = {
            version: 1,
            savedAt: Date.now(),
            session: {
                ...stripLargeDataUrls({ ...sessionMeta }),
                messageCount: strippedMessages.length
            },
            messages: strippedMessages
        };
        if (safeLocalStorageSet(EMERGENCY_SESSION_KEY, JSON.stringify(payload))) {
            return true;
        }
        // 配额兜底：只保留最近一段消息再试一次
        payload.messages = strippedMessages.slice(-EMERGENCY_FALLBACK_MESSAGE_COUNT);
        payload.session.messageCount = payload.messages.length;
        payload.truncated = true;
        return safeLocalStorageSet(EMERGENCY_SESSION_KEY, JSON.stringify(payload));
    } catch (e) {
        logger.error('[Storage] 写入会话应急槽失败:', e);
        return false;
    }
}

/**
 * 读取会话应急槽（数据损坏时清槽返回 null）
 * @returns {Object|null} { savedAt, session, messages, truncated? }
 */
export function loadEmergencySessionSnapshot() {
    const raw = safeLocalStorageGet(EMERGENCY_SESSION_KEY);
    if (!raw) return null;
    try {
        const snap = JSON.parse(raw);
        if (!snap?.session?.id || !Array.isArray(snap.messages)) {
            clearEmergencySessionSnapshot();
            return null;
        }
        return snap;
    } catch (e) {
        logger.warn('[Storage] 会话应急槽数据损坏，已丢弃:', e);
        clearEmergencySessionSnapshot();
        return null;
    }
}

/**
 * 清空会话应急槽
 */
export function clearEmergencySessionSnapshot() {
    try {
        localStorage.removeItem(EMERGENCY_SESSION_KEY);
    } catch (_e) {
        /* 跟踪保护下 removeItem 也可能抛错，静默 */
    }
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
