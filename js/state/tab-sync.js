/**
 * 跨标签页状态同步
 * 使用 BroadcastChannel 在多个标签页之间同步关键事件
 */

import { state } from '../core/state.js';
import { eventBus } from '../core/events.js';
import { logger } from '../utils/logger.js';

const CHANNEL_NAME = 'webchat-sync';
let channel = null;

// 懒加载 sessions.js 以打破 tab-sync ← sessions ← tab-sync 循环依赖
async function getSessionsModule() {
    return import('./sessions.js');
}

// 每个标签页的唯一 ID（sessionStorage 保证每个 tab 独立）
let tabId;
try {
    tabId = sessionStorage.getItem('_tabId');
    if (!tabId) {
        tabId = crypto.randomUUID
            ? crypto.randomUUID()
            : Math.random().toString(36).slice(2) + Date.now().toString(36);
        sessionStorage.setItem('_tabId', tabId);
    }
} catch {
    // tracking protection 阻止 sessionStorage 访问时降级
    tabId = Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/**
 * 初始化跨标签页同步
 */
export function initTabSync() {
    if (typeof BroadcastChannel === 'undefined') {
        logger.debug('[TabSync] BroadcastChannel 不可用，跳过跨标签页同步');
        return;
    }

    channel = new BroadcastChannel(CHANNEL_NAME);
    channel.onmessage = handleMessage;
    logger.debug(`[TabSync] 已初始化 (tabId: ${tabId.slice(0, 8)})`);
}

/**
 * 广播事件到其他标签页
 */
export function broadcastEvent(type, data) {
    if (!channel) return;
    channel.postMessage({ type, data, tabId });
}

/**
 * 处理来自其他标签页的消息
 */
async function handleMessage({ data: msg }) {
    if (msg.tabId === tabId) return;

    switch (msg.type) {
        case 'session-deleted': {
            const sid = msg.data.sessionId;

            // 跨 tab 标 _deletedSessionIds + 删元数据 + 取消 dirty 全部走 sessions.js 收敛入口，
            // 避免 tab-sync 裸 splice 绕过单一改写出口
            try {
                const { addDeletedSessionId, cancelPendingSave, removeSessionMeta } =
                    await getSessionsModule();
                addDeletedSessionId(sid);
                if (sid === state.currentSessionId) cancelPendingSave();

                if (removeSessionMeta(sid)) {
                    eventBus.emit('sessions:updated', { sessions: state.sessions });
                    // 如果删除的是当前会话，切到第一个
                    if (sid === state.currentSessionId && state.sessions.length > 0) {
                        eventBus.emit('session:switch-requested', {
                            sessionId: state.sessions[0].id
                        });
                    }
                }
            } catch (e) {
                logger.error('[TabSync] 处理 session-deleted 加载 sessions.js 失败:', e);
            }
            break;
        }

        case 'session-created': {
            // 其他 tab 新建会话：把元数据塞到列表头部让 sidebar 看见
            const incoming = msg.data?.session;
            if (!incoming?.id) break;
            try {
                const { addSessionMetaIfAbsent } = await getSessionsModule();
                if (addSessionMetaIfAbsent(incoming)) {
                    eventBus.emit('sessions:updated', { sessions: state.sessions });
                    if (incoming.updatedAt && state._lastKnownSessionUpdatedAt) {
                        state._lastKnownSessionUpdatedAt.set(incoming.id, incoming.updatedAt);
                    }
                }
            } catch (e) {
                logger.error('[TabSync] 处理 session-created 加载 sessions.js 失败:', e);
            }
            break;
        }

        case 'session-updated': {
            const sid = msg.data.sessionId;
            try {
                const { updateSessionMeta } = await getSessionsModule();
                const changed = updateSessionMeta(sid, {
                    updatedAt: msg.data.updatedAt,
                    messageCount: msg.data.messageCount
                });
                if (changed) eventBus.emit('sessions:updated', { sessions: state.sessions });
            } catch (e) {
                logger.error('[TabSync] 处理 session-updated 加载 sessions.js 失败:', e);
            }
            // 同步本 tab 乐观锁 baseline 到远端最新值，否则被动观察的 tab 下次保存
            // 用陈旧 baseline 必然触发假冲突（即使本 tab 从未编辑过这个会话）
            if (msg.data.updatedAt && state._lastKnownSessionUpdatedAt) {
                state._lastKnownSessionUpdatedAt.set(sid, msg.data.updatedAt);
            }
            // 当前会话被远端改写：触发 'storage:remote-updated' 让 UI 决定提示/重载策略；
            // 不主动覆盖 state.messages 避免打断用户正在编辑的输入
            if (sid === state.currentSessionId) {
                eventBus.emit('storage:remote-updated', {
                    sessionId: sid,
                    updatedAt: msg.data.updatedAt
                });
            }
            break;
        }
    }
}

/**
 * 销毁同步通道
 */
export function destroyTabSync() {
    if (channel) {
        channel.close();
        channel = null;
    }
}
