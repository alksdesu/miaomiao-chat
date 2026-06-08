/**
 * 会话管理
 * 处理会话的创建、切换、删除和持久化
 * 注意：UI 更新通过事件通知，由 UI 层监听处理
 */

import { state } from '../core/state.js';
import { isElementsInitialized } from '../core/elements.js';
import { eventBus } from '../core/events.js';
import {
    saveSessionToDB,
    loadAllSessionsFromDB,
    deleteSessionFromDB,
    migrateFromLocalStorage,
    savePreference,
    loadPreference,
    loadSessionMessages,
    saveSessionAtomic,
    SessionConflictError
} from './storage.js';
import { generateSessionId, generateSessionName } from '../utils/helpers.js';
import { renderSessionMessages } from '../messages/restore.js';
import { replaceAllMessages } from '../core/state-mutations.js';
import { requestStateMachine } from '../core/request-state-machine.js';
import { broadcastEvent } from './tab-sync.js';
import { buildSessionSearchIndex } from './session-search-index.js';
import { createThinkingDots } from '../api/handler-loading-dots.js';
import { getTextContent, agePendingToolCallsInPlace } from '../messages/schema.js';
import {
    replaceVideoDataUrlsDeep,
    isElectronIpcAvailable,
    isAndroidFilesystemAvailable
} from './video-persistence.js';
import { showConfirmDialog } from '../utils/dialogs.js';
import { logger } from '../utils/logger.js';

// 防抖保存定时器
let saveSessionTimer = null;
// 已删除会话 ID 集合，防止异步保存操作重建已删除的记录
const _deletedSessionIds = new Set();

// 启动/切回会话时把上次中断的 pending/running tool_call 老化为 ERROR。
// 浏览器关闭/崩溃时正在执行的工具调用 part.state 永久停留在 'pending'/'running'，
// UI 转圈无法恢复，重发时 adapter 也会带这个孤儿 part 触发
// 'tool_use without tool_result' 400 — 加载/重载入口主动 age 一次让用户看到明确中断态。
// 实现已下沉到 messages/schema.js，sessions.js 仅在入口调用并传 nowMs 触发时间窗判定。

/**
 * 跨 tab 标记 session 已删（由 tab-sync 在收到 session-deleted 广播时调用）
 *
 * 让本 tab 后续 saveAssistantMessage / saveCurrentSessionMessages / debouncedSaveSession
 * 路径的 isSessionDeleted 守卫生效，防止另一 tab 删除后本 tab 用陈旧 state 重建该 session
 */
export function addDeletedSessionId(sessionId) {
    if (sessionId) _deletedSessionIds.add(sessionId);
}

/**
 * 检测会话是否已被标记为删除（防止 sync.js 等异步保存路径写回已删除会话）
 */
export function isSessionDeleted(sessionId) {
    return _deletedSessionIds.has(sessionId);
}

/**
 * 从 state.sessions 移除指定 id 的元数据条目（如已存在）
 * 返回是否真实发生删除，由调用方决定是否 emit sessions:updated
 */
export function removeSessionMeta(sessionId) {
    const idx = state.sessions.findIndex((s) => s.id === sessionId);
    if (idx === -1) return false;
    state.sessions.splice(idx, 1);
    return true;
}

/**
 * 把外部 tab 创建的会话元数据塞到列表头部（dedup by id）
 */
export function addSessionMetaIfAbsent(sessionMeta) {
    if (!sessionMeta?.id) return false;
    if (state.sessions.some((s) => s.id === sessionMeta.id)) return false;
    state.sessions.unshift(sessionMeta);
    return true;
}

/**
 * 更新已存在 session 的元数据字段（updatedAt / messageCount）
 */
export function updateSessionMeta(sessionId, patch) {
    const session = state.sessions.find((s) => s.id === sessionId);
    if (!session) return false;
    let changed = false;
    if (patch.updatedAt && session.updatedAt !== patch.updatedAt) {
        session.updatedAt = patch.updatedAt;
        changed = true;
    }
    if (patch.messageCount !== undefined && session.messageCount !== patch.messageCount) {
        session.messageCount = patch.messageCount;
        changed = true;
    }
    return changed;
}

// 会话切换 AbortController
let sessionSwitchController = null;

