/**
 * 清空聊天功能
 * 处理当前会话的清空操作
 */

import { state } from '../core/state.js';
import { elements } from '../core/elements.js';
import { saveCurrentSessionMessages } from '../state/sessions.js';
import { showConfirmDialog } from '../utils/dialogs.js';
import { replaceAllMessages } from '../core/state-mutations.js';
import { clearUndoStack } from '../tools/undo.js';
import { logger } from '../utils/logger.js';
import { createWelcomeMessage } from './welcome-message.js';

/**
 * 处理清空当前会话
 */
export async function handleClear() {
    // 流式加载中不允许清空
    if (state.isLoading) return;

    const confirmed = await showConfirmDialog('确定要清空当前会话的所有对话吗？', '确认清空');
    if (!confirmed) return;

    // 通过安全函数清空三种格式的消息
    replaceAllMessages([]);

    // 清空撤销栈
    clearUndoStack();

    // 重置相关状态
    state.lastUserMessage = null;
    state.editingIndex = null;
    state.currentReplies = [];
    state.selectedReplyIndex = 0;
    state.currentAssistantMessage = null;

    // 清除编辑状态
    if (state.editingElement) {
        state.editingElement.classList.remove('editing');
        state.editingElement = null;
    }

    // eslint-disable-next-line no-restricted-syntax -- createWelcomeMessage 已转义自定义名称
    elements.messagesArea.innerHTML = createWelcomeMessage();

    // 标记脏并立即保存（force=true 确保空消息写入 DB）
    state.sessionDirty = true;
    await saveCurrentSessionMessages(true);
}

/**
 * 初始化清空功能
 */
export function initClearChat() {
    // 绑定清空按钮
    elements.clearButton?.addEventListener('click', handleClear);

    logger.debug('Clear chat initialized');
}
