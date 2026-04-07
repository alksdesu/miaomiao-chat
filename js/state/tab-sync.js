/**
 * 跨标签页状态同步
 * 使用 BroadcastChannel 在多个标签页之间同步关键事件
 */

import { state } from '../core/state.js';
import { eventBus } from '../core/events.js';

const CHANNEL_NAME = 'webchat-sync';
let channel = null;

// 每个标签页的唯一 ID（sessionStorage 保证每个 tab 独立）
let tabId;
try {
    tabId = sessionStorage.getItem('_tabId');
    if (!tabId) {
        tabId = (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36));
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
        console.log('[TabSync] BroadcastChannel 不可用，跳过跨标签页同步');
        return;
    }

    channel = new BroadcastChannel(CHANNEL_NAME);
    channel.onmessage = handleMessage;
    console.log(`[TabSync] 已初始化 (tabId: ${tabId.slice(0, 8)})`);
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
function handleMessage({ data: msg }) {
    if (msg.tabId === tabId) return;

    switch (msg.type) {
        case 'session-deleted': {
            const idx = state.sessions.findIndex(s => s.id === msg.data.sessionId);
            if (idx !== -1) {
                state.sessions.splice(idx, 1);
                eventBus.emit('sessions:updated', { sessions: state.sessions });

                // 如果删除的是当前会话，切到第一个
                if (msg.data.sessionId === state.currentSessionId && state.sessions.length > 0) {
                    eventBus.emit('session:switch-requested', { sessionId: state.sessions[0].id });
                }
            }
            break;
        }

        case 'session-updated': {
            // 如果当前正在查看被更新的会话，提示有新消息
            if (msg.data.sessionId === state.currentSessionId) {
                eventBus.emit('ui:notification', {
                    message: '当前会话在其他标签页中有更新，点击刷新查看',
                    type: 'info',
                    duration: 5000
                });
            }
            // 更新列表中的元数据
            const session = state.sessions.find(s => s.id === msg.data.sessionId);
            if (session && msg.data.updatedAt) {
                session.updatedAt = msg.data.updatedAt;
                if (msg.data.messageCount !== undefined) {
                    session.messageCount = msg.data.messageCount;
                }
                eventBus.emit('sessions:updated', { sessions: state.sessions });
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
