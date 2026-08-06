/**
 * 消息渲染模块
 * 负责创建和渲染消息 DOM 元素
 * 注意：编辑/删除操作通过事件触发，避免循环依赖
 */

import { state } from '../core/state.js';
import { elements } from '../core/elements.js';
import { eventBus } from '../core/events.js';
import { safeMarkedParse } from '../utils/markdown.js';
import { escapeHtml } from '../utils/helpers.js';
import { getCurrentModelCapabilities } from '../api/current.js';
import { renderCapabilityBadgesText } from '../utils/capability-badges.js';
import { renderHumanizedError } from '../utils/errors.js';
import { categorizeFile, truncateFileName } from '../utils/file-helpers.js';
import { lazyImageManager } from '../utils/lazy-image.js';
import { PartType, MediaKind, partsToToolCallRestoreFormat } from './schema.js';
import { renderMediaCard as renderMediaBlock } from '../ui/media-cards.js';

// 从子模块导入并 re-export，保持外部 import 兼容
import {
    enhanceCodeBlocks,
    updateCodeBlockInMessage,
    bindImageClickEvents,
    captureExpandedCodeBlockState,
    restoreExpandedCodeBlockState
} from './render-code.js';
import {
    renderThinkingBlock,
    clearThinkingCache,
    enhanceThinkingBlocks,
    purgeThinkingCacheInElement,
    captureExpandedThinkingState,
    restoreExpandedThinkingState
} from './render-thinking.js';
import { renderSearchGrounding } from './render-search.js';
import { getMessageUiState, updateMessageUiState } from './message-ui-state.js';

export {
    enhanceCodeBlocks,
    updateCodeBlockInMessage,
    bindImageClickEvents,
    captureExpandedCodeBlockState,
    restoreExpandedCodeBlockState
};
export {
    renderThinkingBlock,
    clearThinkingCache,
    enhanceThinkingBlocks,
    purgeThinkingCacheInElement,
    captureExpandedThinkingState,
    restoreExpandedThinkingState
};
export { renderSearchGrounding };

/**
 * 添加消息到 DOM
 * @param {string} role - 角色
 * @param {string} content - 内容
 * @param {Array} images - 图片数组
 * @returns {HTMLElement} 消息元素
 */
export function addMessage(role, content, images = null) {
    const messageEl = createMessageElement(role, content, images);
    elements.messagesArea.appendChild(messageEl);
    scrollToBottom();
    return messageEl;
}

/**
 * 创建消息 DOM 元素
 * @param {string} role - 角色 ('user' | 'assistant')
 * @param {string} content - 消息内容
 * @param {Array} images - 图片数组
 * @param {string} messageId - 可选的唯一消息ID
 * @param {string} modelName - 可选的模型名称
 * @param {string} providerName - 可选的提供商名称
 * @param {Object} [options] - 渲染选项
 * @param {boolean} [options.deferAssistantRender=false] - assistant 内容仅放纯文本占位，
 *   由调用方稍后整体渲染（会话恢复分片路径专用，避免同一条消息 markdown 双重解析）
 * @returns {HTMLElement} 消息元素
 */
