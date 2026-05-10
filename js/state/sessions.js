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
    saveSessionAtomic
} from './storage.js';
import { generateSessionId, generateSessionName } from '../utils/helpers.js';
import { renderSessionMessages } from '../messages/restore.js';
import {
    replaceAllMessages,
    setIsLoading,
    setIsSending,
    setCurrentAssistantMessage,
    setCurrentAbortController,
    setCurrentSessionId,
    setSelectedReplyIndex,
    setSessionDirty,
    setEditingIndex,
    setEditingElement,
    setSessions,
    setIsSwitchingSession,
    setLastUserMessage,
    setMessageHistory,
    setCurrentReplies,
    setUploadedImages,
    setApiFormat as setStateApiFormat
} from '../core/state-mutations.js';
import { requestStateMachine } from '../core/request-state-machine.js';
import { broadcastEvent } from './tab-sync.js';
import { buildSessionSearchIndex } from './session-search-index.js';
import { getTextContent } from '../messages/schema.js';
import {
    replaceVideoDataUrlsDeep,
    isElectronIpcAvailable,
    isAndroidFilesystemAvailable
} from './video-persistence.js';
import { logger } from '../utils/logger.js';

// 防抖保存定时器
let saveSessionTimer = null;
// 已删除会话 ID 集合，防止异步保存操作重建已删除的记录
const _deletedSessionIds = new Set();

// 会话切换 AbortController
let sessionSwitchController = null;

