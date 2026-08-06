/**
 * 回复选择器模块
 * 处理多回复的选择和切换
 */

import { state, elements } from '../core/state.js';
import { eventBus } from '../core/events.js';
import { updateMessageAt } from '../core/state-mutations.js';
import { debouncedSaveSession } from '../state/sessions.js';
import { PartType } from './schema.js';
import { renderReplyWithSelector } from './renderer.js';
import { logger } from '../utils/logger.js';
import { updateMessageUiState } from './message-ui-state.js';
import { hasStoredMedia, resolveMessagesMediaForApi } from '../state/media-blob-store.js';

/**
 * 选择回复（支持两种调用方式：直接索引或带消息索引）
 * @param {number} replyIndex - 回复索引
 * @param {number|null} messageIndex - 消息索引
 * @param {string|null} messageId - 消息 ID
 */
export async function selectReply(replyIndex, messageIndex = null, messageId = null) {
    let replies;
    let messageEl;

    if (messageId) {
        const resolvedIndex = state.messageStore.findIndexById(messageId);
        if (resolvedIndex >= 0) messageIndex = resolvedIndex;
    }

    // 如果提供了消息索引，从消息历史中获取回复
    if (messageIndex !== null) {
        const msg = state.messages[messageIndex];
        if (!msg) return;
        replies = msg.replies?.all;
        if (!replies) return;
        messageEl = Array.from(
            elements.messagesArea.querySelectorAll('.message[data-message-id]')
        ).find((element) => element.dataset.messageId === msg.id);
        messageEl ||= elements.messagesArea.querySelector(
            `.message[data-message-index="${messageIndex}"]`
        );

        // Bug 2 防御性日志（而非复杂的 DOM 恢复）
        if (!messageEl) {
            logger.error(`[Bug 2] 消息索引 ${messageIndex} 的 DOM 元素未找到`);
            logger.error('[Bug 2] 这表明 dataset.messageIndex 未正确设置');

            // 使用 currentAssistantMessage 作为后备（流式输出时）
            if (state.currentAssistantMessage) {
                messageEl = state.currentAssistantMessage.closest('.message');
                logger.warn('[Bug 2] 使用 state.currentAssistantMessage 作为后备');
            } else {
                return; // 无法恢复，直接返回
            }
        }
    } else {
        // 使用当前的回复状态（正在生成时）
        replies = state.currentReplies;
        if (state.currentAssistantMessage) {
            messageEl = state.currentAssistantMessage.closest('.message');
        }
    }

    if (!messageEl) return; // Bug 2 添加最终检查
    if (!replies || replyIndex < 0 || replyIndex >= replies.length) return;

    const resolvedMessageId = messageId || messageEl.dataset.messageId;
    if (resolvedMessageId) {
        updateMessageUiState(resolvedMessageId, { selectedReply: replyIndex });
    }

    const storedReply = replies[replyIndex];
    let reply = storedReply;
    if (hasStoredMedia(storedReply)) {
        try {
            [reply] = await resolveMessagesMediaForApi([storedReply]);
        } catch (error) {
            logger.error('[ReplySelector] 加载回复媒体失败:', error);
            eventBus.emit('ui:notification', { message: '回复媒体加载失败', type: 'error' });
            return;
        }
    }

    // 更新消息历史中的选中索引 - 通过安全函数同步
    if (messageIndex !== null) {
        applyReplyToMessage(messageIndex, storedReply, replyIndex);

        debouncedSaveSession();
    } else {
        state.selectedReplyIndex = replyIndex;
        updateMessageHistoryWithSelectedReply();
    }

    const displayReplies =
        reply === storedReply
            ? replies
            : replies.map((item, index) => (index === replyIndex ? reply : item));
    renderReplyWithSelector(displayReplies, replyIndex, messageEl);
}

// 已删除 bindImageClickEvents 函数（改用内联 onclick，与其他渲染函数保持一致）

/**
 * 将回复数据应用到指定索引的消息
 * @param {number} index - 消息索引
 * @param {Object} reply - 回复对象
 * @param {number} selectedIndex - 选中的回复索引
 * @param {Array|null} replies - 可选的完整回复列表
 */
export function applyReplyToMessage(index, reply, selectedIndex, replies = null) {
    const existingMsg = state.messages[index];
    const parts = reply.parts
        .filter((part) => part.type !== PartType.TOOL_CALL && part.type !== PartType.FILE)
        .map((part) => structuredClone(part));
    for (const part of existingMsg?.parts || []) {
        if (part.type === PartType.TOOL_CALL || part.type === PartType.FILE) {
            parts.push(structuredClone(part));
        }
    }
    const updates = { parts, error: reply.error || null };

    // 同步 reply 的 meta 到顶层（模型名、统计、provider-specific 数据）
    if (reply.meta) {
        updates.meta = reply.meta;
    }

    const existingReplies = existingMsg?.replies;
    if ((existingReplies || replies) && Number.isInteger(selectedIndex)) {
        updates.replies = {
            ...(existingReplies || {}),
            all: replies || existingReplies.all,
            selected: selectedIndex
        };
    }

    updateMessageAt(index, updates);
}

/**
 * 更新消息历史中选中的回复
 */
function updateMessageHistoryWithSelectedReply() {
    if (state.currentReplies.length === 0) return;

    const reply = state.currentReplies[state.selectedReplyIndex];
    const lastIndex = state.messages.length - 1;

    if (lastIndex < 0) return;
    if (state.messages[lastIndex].role !== 'assistant') return;

    applyReplyToMessage(lastIndex, reply, state.selectedReplyIndex, state.currentReplies);

    debouncedSaveSession();
}

/**
 * 初始化回复选择器事件监听
 */
export function initReplySelector() {
    // 监听回复选择请求事件
    eventBus.on('reply:select-requested', ({ index, messageIndex, messageId }) => {
        void selectReply(index, messageIndex, messageId);
    });

    logger.debug('Reply selector initialized');
}
