/**
 * 回复选择器模块
 * 处理多回复的选择和切换
 */

import { state, elements } from '../core/state.js';
import { eventBus } from '../core/events.js';
import { updateMessageAt, setSelectedReplyIndex } from '../core/state-mutations.js';
import { debouncedSaveSession } from '../state/sessions.js';
import { safeMarkedParse } from '../utils/markdown.js';
import { escapeHtml } from '../utils/helpers.js';
import {
    PartType,
    MediaKind,
    textPart,
    thinkingPart,
    mediaPart,
    isSchemaFormatParts,
    getTextContent,
    getThinkingContent
} from './schema.js';
import {
    renderThinkingBlock,
    enhanceCodeBlocks,
    renderContentParts,
    restoreToolCallsFromMessage
} from './renderer.js';
import { renderHumanizedError } from '../utils/errors.js';
import { getIcon } from '../utils/icons.js';
import { isVideoMimeType } from '../utils/media.js';
import {
    renderImageCard as renderImageBlock,
    renderVideoCard as renderVideoBlock
} from '../ui/media-cards.js';
import { logger } from '../utils/logger.js';

/**
 * 选择回复（支持两种调用方式：直接索引或带消息索引）
 * @param {number} replyIndex - 回复索引
 * @param {number|null} messageIndex - 消息索引
 */