export function createMessageElement(
    role,
    content,
    images = null,
    messageId = null,
    modelName = null,
    _providerName = null,
    options = {}
) {
    const { deferAssistantRender = false } = options;
    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${role}`;

    if (messageId) {
        messageDiv.dataset.messageId = messageId;
    }

    const avatar = document.createElement('div');
    avatar.className = 'message-avatar';
    const userInitial = (state.userName || 'User').charAt(0).toUpperCase();
    const charInitial = (state.charName || 'Assistant').charAt(0).toUpperCase();
    avatar.textContent = role === 'user' ? userInitial : charInitial;

    const contentWrapper = document.createElement('div');
    contentWrapper.className = 'message-content-wrapper';

    if (role === 'assistant' && (modelName || _providerName)) {
        const modelBadge = document.createElement('div');
        modelBadge.className = 'message-model-badge';

        const capabilities = getCurrentModelCapabilities();
        const badgesText = renderCapabilityBadgesText(capabilities);

        const badgeText = [modelName + badgesText, _providerName].filter(Boolean).join(' | ');
        modelBadge.textContent = badgeText;
        modelBadge.title = `模型: ${modelName || '未知'}\n提供商: ${_providerName || '未知'}`;

        contentWrapper.appendChild(modelBadge);
    }

    const contentDiv = document.createElement('div');
    contentDiv.className = 'message-content';

    if (role === 'assistant' && !deferAssistantRender && typeof marked !== 'undefined') {
        // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
        contentDiv.innerHTML = safeMarkedParse(content);
    } else {
        contentDiv.textContent = content;
    }

    // 附件（用户消息）- 支持图片、PDF、TXT
    if (images && images.length > 0) {
        const attachmentsContainer = document.createElement('div');
        attachmentsContainer.className = 'message-images';
        images.forEach((file) => {
            const category = file.category || categorizeFile(file.type);

            if (category === 'image') {
                const imgEl = document.createElement('img');
                imgEl.src =
                    'data:image/svg+xml,%3Csvg width="400" height="300" xmlns="http://www.w3.org/2000/svg"%3E%3Crect width="100%25" height="100%25" fill="%23f5f5f5"/%3E%3C/svg%3E';
                imgEl.dataset.src = file.compressed || file.data;
                imgEl.alt = file.name;
                imgEl.title = '点击查看大图';
                imgEl.className = 'lazy-image';
                imgEl.loading = 'lazy';
                imgEl.decoding = 'async';
                imgEl.onclick = () => {
                    eventBus.emit('ui:open-image-viewer', { url: file.data });
                };
                attachmentsContainer.appendChild(imgEl);

                requestIdleCallback(
                    () => {
                        lazyImageManager.observe(imgEl);
                    },
                    { timeout: 500 }
                );
            } else if (category === 'pdf') {
                const fileEl = document.createElement('div');
                fileEl.className = 'message-file-item pdf';
                // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
                fileEl.innerHTML = `
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                        <polyline points="14 2 14 8 20 8"/>
                    </svg>
                    <span class="file-name" title="${escapeHtml(file.name)}">${escapeHtml(truncateFileName(file.name, 20))}</span>
                `;
                attachmentsContainer.appendChild(fileEl);
            } else if (category === 'text') {
                const isMarkdown = file.type === 'text/markdown' || file.name.endsWith('.md');
                const fileEl = document.createElement('div');
                fileEl.className = `message-file-item ${isMarkdown ? 'md' : 'txt'}`;
                // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
                fileEl.innerHTML = `
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                        <polyline points="14 2 14 8 20 8"/>
                        <line x1="16" y1="13" x2="8" y2="13"/>
                        <line x1="16" y1="17" x2="8" y2="17"/>
                    </svg>
                    <span class="file-name" title="${escapeHtml(file.name)}">${escapeHtml(truncateFileName(file.name, 20))}</span>
                `;
                attachmentsContainer.appendChild(fileEl);
            }
        });
        contentDiv.appendChild(attachmentsContainer);
    }

    contentWrapper.appendChild(contentDiv);

    // 操作按钮组
    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'message-actions';
    actionsDiv.setAttribute('role', 'toolbar');
    actionsDiv.setAttribute('aria-label', '消息操作');

    if (role === 'assistant') {
        const retryButton = document.createElement('button');
        retryButton.className = 'msg-action-btn retry-msg';
        // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
        retryButton.innerHTML = `<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M1 4v6h6"/>
            <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>
        </svg>`;
        retryButton.title = '重新生成';
        retryButton.setAttribute('aria-label', '重新生成回复');
        retryButton.onclick = () => {
            eventBus.emit('message:retry-requested', { messageEl: messageDiv });
        };
        actionsDiv.appendChild(retryButton);
    }

    const editButton = document.createElement('button');
    editButton.className = 'msg-action-btn edit-msg';
    // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
    editButton.innerHTML = `<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
    </svg>`;
    editButton.title = '编辑';
    editButton.setAttribute('aria-label', '编辑消息');
    editButton.onclick = () => {
        eventBus.emit('message:edit-requested', { messageEl: messageDiv });
    };
    actionsDiv.appendChild(editButton);

    const quoteButton = document.createElement('button');
    quoteButton.className = 'msg-action-btn quote-msg';
    // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
    quoteButton.innerHTML = `<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M3 21c3 0 7-1 7-8V5c0-1.25-.756-2.017-2-2H4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .008-1 1.031V20c0 1 0 1 1 1z"/>
        <path d="M15 21c3 0 7-1 7-8V5c0-1.25-.757-2.017-2-2h-4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2h.75c0 2.25.25 4-2.75 4v3c0 1 0 1 1 1z"/>
    </svg>`;
    quoteButton.title = '引用';
    quoteButton.setAttribute('aria-label', '引用消息');
    quoteButton.onclick = () => {
        eventBus.emit('message:quote-requested', { messageEl: messageDiv, role, content });
    };
    actionsDiv.appendChild(quoteButton);

    const deleteButton = document.createElement('button');
    deleteButton.className = 'msg-action-btn delete-msg';
    // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
    deleteButton.innerHTML = `<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="3 6 5 6 21 6"/>
        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
    </svg>`;
    deleteButton.title = '删除';
    deleteButton.setAttribute('aria-label', '删除消息');
    deleteButton.onclick = () => {
        eventBus.emit('message:delete-requested', { messageEl: messageDiv });
    };
    actionsDiv.appendChild(deleteButton);

    contentWrapper.appendChild(actionsDiv);

    messageDiv.appendChild(avatar);
    messageDiv.appendChild(contentWrapper);

    // defer 模式下内容稍后会被整体重渲，此处增强是无效功
    if (role === 'assistant' && !deferAssistantRender) {
        setTimeout(() => enhanceCodeBlocks(messageDiv), 0);
    }

    return messageDiv;
}

/**
 * 渲染多回复选择器
 */
export function renderReplyWithSelector(replies, selectedIndex, assistantMessageEl) {
    const contentWrapper = assistantMessageEl.querySelector('.message-content-wrapper');
    const contentDiv = assistantMessageEl.querySelector('.message-content');

    if (!contentWrapper || !contentDiv) return;

    const messageIndex = assistantMessageEl.dataset.messageIndex;
    const msgIdx = messageIndex !== undefined ? parseInt(messageIndex) : null;
    const messageId = assistantMessageEl.dataset.messageId || null;

    const loadingIndicator = contentDiv.querySelector('.loading-indicator, .thinking-dots');
    if (loadingIndicator) loadingIndicator.remove();

    // 切换 reply 前清掉旧 thinking-id 缓存，避免重渲累积 100k thinking 副本
    purgeThinkingCacheInElement(contentDiv);

    if (replies.length > 1) {
        let selectorEl = contentWrapper.querySelector('.reply-selector');
        if (!selectorEl) {
            selectorEl = document.createElement('div');
            selectorEl.className = 'reply-selector';
            contentWrapper.insertBefore(selectorEl, contentDiv);
        }

        // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
        selectorEl.innerHTML = '';
        replies.forEach((reply, index) => {
            const tab = document.createElement('button');
            const classList = ['reply-tab'];
            if (index === selectedIndex) classList.push('active');
            if (reply.error) classList.push('reply-tab-error');
            tab.className = classList.join(' ');
            tab.textContent = index + 1;
            const tabLabel = reply.error ? `回复 ${index + 1}（失败）` : `回复 ${index + 1}`;
            tab.title = tabLabel;
            tab.setAttribute('aria-label', tabLabel);
            if (index === selectedIndex) {
                tab.setAttribute('aria-current', 'true');
            }
            tab.onclick = () => {
                eventBus.emit('reply:select-requested', {
                    index,
                    messageIndex: msgIdx,
                    messageId
                });
            };
            selectorEl.appendChild(tab);
        });
    }

    const reply = replies[selectedIndex] || replies[0];
    if (!reply) return;
    let html = renderCanonicalParts(reply.parts, 'assistant');
    if (reply.error) html += renderHumanizedError({ error: reply.error }, null, true);

    const groundingMetadata = reply.meta?.raw?.gemini?.groundingMetadata;
    if (groundingMetadata) html += renderSearchGrounding(groundingMetadata);

    // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
    contentDiv.innerHTML = html;
    syncCurrentAssistantMessageReference();

    bindImageClickEvents(contentDiv);
    enhanceCodeBlocks(assistantMessageEl);

    // innerHTML 覆盖会抹掉 tool-calls-group 节点，从消息 parts 重建
    if (Number.isInteger(msgIdx)) {
        restoreToolCallsFromMessage(state.messages[msgIdx], contentDiv);
    }

    scrollToBottom();
}

/**
 * 滚动到底部
 */
export function scrollToBottom() {
    elements.messagesArea.scrollTo({
        top: elements.messagesArea.scrollHeight,
        behavior: 'smooth'
    });
}

/**
 * 检查是否在底部附近（阈值 150px）
 */
export function isNearBottom() {
    const { scrollTop, scrollHeight, clientHeight } = elements.messagesArea;
    return scrollHeight - scrollTop - clientHeight < 150;
}

function syncCurrentAssistantMessageReference() {
    const assistantMessages = Array.from(
        elements.messagesArea?.querySelectorAll('.message.assistant') || []
    );
    const latestAssistantMessage =
        assistantMessages.length > 0 ? assistantMessages[assistantMessages.length - 1] : null;

    state.currentAssistantMessage =
        latestAssistantMessage?.querySelector('.message-content') || null;
}

// 文件附件卡片 HTML（pdf / 文本类），与 createMessageElement 的附件渲染保持一致
const LAZY_IMAGE_PLACEHOLDER =
    'data:image/svg+xml,%3Csvg width="400" height="300" xmlns="http://www.w3.org/2000/svg"%3E%3Crect width="100%25" height="100%25" fill="%23f5f5f5"/%3E%3C/svg%3E';

function renderFilePartCard(name, mime) {
    const isPdf = mime === 'application/pdf';
    const isMarkdown = mime === 'text/markdown' || (name || '').endsWith('.md');
    const cls = isPdf ? 'pdf' : isMarkdown ? 'md' : 'txt';
    const lines = isPdf
        ? '<path d="M10 12h4"/><path d="M10 16h4"/>'
        : '<line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>';
    const safeName = escapeHtml(name || '文件');
    return (
        `<div class="message-file-item ${cls}">` +
        `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">` +
        `<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>` +
        `<polyline points="14 2 14 8 20 8"/>${lines}</svg>` +
        `<span class="file-name" title="${safeName}">${escapeHtml(truncateFileName(name || '文件', 20))}</span>` +
        `</div>`
    );
}