// 视频 dataURL → 持久化 URL 映射缓存。会话切换前不再 clear，让后台流仍能命中映射
// 避免重复 IPC store-video 落盘相同视频；用 LRU 容量上限防内存无限增长（每条映射 ~150 字节
// + 大量长时会话视频）
const MAX_VIDEO_URL_CACHE_ENTRIES = 500;
const persistedVideoUrlCache = new Map();
function setVideoCacheEntry(key, value) {
    // sanity 守卫：value 必须是 file://、blob:、http(s):// 等持久 URL；data: 进 LRU 会让数百 MB base64 长驻内存
    if (typeof value !== 'string' || value.startsWith('data:')) {
        return;
    }
    if (persistedVideoUrlCache.has(key)) {
        // LRU：重新插入到末尾
        persistedVideoUrlCache.delete(key);
    } else if (persistedVideoUrlCache.size >= MAX_VIDEO_URL_CACHE_ENTRIES) {
        // 淘汰最老一条（Map.keys() 按插入顺序）
        const oldest = persistedVideoUrlCache.keys().next().value;
        if (oldest !== undefined) persistedVideoUrlCache.delete(oldest);
    }
    persistedVideoUrlCache.set(key, value);
}

function cloneSerializable(data) {
    if (typeof globalThis.structuredClone === 'function') {
        return globalThis.structuredClone(data);
    }
    return JSON.parse(JSON.stringify(data));
}

/**
 * 构建用于持久化的会话消息快照
 * - Electron 环境：将视频 Data URL 落盘并替换为 file:// URL
 * - Android (Capacitor) 环境：将视频落盘到 DATA/message-videos 并替换为可播放 URL
 * - Web：保持原样
 */
export async function createPersistedSessionPayload(source = {}) {
    const clonedPayload = {
        messages: cloneSerializable(source.messages || [])
    };

    if (!isElectronIpcAvailable() && !isAndroidFilesystemAvailable()) {
        return clonedPayload;
    }

    const cache = new Map(persistedVideoUrlCache);

    await replaceVideoDataUrlsDeep(clonedPayload.messages, cache);

    for (const [dataUrl, fileUrl] of cache.entries()) {
        setVideoCacheEntry(dataUrl, fileUrl);
    }

    return clonedPayload;
}

/**
 * 加载所有会话
 */
export async function loadSessions() {
    try {
        // 先尝试从 localStorage 迁移旧数据
        await migrateFromLocalStorage();

        // 从 IndexedDB 加载会话
        state.sessions = await loadAllSessionsFromDB();
    } catch (e) {
        logger.error('加载会话失败:', e);
        state.sessions = [];
    }

    // 加载当前会话ID
    let currentId = null;
    try {
        // 优先从 IndexedDB 加载
        if (state.storageMode !== 'localStorage') {
            currentId = await loadPreference('currentSessionId');
        }
        // 降级：从 localStorage 加载
        if (!currentId) {
            currentId = localStorage.getItem('geminiCurrentSessionId');
        }
    } catch (error) {
        logger.error('加载当前会话ID失败:', error);
        currentId = localStorage.getItem('geminiCurrentSessionId');
    }

    // 如果没有会话，创建一个默认会话
    if (state.sessions.length === 0) {
        const newSession = await createNewSession(false);
        // 必须设置 currentSessionId，否则 saveCurrentSessionMessages 不会保存
        state.currentSessionId = newSession.id;
        await saveCurrentSessionId();
    } else if (currentId && state.sessions.find((s) => s.id === currentId)) {
        await switchToSession(currentId, false);
    } else {
        // 切换到最新的会话
        await switchToSession(state.sessions[0].id, false);
    }

    // 通知 UI 更新
    eventBus.emit('sessions:loaded', { sessions: state.sessions });
}

/**
 * 保存当前会话ID
 */
export async function saveCurrentSessionId() {
    try {
        // 优先保存到 IndexedDB
        if (state.storageMode !== 'localStorage') {
            await savePreference('currentSessionId', state.currentSessionId || '');
        } else {
            // 降级：保存到 localStorage
            localStorage.setItem('geminiCurrentSessionId', state.currentSessionId || '');
        }
    } catch (error) {
        logger.error('保存当前会话ID失败:', error);
        // 降级处理
        localStorage.setItem('geminiCurrentSessionId', state.currentSessionId || '');
    }
}

// in-flight 守卫：save 进行时新的 dirty 不会被 sessionDirty=false 错误清零
// 也避免并发 save 重复写 IDB；并发请求被合并到 trailing-save
let _savingPromise = null;

/**
 * 保存当前会话的消息（立即执行）
 */
