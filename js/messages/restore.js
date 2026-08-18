/**
 * 会话消息恢复模块
 * 处理会话切换时的消息渲染和恢复
 */

import { state, elements } from '../core/state.js';
import { eventBus } from '../core/events.js';
import { EVENTS } from '../core/events-registry.js';
import {
    createMessageElement,
    rerenderMessageContent,
    captureExpandedThinkingState,
    restoreExpandedThinkingState,
    purgeThinkingCacheInElement,
    renderReplyWithSelector,
    enhanceCodeBlocks,
    captureExpandedCodeBlockState,
    restoreExpandedCodeBlockState,
    clearThinkingCache,
    renderSearchGrounding,
    renderCanonicalParts
} from './renderer.js';
import { renderStreamStatsFromData } from '../stream/stats.js';
import { rebuildMessageIdMap, ensureMessageIds } from '../core/state-mutations.js';
import { renderHumanizedError } from '../utils/errors.js';
import { safeSetHTML } from '../utils/helpers.js';
import { lazyImageManager } from '../utils/lazy-image.js';
import { PartType, MediaKind, filterParts, partsToToolCallRestoreFormat } from './schema.js';
import { logger } from '../utils/logger.js';
import { longChatPerformance } from '../utils/long-chat-performance.js';
import { messageRenderController } from './message-render-controller.js';
import {
    getMessageUiState,
    retainMessageUiStates,
    updateMessageUiState
} from './message-ui-state.js';
import { isLazyMessage, loadStoredMessageAt } from '../state/session-message-repository.js';
import {
    hasStoredMedia,
    releaseAllMediaObjectUrls,
    releaseMediaObjectUrl,
    resolveMessageMediaForDisplay
} from '../state/media-blob-store.js';

const messageMediaIds = new WeakMap();

