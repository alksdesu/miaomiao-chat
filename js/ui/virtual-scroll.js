/**
 * 虚拟滚动模块
 * 用于超长会话（500+ 消息）的性能优化
 * 只渲染可见区域的消息，大幅降低 DOM 节点数量
 */

import { state } from '../core/state.js';
import { elements } from '../core/elements.js';
import { eventBus } from '../core/events.js';
import {
    createMessageElement,
    renderThinkingBlock,
    renderReplyWithSelector
} from '../messages/renderer.js';
import { renderStreamStatsFromData } from '../stream/stats.js';
import { lazyImageManager } from '../utils/lazy-image.js';
import {
    PartType,
    MediaKind,
    hasParts,
    getTextContent,
    getThinkingContent
} from '../messages/schema.js';
import { escapeHtml } from '../utils/helpers.js';
import { logger } from '../utils/logger.js';

// 虚拟滚动配置
const VIRTUAL_SCROLL_CONFIG = {
    enabled: true, // 默认启用虚拟滚动
    threshold: 50, // 消息数量阈值
    itemHeight: 150, // 预估每条消息高度（px）
    overscan: 8, // 上下额外渲染的消息数量（增加到8，减少闪烁）
    buffer: 15 // 缓冲区大小（增加到15，改善滚动体验）
};

// 虚拟滚动状态
const virtualScrollState = {
    isActive: false, // 是否正在使用虚拟滚动
    visibleRange: { start: 0, end: 50 }, // 可见范围
    scrollTop: 0, // 当前滚动位置
    containerHeight: 0, // 容器高度
    totalHeight: 0, // 总内容高度
    itemHeights: new Map(), // 实际测量的每条消息高度 Map<index, height>
    renderedMessages: new Set(), // 已渲染的消息索引
    prefixHeights: [], // 前缀和数组：prefixHeights[i] = 前 i 条消息的总高度
    messagePool: new Map() // DOM 对象池：缓存离开可见区域的消息 DOM（index -> element）
};

const observedMessageElements = new Set();
const pendingHeightRefreshIndexes = new Set();
let messageResizeObserver = null;
let viewportRefreshRafId = null;
let heightRefreshRafId = null;

/**
 * 计算智能阈值（考虑图片因素）
 * 含有图片的消息会降低阈值
 */
function calculateSmartThreshold(messages) {
    let imageCount = 0;
    let hasImage = false;

    // 统计图片数量
    for (const msg of messages) {
        if (hasParts(msg)) {
            // 新格式
            imageCount += msg.parts.filter(
                (p) => p.type === PartType.MEDIA && p.media === MediaKind.IMAGE
            ).length;
            // 旧 Gemini 格式
            imageCount += msg.parts.filter((p) => p.inlineData).length;
            if (!hasImage && imageCount > 0) hasImage = true;
        }
        if (msg.content && Array.isArray(msg.content)) {
            imageCount += msg.content.filter((p) => p.type === 'image_url').length;
            imageCount += msg.content.filter((p) => p.type === 'image').length;
            if (!hasImage && imageCount > 0) hasImage = true;
        }
    }

    // 根据图片密度调整阈值
    if (!hasImage) {
        // 纯文本消息：使用默认阈值
        return VIRTUAL_SCROLL_CONFIG.threshold;
    }

    const imageRatio = imageCount / messages.length;
    if (imageRatio > 0.3) {
        // 高图片密度（> 30%）：大幅降低阈值
        return Math.max(30, Math.floor(VIRTUAL_SCROLL_CONFIG.threshold * 0.3));
    } else if (imageRatio > 0.1) {
        // 中等图片密度（10-30%）：适度降低阈值
        return Math.max(50, Math.floor(VIRTUAL_SCROLL_CONFIG.threshold * 0.5));
    } else {
        // 低图片密度（< 10%）：轻微降低阈值
        return Math.max(40, Math.floor(VIRTUAL_SCROLL_CONFIG.threshold * 0.75));
    }
}