export function renderCanonicalParts(parts, role = 'assistant', { lazyImages = false } = {}) {
    if (!Array.isArray(parts)) return '';

    let html = '';
    for (const part of parts) {
        if (part.type === PartType.THINKING) {
            html += renderThinkingBlock(part.text);
        } else if (part.type === PartType.TEXT && part.text && part.text !== '(调用工具)') {
            html += role === 'assistant' ? safeMarkedParse(part.text) : escapeHtml(part.text);
        } else if (part.type === PartType.MEDIA && part.url) {
            const category = categorizeFile(part.mime);
            if (category === 'text' || category === 'pdf') {
                html += renderFilePartCard(part.name, part.mime);
            } else if (lazyImages && part.media === MediaKind.IMAGE) {
                html += `<div class="image-wrapper"><img src="${LAZY_IMAGE_PLACEHOLDER}" data-src="${escapeHtml(part.url)}" alt="Generated image" class="lazy-image" loading="lazy" decoding="async" style="cursor:pointer;"></div>`;
            } else {
                const mediaType =
                    part.media === MediaKind.VIDEO
                        ? 'video'
                        : part.media === MediaKind.AUDIO
                          ? 'audio'
                          : 'image';
                html += renderMediaBlock(part.url, mediaType, part.mime);
            }
        } else if (part.type === PartType.FILE) {
            html += renderFilePartCard(part.name, part.mime);
        }
    }
    return html;
}