export async function saveCurrentSessionMessages(force = false) {
    if (!state.currentSessionId) return;
    // 防止保存已删除的会话
    if (_deletedSessionIds.has(state.currentSessionId)) return;
    // 跳过无变更的保存（除非强制）
    if (!force && !state.sessionDirty) return;

    // in-flight：上一轮 save 还没完成，标记保留 dirty 让其完成后由 finally 触发 trailing
    if (_savingPromise) {
        state.sessionDirty = true;
        return _savingPromise;
    }

    const session = state.sessions.find((s) => s.id === state.currentSessionId);
    if (!session) return;
    session.apiFormat = state.apiFormat;
    session.updatedAt = Date.now();

    // 保存当前预填充状态快照
    session.prefillSnapshot = {
        prefillEnabled: state.prefillEnabled,
        systemPrompt: state.systemPrompt,
        prefillMessages: JSON.parse(JSON.stringify(state.prefillMessages || [])),
        charName: state.charName,
        userName: state.userName,
        systemPrefillMessages: JSON.parse(JSON.stringify(state.systemPrefillMessages || [])),
        geminiSystemPartsEnabled: state.geminiSystemPartsEnabled,
        geminiSystemParts: JSON.parse(JSON.stringify(state.geminiSystemParts || []))
    };

    session.monitorEnabled = state.monitorEnabled ?? false;

    // 自动生成会话名称（取第一条用户消息）
    if (!session.customName) {
        let content = '';

        if (state.messages.length > 0) {
            const firstUserMsg = state.messages.find((m) => m.role === 'user');
            if (firstUserMsg) {
                // 用 schema 工具函数提取（内部处理新/旧格式回退）
                if (!content) {
                    content = getTextContent(firstUserMsg);
                }
            }
        }

        if (content) {
            session.name = generateSessionName(content);
        }
    }

    // 进入 save 流程：起点记录 dirty 快照，写完后只有 dirty 仍是该值（中间无新增）才清零
    const dirtyAtStart = state.sessionDirty;

    const doSave = async () => {
        let persistedPayload;
        try {
            persistedPayload = await createPersistedSessionPayload({
                messages: state.messages
            });
        } catch (error) {
            logger.error('[Session] 构建持久化快照失败，回退到原始消息:', error);
            persistedPayload = {
                messages: cloneSerializable(state.messages)
            };
        }

        // 保存到 IndexedDB（消息和元数据原子写入同一事务 + 乐观锁防多 tab 后写覆盖）
        try {
            const searchIndex = buildSessionSearchIndex(state.messages);
            session.messageCount = state.messages.length;
            const sessionMeta = {
                id: session.id,
                name: session.name,
                apiFormat: session.apiFormat,
                createdAt: session.createdAt,
                updatedAt: session.updatedAt,
                customName: session.customName,
                messageCount: session.messageCount,
                prefillSnapshot: session.prefillSnapshot,
                folderId: session.folderId ?? null,
                monitorEnabled: session.monitorEnabled ?? false
            };
            const expectedUpdatedAt = state._lastKnownSessionUpdatedAt?.get(session.id) ?? null;
            await saveSessionAtomic(
                sessionMeta,
                {
                    ...persistedPayload,
                    searchIndex
                },
                { expectedUpdatedAt }
            );
            state._lastKnownSessionUpdatedAt?.set(session.id, session.updatedAt);
            // dirty 快照模式：save 期间新到的 dirty 不被清零，防止丢一轮变更
            if (state.sessionDirty === dirtyAtStart) {
                state.sessionDirty = false;
            }
            broadcastEvent('session-updated', {
                sessionId: session.id,
                updatedAt: session.updatedAt,
                messageCount: session.messageCount
            });
        } catch (e) {
            if (e instanceof SessionConflictError) {
                cancelPendingSave();
                logger.warn(
                    `[Session] 多 tab 写入冲突 ${e.sessionId}: 期望 ${e.expectedUpdatedAt}, IDB ${e.actualUpdatedAt}`
                );
                eventBus.emit('storage:conflict', {
                    sessionId: e.sessionId,
                    expectedUpdatedAt: e.expectedUpdatedAt,
                    actualUpdatedAt: e.actualUpdatedAt
                });
            } else {
                logger.error('保存会话到 IndexedDB 失败:', e);
                eventBus.emit('ui:notification', { message: '保存会话失败', type: 'error' });
            }
        }

        saveCurrentSessionId();
        eventBus.emit('sessions:updated', { sessions: state.sessions });
    };

    _savingPromise = doSave().finally(() => {
        _savingPromise = null;
        // trailing save：若 save 期间有新 dirty 到来（dirty 仍为 true），排下一轮 debounced
        if (state.sessionDirty) {
            debouncedSaveSession();
        }
    });
    return _savingPromise;
}

/**
 * 防抖保存当前会话（500ms 延迟）
 */
export function debouncedSaveSession() {
    clearTimeout(saveSessionTimer);
    saveSessionTimer = setTimeout(() => {
        saveCurrentSessionMessages();
    }, 500);
}

/**
 * 取消当前会话的待保存定时器（不触发立即保存）
 *
 * 用于：另一 tab 删除了 currentSession 时，本 tab 需要丢弃尚未 flush 的 dirty 数据，
 * 避免下次 timer 触发时把已删 session 重建
 */
