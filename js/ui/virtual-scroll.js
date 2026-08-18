import { state } from '../core/state.js';
import { elements } from '../core/elements.js';
import { eventBus } from '../core/events.js';
import { EVENTS } from '../core/events-registry.js';
import { PartType, MediaKind } from '../messages/schema.js';
import { logger } from '../utils/logger.js';
import { longChatPerformance } from '../utils/long-chat-performance.js';
import { lazyImageManager } from '../utils/lazy-image.js';
import { MessageVirtualizer } from './message-virtualizer.js';

const VIRTUAL_SCROLL_CONFIG = {
    threshold: 50,
    activeClass: 'virtual-scroll-active',
    estimateHeight: 160,
    overscan: 1200
};

let isActive = false;
let strategy = 'none';
let activeVirtualizer = null;
let activeOptions = null;
let pendingMessageRefresh = false;

function getMessagesArea() {
    return elements.messagesArea || elements.chatWindow || null;
}

function calculateSmartThreshold(messages) {
    if (!Array.isArray(messages) || messages.length === 0) {
        return VIRTUAL_SCROLL_CONFIG.threshold;
    }
    let imageCount = 0;
    for (const msg of messages) {
        if (Array.isArray(msg.parts)) {
            imageCount += msg.parts.filter(
                (part) => part.type === PartType.MEDIA && part.media === MediaKind.IMAGE
            ).length;
        }
    }

    if (imageCount === 0) return VIRTUAL_SCROLL_CONFIG.threshold;
    const imageRatio = imageCount / messages.length;
    if (imageRatio > 0.3) return Math.max(15, Math.floor(VIRTUAL_SCROLL_CONFIG.threshold * 0.3));
    if (imageRatio > 0.1) return Math.max(25, Math.floor(VIRTUAL_SCROLL_CONFIG.threshold * 0.5));
    return Math.max(40, Math.floor(VIRTUAL_SCROLL_CONFIG.threshold * 0.75));
}

export function initVirtualScroll(force = null, options = null) {
    const messagesArea = getMessagesArea();
    if (!messagesArea) return false;

    const messages = options?.messages || state.messages || [];
    const threshold = calculateSmartThreshold(messages);
    const renderingMode = state.longChatRenderingMode || 'auto';
    // 空列表一律不虚拟化：虚拟化器 init 会 replaceChildren 成 spacer，把欢迎消息冲掉
    const shouldEnable =
        messages.length > 0 &&
        (force !== null
            ? force
            : renderingMode === 'virtual' ||
              (renderingMode === 'auto' && messages.length >= threshold));
    longChatPerformance.setGauge('virtualScrollThreshold', threshold);

    disableVirtualScroll();
    activeOptions = options;

    if (shouldEnable && typeof options?.renderItem === 'function') {
        try {
            activeVirtualizer = new MessageVirtualizer({
                root: messagesArea,
                renderItem: options.renderItem,
                onUnmount: options.onUnmount,
                estimateHeight: options.estimateHeight || VIRTUAL_SCROLL_CONFIG.estimateHeight,
                overscan: options.overscan || VIRTUAL_SCROLL_CONFIG.overscan
            });
            activeVirtualizer.init(messages, {
                initialIndex: options.initialIndex,
                estimates: options.estimates
            });
            messagesArea.classList.add(VIRTUAL_SCROLL_CONFIG.activeClass);
            isActive = true;
            strategy = 'variable-height';
            options.handled = true;
            longChatPerformance.setGauge('virtualScrollActive', 1);
            logger.debug(`[VirtualScroll] 可变高度虚拟列表已启用（${messages.length} 条）`);
            return true;
        } catch (error) {
            logger.error('[VirtualScroll] 初始化失败，回退完整渲染:', error);
            activeVirtualizer?.destroy();
            activeVirtualizer = null;
        }
    }

    options?.renderAll?.();
    if (options) options.handled = true;
    strategy = messages.length > 0 ? 'content-visibility-fallback' : 'none';
    if (messages.length > 0) {
        messagesArea.classList.add(VIRTUAL_SCROLL_CONFIG.activeClass);
    }
    isActive = false;
    longChatPerformance.setGauge('virtualScrollActive', 0);
    return false;
}