const persistedVideoUrlCache = new Map();

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
        persistedVideoUrlCache.set(dataUrl, fileUrl);
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
        setSessions(await loadAllSessionsFromDB());
    } catch (e) {
        logger.error('加载会话失败:', e);
        setSessions([]);
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
        setCurrentSessionId(newSession.id);
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

/**
 * 保存当前会话的消息（立即执行）
 */
export async function saveCurrentSessionMessages(force = false) {
    if (!state.currentSessionId) return;
    // 防止保存已删除的会话
    if (_deletedSessionIds.has(state.currentSessionId)) return;
    // 跳过无变更的保存（除非强制）
    if (!force && !state.sessionDirty) return;

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

    // 保存到 IndexedDB（消息和元数据原子写入同一事务）
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
        await saveSessionAtomic(sessionMeta, {
            ...persistedPayload,
            searchIndex
        });
        setSessionDirty(false);
        broadcastEvent('session-updated', {
            sessionId: session.id,
            updatedAt: session.updatedAt,
            messageCount: session.messageCount
        });
    } catch (e) {
        logger.error('保存会话到 IndexedDB 失败:', e);
        eventBus.emit('ui:notification', { message: '保存会话失败', type: 'error' });
    }

    saveCurrentSessionId();
    eventBus.emit('sessions:updated', { sessions: state.sessions });
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

    state.sessions.unshift(newSession);

    // 保存到 IndexedDB
    try {
        await saveSessionToDB(newSession);
    } catch (e) {
        logger.error('保存新会话失败:', e);
    }

    if (shouldSwitch) {
        await switchToSession(newSession.id, false);
        eventBus.emit('ui:notification', { message: '已创建新会话', type: 'info' });
    }

    eventBus.emit('sessions:updated', { sessions: state.sessions });
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
    setIsSwitchingSession(true);

    // 触发会话切换前事件（用于清理）
    eventBus.emit('session:before-switch');

    // 清理视频 data URL 缓存（键为完整 base64 data URL，占用大量内存）
    if (persistedVideoUrlCache.size > 0) {
        persistedVideoUrlCache.clear();
    }

    try {
        // 检查是否被中断
        if (signal.aborted) {
            logger.debug('[Session] 会话切换被取消');
            return;
        }

        const oldSessionId = state.currentSessionId;

        // 将当前会话的生成任务移到后台（必须在 cancel 之前，否则 abort 会取消请求）
        // 注意：AbortController 存储在状态机中，不在 state.currentAbortController
        const activeAbortController = requestStateMachine.abortController;
        const hasActiveRequest = requestStateMachine.isBusy() && activeAbortController;
        if (oldSessionId && hasActiveRequest) {
            logger.debug(`[sessions.js] 将会话 ${oldSessionId} 的任务移到后台`);
            state.backgroundTasks.set(oldSessionId, {
                abortController: activeAbortController,
                messageElement: state.currentAssistantMessage,
                createdAt: Date.now()
            });

            // 立即清空全局引用，阻止后台流的 rAF 回调继续渲染到旧 DOM
            setCurrentAssistantMessage(null);

            eventBus.emit('ui:notification', {
                message: '上一个会话的生成将在后台继续',
                type: 'info',
                duration: 3000
            });

            // 3分钟后自动清理超时的后台任务
            const cleanupTimer = setTimeout(() => {
                const task = state.backgroundTasks.get(oldSessionId);
                if (task && Date.now() - task.createdAt > 180000) {
                    logger.warn('[sessions.js] 清理超时后台任务:', oldSessionId);
                    task.abortController?.abort();
                    state.backgroundTasks.delete(oldSessionId);
                    eventBus.emit('sessions:updated');
                }
            }, 180000);
            state.backgroundTasks.get(oldSessionId).cleanupTimer = cleanupTimer;

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

        // 切换会话 - 从 IndexedDB 按需加载消息
        setCurrentSessionId(sessionId);

        // v4: 从 messages store 按需加载（不再从内存中的 session 对象取消息）
        let msgData = null;
        try {
            msgData = await loadSessionMessages(sessionId);
        } catch (e) {
            logger.error('[Session] 从 IndexedDB 加载消息失败:', e);
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

        replaceAllMessages(msgData.messages || []);

        setLastUserMessage(null);
        setMessageHistory([]);

        // 退出编辑模式（清理 DOM 状态）
        if (state.editingElement) {
            state.editingElement.classList.remove('editing');
        }
        setEditingIndex(null);
        setEditingElement(null);

        // 清空输入框
        if (elements && elements.userInput) {
            elements.userInput.value = '';
            elements.userInput.style.height = 'auto';
        }

        // 通知 UI 更新编辑按钮状态
        eventBus.emit('editor:mode-changed', { isEditing: false });

        setCurrentReplies([]);
        setSelectedReplyIndex(0);
        setUploadedImages([]);

        // 更新图片预览（清空）
        eventBus.emit('ui:update-image-preview');

        // 恢复会话的 API 格式
        if (session.apiFormat && session.apiFormat !== state.apiFormat) {
            setStateApiFormat(session.apiFormat);
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
        import('../devtools/monitor-state.js')
            .then(({ syncMonitorOnSessionSwitch }) => {
                syncMonitorOnSessionSwitch(session);
            })
            .catch(() => {});

        // 检查目标会话是否有后台任务
        const backgroundTask = state.backgroundTasks.get(sessionId);
        if (backgroundTask) {
            // 恢复后台任务的状态
            setIsLoading(true);
            setCurrentAbortController(backgroundTask.abortController);
            // currentAssistantMessage 将在 renderSessionMessages 后自动恢复
            logger.debug(
                `[sessions.js] 恢复会话 ${sessionId} 的后台任务, state.isLoading =`,
                state.isLoading
            );

            // 🔧 显示取消按钮（恢复后台任务时）
            eventBus.emit('ui:show-cancel-button');
        } else {
            // 🔧 没有后台任务，完全重置状态和UI（修复切换会话后按钮卡住的问题）
            setIsLoading(false);
            setIsSending(false);
            setCurrentAssistantMessage(null);
            setCurrentAbortController(null);

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

                    const lastAssistantMsg = messagesArea.querySelector(
                        '.message.assistant:last-child .message-content'
                    );
                    if (lastAssistantMsg) {
                        setCurrentAssistantMessage(lastAssistantMsg);
                        logger.debug('[sessions.js] 后台任务 DOM 引用已恢复（已保存的消息）');
                    } else {
                        // 未找到消息框，创建新的占位符（消息还没保存到数组）
                        logger.debug('[sessions.js] 未找到助手消息，创建新占位符（正在流式输出）');

                        // 创建消息框（与 handler.js 中的逻辑一致）
                        const messageDiv = document.createElement('div');
                        messageDiv.className = 'message assistant';

                        const avatar = document.createElement('div');
                        avatar.className = 'message-avatar';
                        avatar.textContent = 'AI';

                        const contentWrapper = document.createElement('div');
                        contentWrapper.className = 'message-content-wrapper';

                        const contentDiv = document.createElement('div');
                        contentDiv.className = 'message-content';
                        // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
                        contentDiv.innerHTML =
                            '<div class="thinking-dots"><span></span><span></span><span></span></div>';

                        messageDiv.appendChild(avatar);
                        contentWrapper.appendChild(contentDiv);
                        messageDiv.appendChild(contentWrapper);

                        // 添加到 DOM
                        messagesArea.appendChild(messageDiv);

                        // 恢复引用
                        setCurrentAssistantMessage(contentDiv);
                        logger.debug('[sessions.js] 后台任务占位符已创建');
                    }
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
            setIsSwitchingSession(false);
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
    setSessionDirty(false);

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
        setCurrentSessionId(null);
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
eventBus.on('messages:changed', () => {
    setSessionDirty(true);
    debouncedSaveSession();
});

// 监听存储配额超出事件，显示通知
eventBus.on('storage:quota-exceeded', ({ message }) => {
    eventBus.emit('ui:notification', { message, type: 'error' });
});

// 监听跨标签页会话切换请求
eventBus.on('session:switch-requested', ({ sessionId }) => {
    if (sessionId && sessionId !== state.currentSessionId) {
        switchToSession(sessionId, true).catch((e) =>
            logger.error('[Sessions] 跨标签页切换失败:', e)
        );
    }
});