export function cancelPendingSave() {
    if (saveSessionTimer) {
        clearTimeout(saveSessionTimer);
        saveSessionTimer = null;
    }
}

/**
 * 从 IDB 重新加载 currentSession 的消息（用于多 tab 冲突/远端更新恢复路径）
 *
 * 流程：丢弃 dirty + 重 load messages + 更新乐观锁基线 + 触发 UI 重渲染。
 * 仅在 currentSessionId 已存在且非已删的情况下执行
 */
export async function reloadCurrentSessionMessages() {
    const sid = state.currentSessionId;
    if (!sid || _deletedSessionIds.has(sid)) return false;
    cancelPendingSave();
    state.sessionDirty = false;

    let msgData = null;
    try {
        msgData = await loadSessionMessages(sid);
    } catch (e) {
        logger.error('[Session] 重新加载消息失败:', e);
        return false;
    }
    const aged = agePendingToolCallsInPlace(msgData?.messages, { nowMs: Date.now() });
    replaceAllMessages(msgData?.messages || []);

    // 更新乐观锁基线：从 sessions 数组对应记录拿最新 updatedAt（loadAllSessions 已同步过元数据）
    const session = state.sessions.find((s) => s.id === sid);
    if (session?.updatedAt) {
        state._lastKnownSessionUpdatedAt.set(sid, session.updatedAt);
    }

    // 触发 UI 重渲染。emit 用 'reloaded' action 让全局 messages:changed 监听器跳过
    // debouncedSaveSession，避免 reload → debounce → save → broadcast → 其他 tab 收
    // remote-updated → toast 的连环风暴
    renderSessionMessages(state.messages);
    eventBus.emit('messages:changed', { action: 'reloaded', sessionId: sid });

    // 仅当 aged > 0 时需要持久化老化结果，主动调用一次而不依赖 debouncedSaveSession
    if (aged > 0) {
        logger.info(`[Session] reload 老化 ${aged} 个中断的 pending tool_call → ERROR`);
        state.sessionDirty = true;
        await saveCurrentSessionMessages(true);
    }
    return true;
}

/**
 * 创建新会话
 * @param {boolean} shouldSwitch - 是否立即切换到新会话
 * @returns {Promise<Object>} 新会话对象
 */
export async function createNewSession(shouldSwitch = true) {
    // 检查当前会话是否为空，如果为空则直接复用
    // v4 架构下 session 是纯元数据，消息在 state.messages 中
    const currentSession = state.sessions.find((s) => s.id === state.currentSessionId);
    if (currentSession) {
        const hasMessages = state.messages.length > 0;
        if (!hasMessages && !currentSession.customName) {
            eventBus.emit('ui:notification', {
                message: '当前会话为空，无需创建新会话',
                type: 'info'
            });
            return currentSession;
        }
    }

    // 先保存当前会话
    await saveCurrentSessionMessages();

    const newSession = {
        id: generateSessionId(),
        name: '新会话',
        apiFormat: state.apiFormat,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        customName: false,
        messageCount: 0,
        folderId: null,
        monitorEnabled: false,
        prefillSnapshot: {
            prefillEnabled: true,
            systemPrompt: '',
            prefillMessages: [],
            charName: 'Assistant',
            userName: 'User',
            systemPrefillMessages: [],
            geminiSystemPartsEnabled: false,
            geminiSystemParts: []
        }
    };

    // 先落盘再 unshift，失败时不留"内存有 IDB 无"的孤儿会话
    // 用户对孤儿编辑会持续保存失败，刷新后数据全部丢失
    try {
        await saveSessionToDB(newSession);
    } catch (e) {
        logger.error('保存新会话失败:', e);
        eventBus.emit('ui:notification', {
            message: '创建会话失败：存储空间不足或数据库异常',
            type: 'error',
            duration: 8000
        });
        return null;
    }

    state.sessions.unshift(newSession);

    if (shouldSwitch) {
        await switchToSession(newSession.id, false);
        eventBus.emit('ui:notification', { message: '已创建新会话', type: 'info' });
    }

    eventBus.emit('sessions:updated', { sessions: state.sessions });
    // 跨 tab 通知新建（其他 tab 列表里此会话）
    try {
        broadcastEvent('session-created', { session: newSession });
    } catch (_) {
        /* tab-sync 未就绪时静默 */
    }
    return newSession;
}

/**
 * 切换到指定会话
 * @param {string} sessionId - 会话 ID
 * @param {boolean} saveOld - 是否保存旧会话
 * @param {Object} elements - DOM 元素引用（用于检查输入框）
 */
