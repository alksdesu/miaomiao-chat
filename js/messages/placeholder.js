/**
 * 助手消息占位符
 * 创建带有操作按钮的助手消息 DOM 元素
 */

import { eventBus } from '../core/events.js';
import { createThinkingDots } from '../api/handler-loading-dots.js';

/**
 * 创建助手消息占位符
 * @returns {HTMLElement} 消息元素
 */
export function createAssistantMessagePlaceholder() {
    const messageDiv = document.createElement('div');
    messageDiv.className = 'message assistant';

    const avatar = document.createElement('div');
    avatar.className = 'message-avatar';
    avatar.textContent = 'G';

    const contentWrapper = document.createElement('div');
    contentWrapper.className = 'message-content-wrapper';

    const contentDiv = document.createElement('div');
    contentDiv.className = 'message-content';
    contentDiv.appendChild(createThinkingDots());

    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'message-actions';
    actionsDiv.setAttribute('role', 'toolbar');
    actionsDiv.setAttribute('aria-label', '消息操作');

    // 重试按钮
    const retryButton = document.createElement('button');
    retryButton.className = 'msg-action-btn retry-msg';
    // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
    retryButton.innerHTML = `<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M1 4v6h6"/>
        <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>
    </svg>`;
    retryButton.title = '重新生成';
    retryButton.setAttribute('aria-label', '重新生成回复');
    retryButton.onclick = () => eventBus.emit('message:retry-requested', { messageEl: messageDiv });
    actionsDiv.appendChild(retryButton);

    // 编辑按钮
    const editButton = document.createElement('button');
    editButton.className = 'msg-action-btn edit-msg';
    // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
    editButton.innerHTML = `<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
    </svg>`;
    editButton.title = '编辑';
    editButton.setAttribute('aria-label', '编辑消息');
    editButton.onclick = () => eventBus.emit('message:edit-requested', { messageEl: messageDiv });
    actionsDiv.appendChild(editButton);

    // 引用按钮
    const quoteButton = document.createElement('button');
    quoteButton.className = 'msg-action-btn quote-msg';
    // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
    quoteButton.innerHTML = `<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M3 21c3 0 7-1 7-8V5c0-1.25-.756-2.017-2-2H4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .008-1 1.031V20c0 1 0 1 1 1z"/>
        <path d="M15 21c3 0 7-1 7-8V5c0-1.25-.757-2.017-2-2h-4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2h.75c0 2.25.25 4-2.75 4v3c0 1 0 1 1 1z"/>
    </svg>`;
    quoteButton.title = '引用';
    quoteButton.setAttribute('aria-label', '引用消息');
    quoteButton.onclick = () =>
        eventBus.emit('message:quote-requested', {
            messageEl: messageDiv,
            role: 'assistant',
            content: ''
        });
    actionsDiv.appendChild(quoteButton);

    // 复制全文按钮 —— 用户视角的基础功能（ChatGPT / Claude.ai 默认提供消息级复制）
    const copyButton = document.createElement('button');
    copyButton.className = 'msg-action-btn copy-msg';
    // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
    copyButton.innerHTML = `<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
    </svg>`;
    copyButton.title = '复制全文';
    copyButton.setAttribute('aria-label', '复制助手消息全文');
    copyButton.onclick = () => eventBus.emit('message:copy-requested', { messageEl: messageDiv });
    actionsDiv.appendChild(copyButton);

    // 删除按钮
    const deleteButton = document.createElement('button');
    deleteButton.className = 'msg-action-btn delete-msg';
    // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
    deleteButton.innerHTML = `<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="3 6 5 6 21 6"/>
        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
    </svg>`;
    deleteButton.title = '删除';
    deleteButton.setAttribute('aria-label', '删除消息');
    deleteButton.onclick = () =>
        eventBus.emit('message:delete-requested', { messageEl: messageDiv });
    actionsDiv.appendChild(deleteButton);

    contentWrapper.appendChild(actionsDiv);

    messageDiv.appendChild(avatar);
    contentWrapper.appendChild(contentDiv);
    messageDiv.appendChild(contentWrapper);

    return messageDiv;
}
