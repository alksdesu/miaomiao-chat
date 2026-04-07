/**
 * 状态变更辅助函数（统一消息格式版）
 *
 * state.messages 是唯一数据源（新 parts[] 格式）。
 */

import { state } from './state.js';
import { eventBus } from './events.js';
import { generateMessageId } from '../utils/helpers.js';
import { PartType, hasParts } from '../messages/schema.js';

function rebuildMessageIdMapFromIndex(fromIndex) {
    if (!state.messageIdMap) return;
    for (let i = fromIndex; i < state.messages.length; i++) {
        const id = state.messages[i]?.id;
        if (id) state.messageIdMap.set(id, i);
    }
}

export function rebuildMessageIdMap() {
    if (!state.messageIdMap) {
        state.messageIdMap = new Map();
    } else {
        state.messageIdMap.clear();
    }
    state.messages.forEach((msg, i) => {
        if (msg.id) state.messageIdMap.set(msg.id, i);
    });
}

/**
 * 添加消息（新格式，单参数）
 * @param {Object} msg - 新格式消息对象（含 parts[], meta 等）
 * @returns {number} 新消息的索引
 */
export function pushMessage(msg) {
    state.messages.push(msg);

    const index = state.messages.length - 1;

    if (msg.id && state.messageIdMap) {
        state.messageIdMap.set(msg.id, index);
    }

    state.sessionDirty = true;
    eventBus.emit('state:messages-pushed', { index, msg });
    return index;
}

/**
 * 删除消息
 */
export function removeMessageAt(index) {
    if (index < 0 || index >= state.messages.length) return;

    const removed = state.messages[index];
    if (removed.id && state.messageIdMap) {
        state.messageIdMap.delete(removed.id);
    }

    state.messages.splice(index, 1);

    if (state.messageIdMap) rebuildMessageIdMapFromIndex(index);
    state.sessionDirty = true;
    eventBus.emit('state:message-removed', { index, removed });
}

/**
 * 删除指定索引后的所有消息
 */
export function removeMessagesAfter(fromIndex) {
    if (fromIndex < 0) return;
    const removeCount = Math.max(0, state.messages.length - fromIndex - 1);
    if (removeCount === 0) return;

    if (state.messageIdMap) {
        for (let i = fromIndex + 1; i < state.messages.length; i++) {
            const id = state.messages[i]?.id;
            if (id) state.messageIdMap.delete(id);
        }
    }

    state.messages = state.messages.slice(0, fromIndex + 1);

    state.sessionDirty = true;
    eventBus.emit('state:messages-removed-after', { fromIndex, removeCount, newLength: state.messages.length });
}

/**
 * 更新消息（spread merge 或完整替换）
 * @param {number} index
 * @param {Object} updates - 直接合并到 state.messages[index]
 * @param {boolean} replace - true 时完整替换
 */
export function updateMessageAt(index, updates, replace = false) {
    if (index < 0 || index >= state.messages.length) return;

    const old = state.messages[index];

    // replace 模式下维护 messageIdMap
    if (replace && old.id && state.messageIdMap) {
        state.messageIdMap.delete(old.id);
    }

    state.messages[index] = replace ? updates : { ...old, ...updates };

    // 确保新消息的 ID 在 map 中
    const newMsg = state.messages[index];
    if (newMsg.id && state.messageIdMap) {
        state.messageIdMap.set(newMsg.id, index);
    }

    state.sessionDirty = true;
    eventBus.emit('state:message-updated', { index, old, msg: newMsg });
}

/**
 * 替换所有消息
 * @param {Array} messages - 新格式消息数组
 */
export function replaceAllMessages(messages) {
    state.messages = [...messages];

    state.sessionDirty = false;
    rebuildMessageIdMap();
    eventBus.emit('state:messages-replaced', { newLength: state.messages.length });
}

/**
 * 弹出最后一条 assistant 消息
 */
export function popLastAssistantMessage() {
    const len = state.messages.length;
    if (len === 0) return null;

    const msg = state.messages[len - 1];
    if (msg.role !== 'assistant') return null;

    state.messages.pop();

    if (msg.id && state.messageIdMap) state.messageIdMap.delete(msg.id);
    state.sessionDirty = true;
    eventBus.emit('state:message-removed', { index: len - 1, removed: msg });
    return msg;
}

/**
 * 临时扩展消息数组（工具调用 continuation）
 */
export function extendMessagesTemporarily(extraMessages) {
    const backup = {
        messages: state.messages,
    };
    state.messages = [...state.messages, ...extraMessages];
    return backup;
}

export function restoreMessages(backup) {
    if (backup?.messages) {
        state.messages = backup.messages;
        rebuildMessageIdMap();
    }
}

/**
 * 更新消息中的文本内容（新格式：修改 parts 中的 text part）
 */
export function updateMessageTextAt(index, newText) {
    if (index < 0 || index >= state.messages.length) return;

    const msg = state.messages[index];

    // 新格式：修改 parts 中的第一个 text part
    if (hasParts(msg)) {
        const textPart = msg.parts.find(p => p.type === PartType.TEXT);
        if (textPart) {
            textPart.text = newText;
        } else {
            msg.parts.push({ type: PartType.TEXT, text: newText });
        }
    } else {
        // 旧格式兜底：创建 parts 而非写 content
        if (!msg.parts) msg.parts = [];
        msg.parts.push({ type: PartType.TEXT, text: newText });
    }

    state.sessionDirty = true;
    eventBus.emit('state:message-updated', { index, old: msg, msg });
}

/**
 * 批量补充缺少 ID 的消息
 */
export function ensureMessageIds() {
    let count = 0;
    for (const msg of state.messages) {
        if (!msg.id) {
            msg.id = generateMessageId();
            count++;
        }
    }
    if (count > 0) {
        rebuildMessageIdMap();
        state.sessionDirty = true;
    }
    return count;
}

export function setState(key, value) {
    state[key] = value;
}

export function logStateMutations() {
    const stats = { pushed: 0, removed: 0, updated: 0, propChanged: 0 };
    const handlers = {
        'state:messages-pushed': () => stats.pushed++,
        'state:message-removed': () => stats.removed++,
        'state:message-updated': () => stats.updated++,
        'state:property-changed': () => stats.propChanged++,
    };
    Object.entries(handlers).forEach(([e, h]) => eventBus.on(e, h));
    return () => {
        Object.entries(handlers).forEach(([e, h]) => eventBus.off(e, h));
        console.log('State Mutations:', stats);
    };
}
