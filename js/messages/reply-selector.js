/**
 * 回复选择器模块
 * 处理多回复的选择和切换
 */

import { state, elements } from '../core/state.js';
import { eventBus } from '../core/events.js';
import { updateMessageAt } from '../core/state-mutations.js';
import { debouncedSaveSession } from '../state/sessions.js';
import { safeMarkedParse } from '../utils/markdown.js';
import { PartType, MediaKind, textPart, thinkingPart, mediaPart, isSchemaFormatParts, getTextContent } from './schema.js';
import { renderThinkingBlock, enhanceCodeBlocks, renderContentParts } from './renderer.js';
import { renderHumanizedError } from '../utils/errors.js';
import { getMediaExtension, isVideoMimeType, isVideoUrl } from '../utils/media.js';

function renderDownloadIcon() {
    return `
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/>
        </svg>
    `;
}

function encodeInlineUrl(url) {
    return encodeURIComponent(url || '');
}

function renderImageBlock(url) {
    const encodedUrl = encodeInlineUrl(url);
    const ext = getMediaExtension(url, '', 'png');
    return `<div class="image-wrapper">
        <img src="${url}" alt="Generated image" title="点击查看大图" onclick="openImageViewer(decodeURIComponent('${encodedUrl}'))" style="cursor:pointer;">
        <button type="button" class="download-image-btn" onclick="event.stopPropagation();downloadImage(decodeURIComponent('${encodedUrl}'), 'image-${Date.now()}.${ext}')" title="下载原图">
            ${renderDownloadIcon()}
        </button>
    </div>`;
}