export async function switchToSession(sessionId, saveOld = true, elements = null) {
    // 防止重复切换（同一会话）
    if (state.currentSessionId === sessionId) return;

    // 清除防抖保存定时器，防止跨会话保存
    if (saveSessionTimer) {
        clearTimeout(saveSessionTimer);
        saveSessionTimer = null;
    }

    // 如果正在切换，取消当前切换，开始新的切换
    if (state.isSwitchingSession && sessionSwitchController) {
        logger.warn(`[Session] 取消正在进行的会话切换，切换到新目标: ${sessionId}`);
        sessionSwitchController.abort();
    }

    // 创建新的 AbortController
    sessionSwitchController = new AbortController();
    const { signal } = sessionSwitchController;

    // 设置切换标志
    state.isSwitchingSession = true;

    // 触发会话切换前事件（用于清理）
    eventBus.emit('session:before-switch');

    // 之前 switchToSession 主动 clear 会让后台流（生成含视频的回复）丢失映射，
    // 后续 enrichToolResultWithFiles 重复 IPC store-video 落盘相同视频。
    // 改为 LRU 容量限制（MAX_VIDEO_URL_CACHE_ENTRIES）自动淘汰，不再切会话主动 clear

    try {
        // 检查是否被中断
        if (signal.aborted) {
            logger.debug('[Session] 会话切换被取消');
            return;
        }

        const oldSessionId = state.currentSessionId;

        // 将当前会话的生成任务移到后台（必须在 cancel 之前，否则 abort 会取消请求）
        // AbortController 仅存于状态机 + backgroundTask；state 上无对应字段
        const activeAbortController = requestStateMachine.abortController;
        const hasActiveRequest = requestStateMachine.isBusy() && activeAbortController;
        if (oldSessionId && hasActiveRequest) {
            logger.debug(`[sessions.js] 将会话 ${oldSessionId} 的任务移到后台`);

            // 一次性构建 task 对象再 set，避免事后回填 cleanupTimer 期间被并发 delete
            // （deleteSession / cleanupAfterSend / 自身 timer 三处竞争）导致 TypeError
            const task = {
                abortController: activeAbortController,
                messageElement: state.currentAssistantMessage,
                createdAt: Date.now(),
                cleanupTimer: null
            };
            task.cleanupTimer = setTimeout(() => {
                const current = state.backgroundTasks.get(oldSessionId);
                if (current === task && Date.now() - task.createdAt > 180000) {
                    logger.warn('[sessions.js] 清理超时后台任务:', oldSessionId);
                    task.abortController?.abort();
                    state.backgroundTasks.delete(oldSessionId);
                    eventBus.emit('sessions:updated');
                }
            }, 180000);
            state.backgroundTasks.set(oldSessionId, task);

            // 立即清空全局引用，阻止后台流的 rAF 回调继续渲染到旧 DOM
            state.currentAssistantMessage = null;

            eventBus.emit('ui:notification', {
                message: '上一个会话的生成将在后台继续',
                type: 'info',
                duration: 3000
            });

            // 不 cancel/abort 请求，只重置状态机到 IDLE
            // 请求继续在后台运行，由 sendToAPI 的 finally 清理
            requestStateMachine.forceReset({ skipAbort: true, silent: true });
        } else if (requestStateMachine.isBusy()) {
            // 没有 abortController 的异常情况，直接取消
            requestStateMachine.cancel();
        }

        // 保存当前会话
        if (saveOld && state.currentSessionId) {
            await saveCurrentSessionMessages();
        }

        // 再次检查是否被中断
        if (signal.aborted) {
            logger.debug('[Session] 会话切换在保存后被取消');
            return;
        }

        const session = state.sessions.find((s) => s.id === sessionId);
        if (!session) {
            logger.error(`会话 ${sessionId} 不存在`);
            return;
        }

        // v4: 从 messages store 按需加载（不再从内存中的 session 对象取消息）
        // 重要：currentSessionId 赋值延后到 await 完成之后；中间 await 被 abort 时 currentSessionId
        // 保持原值，避免 B 数据落库到 C 的连切覆盖 race
        let msgData = null;
        try {
            msgData = await loadSessionMessages(sessionId);
        } catch (e) {
            logger.error('[Session] 从 IndexedDB 加载消息失败:', e);
        }

        // 关键检查：await 后立即查 abort，否则 replaceAllMessages 会覆盖 C 的 state.messages
        if (signal.aborted) {
            logger.debug('[Session] 会话切换在 loadSessionMessages 后被取消');
            return;
        }

        // 兼容: 如果 messages store 没有数据，尝试从 session 对象中取（v3 未迁移数据）
        if (!msgData) {
            if (session._pendingMessages) {
                msgData = {
                    messages: session._pendingMessages
                };
            } else {
                msgData = { messages: [] };
            }
        }

        // 启动/切回时把上次中断的 pending tool_call 老化为 ERROR，防 UI 永久转圈 + 重发 400
        const aged = agePendingToolCallsInPlace(msgData.messages, { nowMs: Date.now() });
        if (aged > 0) {
            logger.info(`[Session] 老化 ${aged} 个中断的 pending tool_call → ERROR`);
            state.sessionDirty = true;
        }

        // 与 replaceAllMessages 紧邻同步执行，保证 currentSessionId 与 state.messages 原子切换
        state.currentSessionId = sessionId;
        replaceAllMessages(msgData.messages || []);

        // 记录加载时的 updatedAt 作为乐观锁基线，下次 saveSessionAtomic 用它对比
        if (session.updatedAt) {
            state._lastKnownSessionUpdatedAt.set(sessionId, session.updatedAt);
        }

        state.lastUserMessage = null;
        state.messageHistory = [];

        // 退出编辑模式（清理 DOM 状态）
        if (state.editingElement) {
            state.editingElement.classList.remove('editing');
        }
        state.editingIndex = null;
        state.editingElement = null;

        // 清空输入框
        if (elements && elements.userInput) {
            elements.userInput.value = '';
            elements.userInput.style.height = 'auto';
        }

        // 通知 UI 更新编辑按钮状态
        eventBus.emit('editor:mode-changed', { isEditing: false });

        state.currentReplies = [];
        state.selectedReplyIndex = 0;
        state.uploadedImages = [];

        // 更新图片预览（清空）
        eventBus.emit('ui:update-image-preview');

        // 恢复会话的 API 格式
        if (session.apiFormat && session.apiFormat !== state.apiFormat) {
            state.apiFormat = session.apiFormat;
            eventBus.emit('config:format-change-requested', {
                format: session.apiFormat,
                shouldFetchModels: false
            });
        }

        // 恢复预填充快照（兼容旧字段 prefillConfig）
        const ps = session.prefillSnapshot || session.prefillConfig;
        if (ps) {
            state.prefillEnabled = ps.prefillEnabled ?? true;
            state.systemPrompt = ps.systemPrompt ?? '';
            state.prefillMessages = ps.prefillMessages
                ? JSON.parse(JSON.stringify(ps.prefillMessages))
                : [];
            state.charName = ps.charName ?? 'Assistant';
            state.userName = ps.userName ?? 'User';
            state.systemPrefillMessages = ps.systemPrefillMessages
                ? JSON.parse(JSON.stringify(ps.systemPrefillMessages))
                : [];
            state.geminiSystemPartsEnabled = ps.geminiSystemPartsEnabled ?? false;
            state.geminiSystemParts = ps.geminiSystemParts
                ? JSON.parse(JSON.stringify(ps.geminiSystemParts))
                : [];
        } else {
            state.prefillEnabled = true;
            state.systemPrompt = '';
            state.prefillMessages = [];
            state.charName = 'Assistant';
            state.userName = 'User';
            state.systemPrefillMessages = [];
            state.geminiSystemPartsEnabled = false;
            state.geminiSystemParts = [];
        }
        eventBus.emit('config:sync-prefill-ui');

        // 恢复 AI Monitor 状态
        state.monitorEnabled = session.monitorEnabled ?? false;
        // 走 eventBus 反向通知 devtools 层（避免 state → devtools 静态边把 tools 链拖进来）
        // 用专用事件名避免与下方 UI 通知用的 session:switched 双发触发所有 listener 跑两次
        eventBus.emit('session:monitor-ready', { session });

        // 检查目标会话是否有后台任务
        const backgroundTask = state.backgroundTasks.get(sessionId);
        if (backgroundTask) {
            // 恢复后台任务的状态（abortController 由状态机/backgroundTask 持有，state 字段已废除）
            state.isLoading = true;
            // currentAssistantMessage 将在 renderSessionMessages 后自动恢复
            logger.debug(
                `[sessions.js] 恢复会话 ${sessionId} 的后台任务, state.isLoading =`,
                state.isLoading
            );

            // 🔧 显示取消按钮（恢复后台任务时）
            eventBus.emit('ui:show-cancel-button');
        } else {
            // 🔧 没有后台任务，完全重置状态和UI（修复切换会话后按钮卡住的问题）
            state.isLoading = false;
            state.isSending = false;
            state.currentAssistantMessage = null;

            // 清除发送锁超时定时器（通过状态机统一管理）
            requestStateMachine.clearSendLockTimeout();

            logger.debug(
                '[sessions.js] 切换到空闲会话，已重置 state.isLoading =',
                state.isLoading,
                ', state.isSending =',
                state.isSending
            );

            // 重置 UI 按钮状态
            eventBus.emit('ui:reset-input-buttons');
        }

        // 检查是否被中断
        if (signal.aborted) {
            logger.debug('[Session] 会话切换在 UI 更新前被取消');
            return;
        }

        saveCurrentSessionId();

        // 渲染会话消息
        renderSessionMessages();

        // 最后检查是否被中断
        if (signal.aborted) {
            logger.debug('[Session] 会话切换在渲染后被取消');
            return;
        }

        // 如果有后台任务，恢复 currentAssistantMessage 引用
        if (backgroundTask && backgroundTask.messageElement && isElementsInitialized()) {
            // 延迟到下一帧执行，确保 renderSessionMessages() 的 DOM 操作完全完成
            requestAnimationFrame(() => {
                // 二次检查：确保会话没有再次切换
                if (state.currentSessionId !== sessionId) {
                    logger.warn('[sessions.js] 会话已切换，取消后台任务恢复');
                    return;
                }

                try {
                    // 直接使用 document.getElementById 避免 Proxy 问题
                    const messagesArea = document.getElementById('messages');
                    if (!messagesArea) {
                        logger.error('[sessions.js] messagesArea 不存在');
                        return;
                    }

                    // renderSessionMessages 已基于 state.messages 重渲，DOM 上的
                    // .message.assistant:last-child 一定是已落库的历史消息（流式 placeholder
                    // 未 commit 不在 state.messages 中、不会被渲染）。复用历史 DOM 会让流式
                    // update 覆盖老消息内容 — 总是新建占位符，commit 后由 messages:changed
                    // 触发 renderSessionMessages 重渲换成正式 DOM
                    logger.debug('[sessions.js] 后台任务切回：新建流式占位符');

                    const messageDiv = document.createElement('div');
                    messageDiv.className = 'message assistant';

                    const avatar = document.createElement('div');
                    avatar.className = 'message-avatar';
                    avatar.textContent = 'AI';

                    const contentWrapper = document.createElement('div');
                    contentWrapper.className = 'message-content-wrapper';

                    const contentDiv = document.createElement('div');
                    contentDiv.className = 'message-content';
                    contentDiv.appendChild(createThinkingDots());

                    messageDiv.appendChild(avatar);
                    contentWrapper.appendChild(contentDiv);
                    messageDiv.appendChild(contentWrapper);
                    messagesArea.appendChild(messageDiv);

                    state.currentAssistantMessage = contentDiv;
                } catch (error) {
                    logger.error('[sessions.js] ❌ 恢复后台任务失败:', error);
                }
            });
        }

        // 通知 UI 更新
        eventBus.emit('session:switched', {
            oldId: oldSessionId,
            newId: sessionId,
            session
        });
    } catch (error) {
        // 忽略 AbortError（正常的取消操作）
        if (error.name === 'AbortError') {
            logger.debug('[Session] 会话切换被取消（AbortError）');
            return;
        }
        logger.error('会话切换失败:', error);
        eventBus.emit('ui:notification', { message: '会话切换失败', type: 'error' });
    } finally {
        // 清除切换标志（只有在没有新的切换时）
        // 如果已经有新的 AbortController，说明新的切换已经开始，不要清除标志
        if (sessionSwitchController && sessionSwitchController.signal === signal) {
            state.isSwitchingSession = false;
            sessionSwitchController = null;
        }
    }
}

