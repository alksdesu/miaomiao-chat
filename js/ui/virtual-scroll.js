/**
 * 长会话渲染优化模块
 *
 * 使用浏览器原生 content-visibility:auto + contain-intrinsic-size，
 * 让屏幕外的消息节点跳过 layout/paint，但 DOM 仍真实挂载，
 * 因此 scrollIntoView 等 API 永远可用，不会出现"末尾消息渲染不出"自锁。
 *
 * 启用条件：messages.length 达到智能阈值（含图片时降低阈值）。
 */

import { state } from '../core/state.js';
import { elements } from '../core/elements.js';
import { eventBus } from '../core/events.js';
import { PartType, MediaKind, hasParts } from '../messages/schema.js';
import { logger } from '../utils/logger.js';

const VIRTUAL_SCROLL_CONFIG = {
    threshold: 50,
    activeClass: 'virtual-scroll-active'
};

let isActive = false;

/**
 * 智能阈值：图片密度越高，越早启用 content-visibility 优化
 */
function calculateSmartThreshold(messages) {
    let imageCount = 0;

    for (const msg of messages) {
        if (hasParts(msg)) {
            imageCount += msg.parts.filter(
                (p) => p.type === PartType.MEDIA && p.media === MediaKind.IMAGE
            ).length;
            imageCount += msg.parts.filter((p) => p.inlineData).length;
        }
        if (Array.isArray(msg.content)) {
            imageCount += msg.content.filter(
                (p) => p.type === 'image_url' || p.type === 'image'
            ).length;
        }
    }

    if (imageCount === 0) {
        return VIRTUAL_SCROLL_CONFIG.threshold;
    }

    const imageRatio = imageCount / messages.length;
    if (imageRatio > 0.3) {
        return Math.max(30, Math.floor(VIRTUAL_SCROLL_CONFIG.threshold * 0.3));
    }
    if (imageRatio > 0.1) {
        return Math.max(50, Math.floor(VIRTUAL_SCROLL_CONFIG.threshold * 0.5));
    }
    return Math.max(40, Math.floor(VIRTUAL_SCROLL_CONFIG.threshold * 0.75));
}

/**
 * 初始化（决定是否启用 content-visibility 优化）
 * @param {boolean|null} force - 强制启用/禁用；null 时按阈值判断
 */
export function initVirtualScroll(force = null) {
    if (!elements.messagesArea) {
        return;
    }

    const messages = state.messages;
    const threshold = calculateSmartThreshold(messages);
    const shouldEnable = force !== null ? force : messages.length >= threshold;

    if (shouldEnable && !isActive) {
        elements.messagesArea.classList.add(VIRTUAL_SCROLL_CONFIG.activeClass);
        isActive = true;
        logger.debug(
            `[VirtualScroll] content-visibility 优化已启用（${messages.length} 条 / 阈值 ${threshold}）`
        );
    } else if (!shouldEnable && isActive) {
        disableVirtualScroll();
    }
}

/**
 * 关闭 content-visibility 优化（切换会话清理时使用）
 */
export function disableVirtualScroll() {
    if (!isActive) {
        return;
    }
    elements.messagesArea?.classList.remove(VIRTUAL_SCROLL_CONFIG.activeClass);
    isActive = false;
    logger.debug('[VirtualScroll] content-visibility 优化已关闭');
}

/**
 * 滚动到指定消息索引
 * @param {number} index - 消息索引（对应 .message[data-message-index]）
 * @param {ScrollBehavior} behavior - 滚动行为
 */
export function scrollToMessage(index, behavior = 'smooth') {
    if (!Number.isInteger(index) || index < 0 || index >= state.messages.length) {
        return false;
    }
    const messageEl = elements.messagesArea?.querySelector(`[data-message-index="${index}"]`);
    if (!messageEl) {
        return false;
    }
    messageEl.scrollIntoView({ behavior, block: 'center' });
    return true;
}

/**
 * 滚动到底部（保留以维持现有调用方语义）
 */
export function scrollToBottom(behavior = 'smooth') {
    return scrollToMessage(state.messages.length - 1, behavior);
}

/**
 * 调试用统计（保留导出签名，避免破坏潜在调用方）
 */
export function getVirtualScrollStats() {
    return {
        isActive,
        strategy: 'content-visibility',
        totalMessages: state.messages.length
    };
}

// restore.js 通过事件解耦，避免 messages 层直接 import UI 层
eventBus.on('restore:disable-virtual-scroll', () => disableVirtualScroll());
eventBus.on('restore:init-virtual-scroll', () => initVirtualScroll());