function getVirtualMessageIndex(messageEl) {
    const index = parseInt(messageEl?.dataset.messageIndex || '', 10);
    return Number.isNaN(index) ? -1 : index;
}

function syncMeasuredMessageHeight(index, rawHeight) {
    if (!Number.isInteger(index) || index < 0) {
        return false;
    }

    const nextHeight = Math.max(0, Math.ceil(rawHeight || 0));
    if (nextHeight === 0) {
        return false;
    }

    const hasMeasuredHeight = virtualScrollState.itemHeights.has(index);
    const previousHeight = hasMeasuredHeight
        ? virtualScrollState.itemHeights.get(index)
        : VIRTUAL_SCROLL_CONFIG.itemHeight;

    if (nextHeight === VIRTUAL_SCROLL_CONFIG.itemHeight) {
        if (!hasMeasuredHeight) {
            return false;
        }

        virtualScrollState.itemHeights.delete(index);
        return previousHeight !== VIRTUAL_SCROLL_CONFIG.itemHeight;
    }

    if (previousHeight === nextHeight) {
        return false;
    }

    virtualScrollState.itemHeights.set(index, nextHeight);
    return true;
}

function flushPendingMessageHeightRefresh() {
    heightRefreshRafId = null;

    if (
        !virtualScrollState.isActive ||
        !elements.messagesArea ||
        pendingHeightRefreshIndexes.size === 0
    ) {
        pendingHeightRefreshIndexes.clear();
        return;
    }

    let minChanged = Infinity;
    const indexes = Array.from(pendingHeightRefreshIndexes).sort((left, right) => left - right);
    pendingHeightRefreshIndexes.clear();

    indexes.forEach((index) => {
        const messageEl = elements.messagesArea.querySelector(
            `.message[data-message-index="${index}"]`
        );
        if (!messageEl) {
            return;
        }

        if (syncMeasuredMessageHeight(index, messageEl.offsetHeight) && index < minChanged) {
            minChanged = index;
        }
    });

    if (minChanged < Infinity) {
        updatePrefixHeightAt(minChanged);
        updateVisibleRange();
        renderVirtualMessages();
    }
}

function scheduleMessageHeightRefresh(index) {
    if (!virtualScrollState.isActive || !Number.isInteger(index) || index < 0) {
        return;
    }

    pendingHeightRefreshIndexes.add(index);
    if (heightRefreshRafId) {
        return;
    }

    heightRefreshRafId = requestAnimationFrame(() => {
        flushPendingMessageHeightRefresh();
    });
}

function ensureMessageResizeObserver() {
    const ResizeObserverCtor = globalThis.ResizeObserver;
    if (messageResizeObserver || typeof ResizeObserverCtor !== 'function') {
        return;
    }

    messageResizeObserver = new ResizeObserverCtor((entries) => {
        entries.forEach((entry) => {
            const index = getVirtualMessageIndex(entry.target);
            if (index >= 0) {
                scheduleMessageHeightRefresh(index);
            }
        });
    });
}

function observeRenderedMessage(messageEl) {
    if (!messageEl || observedMessageElements.has(messageEl)) {
        return;
    }

    ensureMessageResizeObserver();
    if (!messageResizeObserver) {
        return;
    }

    messageResizeObserver.observe(messageEl);
    observedMessageElements.add(messageEl);
}

function unobserveRenderedMessage(messageEl) {
    if (!messageEl || !messageResizeObserver || !observedMessageElements.has(messageEl)) {
        return;
    }

    messageResizeObserver.unobserve(messageEl);
    observedMessageElements.delete(messageEl);
}

/**
 * 初始化虚拟滚动
 * @param {boolean} force - 强制启用/禁用
 */
