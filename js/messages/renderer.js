/**
 * 消息渲染模块
 * 负责创建和渲染消息 DOM 元素
 * 注意：编辑/删除操作通过事件触发，避免循环依赖
 */

import { state } from '../core/state.js';
import { elements } from '../core/elements.js';
import { eventBus } from '../core/events.js';
import { setCurrentAssistantMessage } from '../core/state-mutations.js';
import { safeMarkedParse } from '../utils/markdown.js';
import { escapeHtml } from '../utils/helpers.js';
import { getCurrentModelCapabilities } from '../providers/manager.js';
import { renderCapabilityBadgesText } from '../utils/capability-badges.js';
import { renderHumanizedError } from '../utils/errors.js';
import { categorizeFile, truncateFileName } from '../utils/file-helpers.js';
import { lazyImageManager } from '../utils/lazy-image.js';
import { isVideoMimeType, isAudioMimeType, isVideoUrl } from '../utils/media.js';
import {
    PartType,
    MediaKind,
    hasParts,
    isSchemaFormatParts,
    getTextContent,
    getThinkingContent,
    partsToToolCallRestoreFormat
} from './schema.js';
import {
    renderImageCard as renderImageMedia,
    renderVideoCard as renderVideoMedia,
    renderAudioCard as renderAudioMedia,
    renderMediaCard as renderMediaBlock
} from '../ui/media-cards.js';

// 从子模块导入并 re-export，保持外部 import 兼容
import {
    enhanceCodeBlocks,
    updateCodeBlockInMessage,
    bindImageClickEvents
} from './render-code.js';
import {
    renderThinkingBlock,
    clearThinkingCache,
    enhanceThinkingBlocks
} from './render-thinking.js';
import { renderSearchGrounding } from './render-search.js';
import { logger } from '../utils/logger.js';

export { enhanceCodeBlocks, updateCodeBlockInMessage, bindImageClickEvents };
export { renderThinkingBlock, clearThinkingCache, enhanceThinkingBlocks };
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
 * @returns {HTMLElement} 消息元素
 */
export function createMessageElement(
    role,
    content,
    images = null,
    messageId = null,
    modelName = null,
    _providerName = null
) {
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

    if (role === 'assistant' && typeof marked !== 'undefined') {
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

    if (role === 'assistant') {
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

    const loadingIndicator = contentDiv.querySelector('.loading-indicator, .thinking-dots');
    if (loadingIndicator) loadingIndicator.remove();

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
            tab.className = `reply-tab${index === selectedIndex ? ' active' : ''}`;
            tab.textContent = index + 1;
            tab.title = `回复 ${index + 1}`;
            tab.onclick = () => {
                eventBus.emit('reply:select-requested', { index, messageIndex: msgIdx });
            };
            selectorEl.appendChild(tab);
        });
    }

    const reply = replies[selectedIndex] || replies[0];
    if (!reply) return;
    let html = '';

    if (reply.isError) {
        const errorObj = {
            error: {
                type: reply.errorType || 'unknown',
                message: reply.errorMessage || 'Unknown error'
            }
        };
        html = renderHumanizedError(errorObj, null, true);
    } else if (isSchemaFormatParts(reply.parts)) {
        for (const part of reply.parts) {
            if (part.type === PartType.THINKING) {
                html += renderThinkingBlock(part.text);
            } else if (part.type === PartType.TEXT && part.text && part.text !== '(调用工具)') {
                html += safeMarkedParse(part.text);
            } else if (part.type === PartType.MEDIA && part.url) {
                if (part.media === MediaKind.VIDEO) {
                    html += renderVideoMedia(part.url, part.mime);
                } else if (part.media === MediaKind.AUDIO) {
                    html += renderAudioMedia(part.url, part.mime);
                } else {
                    html += renderImageMedia(part.url);
                }
            }
        }
    } else {
        // 旧格式回退（旧格式兜底，未迁移数据需要）：用 schema.js 工具函数提取
        const replyThinking = getThinkingContent(reply);
        if (replyThinking) {
            html += renderThinkingBlock(replyThinking);
        }

        if (reply.contentParts && reply.contentParts.length > 0) {
            // 旧格式兜底，未迁移数据需要
            html += renderContentParts(reply.contentParts); // 旧格式兜底
        } else if (state.apiFormat === 'gemini' && reply.parts) {
            html += renderGeminiParts(reply.parts);
            if (reply.groundingMetadata) {
                html += renderSearchGrounding(reply.groundingMetadata);
            }
        } else {
            const replyText = getTextContent(reply);
            if (replyText) {
                html += safeMarkedParse(replyText);
            }
        }
    }

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
 * 渲染 Gemini parts
 */
function renderGeminiParts(parts) {
    let html = '';
    for (const part of parts) {
        if (part.thought) continue;

        if (part.text) {
            html += safeMarkedParse(part.text);
        } else if (part.inlineData || part.inline_data) {
            const inlineData = part.inlineData || part.inline_data;
            const mimeType = inlineData.mimeType || inlineData.mime_type;
            const dataUrl = `data:${mimeType};base64,${inlineData.data}`;
            let mediaType;
            if (isVideoMimeType(mimeType)) mediaType = 'video';
            else if (isAudioMimeType(mimeType)) mediaType = 'audio';
            else mediaType = 'image';
            html += renderMediaBlock(dataUrl, mediaType, mimeType);
        }
    }
    return html;
}

