/**
 * 会话消息恢复模块
 * 处理会话切换时的消息渲染和恢复
 */

import { state, elements } from '../core/state.js';
import { eventBus } from '../core/events.js';
import { createMessageElement, renderThinkingBlock, renderReplyWithSelector, enhanceCodeBlocks, renderContentParts, bindImageClickEvents, clearThinkingCache, renderSearchGrounding } from './renderer.js';
import { safeMarkedParse } from '../utils/markdown.js';
import { renderStreamStatsFromData } from '../stream/stats.js';
import { rebuildMessageIdMap, ensureMessageIds } from '../core/state-mutations.js';
import { renderHumanizedError } from '../utils/errors.js';
import { lazyImageManager } from '../utils/lazy-image.js';
import { PartType, MediaKind, ToolState, hasParts, filterParts, getThinkingContent as schemaGetThinkingContent } from './schema.js';

/**
 * 解析 OpenAI/Claude 格式的用户消息内容
 * @param {string|Array} content - 消息内容
 * @returns {Object} { text, images }
 */
function parseUserContent(content) {
    let text = '';
    const attachments = [];

    if (Array.isArray(content)) {
        content.forEach(part => {
            if (part.type === 'text') {
                text += (text ? '\n' : '') + (part.text || '');
            } else if (part.type === 'image_url' && part.image_url?.url) {
                // 图片（OpenAI 格式）
                attachments.push({
                    name: '已上传图片',
                    type: 'image/*',
                    category: 'image',
                    data: part.image_url.url,
                });
            } else if (part.type === 'image' && part.source?.data) {
                // 图片（Claude 格式）
                const mimeType = part.source.media_type || 'image/*';
                attachments.push({
                    name: '已上传图片',
                    type: mimeType,
                    category: 'image',
                    data: `data:${mimeType};base64,${part.source.data}`,
                });
            } else if (part.type === 'file' && part.file?.file_data) {
                // PDF（OpenAI 格式）
                attachments.push({
                    name: part.file.filename || '已上传PDF',
                    type: 'application/pdf',
                    category: 'pdf',
                    data: part.file.file_data,
                });
            } else if (part.type === 'document' && part.source?.data) {
                // PDF（Claude 格式）
                const mimeType = part.source.media_type || 'application/pdf';
                attachments.push({
                    name: '已上传PDF',
                    type: mimeType,
                    category: 'pdf',
                    data: `data:${mimeType};base64,${part.source.data}`,
                });
            }
            // 注意：TXT/MD 文件在 OpenAI/Claude 格式中会被解码为文本内容
            // 无法从纯文本中恢复为附件形式
        });
    } else if (typeof content === 'string') {
        text = content;
    }

    // 返回 images 以保持向后兼容
    return { text, images: attachments };
}

/**
 * 渲染会话消息
 */