export function initVirtualScroll(force = null) {
    const messages = state.messages;

    // 计算智能阈值
    const smartThreshold = calculateSmartThreshold(messages);

    const shouldEnable = force !== null ? force : messages.length >= smartThreshold;

    if (shouldEnable && !virtualScrollState.isActive) {
        logger.debug(
            `[VirtualScroll] 启用虚拟滚动 (${messages.length} 条消息, 阈值: ${smartThreshold})`
        );
        enableVirtualScroll();
    } else if (!shouldEnable && virtualScrollState.isActive) {
        disableVirtualScroll();
    }
}

/**
 * 重建前缀和数组（O(n) 一次性构建）
 */
function rebuildPrefixHeights() {
    const messages = state.messages;
    const n = messages.length;
    const prefix = new Array(n + 1);
    prefix[0] = 0;
    for (let i = 0; i < n; i++) {
        prefix[i + 1] =
            prefix[i] + (virtualScrollState.itemHeights.get(i) || VIRTUAL_SCROLL_CONFIG.itemHeight);
    }
    virtualScrollState.prefixHeights = prefix;
    virtualScrollState.totalHeight = prefix[n];
}

/**
 * 单点更新前缀和（当某条消息高度变化时）
 */
function updatePrefixHeightAt(index) {
    const prefix = virtualScrollState.prefixHeights;
    if (!prefix || prefix.length === 0) {
        rebuildPrefixHeights();
        return;
    }
    const messages = state.messages;
    const n = messages.length;
    // 从 index 开始重新累加
    for (let i = index; i < n; i++) {
        prefix[i + 1] =
            prefix[i] + (virtualScrollState.itemHeights.get(i) || VIRTUAL_SCROLL_CONFIG.itemHeight);
    }
    virtualScrollState.totalHeight = prefix[n];
}

/**
 * 二分查找前缀和数组：找到第一个 prefixHeights[i] > target 的 i
 */