function renderVideoBlock(url, mimeType = '') {
    const encodedUrl = encodeInlineUrl(url);
    const ext = getMediaExtension(url, mimeType, 'mp4');
    return `<div class="image-wrapper video-wrapper">
        <video src="${url}" controls playsinline muted preload="metadata" title="AI 生成视频"></video>
        <button type="button" class="download-image-btn" onclick="event.stopPropagation();downloadMedia(decodeURIComponent('${encodedUrl}'), 'video-${Date.now()}.${ext}')" title="下载视频">
            ${renderDownloadIcon()}
        </button>
    </div>`;
}

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
        replies = msg.replies?.all || msg.allReplies;
        if (!replies) return;
        messageEl = elements.messagesArea.querySelector(`.message[data-message-index="${messageIndex}"]`);

        // Bug 2 防御性日志（而非复杂的 DOM 恢复）
        if (!messageEl) {
            console.error(`[Bug 2] 消息索引 ${messageIndex} 的 DOM 元素未找到`);
            console.error('[Bug 2] 这表明 dataset.messageIndex 未正确设置');

            // 使用 currentAssistantMessage 作为后备（流式输出时）
            if (state.currentAssistantMessage) {
                messageEl = state.currentAssistantMessage.closest('.message');
                console.warn('[Bug 2] 使用 state.currentAssistantMessage 作为后备');
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
        // 新格式优先：从 parts 提取文本
        let textContent = '';
        if (reply.parts && reply.parts.length > 0 && reply.parts[0]?.type) {
            textContent = getTextContent(reply);
        }
        // 旧格式回退
        if (!textContent) {
            textContent = reply.content || '';
        }

        applyReplyToMessage(messageIndex, reply, textContent, {
            replyIndex,
        });

        debouncedSaveSession();
    } else {
        state.selectedReplyIndex = replyIndex;
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
                        } else if (part.type === PartType.TEXT && part.text && part.text !== '(调用工具)') {
                            html += safeMarkedParse(part.text);
                        } else if (part.type === PartType.MEDIA && part.url) {
                            if (part.media === MediaKind.VIDEO) {
                                html += renderVideoBlock(part.url, part.mime);
                            } else if (part.media === MediaKind.AUDIO) {
                                html += `<div class="audio-wrapper"><audio src="${part.url}" controls preload="metadata"></audio></div>`;
                            } else {
                                html += renderImageBlock(part.url);
                            }
                        }
                    }
                }
                // 旧格式回退链
                else {
                    // 思维链
                    if (reply.thinkingContent) {
                        html += renderThinkingBlock(reply.thinkingContent);
                    }
                    // contentParts
                    if (reply.contentParts && reply.contentParts.length > 0) {
                        html += renderContentParts(reply.contentParts);
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
                    // content 字符串/数组
                    else if (reply.content) {
                        if (Array.isArray(reply.content)) {
                            for (const part of reply.content) {
                                if (part.type === 'text') {
                                    html += safeMarkedParse(part.text);
                                } else if (part.type === 'video_url') {
                                    const url = part.video_url?.url || part.url;
                                    html += renderVideoBlock(url, part.mime_type || part.mimeType || part.video_url?.mime_type || part.video_url?.mimeType);
                                } else if (part.type === 'image_url' && part.image_url?.url) {
                                    const url = part.image_url.url;
                                    if (isVideoUrl(url)) {
                                        html += renderVideoBlock(url);
                                    } else {
                                        html += renderImageBlock(url);
                                    }
                                }
                            }
                        } else {
                            html += safeMarkedParse(reply.content);
                        }
                    }
                }
            }
            contentDiv.innerHTML = html;

            // 不再需要手动绑定图片事件（已使用内联 onclick）

            // 增强代码块（绑定复制按钮、表格导出、思维链折叠等）
            enhanceCodeBlocks(messageEl);
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
        parts = reply.parts.filter(p => p.type !== PartType.TOOL_CALL && p.type !== PartType.FILE);
    } else {
        // 旧格式回退：从旧字段重建 parts
        parts = [];
        if (reply.thinkingContent) {
            parts.push(thinkingPart(reply.thinkingContent, reply.thinkingSignature || reply.thoughtSignature || null));
        }
        if (textContent) {
            parts.push(textPart(textContent));
        }
        if (reply.contentParts && reply.contentParts.length > 0) {
            for (const cp of reply.contentParts) {
                if (cp.type === 'image' || cp.type === 'image_url') {
                    const url = cp.url || cp.image_url?.url;
                    if (url) parts.push(mediaPart(MediaKind.IMAGE, url));
                } else if (cp.type === 'video' || cp.type === 'video_url') {
                    const url = cp.url || cp.video_url?.url;
                    if (url) parts.push(mediaPart(MediaKind.VIDEO, url, cp.mime_type || cp.mimeType));
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
        ...extraOpenai,
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
    // 新格式优先
    let textContent = '';
    if (reply.parts && reply.parts.length > 0 && reply.parts[0]?.type) {
        textContent = reply.parts.filter(p => p.type === PartType.TEXT).map(p => p.text).join('');
    }
    if (!textContent) {
        textContent = reply.content || '';
    }
    const lastIndex = state.messages.length - 1;

    if (lastIndex < 0) return;
    if (state.messages[lastIndex].role !== 'assistant') return;

    const shared = {
        replies: { all: state.currentReplies, selected: state.selectedReplyIndex },
        replyIndex: state.selectedReplyIndex,
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
        .filter(chunk => chunk.web)
        .map(chunk => `
            <a href="${chunk.web.uri}" target="_blank" rel="noopener" class="search-source">
                ${escapeHtml(chunk.web.title || new URL(chunk.web.uri).hostname)}
            </a>
        `);

    if (sources.length === 0) return '';

    return `
        <div class="search-sources">
            <span class="sources-label">🔍 来源:</span>
            ${sources.join('')}
        </div>
    `;
}

/**
 * 转义 HTML
 */
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/**
 * 初始化回复选择器事件监听
 */
export function initReplySelector() {
    // 监听回复选择请求事件
    eventBus.on('reply:select-requested', ({ index, messageIndex }) => {
        selectReply(index, messageIndex);
    });

    console.log('Reply selector initialized');
}