export function renderSessionMessages() {
    // 清理旧的虚拟滚动状态（通过事件通知 UI 层）
    eventBus.emit('restore:disable-virtual-scroll');

    // 清理思维链惰性渲染缓存（防止跨会话内存泄漏）
    clearThinkingCache();

    // 清空消息区域
    elements.messagesArea.innerHTML = '';

    // 检查是否有消息
    const messages = state.messages;

    if (messages.length === 0) {
        // 显示欢迎消息
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
                <h2>你好，我是 AI 助手</h2>
            </div>
        `;
        return;
    }

    // 如果消息数量超过阈值，使用虚拟滚动
    if (messages.length >= 50) {
        console.log(`消息数量 ${messages.length}，启用虚拟滚动模式`);
        eventBus.emit('restore:init-virtual-scroll');
        rebuildMessageIdMap(); // 重建索引映射
        // 虚拟滚动模块会自动渲染
        return;
    }

    // 传统渲染模式（< 100 条消息）

    // 性能优化：使用 DocumentFragment 批量插入，避免频繁 reflow
    const fragment = document.createDocumentFragment();
    const enhancementQueue = []; // 增强操作队列（异步执行）

    // 批量补充缺少 ID 的旧消息
    ensureMessageIds();

    // 渲染所有消息（统一读 state.messages）
    state.messages.forEach((msg, index) => {
        // 新格式优先从 parts 提取文本和附件
        let text, images;
        if (hasParts(msg)) {
            text = filterParts(msg.parts, PartType.TEXT).map(p => p.text).join('\n');
            const mediaAttachments = filterParts(msg.parts, PartType.MEDIA)
                .filter(p => p.media === MediaKind.IMAGE)
                .map(p => ({
                    name: '已上传图片',
                    type: p.mime || 'image/*',
                    category: 'image',
                    data: p.url,
                }));
            const fileAttachments = filterParts(msg.parts, PartType.FILE)
                .map(p => ({
                    name: p.name || '已上传文件',
                    type: p.mime || 'application/octet-stream',
                    category: p.mime === 'application/pdf' ? 'pdf' : 'text',
                    data: p.url,
                }));
            images = [...mediaAttachments, ...fileAttachments];
        } else {
            ({ text, images } = parseUserContent(msg.content));
        }
        const modelName = msg.modelName || msg.meta?.model || null;
        const providerName = msg.providerName || msg.meta?.provider || null;

        const messageEl = createMessageElement(msg.role, text, images.length > 0 ? images : null, msg.id, modelName, providerName);
        messageEl.dataset.messageIndex = index;

        fragment.appendChild(messageEl);

        const isError = msg.isError || msg.error;
        if (msg.role === 'assistant' && !isError) {
            enhancementQueue.push({ messageEl, msg, openaiMsg: msg });
        } else if (msg.role === 'assistant' && isError) {
            const contentDiv = messageEl.querySelector('.message-content');
            if (contentDiv) {
                const storedErrorHtml = msg.errorHtml || msg.meta?.raw?.errorHtml;
                if (storedErrorHtml) {
                    contentDiv.innerHTML = window.DOMPurify ? DOMPurify.sanitize(storedErrorHtml) : storedErrorHtml;
                } else if (msg.errorData) {
                    contentDiv.innerHTML = renderHumanizedError(msg.errorData, msg.httpStatus || null, false);
                } else {
                    contentDiv.innerHTML = '<div class="error-humanized"><div class="error-humanized-content"><div class="error-humanized-title">错误消息加载失败</div><div class="error-humanized-hint">请重新发送消息</div></div></div>';
                }
            }
            messageEl.dataset.isError = 'true';
        }
    });

    // 一次性插入所有消息（只触发一次 reflow）
    elements.messagesArea.appendChild(fragment);

    // Render assistant enhancements immediately on restore.
    for (let idx = 0; idx < enhancementQueue.length; idx++) {
        const { messageEl, msg, openaiMsg } = enhancementQueue[idx];
        try {
            enhanceAssistantMessage(messageEl, msg, openaiMsg);
        } catch (e) {
            console.error('[Restore] 消息增强失败 (index:', idx, '):', e);
        }
    }


    // 观察所有懒加载图片
    requestIdleCallback(() => {
        const lazyImages = elements.messagesArea.querySelectorAll('.lazy-image:not(.observed)');
        lazyImages.forEach(img => {
            lazyImageManager.observe(img);
            img.classList.add('observed');
        });
    }, { timeout: 1000 });

    // 滚动到底部
    setTimeout(() => {
        elements.messagesArea.scrollTo({
            top: elements.messagesArea.scrollHeight,
            behavior: 'instant'
        });
    }, 50);
}

/**
 * 恢复工具调用UI（紧凑按钮 + 媒体提取模式）
 * @param {Array} toolCalls - 工具调用数组
 * @param {HTMLElement} messageEl - 消息元素
 */
async function restoreToolCallsUI(toolCalls, messageEl) {
    if (!toolCalls || toolCalls.length === 0) return;

    console.log(`[Restore] 恢复 ${toolCalls.length} 个工具调用UI`);

    const contentDiv = messageEl.querySelector('.message-content');
    if (!contentDiv) {
        console.warn('[Restore] 未找到消息内容容器');
        return;
    }

    try {
        // 兼容旧数据：给没有 status 的工具调用补充默认状态
        const normalized = toolCalls.map(tc => ({
            ...tc,
            status: tc.status || 'completed',
            result: tc.result || (tc.status !== 'failed' ? { restored: true, message: '(工具结果未保存)' } : null)
        }));

        eventBus.emit('restore:tool-calls', { toolCalls: normalized, contentDiv });
        console.log('[Restore] 工具UI恢复完成');
    } catch (error) {
        console.error('[Restore] 恢复工具UI失败:', error);
    }
}

/**
 * 异步增强 assistant 消息（思维链、统计、多回复、工具UI）
 * 性能优化：使用 requestIdleCallback 避免阻塞 UI
 * 性能优化：缓存 DOM 查询
 * @param {HTMLElement} messageEl - 消息元素
 * @param {Object} msg - Gemini 或 OpenAI 消息对象
 * @param {Object} openaiMsg - OpenAI 格式消息对象（用于元数据）
 */
function enhanceAssistantMessage(_messageEl, msg, openaiMsg) {
    // 优化：缓存 querySelector 结果
    const contentDiv = _messageEl.querySelector('.message-content');

    // 恢复消息内容（思维链 + 文本/图片）
    if (contentDiv && openaiMsg) {
        let html = '';
        let contentRendered = false;  // 跟踪是否成功渲染了内容

        // 1. 渲染思维链：新格式 parts 优先，回退到旧字段
        let thinkingText = '';
        if (hasParts(msg)) {
            thinkingText = schemaGetThinkingContent(msg);
        }
        if (!thinkingText) {
            if (openaiMsg.thinkingContent) console.warn('[Restore] 命中旧格式回退: thinkingContent');
            thinkingText = openaiMsg.thinkingContent || '';
        }
        if (thinkingText) {
            html += renderThinkingBlock(thinkingText);
        }

        // 2. 渲染内容：新格式 parts 优先
        if (hasParts(msg)) {
            for (const p of msg.parts) {
                if (p.type === PartType.THINKING) continue; // 已在上面渲染
                if (p.type === PartType.TEXT && p.text && p.text !== '(调用工具)') {
                    html += safeMarkedParse(p.text);
                    contentRendered = true;
                } else if (p.type === PartType.MEDIA && p.url) {
                    if (p.media === MediaKind.VIDEO) {
                        html += `<div class="image-wrapper video-wrapper"><video src="${p.url}" controls playsinline muted preload="metadata"></video></div>`;
                    } else if (p.media === MediaKind.AUDIO) {
                        html += `<div class="audio-wrapper"><audio src="${p.url}" controls preload="metadata"></audio></div>`;
                    } else {
                        html += `<div class="image-wrapper"><img src="${p.url}" alt="Generated image" style="cursor:pointer;"></div>`;
                    }
                    contentRendered = true;
                }
            }
        }

        // 3. 回退到 contentParts（旧格式）
        if (!contentRendered && openaiMsg.contentParts && openaiMsg.contentParts.length > 0) {
            console.warn('[Restore] 命中旧格式回退: contentParts');
            const validContentParts = openaiMsg.contentParts.filter(
                p => !(p.type === PartType.TEXT && p.text === '(调用工具)') && (thinkingText ? p.type !== PartType.THINKING : true)
            );

            if (validContentParts.length > 0) {
                const renderedContent = renderContentParts(validContentParts);
                if (renderedContent && renderedContent.trim()) {
                    html += renderedContent;
                    contentRendered = true;
                }
            }
        }

        // 4. 回退到 openaiMsg.content（旧格式）
        if (!contentRendered && openaiMsg.content) {
            console.warn('[Restore] 命中旧格式回退: content');
            let textContent = '';
            if (typeof openaiMsg.content === 'string') {
                textContent = openaiMsg.content;
            } else if (Array.isArray(openaiMsg.content)) {
                textContent = openaiMsg.content
                    .filter(p => p.type === 'text')
                    .map(p => p.text)
                    .join('');
            }
            if (textContent && textContent !== '(调用工具)') {
                html += safeMarkedParse(textContent);
                contentRendered = true;
            }
        }

        // 5. 如果有内容，更新 DOM
        if (html) {
            contentDiv.innerHTML = html;
        }

        // 日志记录未渲染的情况
        if (!contentRendered && !thinkingText) {
            console.warn('[Restore] 消息无法渲染内容:', {
                index: _messageEl.dataset.messageIndex,
                contentParts: openaiMsg.contentParts?.length,
                content: typeof openaiMsg.content,
                parts: msg?.parts?.length
            });
        }
    }

    // 恢复流统计信息
    const statsData = msg.meta?.stats || msg.streamStats || (openaiMsg && openaiMsg.streamStats);
    if (statsData) {
        const wrapper = _messageEl.querySelector('.message-content-wrapper');
        if (wrapper) {
            wrapper.insertAdjacentHTML('beforeend', renderStreamStatsFromData(statsData));
        }
    }

    // 恢复多回复选择器：新格式 replies 优先，回退到旧字段
    const allReplies = msg.replies?.all || openaiMsg?.allReplies;
    if (allReplies && allReplies.length > 1) {
        const selectedIndex = msg.replies?.selected ?? openaiMsg?.selectedReplyIndex ?? 0;
        renderReplyWithSelector(allReplies, selectedIndex, _messageEl);
    } else {
        enhanceCodeBlocks(_messageEl);
    }

    // 恢复 Gemini 搜索引用（groundingMetadata）
    const groundingMetadata = msg.meta?.raw?.gemini?.groundingMetadata || openaiMsg?.groundingMetadata;
    if (groundingMetadata) {
        const contentDiv = _messageEl.querySelector('.message-content');
        if (contentDiv) {
            contentDiv.insertAdjacentHTML('beforeend', renderSearchGrounding(groundingMetadata));
        }
    }

    // 恢复工具调用UI：新格式 parts 优先，回退到旧字段
    const toolCallParts = filterParts(msg.parts, PartType.TOOL_CALL);
    if (toolCallParts.length > 0) {
        // 映射新格式字段名到 restoreToolCallsUI 期望的格式
        const mapped = toolCallParts.map(tc => ({
            id: tc.id,
            name: tc.name,
            arguments: tc.args,
            status: tc.state === ToolState.DONE ? 'completed' : tc.state === ToolState.ERROR ? 'failed' : tc.state,
            result: tc.result,
            error: tc.error,
            duration: tc.duration,
        }));
        restoreToolCallsUI(mapped, _messageEl);
    } else if (openaiMsg?.toolCalls && openaiMsg.toolCalls.length > 0) {
        console.warn('[Restore] 命中旧格式回退: toolCalls');
        restoreToolCallsUI(openaiMsg.toolCalls, _messageEl);
    }
}