/**
 * 删除会话
 * @param {string} sessionId - 会话 ID
 */
export async function deleteSession(sessionId) {
    const sessionIndex = state.sessions.findIndex((s) => s.id === sessionId);
    if (sessionIndex === -1) return;

    // 立即取消防抖保存，防止删除后定时器触发 saveSessionAtomic 重建已删除的记录
    if (saveSessionTimer) {
        clearTimeout(saveSessionTimer);
        saveSessionTimer = null;
    }
    state.sessionDirty = false;

    // 记录已删除的会话 ID，防止异步保存回写
    _deletedSessionIds.add(sessionId);

    // 从数据库删除
    try {
        await deleteSessionFromDB(sessionId);
        // 删除成功后从防护集合中移除
        _deletedSessionIds.delete(sessionId);
    } catch (e) {
        logger.error('从数据库删除会话失败:', e);
        _deletedSessionIds.delete(sessionId);
        eventBus.emit('ui:notification', { message: '删除会话失败', type: 'error' });
        return;
    }

    // 停止该会话的后台任务
    const task = state.backgroundTasks.get(sessionId);
    if (task) {
        if (task.cleanupTimer) {
            clearTimeout(task.cleanupTimer);
        }
        task.abortController.abort();
        state.backgroundTasks.delete(sessionId);
    }

    // 从状态中删除
    state.sessions.splice(sessionIndex, 1);

    // 如果删除的是当前会话，先清空 currentSessionId 再切换
    if (state.currentSessionId === sessionId) {
        state.currentSessionId = null;
        if (state.sessions.length > 0) {
            const nextSession = state.sessions[sessionIndex] || state.sessions[sessionIndex - 1];
            await switchToSession(nextSession.id, false);
        } else {
            await createNewSession(true);
        }
    }

    eventBus.emit('ui:notification', { message: '会话已删除', type: 'info' });
    eventBus.emit('sessions:updated', { sessions: state.sessions });
    broadcastEvent('session-deleted', { sessionId });
}

