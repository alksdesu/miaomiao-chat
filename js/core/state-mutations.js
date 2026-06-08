/**
 * 状态变更入口（仅保留有语义的复合 / message-store mutator）
 *
 * 一行透传 / boolean 强转 setter 已废除——state.js 的 Proxy 拦截赋值并自动 emit `state:xxx`，
 * 直接 `state.xxx = value` 等价于过去的 setXxx(value) 但零调用开销且更易读。
 *
 * 本模块仅保留两类不可下放到调用方的入口：
 *   1. message-store mutator：依赖 state.messageStore 内部 splice 原地改 + 同步 sessionDirty + 发事件
 *   2. 复合 setter：多 flag + DOM 引用必须同步设置/清空（continuation / image-retry）
 */

import { state } from './state.js';
import { eventBus } from './events.js';
import { generateMessageId } from '../utils/helpers.js';
import { PartType, hasParts } from '../messages/schema.js';
import { normalizeAllMessages } from '../messages/legacy-adapter.js';

/**
 * 内部 helper：拿到当前 messageStore（state.js 初始化时挂载）
 * 所有 mutator 经此转发，store 内部 splice 原地改保持数组引用稳定
 */
function _store() {
    return state.messageStore;
}

// ========== Message store mutator ==========

/** 重建消息 ID → 索引的完整映射 */
export function rebuildMessageIdMap() {
    _store().rebuildIdMap();
}

/**
 * 添加消息（新格式，单参数）
 * @param {Object} msg - 新格式消息对象（含 parts[], meta 等）
 * @returns {number} 新消息的索引
 */
export function pushMessage(msg) {
    const index = _store().push(msg);
    state.sessionDirty = true;
    return index;
}

/**
 * 删除消息
 * @param {number} index - 消息索引
 */
export function removeMessageAt(index) {
    if (index < 0 || index >= state.messages.length) return;
    _store().splice(index, 1);
    state.sessionDirty = true;
}

/**
 * 删除指定索引后的所有消息
 * @param {number} fromIndex - 起始索引（该索引的消息保留）
 */
export function removeMessagesAfter(fromIndex) {
    if (fromIndex < 0) return;
    const before = state.messages.length;
    _store().removeRangeAfter(fromIndex);
    if (state.messages.length === before) return;
    state.sessionDirty = true;
    eventBus.emit('state:messages-replaced', { newLength: state.messages.length });
}

/**
 * 更新消息（spread merge 或完整替换）
 * @param {number} index
 * @param {Object} updates - 直接合并到 state.messages[index]
 * @param {boolean} replace - true 时完整替换
 */
export function updateMessageAt(index, updates, replace = false) {
    if (index < 0 || index >= state.messages.length) return;
    if (replace) {
        _store().replaceAt(index, updates);
    } else {
        _store().updateAt(index, updates);
    }
    state.sessionDirty = true;
}

/**
 * 替换所有消息（持久化入口）
 *
 * 在此处统一调用 normalizeAllMessages：会话切换 / 导入 / 恢复等所有路径
 * 都会经过这里，旧格式消息被一次性升级为新 parts[] 格式后再写入 state。
 * 若实际产生升级，标记 sessionDirty 让下次保存把升级结果写回存储。
 *
 * @param {Array} messages - 任意格式消息数组（旧/新混合都可接受）
 */
export function replaceAllMessages(messages) {
    const copy = [...messages];
    const upgraded = normalizeAllMessages(copy);

    _store().replaceAll(copy);
    state.sessionDirty = upgraded > 0;
    eventBus.emit('state:messages-replaced', { newLength: state.messages.length });
}

/**
 * 弹出最后一条 assistant 消息
 * @returns {Object|null} 被弹出的消息，如果最后一条不是 assistant 则返回 null
 */
export function popLastAssistantMessage() {
    const len = state.messages.length;
    if (len === 0) return null;

    const last = state.messages[len - 1];
    if (last.role !== 'assistant') return null;

    const msg = _store().pop();
    state.sessionDirty = true;
    return msg;
}

/**
 * 更新消息中的文本内容（新格式：修改 parts 中的 text part）
 */
export function updateMessageTextAt(index, newText) {
    if (index < 0 || index >= state.messages.length) return;

    const msg = state.messages[index];

    if (hasParts(msg)) {
        const textPart = msg.parts.find((p) => p.type === PartType.TEXT);
        if (textPart) {
            textPart.text = newText;
        } else {
            msg.parts.push({ type: PartType.TEXT, text: newText });
        }
    } else {
        if (!msg.parts) msg.parts = [];
        msg.parts.push({ type: PartType.TEXT, text: newText });
    }

    state.sessionDirty = true;
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

/**
 * 通用状态设置（任意属性，键名动态决定时用）
 * 通常直接 `state[key] = value` 即可；本函数仅在键名运行时拼接的场景保留
 * @param {string} key
 * @param {*} value
 */
export function setState(key, value) {
    state[key] = value;
}

// ========== 复合 setter（多 flag + DOM 引用必须同步） ==========

/**
 * 标记进入工具调用 continuation：设置 flag、保存复用的助手消息元素与发起会话 ID
 *
 * sourceSessionId 用于跨会话守卫：resendWithToolResults 触发时若 currentSessionId
 * 已切换到别处，handler 据此判断丢弃 continuation 改走 background save，避免
 * 工具结果污染新切到的会话
 *
 * @param {HTMLElement} messageEl - 要复用的助手消息根元素
 * @param {string|null} [sourceSessionId] - 发起 continuation 时的会话 ID
 */
export function setToolCallContinuation(messageEl, sourceSessionId = null) {
    state.isToolCallContinuation = true;
    state.toolCallContinuationElement = messageEl;
    state.toolCallContinuationSessionId = sourceSessionId;
}

/**
 * 清除工具调用 continuation 标记、DOM 引用与发起会话 ID
 */
export function clearToolCallContinuation() {
    state.isToolCallContinuation = false;
    state.toolCallContinuationElement = null;
    state.toolCallContinuationSessionId = null;
}

/**
 * 标记进入图片压缩重试：设置 flag、保存要复用的助手消息元素与发起会话 ID
 *
 * sourceSessionId 用于跨会话守卫：resolvePlaceholder 触发时若 currentSessionId
 * 已切换，丢弃 retry 元素走 resolveNew 而非复用脱离 DOM 的旧元素
 *
 * @param {HTMLElement} messageEl - 要复用的助手消息根元素
 * @param {string|null} [sourceSessionId] - 发起 retry 时的会话 ID
 */
export function setImageRetry(messageEl, sourceSessionId = null) {
    state.isImageCompressionRetry = true;
    state.imageRetryMessageElement = messageEl;
    state.imageRetrySessionId = sourceSessionId;
}

/**
 * 清除图片压缩重试标记、DOM 引用与发起会话 ID（不包含 _imageCompressionRetried 防循环锁）
 */
export function clearImageRetry() {
    state.isImageCompressionRetry = false;
    state.imageRetryMessageElement = null;
    state.imageRetrySessionId = null;
}