function renderWelcomeMessage() {
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
                <h2>你好，我是 AI 助手</h2>
            </div>
        `;
}

/**
 * 渲染会话消息
 */
export function renderSessionMessages() {
    longChatPerformance.observeLongTasks();
    const finishRestore = longChatPerformance.startSpan('sessionRestoreInteractive', {
        sessionId: state.currentSessionId,
        messageCount: state.messages.length
    });
    const finishShellRender = longChatPerformance.startSpan('messageShellRender', {
        messageCount: state.messages.length
    });
    messageRenderController.reset(elements.messagesArea);

    // 清理旧的虚拟滚动状态（通过事件通知 UI 层）
    eventBus.emit(EVENTS.RESTORE_DISABLE_VIRTUAL_SCROLL);

    // 清理思维链惰性渲染缓存（防止跨会话内存泄漏）
    clearThinkingCache();

    // 清空消息区域
    // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
    elements.messagesArea.innerHTML = '';

    // 空会话不在此直接 return：提前退出会跳过末尾的 INIT_VIRTUAL_SCROLL，
    // 让 activeOptions 停在 null，后续删除/重新生成的 DOM 同步就此断链

    // 批量补充缺少 ID 的旧消息
    ensureMessageIds();
    retainMessageUiStates(state.messages.map((message) => message.id));
    // 先建 ID map 再渲染：map 只依赖 state.messages 数组，与 DOM 解耦；
    // 若渲染期 createMessageElement 抛错，map 仍为当前会话状态，不会残留上一会话
    rebuildMessageIdMap();

    const renderMessage = (msg, index) => {
        const text = filterParts(msg.parts, PartType.TEXT)
            .map((part) => part.text)
            .join('\n');
        const mediaAttachments = filterParts(msg.parts, PartType.MEDIA)
            .filter((part) => part.media === MediaKind.IMAGE && part.url)
            .map((part) => ({
                name: '已上传图片',
                type: part.mime || 'image/*',
                category: 'image',
                data: part.url
            }));
        const fileAttachments = filterParts(msg.parts, PartType.FILE)
            .filter((part) => part.url)
            .map((part) => ({
                name: part.name || '已上传文件',
                type: part.mime || 'application/octet-stream',
                category: part.mime === 'application/pdf' ? 'pdf' : 'text',
                data: part.url
            }));
        const images = [...mediaAttachments, ...fileAttachments];
        const modelName = msg.meta?.model || null;
        const providerName = msg.meta?.provider || null;

        const messageEl = createMessageElement(
            msg.role,
            text,
            images.length > 0 ? images : null,
            msg.id,
            modelName,
            providerName,
            // assistant 内容由视口控制器按需渲染，避免同步解析整段会话
            { deferAssistantRender: true }
        );
        messageEl.dataset.messageIndex = index;

        const lazy = isLazyMessage(msg);
        const storedMedia = hasStoredMedia(msg);
        const isError = Boolean(msg.error);
        if (msg.role === 'assistant' || lazy || storedMedia) {
            const dehydrate =
                msg.role === 'assistant' ? () => dehydrateAssistantMessage(messageEl) : null;
            if (isError) messageEl.dataset.isError = 'true';
            messageRenderController.register(
                messageEl,
                async () => {
                    let renderedMessage = msg;
                    let renderedIndex = index;
                    if (lazy) {
                        const loaded = await loadStoredMessageAt(
                            msg._lazy.sessionId,
                            msg._lazy.index
                        );
                        if (!loaded) throw new Error(`消息 ${msg.id} 分页数据缺失`);
                        const currentIndex = state.messageStore.findIndexById(msg.id);
                        renderedIndex = currentIndex >= 0 ? currentIndex : index;
                        state.messageStore.replaceAt(renderedIndex, loaded);
                        renderedMessage = loaded;
                        messageEl.dataset.messageId = loaded.id;
                        messageEl.dataset.messageIndex = String(renderedIndex);
                    }

                    releaseMessageMedia(messageEl);
                    const displayMedia = await resolveMessageMediaForDisplay(renderedMessage);
                    renderedMessage = displayMedia.message;
                    messageMediaIds.set(messageEl, displayMedia.mediaIds);

                    const finishHydration = longChatPerformance.startSpan('assistantHydration', {
                        messageId: renderedMessage.id || '',
                        index: renderedIndex
                    });
                    try {
                        messageEl.classList.remove('message-dehydrated');
                        const renderedError = Boolean(renderedMessage.error);
                        if (renderedMessage.role === 'assistant') {
                            enhanceAssistantMessage(messageEl, renderedMessage, {
                                isError: renderedError
                            });
                            if (renderedError) appendStoredErrorBlock(messageEl, renderedMessage);
                        } else {
                            rerenderMessageContent(
                                messageEl,
                                renderedIndex,
                                renderedMessage.role,
                                renderedMessage
                            );
                        }
                        messageEl.style.minHeight = '';
                    } finally {
                        finishHydration();
                    }
                },
                {
                    priority: index >= state.messages.length - 8,
                    dehydrate
                }
            );
        }
        return messageEl;
    };

    const renderAll = () => {
        if (state.messages.length === 0) {
            renderWelcomeMessage();
            return;
        }
        const fragment = document.createDocumentFragment();
        state.messages.forEach((message, index) =>
            fragment.appendChild(renderMessage(message, index))
        );
        elements.messagesArea.replaceChildren(fragment);
    };

    const virtualScrollRequest = {
        messages: state.messages,
        renderItem: renderMessage,
        renderAll,
        initialIndex: state.messages.length - 1,
        estimates: state.messages.map(
            (message) => getMessageUiState(message.id).measuredHeight || 0
        ),
        getEstimates: () =>
            state.messages.map((message) => getMessageUiState(message.id).measuredHeight || 0),
        beforeRerender: () => {
            releaseAllMediaObjectUrls();
            messageRenderController.reset(elements.messagesArea);
        },
        onUnmount: (messageEl, message) => {
            releaseMessageMedia(messageEl);
            if (message?.role === 'assistant') {
                void messageRenderController.dehydrate(messageEl, { force: true });
            } else if (message?.id) {
                const measuredHeight =
                    messageEl.getBoundingClientRect().height || messageEl.offsetHeight || 0;
                if (measuredHeight > 0) updateMessageUiState(message.id, { measuredHeight });
            }
            messageRenderController.dispose(messageEl);
        },
        handled: false
    };
    eventBus.emit(EVENTS.RESTORE_INIT_VIRTUAL_SCROLL, virtualScrollRequest);
    if (!virtualScrollRequest.handled) renderAll();

    const messageDomCount = elements.messagesArea.querySelectorAll('.message').length;
    longChatPerformance.setGauge('messageDomCount', messageDomCount);
    finishShellRender({ domCount: messageDomCount });

    if (!state.messages.some((message) => message.role === 'assistant')) {
        longChatPerformance.setGauge('pendingMessageHydrations', 0);
    }
    finishRestore({ domCount: messageDomCount });

    // 观察所有懒加载图片
    requestIdleCallback(
        () => {
            const lazyImages = elements.messagesArea.querySelectorAll('.lazy-image:not(.observed)');
            lazyImages.forEach((img) => {
                lazyImageManager.observe(img);
                img.classList.add('observed');
            });
        },
        { timeout: 1000 }
    );

    // 滚动到底部
    setTimeout(() => {
        elements.messagesArea.scrollTo({
            top: elements.messagesArea.scrollHeight,
            behavior: 'instant'
        });
    }, 50);
}

function releaseMessageMedia(messageEl) {
    const mediaIds = messageMediaIds.get(messageEl) || [];
    mediaIds.forEach((mediaId) => releaseMediaObjectUrl(mediaId));
    messageMediaIds.delete(messageEl);
}

function dehydrateAssistantMessage(messageEl) {
    if (!messageEl?.isConnected) return;
    const messageId = messageEl.dataset.messageId;
    const contentWrapper = messageEl.querySelector('.message-content-wrapper');
    const contentDiv = contentWrapper?.querySelector('.message-content');
    if (!contentWrapper || !contentDiv) return;

    const measuredHeight = messageEl.getBoundingClientRect().height || messageEl.offsetHeight || 0;
    if (messageId) {
        updateMessageUiState(messageId, {
            thinkingExpanded: captureExpandedThinkingState(contentDiv),
            codeBlocksExpanded: captureExpandedCodeBlockState(contentDiv),
            measuredHeight
        });
    }

    purgeThinkingCacheInElement(contentDiv);
    releaseMessageMedia(messageEl);
    contentDiv.querySelectorAll('img.lazy-image').forEach((img) => {
        lazyImageManager.unloadImage(img, { force: true, reobserve: false });
    });
    contentWrapper.querySelector('.reply-selector')?.remove();
    contentWrapper.querySelector('.stream-stats')?.remove();
    contentDiv.replaceChildren();
    if (measuredHeight > 0) messageEl.style.minHeight = `${measuredHeight}px`;
    messageEl.classList.add('message-dehydrated');
}

/**
 * 在已渲染的部分接收内容之后追加错误块
 * 与流式路径 sink.renderError 的 insertAdjacentHTML('beforeend') 行为对齐，
 * 不整体覆盖 contentDiv，保住 parts 里已保存的部分接收内容
 * @param {HTMLElement} messageEl - 消息元素
 * @param {Object} msg - 消息对象
 */
function appendStoredErrorBlock(messageEl, msg) {
    const contentDiv = messageEl.querySelector('.message-content');
    if (!contentDiv) return;

    const storedErrorHtml = msg.error?.html;
    if (storedErrorHtml) {
        // 历史 errorHtml 需经 DOMPurify 净化后 append，safeSetHTML 只能整体覆盖，借临时容器过渡
        const holder = document.createElement('div');
        safeSetHTML(holder, storedErrorHtml);
        while (holder.firstChild) {
            contentDiv.appendChild(holder.firstChild);
        }
    } else if (msg.error) {
        // eslint-disable-next-line no-restricted-syntax -- 已审计：renderHumanizedError 输出内容已 escapeHtml
        contentDiv.insertAdjacentHTML(
            'beforeend',
            renderHumanizedError({ error: msg.error }, msg.error.status || null, false)
        );
    } else {
        // eslint-disable-next-line no-restricted-syntax -- 已审计：静态 HTML
        contentDiv.insertAdjacentHTML(
            'beforeend',
            '<div class="error-humanized"><div class="error-humanized-content"><div class="error-humanized-title">错误消息加载失败</div><div class="error-humanized-hint">请重新发送消息</div></div></div>'
        );
    }
}

/**
 * 恢复工具调用UI（紧凑按钮 + 媒体提取模式）
 * @param {Array} toolCalls - 工具调用数组
 * @param {HTMLElement} messageEl - 消息元素
 */
async function restoreToolCallsUI(toolCalls, messageEl) {
    if (!toolCalls || toolCalls.length === 0) return;

    logger.debug(`[Restore] 恢复 ${toolCalls.length} 个工具调用UI`);

    const contentDiv = messageEl.querySelector('.message-content');
    if (!contentDiv) {
        logger.warn('[Restore] 未找到消息内容容器');
        return;
    }

    try {
        // 兼容旧数据：给没有 status 的工具调用补充默认状态；
        // pending/running 是执行流被打断留下的非终态，恢复时收口为 failed，避免卡片永久转圈
        const normalized = toolCalls.map((tc) => {
            const interrupted = tc.status === 'pending' || tc.status === 'running';
            const status = interrupted ? 'failed' : tc.status || 'completed';
            return {
                ...tc,
                status,
                error: interrupted ? '应用重启，工具执行已中断' : tc.error,
                result:
                    tc.result ||
                    (status !== 'failed' ? { restored: true, message: '(工具结果未保存)' } : null)
            };
        });

        eventBus.emit('restore:tool-calls', { toolCalls: normalized, contentDiv });
        logger.debug('[Restore] 工具UI恢复完成');
    } catch (error) {
        logger.error('[Restore] 恢复工具UI失败:', error);
    }
}

// 与用户附件懒加载共用的灰色占位图（renderer.js / memory-manager.js 同款）
/**
 * 异步增强 assistant 消息（思维链、统计、多回复、工具UI）
 * 性能优化：使用 requestIdleCallback 避免阻塞 UI
 * 性能优化：缓存 DOM 查询
 * @param {HTMLElement} messageEl - 消息元素
 * @param {Object} msg - 标准消息对象
 * @param {Object} [options]
 * @param {boolean} [options.isError=false] - 错误消息无正文属正常场景，不打无内容 warn
 */
function enhanceAssistantMessage(_messageEl, msg, { isError = false } = {}) {
    // 优化：缓存 querySelector 结果
    const contentDiv = _messageEl.querySelector('.message-content');

    // 恢复消息内容（思维链 + 文本/图片）
    if (contentDiv) {
        const html = renderCanonicalParts(msg.parts, 'assistant', { lazyImages: true });

        // 5. 如果有内容，更新 DOM
        if (html) {
            // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
            contentDiv.innerHTML = html;
            // 分片增强晚于 renderSessionMessages 的 idle 兜底观察，此处必须自行 observe
            contentDiv.querySelectorAll('img.lazy-image:not(.observed)').forEach((img) => {
                lazyImageManager.observe(img);
                img.classList.add('observed');
            });
        }

        // 日志记录未渲染的情况
        if (!html && !isError) {
            logger.warn('[Restore] 消息无法渲染内容:', {
                index: _messageEl.dataset.messageIndex,
                parts: msg?.parts?.length
            });
        }
    }

    // 恢复流统计信息
    const statsData = msg.meta?.stats;
    if (statsData) {
        const wrapper = _messageEl.querySelector('.message-content-wrapper');
        if (wrapper) {
            // eslint-disable-next-line no-restricted-syntax -- 已审计：renderStreamStatsFromData 输出静态 SVG + 数值字段（ttft/totalTime/tokens/tps）
            wrapper.insertAdjacentHTML('beforeend', renderStreamStatsFromData(statsData));
        }
    }

    const allReplies = msg.replies?.all;
    const uiState = getMessageUiState(msg.id);
    if (allReplies && allReplies.length > 1) {
        const storedIndex = msg.replies?.selected ?? 0;
        const selectedIndex = Math.min(uiState.selectedReply ?? storedIndex, allReplies.length - 1);
        renderReplyWithSelector(allReplies, selectedIndex, _messageEl);
    } else {
        enhanceCodeBlocks(_messageEl);
    }

    // 恢复 Gemini 搜索引用（groundingMetadata）
    const groundingMetadata = msg.meta?.raw?.gemini?.groundingMetadata;
    if ((!allReplies || allReplies.length <= 1) && groundingMetadata) {
        const contentDiv = _messageEl.querySelector('.message-content');
        if (contentDiv) {
            // eslint-disable-next-line no-restricted-syntax -- 已审计：renderSearchGrounding 已对 uri/title 双 escapeHtml + safeHref 协议白名单
            contentDiv.insertAdjacentHTML('beforeend', renderSearchGrounding(groundingMetadata));
        }
    }

    const mapped = partsToToolCallRestoreFormat(msg.parts);
    if (mapped.length > 0) {
        restoreToolCallsUI(mapped, _messageEl);
    }

    restoreExpandedThinkingState(contentDiv, uiState.thinkingExpanded, (block) =>
        enhanceCodeBlocks(block)
    );
    restoreExpandedCodeBlockState(contentDiv, uiState.codeBlocksExpanded);
}

// 虚拟滚动缺渲染上下文时的兜底：按当前 state.messages 全量重建，避免孤儿 DOM 残留
eventBus.on(EVENTS.RESTORE_RERENDER_REQUESTED, () => {
    if (!elements.messagesArea) return;
    renderSessionMessages();
});
