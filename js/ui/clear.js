/**
 * 清空聊天功能
 * 处理当前会话的清空操作
 */

import { state } from '../core/state.js';
import { elements } from '../core/elements.js';
import { saveCurrentSessionMessages } from '../state/sessions.js';
import { showConfirmDialog } from '../utils/dialogs.js';
import { clearIdMappings } from '../api/format-converter.js';
import {
    replaceAllMessages,
    setLastUserMessage,
    setEditingIndex,
    setCurrentReplies,
    setSelectedReplyIndex,
    setCurrentAssistantMessage,
    setEditingElement,
    setSessionDirty
} from '../core/state-mutations.js';
import { clearUndoStack } from '../tools/undo.js';
import { logger } from '../utils/logger.js';

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

    // 清理工具调用 ID 映射表（防止内存泄漏）
    clearIdMappings();

    // 清空撤销栈
    clearUndoStack();

    // 重置相关状态
    setLastUserMessage(null);
    setEditingIndex(null);
    setCurrentReplies([]);
    setSelectedReplyIndex(0);
    setCurrentAssistantMessage(null);

    // 清除编辑状态
    if (state.editingElement) {
        state.editingElement.classList.remove('editing');
        setEditingElement(null);
    }

    // 清空消息区域
    // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
    elements.messagesArea.innerHTML = '';

    // 恢复欢迎消息
    // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
    elements.messagesArea.innerHTML = `
        <div class="welcome-message glass">
            <div class="gemini-logo">
                <svg width="64" height="64" viewBox="0 0 64 64">
                    <defs>
                        <linearGradient id="gemini-gradient" x1="0%" y1="0%" x2="100%" y2="100%">
                            <stop offset="0%" style="stop-color:#9168c0"/>
                            <stop offset="100%" style="stop-color:#a8c7fa"/>
                        </linearGradient>
                    </defs>
                    <circle cx="32" cy="32" r="28" fill="url(#gemini-gradient)"/>
                </svg>
            </div>
            <h2>你好，我是 ${state.charName || 'AI'}</h2>
        </div>
    `;

    // 标记脏并立即保存（force=true 确保空消息写入 DB）
    setSessionDirty(true);
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