export function disableVirtualScroll() {
    activeVirtualizer?.destroy();
    activeVirtualizer = null;
    activeOptions = null;
    pendingMessageRefresh = false;
    getMessagesArea()?.classList.remove(VIRTUAL_SCROLL_CONFIG.activeClass);
    isActive = false;
    strategy = 'none';
    longChatPerformance.setGauge('virtualScrollActive', 0);
}

export function refreshVirtualScroll({ focusIndex = null } = {}) {
    // 消息 DOM 的移除全靠这里重建，静默返回会让删除/重新生成只改数据留下孤儿 DOM，
    // 缺渲染上下文时请求上游全量重渲染兜底
    if (!activeOptions) {
        eventBus.emit(EVENTS.RESTORE_RERENDER_REQUESTED, { focusIndex });
        return false;
    }
    const messages = state.messages || [];
    if (activeVirtualizer) {
        const firstMounted = activeVirtualizer.getElement(activeVirtualizer.range.start);
        const anchorId = firstMounted?.dataset.messageId;
        const anchorIndex = anchorId ? state.messageStore?.findIndexById(anchorId) : -1;
        const initialIndex = Number.isInteger(focusIndex)
            ? focusIndex
            : anchorIndex >= 0
              ? anchorIndex
              : Math.max(0, messages.length - 1);
        activeOptions.messages = messages;
        activeVirtualizer.init(messages, {
            initialIndex,
            estimates: activeOptions.getEstimates?.()
        });
        return true;
    }

    activeOptions.beforeRerender?.();
    activeOptions.renderAll?.();
    return true;
}

export function ensureMessageMounted(index) {
    if (activeVirtualizer) return activeVirtualizer.ensureMounted(index);
    return getMessagesArea()?.querySelector(`[data-message-index="${index}"]`) || null;
}

export function getMountedMessageElement(index) {
    if (activeVirtualizer) return activeVirtualizer.getElement(index);
    return getMessagesArea()?.querySelector(`[data-message-index="${index}"]`) || null;
}

export function isVirtualScrollManaged() {
    return activeOptions !== null;
}

export function scrollToMessage(index, behavior = 'smooth') {
    if (!Number.isInteger(index) || index < 0 || index >= state.messages.length) return false;
    if (activeVirtualizer) {
        const scrolled = activeVirtualizer.scrollToIndex(index, behavior, 'center');
        if (scrolled) {
            const stats = activeVirtualizer.getStats();
            lazyImageManager.unloadOutsideRange(
                Math.max(0, stats.visibleRange.start - 5),
                Math.min(state.messages.length - 1, stats.visibleRange.end + 5),
                getMessagesArea()
            );
        }
        return scrolled;
    }
    const messageEl = getMountedMessageElement(index);
    if (!messageEl) return false;
    messageEl.scrollIntoView({ behavior, block: 'center' });
    return true;
}

export function scrollToBottom(behavior = 'smooth') {
    return scrollToMessage(state.messages.length - 1, behavior);
}

export function getVirtualScrollStats() {
    const virtualStats = activeVirtualizer?.getStats() || {
        renderedMessages: getMessagesArea()?.querySelectorAll?.('.message').length || 0,
        visibleRange: { start: 0, end: state.messages.length - 1 },
        measuredHeights: 0,
        estimatedTotalHeight: 0
    };
    return {
        isActive,
        strategy,
        totalMessages: state.messages.length,
        ...virtualStats
    };
}

eventBus.on(EVENTS.RESTORE_DISABLE_VIRTUAL_SCROLL, () => disableVirtualScroll());
eventBus.on(EVENTS.RESTORE_INIT_VIRTUAL_SCROLL, (options) => initVirtualScroll(null, options));
eventBus.on(EVENTS.LONG_CHAT_RENDERING_MODE_CHANGED, () => {
    if (!activeOptions) return;
    const options = activeOptions;
    options.beforeRerender?.();
    initVirtualScroll(null, options);
});
eventBus.on(EVENTS.MESSAGES_CHANGED, ({ action }) => {
    if (state.isLoading && action !== 'user_sent') {
        pendingMessageRefresh = true;
        return;
    }
    const focusIndex =
        action === 'retry' || action === 'removed_after' ? state.messages.length - 1 : null;
    refreshVirtualScroll({ focusIndex });
});
eventBus.on('state:isLoading', ({ newValue }) => {
    if (newValue || !pendingMessageRefresh) return;
    pendingMessageRefresh = false;
    refreshVirtualScroll({ focusIndex: state.messages.length - 1 });
});
