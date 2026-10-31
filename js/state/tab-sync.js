/**
 * 跨标签页状态同步
 * 使用 BroadcastChannel 在多个标签页之间同步关键事件
 */

import { state } from '../core/state.js';
import { eventBus } from '../core/events.js';
import { logger } from '../utils/logger.js';

const CHANNEL_NAME = 'webchat-sync';
const TAB_PING = 'tab-ping';
const TAB_PONG = 'tab-pong';
const TAB_PROBE_TIMEOUT_MS = 800;
let channel = null;
// 通道可能先于 initTabSync 建立（启动期快照存活探测），会话同步消息要等会话加载完再处理
let syncEnabled = false;
const pendingProbes = new Map();

// 懒加载 sessions.js 以打破 tab-sync ← sessions ← tab-sync 循环依赖
async function getSessionsModule() {
    return import('./sessions.js');
}

function createId() {
    return typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// 按页面实例生成：复制标签页会连 sessionStorage 一起复制，共用 ID 会互相忽略广播
const tabId = createId();

/**
 * 当前页面实例的标签页 ID
 * @returns {string}
 */
export function getTabId() {
    return tabId;
}

function ensureChannel() {
    if (channel) return channel;
    if (typeof BroadcastChannel === 'undefined') return null;
    channel = new BroadcastChannel(CHANNEL_NAME);
    channel.onmessage = handleMessage;
    return channel;
}

/**
 * 初始化跨标签页同步
 */
export function initTabSync() {
    if (!ensureChannel()) {
        logger.debug('[TabSync] BroadcastChannel 不可用，跳过跨标签页同步');
        return;
    }
    syncEnabled = true;
    logger.debug(`[TabSync] 已初始化 (tabId: ${tabId.slice(0, 8)})`);
}

/**
 * 广播事件到其他标签页
 */
export function broadcastEvent(type, data) {
    ensureChannel()?.postMessage({ type, data, tabId });
}

/**
 * 探测指定标签页是否仍然存活：广播 ping，在超时内收到 pong 的视为存活
 * @param {string[]} tabIds
 * @param {Object} [options]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<Set<string>|null>} 存活的标签页 ID；BroadcastChannel 不可用时返回 null
 */
export function probeTabs(tabIds, { timeoutMs = TAB_PROBE_TIMEOUT_MS } = {}) {
    const targets = new Set((tabIds || []).filter((id) => id && id !== tabId));
    if (targets.size === 0) return Promise.resolve(new Set());
    const activeChannel = ensureChannel();
    if (!activeChannel) return Promise.resolve(null);

    const nonce = createId();
    return new Promise((resolve) => {
        const probe = { targets, alive: new Set(), finish: null };
        const timer = setTimeout(() => probe.finish(), timeoutMs);
        probe.finish = () => {
            clearTimeout(timer);
            pendingProbes.delete(nonce);
            resolve(probe.alive);
        };
        pendingProbes.set(nonce, probe);
        activeChannel.postMessage({
            type: TAB_PING,
            data: { nonce, tabIds: [...targets] },
            tabId
        });
    });
}

function handleProbeMessage(msg) {
    if (msg.type === TAB_PING) {
        if (msg.data?.tabIds?.includes(tabId)) {
            channel?.postMessage({ type: TAB_PONG, data: { nonce: msg.data.nonce }, tabId });
        }
        return;
    }
    const probe = pendingProbes.get(msg.data?.nonce);
    if (!probe || !probe.targets.has(msg.tabId)) return;
    probe.alive.add(msg.tabId);
    if (probe.alive.size === probe.targets.size) probe.finish();
}

/**
 * 处理来自其他标签页的消息
 */
async function handleMessage({ data: msg }) {
    if (!msg || msg.tabId === tabId) return;

    if (msg.type === TAB_PING || msg.type === TAB_PONG) {
        handleProbeMessage(msg);
        return;
    }
    if (!syncEnabled) return;

    switch (msg.type) {
        case 'session-deleted': {
            const sid = msg.data.sessionId;

            // 跨 tab 标 _deletedSessionIds + 删元数据 + 取消 dirty 全部走 sessions.js 收敛入口，
            // 避免 tab-sync 裸 splice 绕过单一改写出口
            try {
                const {
                    addDeletedSessionId,
                    cancelPendingSave,
                    removeSessionMeta,
                    stopSessionTask
                } = await getSessionsModule();
                addDeletedSessionId(sid);
                stopSessionTask(sid, 'remote-session-deleted');
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
            const sid = msg.data?.sessionId;
            if (!sid) break;
            try {
                const { updateSessionMeta, applyRemoteSessionUpdate } = await getSessionsModule();
                const changed = updateSessionMeta(sid, {
                    updatedAt: msg.data.updatedAt,
                    messageCount: msg.data.messageCount
                });
                if (changed) eventBus.emit('sessions:updated', { sessions: state.sessions });
                // 乐观锁基线只在本页没有未落库内容时推进，否则下次保存会用旧内容静默覆盖对方
                await applyRemoteSessionUpdate(sid, msg.data.updatedAt);
            } catch (e) {
                logger.error('[TabSync] 处理 session-updated 失败:', e);
            }
            break;
        }

        case 'session-pinned': {
            const sessionId = msg.data?.sessionId;
            if (!sessionId || typeof msg.data?.pinned !== 'boolean') break;
            const session = state.sessions.find((item) => item.id === sessionId);
            if (!session) break;
            session.pinned = msg.data.pinned;
            eventBus.emit('sessions:updated', { sessions: state.sessions });
            break;
        }
    }
}

/**
 * 销毁同步通道
 */
export function destroyTabSync() {
    syncEnabled = false;
    for (const probe of [...pendingProbes.values()]) probe.finish();
    if (channel) {
        channel.close();
        channel = null;
    }
}