/**
 * 重命名会话
 * @param {string} sessionId - 会话 ID
 * @param {string} newName - 新名称
 */
export async function renameSession(sessionId, newName) {
    const session = state.sessions.find((s) => s.id === sessionId);
    if (!session) return;

    session.name = newName.trim() || '未命名会话';
    session.customName = true;
    session.updatedAt = Date.now();

    await saveSessionToDB(session);
    eventBus.emit('sessions:updated', { sessions: state.sessions });
    eventBus.emit('ui:notification', { message: '会话已重命名', type: 'info' });
}

// 监听消息变更事件，自动保存会话
// action='reloaded' 走 reloadCurrentSessionMessages 内部已自决是否保存的路径，
// 此处跳过避免 reload → save → broadcast → 其他 tab toast 的连环风暴
eventBus.on('messages:changed', (payload) => {
    if (payload?.action === 'reloaded') return;
    state.sessionDirty = true;
    debouncedSaveSession();
});

// 监听存储配额超出事件，显示通知 + 调用 navigator.storage.estimate 给用户具体配额数字
// 1s 窗口内同 message 去重：IDB 协议下 request.onerror 与 transaction.onerror 都会 emit
// 用户瞬间收到 2 个相同 toast 堆叠在屏幕上
let _lastQuotaEmitTs = 0;
let _lastQuotaMessage = '';
eventBus.on('storage:quota-exceeded', async ({ message }) => {
    const now = performance.now();
    if (message === _lastQuotaMessage && now - _lastQuotaEmitTs < 1000) {
        return;
    }
    _lastQuotaEmitTs = now;
    _lastQuotaMessage = message;
    let detail = message;
    try {
        if (navigator.storage?.estimate) {
            const est = await navigator.storage.estimate();
            const usedMb = (est.usage / 1024 / 1024).toFixed(1);
            const quotaMb = (est.quota / 1024 / 1024).toFixed(1);
            detail = `${message}（已用 ${usedMb}MB / ${quotaMb}MB），请删除旧会话或清理浏览器存储`;
        }
    } catch (_e) {
        /* navigator.storage 不可用走原 message */
    }
    eventBus.emit('ui:notification', { message: detail, type: 'error', duration: 10000 });
});