function binarySearchPrefix(target) {
    const prefix = virtualScrollState.prefixHeights;
    let lo = 0,
        hi = prefix.length - 1;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (prefix[mid + 1] <= target) {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    return lo;
}

const MESSAGE_POOL_MAX = 30;

/**
 * 启用虚拟滚动
 */
function enableVirtualScroll() {
    logger.debug('🚀 启用虚拟滚动模式');

    virtualScrollState.isActive = true;
    VIRTUAL_SCROLL_CONFIG.enabled = true;

    // 测量容器高度
    virtualScrollState.containerHeight = elements.messagesArea.clientHeight;

    // 构建前缀和数组
    rebuildPrefixHeights();

    // 监听尺寸变化，确保异步内容与窗口尺寸变化后高度缓存同步
    window.addEventListener('resize', scheduleVirtualViewportRefresh);
    document.addEventListener('fullscreenchange', scheduleVirtualViewportRefresh);

    // 绑定滚动事件
    elements.messagesArea.addEventListener('scroll', handleVirtualScroll);

    // 初始渲染
    updateVisibleRange();
    renderVirtualMessages();
}

function scheduleVirtualViewportRefresh() {
    if (!virtualScrollState.isActive || viewportRefreshRafId) {
        return;
    }

    viewportRefreshRafId = requestAnimationFrame(() => {
        viewportRefreshRafId = null;
        virtualScrollState.containerHeight = elements.messagesArea?.clientHeight || 0;
        updateVisibleRange();
        renderVirtualMessages();

        elements.messagesArea
            .querySelectorAll('.message[data-message-index]')
            .forEach((messageEl) => {
                scheduleMessageHeightRefresh(getVirtualMessageIndex(messageEl));
            });
    });
}

/**
 * 禁用虚拟滚动（恢复正常渲染）
 */
export function disableVirtualScroll() {
    if (!virtualScrollState.isActive) return; // 未激活时跳过

    logger.debug('📴 禁用虚拟滚动模式');

    virtualScrollState.isActive = false;
    VIRTUAL_SCROLL_CONFIG.enabled = false;

    // 解绑事件
    elements.messagesArea.removeEventListener('scroll', handleVirtualScroll);
    window.removeEventListener('resize', scheduleVirtualViewportRefresh);
    document.removeEventListener('fullscreenchange', scheduleVirtualViewportRefresh);

    if (viewportRefreshRafId) {
        cancelAnimationFrame(viewportRefreshRafId);
        viewportRefreshRafId = null;
    }
    if (heightRefreshRafId) {
        cancelAnimationFrame(heightRefreshRafId);
        heightRefreshRafId = null;
    }
    pendingHeightRefreshIndexes.clear();
    observedMessageElements.clear();
    messageResizeObserver?.disconnect();
    messageResizeObserver = null;

    // 清理状态
    virtualScrollState.renderedMessages.clear();
    virtualScrollState.itemHeights.clear();
    virtualScrollState.prefixHeights = [];
    virtualScrollState.messagePool.clear();
    virtualScrollState.scrollTop = 0;
}

/**
 * 处理虚拟滚动事件
 * 使用 requestAnimationFrame 节流
 */
let rafId = null;
function handleVirtualScroll() {
    if (rafId) return; // 避免重复调用

    rafId = requestAnimationFrame(() => {
        const scrollTop = elements.messagesArea.scrollTop;

        // 如果滚动变化不大，跳过
        if (Math.abs(scrollTop - virtualScrollState.scrollTop) < 10) {
            rafId = null;
            return;
        }

        virtualScrollState.scrollTop = scrollTop;
        updateVisibleRange();
        renderVirtualMessages();

        rafId = null;
    });
}

/**
 * 计算可见范围
 */
function updateVisibleRange() {
    const messages = state.messages;
    const totalMessages = messages.length;

    if (totalMessages === 0) {
        virtualScrollState.visibleRange = { start: 0, end: 0 };
        return;
    }

    const scrollTop = virtualScrollState.scrollTop;
    const containerHeight = virtualScrollState.containerHeight;

    // O(log n) 二分查找：找到可见起始和结束索引
    let start = binarySearchPrefix(scrollTop);
    let end = binarySearchPrefix(scrollTop + containerHeight) + 1;

    // 如果 end 没有超过 start（内容不足一屏），显示到最后
    if (end <= start) end = totalMessages;

    // 添加 overscan（上下各多渲染几条）
    start = Math.max(0, start - VIRTUAL_SCROLL_CONFIG.overscan);
    end = Math.min(totalMessages, end + VIRTUAL_SCROLL_CONFIG.overscan);

    virtualScrollState.visibleRange = { start, end };
}

/**
 * 渲染虚拟消息
 */
function renderVirtualMessages() {
    const messages = state.messages;
    const { start, end } = virtualScrollState.visibleRange;
    const prefix = virtualScrollState.prefixHeights;

    // O(1) spacer 计算（使用前缀和）
    const topHeight = prefix[start] || 0;
    const bottomHeight = (prefix[messages.length] || 0) - (prefix[end] || 0);

    // 更新占位符高度
    let topSpacer = elements.messagesArea.querySelector('.virtual-spacer-top');
    let bottomSpacer = elements.messagesArea.querySelector('.virtual-spacer-bottom');

    if (!topSpacer) {
        topSpacer = document.createElement('div');
        topSpacer.className = 'virtual-spacer-top';
        topSpacer.style.flexShrink = '0';
        elements.messagesArea.insertBefore(topSpacer, elements.messagesArea.firstChild);
    }

    if (!bottomSpacer) {
        bottomSpacer = document.createElement('div');
        bottomSpacer.className = 'virtual-spacer-bottom';
        bottomSpacer.style.flexShrink = '0';
        elements.messagesArea.appendChild(bottomSpacer);
    }

    topSpacer.style.height = `${topHeight}px`;
    bottomSpacer.style.height = `${bottomHeight}px`;

    // 移除不在可见范围内的消息 → 缓存到对象池
    const existingMessages = Array.from(elements.messagesArea.querySelectorAll('.message'));
    existingMessages.forEach((msgEl) => {
        const index = parseInt(msgEl.dataset.messageIndex);
        if (index < start || index >= end) {
            unobserveRenderedMessage(msgEl);
            msgEl.remove();
            virtualScrollState.renderedMessages.delete(index);
            // 放入对象池（限制大小）
            if (virtualScrollState.messagePool.size < MESSAGE_POOL_MAX) {
                virtualScrollState.messagePool.set(index, msgEl);
            }
        }
    });

    // 对象池超出上限时清理最旧的
    if (virtualScrollState.messagePool.size >= MESSAGE_POOL_MAX) {
        const keys = Array.from(virtualScrollState.messagePool.keys());
        const toRemove = keys.slice(0, keys.length - MESSAGE_POOL_MAX + 10);
        toRemove.forEach((k) => virtualScrollState.messagePool.delete(k));
    }

    // 渲染可见范围内的消息
    const fragment = document.createDocumentFragment();

    for (let i = start; i < end; i++) {
        if (virtualScrollState.renderedMessages.has(i)) continue;

        const msg = messages[i];
        if (!msg) continue;

        // 优先从对象池复用
        let messageEl = virtualScrollState.messagePool.get(i);
        if (messageEl) {
            virtualScrollState.messagePool.delete(i);
        } else {
            messageEl = createVirtualMessageElement(msg, i);
        }

        fragment.appendChild(messageEl);
        virtualScrollState.renderedMessages.add(i);
    }

    // 批量测量新消息高度，一次性更新前缀和（避免多次 O(n) 重建）
    const unmeasuredEls = [];
    for (let i = start; i < end; i++) {
        if (!virtualScrollState.itemHeights.has(i)) {
            const el =
                fragment.querySelector?.(`.message[data-message-index="${i}"]`) ||
                elements.messagesArea.querySelector(`.message[data-message-index="${i}"]`);
            if (el) unmeasuredEls.push({ index: i, el });
        }
    }

    // 插入到正确位置（在 bottom spacer 之前）
    if (fragment.childNodes.length > 0) {
        elements.messagesArea.insertBefore(fragment, bottomSpacer);
    }
    elements.messagesArea
        .querySelectorAll('.message[data-message-index]')
        .forEach(observeRenderedMessage);

    // 批量测量高度 + 一次性更新前缀和（requestIdleCallback 延迟，避免强制 reflow）
    if (unmeasuredEls.length > 0) {
        requestIdleCallback(() => {
            let minChanged = Infinity;
            for (const { index, el } of unmeasuredEls) {
                // 需要重新查询 DOM（fragment 已插入后引用可能变化）
                const domEl = el.isConnected
                    ? el
                    : elements.messagesArea.querySelector(
                          `.message[data-message-index="${index}"]`
                      );
                if (!domEl) continue;
                if (syncMeasuredMessageHeight(index, domEl.offsetHeight) && index < minChanged) {
                    minChanged = index;
                }
            }
            // 只从最小变化索引更新一次前缀和
            if (minChanged < Infinity) {
                updatePrefixHeightAt(minChanged);
                updateVisibleRange();
                renderVirtualMessages();
            }
        });
    }

    // 观察新插入的懒加载图片
    if (fragment.childNodes.length > 0 || unmeasuredEls.length > 0) {
        requestIdleCallback(
            () => {
                const lazyImages = elements.messagesArea.querySelectorAll(
                    '.lazy-image:not(.observed)'
                );
                lazyImages.forEach((img) => {
                    lazyImageManager.observe(img);
                    img.classList.add('observed');
                });
            },
            { timeout: 500 }
        );
    }
}

/**
 * 创建虚拟消息元素
 * @param {Object} msg - 消息对象
 * @param {number} index - 消息索引
 * @returns {HTMLElement} 消息元素
 */
function createVirtualMessageElement(msg, index) {
    let text, images;
    const role = msg.role;
    const messageId = msg.id;

    // 新格式：从 parts 读取
    if (hasParts(msg)) {
        text = getTextContent(msg);
        images = msg.parts
            .filter((p) => p.type === PartType.MEDIA && p.media === MediaKind.IMAGE)
            .map((p) => ({
                name: '已上传图片',
                type: p.mime || 'image/*',
                category: 'image',
                data: p.url
            }));
        // 文件附件
        const fileAttachments = msg.parts
            .filter((p) => p.type === PartType.FILE)
            .map((p) => ({
                name: p.name || '已上传文件',
                type: p.mime || 'application/octet-stream',
                category: p.mime === 'application/pdf' ? 'pdf' : 'text',
                data: p.url
            }));
        images = [...images, ...fileAttachments];
    } else {
        // 旧格式回退：用 schema.js 工具函数读取文本
        text = getTextContent(msg);
        const content = msg.content;
        if (Array.isArray(content)) {
            images = content.filter((p) => p.type === 'image_url');
        } else {
            images = [];
        }
    }

    const messageEl = createMessageElement(
        role,
        text,
        images.length > 0 ? images : null,
        messageId
    );

    messageEl.dataset.messageIndex = index;

    // 恢复思维链（如果有）
    const openaiMsg = state.messages[index];
    // getThinkingContent 内部已处理新/旧格式回退
    const thinkingText = getThinkingContent(msg);
    if (role === 'assistant' && thinkingText) {
        try {
            const contentDiv = messageEl.querySelector('.message-content');
            if (contentDiv) {
                // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
                contentDiv.innerHTML = renderThinkingBlock(thinkingText) + contentDiv.innerHTML;
            }
        } catch (e) {
            logger.error('[VirtualScroll] 思维链恢复失败:', e);
        }
    }

    // 恢复助手消息的媒体内容（图片/视频/音频）
    if (role === 'assistant' && hasParts(msg)) {
        const mediaParts = msg.parts.filter((p) => p.type === PartType.MEDIA);
        if (mediaParts.length > 0) {
            const contentDiv = messageEl.querySelector('.message-content');
            if (contentDiv) {
                let mediaHtml = '';
                for (const p of mediaParts) {
                    const safeUrl = escapeHtml(p.url);
                    if (p.media === MediaKind.VIDEO) {
                        mediaHtml += `<div class="image-wrapper video-wrapper"><video src="${safeUrl}" controls playsinline muted preload="metadata"></video></div>`;
                    } else if (p.media === MediaKind.AUDIO) {
                        mediaHtml += `<div class="audio-wrapper"><audio src="${safeUrl}" controls preload="metadata"></audio></div>`;
                    } else {
                        mediaHtml += `<div class="image-wrapper"><img src="${safeUrl}" alt="Generated image" style="cursor:pointer;"></div>`;
                    }
                }
                contentDiv.insertAdjacentHTML('beforeend', mediaHtml);
            }
        }
    }

    // 恢复流统计（如果有）
    const statsData = openaiMsg?.meta?.stats || openaiMsg?.streamStats;
    if (statsData) {
        requestIdleCallback(() => {
            const wrapper = messageEl.querySelector('.message-content-wrapper');
            if (wrapper) {
                wrapper.insertAdjacentHTML('beforeend', renderStreamStatsFromData(statsData));
            }
        });
    }

    // 恢复多回复（如果有）
    const repliesAll = openaiMsg?.replies?.all;
    const repliesSelected = openaiMsg?.replies?.selected ?? openaiMsg?.selectedReplyIndex ?? 0;
    if (repliesAll && repliesAll.length > 1) {
        requestIdleCallback(() => {
            renderReplyWithSelector(repliesAll, repliesSelected, messageEl);
        });
    }

    return messageEl;
}

/**
 * 滚动到指定消息索引
 * @param {number} index - 消息索引
 * @param {string} behavior - 滚动行为 ('auto' | 'smooth' | 'instant')
 */
export function scrollToMessage(index, behavior = 'smooth') {
    if (!Number.isInteger(index) || index < 0 || index >= state.messages.length) {
        return false;
    }

    if (!virtualScrollState.isActive) {
        const messageEl = elements.messagesArea.querySelector(`[data-message-index="${index}"]`);
        if (messageEl) {
            messageEl.scrollIntoView({ behavior, block: 'center' });
            return true;
        }

        return false;
    }

    if (!virtualScrollState.prefixHeights.length) {
        rebuildPrefixHeights();
    }

    const targetScrollTop = virtualScrollState.prefixHeights[index] || 0;

    elements.messagesArea.scrollTo({
        top: targetScrollTop,
        behavior
    });

    return true;
}

/**
 * 滚动到底部
 * @param {string} behavior - 滚动行为
 */
export function scrollToBottom(behavior = 'smooth') {
    const messages = state.messages;
    scrollToMessage(messages.length - 1, behavior);
}

function messageContainsMermaid(messageEl) {
    return messageEl?.querySelector('.mermaid-block') != null;
}

function collectMermaidAffectedMessageIndexes() {
    const indexes = new Set();

    // 仅处理对象池中真正包含 Mermaid 的条目，避免主题切换时整池失效
    virtualScrollState.messagePool.forEach((messageEl, index) => {
        if (messageContainsMermaid(messageEl)) {
            indexes.add(index);
        }
    });

    const mermaidBlocks = elements.messagesArea?.querySelectorAll('.message .mermaid-block') || [];

    mermaidBlocks.forEach((block) => {
        const messageEl = block.closest('.message');
        const index = parseInt(messageEl?.dataset.messageIndex || '', 10);
        if (!Number.isNaN(index)) {
            indexes.add(index);
        }
    });

    return indexes;
}

function handleMermaidLayoutUpdated(payload) {
    if (!virtualScrollState.isActive) {
        return;
    }

    const messageEl = payload?.container?.closest('.message[data-message-index]');
    const index = getVirtualMessageIndex(messageEl);
    scheduleMessageHeightRefresh(index);
}

function invalidateMermaidVirtualCache() {
    if (!virtualScrollState.isActive || !elements.messagesArea) {
        return;
    }

    const affectedIndexes = collectMermaidAffectedMessageIndexes();
    if (affectedIndexes.size === 0) {
        return;
    }

    affectedIndexes.forEach((index) => {
        virtualScrollState.messagePool.delete(index);
        virtualScrollState.itemHeights.delete(index);
    });

    virtualScrollState.containerHeight = elements.messagesArea.clientHeight;
    rebuildPrefixHeights();
    updateVisibleRange();
    renderVirtualMessages();
}

/**
 * 获取虚拟滚动统计信息
 */
export function getVirtualScrollStats() {
    const messages = state.messages;

    return {
        isActive: virtualScrollState.isActive,
        totalMessages: messages.length,
        renderedMessages: virtualScrollState.renderedMessages.size,
        visibleRange: virtualScrollState.visibleRange,
        measuredHeights: virtualScrollState.itemHeights.size,
        estimatedTotalHeight: messages.length * VIRTUAL_SCROLL_CONFIG.itemHeight
    };
}

// restore.js 通过事件解耦，避免 messages 层直接导入 UI 层
eventBus.on('restore:disable-virtual-scroll', () => disableVirtualScroll());
eventBus.on('restore:init-virtual-scroll', () => initVirtualScroll());
eventBus.on('mermaid:layout-updated', handleMermaidLayoutUpdated);
eventBus.on('ui:theme-applied', invalidateMermaidVirtualCache);