export function selectReply(replyIndex, messageIndex = null) {
    let replies;
    let messageEl;

    // 如果提供了消息索引，从消息历史中获取回复
    if (messageIndex !== null) {
        const msg = state.messages[messageIndex];
        if (!msg) return;
        replies = msg.replies?.all;
        if (!replies) return;
        messageEl = elements.messagesArea.querySelector(
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

    const reply = replies[replyIndex];

    // 更新消息历史中的选中索引 - 通过安全函数同步
    if (messageIndex !== null) {
        // 用 schema.js 工具函数提取文本（内部已处理新/旧格式回退）
        const textContent = getTextContent(reply);

        applyReplyToMessage(messageIndex, reply, textContent, {
            replyIndex
        });

        debouncedSaveSession();
    } else {
        setSelectedReplyIndex(replyIndex);
        updateMessageHistoryWithSelectedReply();
    }

    // 更新显示的内容
    if (messageEl) {
        const wrapper = messageEl.querySelector('.message-content-wrapper');
        const contentDiv = messageEl.querySelector('.message-content');

        if (wrapper && contentDiv) {
            // 更新选择器
            const selectorEl = wrapper.querySelector('.reply-selector');
            if (selectorEl) {
                selectorEl.querySelectorAll('.reply-tab').forEach((tab, i) => {
                    tab.classList.toggle('active', i === replyIndex);
                });
            }

            // 更新内容
            let html = '';

            // 检查是否是错误回复
            if (reply.isError) {
                const errorObj = {
                    error: {
                        type: reply.errorType || 'unknown',
                        message: reply.errorMessage || 'Unknown error'
                    }
                };
                html = renderHumanizedError(errorObj, null, true);
            } else {
                // 新格式 parts[] 优先
                if (isSchemaFormatParts(reply.parts)) {
                    for (const part of reply.parts) {
                        if (part.type === PartType.THINKING) {
                            html += renderThinkingBlock(part.text);
                        } else if (
                            part.type === PartType.TEXT &&
                            part.text &&
                            part.text !== '(调用工具)'
                        ) {
                            html += safeMarkedParse(part.text);
                        } else if (part.type === PartType.MEDIA && part.url) {
                            if (part.media === MediaKind.VIDEO) {
                                html += renderVideoBlock(part.url, part.mime);
                            } else if (part.media === MediaKind.AUDIO) {
                                html += `<div class="audio-wrapper"><audio src="${escapeHtml(part.url)}" controls preload="metadata"></audio></div>`;
                            } else {
                                html += renderImageBlock(part.url);
                            }
                        }
                    }
                }
                // 旧格式回退链（旧格式兜底，未迁移数据需要）
                else {
                    // 思维链（已用 schema.js 工具函数）
                    const replyThinking = getThinkingContent(reply);
                    if (replyThinking) {
                        html += renderThinkingBlock(replyThinking);
                    }
                    // contentParts（旧格式含媒体数据）
                    if (reply.contentParts && reply.contentParts.length > 0) {
                        html += renderContentParts(reply.contentParts); // 旧格式兜底
                    }
                    // Gemini 原始格式
                    else if (state.apiFormat === 'gemini' && reply.parts) {
                        for (const part of reply.parts) {
                            if (part.thought) continue;
                            if (part.text) {
                                html += safeMarkedParse(part.text);
                            } else if (part.inlineData || part.inline_data) {
                                const inlineData = part.inlineData || part.inline_data;
                                const mimeType = inlineData.mimeType || inlineData.mime_type;
                                const dataUrl = `data:${mimeType};base64,${inlineData.data}`;
                                if (isVideoMimeType(mimeType)) {
                                    html += renderVideoBlock(dataUrl, mimeType);
                                } else {
                                    html += renderImageBlock(dataUrl);
                                }
                            }
                        }
                        if (reply.groundingMetadata) {
                            html += renderSearchGrounding(reply.groundingMetadata);
                        }
                    }
                    // 文本回退（用 schema.js 工具函数，覆盖 content 字符串/数组）
                    else {
                        const replyText = getTextContent(reply);
                        if (replyText) {
                            html += safeMarkedParse(replyText);
                        }
                    }
                }
            }
            // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
            contentDiv.innerHTML = html;

            // 不再需要手动绑定图片事件（已使用内联 onclick）

            // 增强代码块（绑定复制按钮、表格导出、思维链折叠等）
            enhanceCodeBlocks(messageEl);

            // innerHTML 覆盖会抹掉 tool-calls-group 节点，从当前消息 parts 重建
            const resolvedMsgIndex =
                messageIndex !== null
                    ? messageIndex
                    : parseInt(messageEl.dataset?.messageIndex ?? '', 10);
            if (Number.isInteger(resolvedMsgIndex)) {
                restoreToolCallsFromMessage(state.messages[resolvedMsgIndex], contentDiv);
            }
        }
    }
}

// 已删除 bindImageClickEvents 函数（改用内联 onclick，与其他渲染函数保持一致）

/**
 * 将回复数据应用到指定索引的消息
 * @param {number} index - 消息索引
 * @param {Object} reply - 回复对象
 * @param {string} textContent - 文本内容
 * @param {Object} extraOpenai - 额外字段（selectedReplyIndex, allReplies 等）
 */
function applyReplyToMessage(index, reply, textContent, extraOpenai = {}) {
    // 优先使用回复自身的 parts（新格式）
    let parts;
    if (isSchemaFormatParts(reply.parts)) {
        // 新格式：直接使用 reply.parts（去掉 tool_call/file，后面从 existingMsg 补回）
        parts = reply.parts.filter(
            (p) => p.type !== PartType.TOOL_CALL && p.type !== PartType.FILE
        );
    } else {
        // 旧格式回退：从旧字段重建 parts
        parts = [];
        const replyThinking = getThinkingContent(reply);
        if (replyThinking) {
            parts.push(
                thinkingPart(
                    replyThinking,
                    reply.thinkingSignature || reply.thoughtSignature || null
                )
            );
        }
        if (textContent) {
            parts.push(textPart(textContent));
        }
        // 旧格式 contentParts 中的媒体 → 新格式 mediaPart（旧格式兜底，未迁移数据需要）
        if (reply.contentParts && reply.contentParts.length > 0) {
            for (const cp of reply.contentParts) {
                // 旧格式兜底，未迁移数据需要
                if (cp.type === 'image' || cp.type === 'image_url') {
                    const url = cp.url || cp.image_url?.url;
                    if (url) parts.push(mediaPart(MediaKind.IMAGE, url));
                } else if (cp.type === 'video' || cp.type === 'video_url') {
                    const url = cp.url || cp.video_url?.url;
                    if (url)
                        parts.push(mediaPart(MediaKind.VIDEO, url, cp.mime_type || cp.mimeType));
                }
            }
        }
    }

    // 保留原始消息中的 tool_call 和 file parts
    const existingMsg = state.messages[index];
    if (existingMsg?.parts && Array.isArray(existingMsg.parts)) {
        for (const p of existingMsg.parts) {
            if (p.type === PartType.TOOL_CALL || p.type === PartType.FILE) {
                parts.push(p);
            }
        }
    }

    const updates = {
        parts,
        ...extraOpenai
    };

    // 同步 reply 的 meta 到顶层（模型名、统计、provider-specific 数据）
    if (reply.meta) {
        updates.meta = reply.meta;
    }

    // 同步更新 replies.selected
    const replyIdx = extraOpenai.replyIndex ?? extraOpenai.selectedReplyIndex;
    if (replyIdx !== undefined) {
        const existingReplies = existingMsg?.replies;
        if (existingReplies) {
            updates.replies = { ...existingReplies, selected: replyIdx };
        }
    }

    updateMessageAt(index, updates);
}

/**
 * 更新消息历史中选中的回复
 */
function updateMessageHistoryWithSelectedReply() {
    if (state.currentReplies.length === 0) return;

    const reply = state.currentReplies[state.selectedReplyIndex];
    // 用 schema.js 工具函数提取文本（内部已处理新/旧格式回退）
    const textContent = getTextContent(reply);
    const lastIndex = state.messages.length - 1;

    if (lastIndex < 0) return;
    if (state.messages[lastIndex].role !== 'assistant') return;

    const shared = {
        replies: { all: state.currentReplies, selected: state.selectedReplyIndex },
        replyIndex: state.selectedReplyIndex
    };

    applyReplyToMessage(lastIndex, reply, textContent, shared);

    debouncedSaveSession();
}

/**
 * 渲染搜索引用（Gemini Web Search）
 */
function renderSearchGrounding(groundingMetadata) {
    if (!groundingMetadata?.groundingChunks && !groundingMetadata?.webSearchQueries) return '';

    const chunks = groundingMetadata.groundingChunks || [];
    const sources = chunks
        .filter((chunk) => chunk.web)
        .map(
            (chunk) => `
            <a href="${escapeHtml(chunk.web.uri)}" target="_blank" rel="noopener" class="search-source">
                ${escapeHtml(chunk.web.title || new URL(chunk.web.uri).hostname)}
            </a>
        `
        );

    if (sources.length === 0) return '';

    return `
        <div class="search-sources">
            <span class="sources-label">${getIcon('search', { size: 14 })} 来源:</span>
            ${sources.join('')}
        </div>
    `;
}

/**
 * 初始化回复选择器事件监听
 */
export function initReplySelector() {
    // 监听回复选择请求事件
    eventBus.on('reply:select-requested', ({ index, messageIndex }) => {
        selectReply(index, messageIndex);
    });

    logger.debug('Reply selector initialized');
}