// 监听多 tab 写入冲突：弹 confirm dialog 让用户决定是否丢弃本地改动重新加载
// 之前只发 toast 8s 自动消失，用户错过提示就不知道还能 reload
eventBus.on('storage:conflict', async ({ sessionId }) => {
    if (sessionId !== state.currentSessionId) return;
    try {
        const confirmed = await showConfirmDialog(
            '另一标签页已更新此会话，是否丢弃本地未保存改动并重新加载？\n\n选「取消」可继续编辑（再次保存仍会冲突）',
            '会话保存冲突'
        );
        if (confirmed) {
            await reloadCurrentSessionMessages();
        }
    } catch (e) {
        logger.error('[Session] 处理冲突 dialog 失败:', e);
        eventBus.emit('ui:notification', {
            message: '检测到此会话在其他标签页已更新（保存冲突），点击侧栏对应会话可重新加载',
            type: 'warning',
            duration: 8000
        });
    }
});

// 监听远端 tab 更新：仅提示，不主动覆盖避免打断本 tab 输入
eventBus.on('storage:remote-updated', ({ sessionId }) => {
    if (sessionId !== state.currentSessionId) return;
    eventBus.emit('ui:notification', {
        message: '此会话在其他标签页有更新，点击侧栏对应会话可同步最新内容',
        type: 'info',
        duration: 5000
    });
});

// 监听跨标签页会话切换请求
eventBus.on('session:switch-requested', ({ sessionId }) => {
    if (sessionId && sessionId !== state.currentSessionId) {
        switchToSession(sessionId, true).catch((e) =>
            logger.error('[Sessions] 跨标签页切换失败:', e)
        );
    }
});