/**
 * 渲染内容（OpenAI/Claude 格式）
 */
function renderContent(content) {
    if (Array.isArray(content)) {
        let html = '';
        for (const part of content) {
            if (part.type === 'text') {
                html += safeMarkedParse(part.text);
            } else if (part.type === 'video_url') {
                const url = part.video_url?.url || part.url;
                html += renderMediaBlock(
                    url,
                    'video',
                    part.mime_type ||
                        part.mimeType ||
                        part.video_url?.mime_type ||
                        part.video_url?.mimeType
                );
            } else if (part.type === 'audio_url') {
                const url = part.audio_url?.url || part.url;
                html += renderMediaBlock(url, 'audio', part.mime_type || part.mimeType);
            } else if (part.type === 'image_url' && part.image_url?.url) {
                const url = part.image_url.url;
                const mediaType = isVideoUrl(url) ? 'video' : 'image';
                html += renderMediaBlock(url, mediaType);
            }
        }
        return html;
    } else {
        return safeMarkedParse(content);
    }
}

/**
 * 渲染 contentParts 数组（包含文本、图片和思维链）
 * @param {Array} contentParts - 内容部分数组
 * @returns {string} HTML字符串
 */
export function renderContentParts(contentParts) {
    let html = '';
    for (const part of contentParts) {
        if (part.type === PartType.THINKING) {
            html += renderThinkingBlock(part.text, false);
        } else if (part.type === PartType.TEXT) {
            if (part.text && part.text !== '(调用工具)') {
                html += safeMarkedParse(part.text);
            }
        } else if (part.type === 'video_url' && part.complete && part.url) {
            html += renderMediaBlock(part.url, 'video', part.mimeType || part.mime_type);
        } else if (part.type === 'audio_url' && part.complete && part.url) {
            html += renderMediaBlock(part.url, 'audio', part.mimeType || part.mime_type);
        } else if (part.type === 'image_url' && part.complete && part.url) {
            const mediaType = isVideoUrl(part.url, part.mimeType || part.mime_type)
                ? 'video'
                : 'image';
            html += renderMediaBlock(part.url, mediaType, part.mimeType || part.mime_type);
        }
    }
    return html;
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

    setCurrentAssistantMessage(latestAssistantMessage?.querySelector('.message-content') || null);
}

function buildMessageHtml(message, role) {
    if (!message) {
        return '';
    }

    if (hasParts(message)) {
        let htmlContent = '';
        for (const part of message.parts) {
            if (part.type === PartType.THINKING) {
                htmlContent += renderThinkingBlock(part.text);
            } else if (part.type === PartType.TEXT && part.text && part.text !== '(调用工具)') {
                htmlContent +=
                    role === 'assistant' ? safeMarkedParse(part.text) : escapeHtml(part.text);
            } else if (part.type === PartType.MEDIA && part.url) {
                const mediaType =
                    part.media === MediaKind.VIDEO
                        ? 'video'
                        : part.media === MediaKind.AUDIO
                          ? 'audio'
                          : 'image';
                htmlContent += renderMediaBlock(part.url, mediaType, part.mime);
            }
        }

        if (htmlContent) {
            return htmlContent;
        }
    }

    // 旧格式回退（旧格式兜底，未迁移数据需要）：contentParts 含媒体数据
    if (message?.contentParts?.length > 0) {
        logger.warn('[Renderer] 命中旧格式回退: contentParts');
        const validParts = message.contentParts.filter(
            (part) => !(part.type === PartType.TEXT && part.text === '(调用工具)')
        );
        if (validParts.length > 0) {
            return renderContentParts(validParts);
        }
    }

    // 旧格式回退：用 schema.js 工具函数提取
    const thinkingFallback = getThinkingContent(message);
    const textFallback = getTextContent(message);
    if (role === 'assistant' && thinkingFallback) {
        let html = renderThinkingBlock(thinkingFallback);
        if (textFallback) {
            html += safeMarkedParse(textFallback);
        } else if (Array.isArray(message.content)) {
            html += renderContent(message.content);
        }
        return html;
    }

    if (textFallback) {
        return role === 'assistant' ? safeMarkedParse(textFallback) : escapeHtml(textFallback);
    }

    return message?.content ? renderContent(message.content) : '';
}

export function rerenderMessageContent(messageEl, index, role) {
    const contentWrapper = messageEl?.querySelector('.message-content-wrapper');
    const contentDiv = contentWrapper?.querySelector('.message-content');
    const message = state.messages[index];

    if (!contentWrapper || !contentDiv || !message) {
        return false;
    }

    messageEl.classList.remove('editing');

    if (!Array.isArray(message.replies?.all) || message.replies.all.length <= 1) {
        contentWrapper.querySelector('.reply-selector')?.remove();
    }

    // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
    contentDiv.innerHTML = buildMessageHtml(message, role);
    syncCurrentAssistantMessageReference();

    enhanceCodeBlocks(messageEl);

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

eventBus.on('message:content-updated', ({ messageEl, index, role }) => {
    rerenderMessageContent(messageEl, index, role);
});