function buildMessageHtml(message, role) {
    if (!message) {
        return '';
    }

    return renderCanonicalParts(message.parts, role);
}

export function rerenderMessageContent(messageEl, index, role, messageOverride = null) {
    const contentWrapper = messageEl?.querySelector('.message-content-wrapper');
    const contentDiv = contentWrapper?.querySelector('.message-content');
    const message = messageOverride || state.messages[index];

    if (!contentWrapper || !contentDiv || !message) {
        return false;
    }

    messageEl.classList.remove('editing');

    if (!Array.isArray(message.replies?.all) || message.replies.all.length <= 1) {
        contentWrapper.querySelector('.reply-selector')?.remove();
    }

    // 重渲会清掉用户展开的 thinking-block；先捕获展开状态，重渲后按位置索引还原，
    // 避免长会话每次工具调用/编辑都强制折叠所有思维链导致用户反复展开
    const messageId = messageEl.dataset.messageId;
    const expandedThinking = captureExpandedThinkingState(contentDiv);
    const expandedCodeBlocks = captureExpandedCodeBlockState(contentDiv);
    if (messageId) {
        updateMessageUiState(messageId, {
            thinkingExpanded: expandedThinking,
            codeBlocksExpanded: expandedCodeBlocks
        });
    }

    // 清理旧 thinking-id 缓存，避免重渲后旧 tid 永久泄漏（100k thinking × N 次重渲 → MB 级累积）
    purgeThinkingCacheInElement(contentDiv);

    // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
    contentDiv.innerHTML = buildMessageHtml(message, role);
    syncCurrentAssistantMessageReference();

    enhanceCodeBlocks(messageEl);
    const uiState = messageId ? getMessageUiState(messageId) : null;
    restoreExpandedThinkingState(
        contentDiv,
        uiState?.thinkingExpanded || expandedThinking,
        (block) => enhanceCodeBlocks(block)
    );
    restoreExpandedCodeBlockState(contentDiv, uiState?.codeBlocksExpanded || expandedCodeBlocks);

    if (role === 'assistant') {
        restoreToolCallsFromMessage(message, contentDiv);
    }

    return true;
}

/**
 * 从消息 parts 中重建工具调用 UI
 * 任何重写 .message-content innerHTML 的路径（编辑保存/取消、多回复切换）
 * 都会抹掉 tool-calls-group 节点，导致 tool-display 的 WeakMap 数据失效。
 * 此函数复用 restore:tool-calls 事件，与会话切换/初次加载走同一条管线。
 */
export function restoreToolCallsFromMessage(message, contentDiv) {
    if (!message || !contentDiv) return;
    const mapped = partsToToolCallRestoreFormat(message.parts);
    if (mapped.length === 0) return;
    const normalized = mapped.map((tc) => ({
        ...tc,
        status: tc.status || 'completed',
        result:
            tc.result ||
            (tc.status !== 'failed' ? { restored: true, message: '(工具结果未保存)' } : null)
    }));
    eventBus.emit('restore:tool-calls', { toolCalls: normalized, contentDiv });
}

// 事件监听

eventBus.on('message:content-updated', ({ messageEl, index, role, messageOverride }) => {
    rerenderMessageContent(messageEl, index, role, messageOverride);
});
