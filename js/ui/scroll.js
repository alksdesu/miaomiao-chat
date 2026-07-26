/**
 * 滚动控制模块
 * 处理消息区域的滚动行为和滚动监听
 */

import { elements } from '../core/elements.js';
import { eventBus } from '../core/events.js';
import { logger } from '../utils/logger.js';

const NEAR_BOTTOM_THRESHOLD_PX = 150;

let scrollTimeout = null;

/**
 * 滚动到底部
 */
export function scrollToBottom() {
    if (!elements.messagesArea) return;
    elements.messagesArea.scrollTo({
        top: elements.messagesArea.scrollHeight,
        behavior: 'smooth'
    });
}

/**
 * 更新滚动到底部按钮的显示状态
 */
function updateScrollButtonVisibility() {
    if (!elements.messagesArea || !elements.scrollToBottomBtn) return;

    const scrollTop = elements.messagesArea.scrollTop;
    const scrollHeight = elements.messagesArea.scrollHeight;
    const clientHeight = elements.messagesArea.clientHeight;
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight;

    if (distanceFromBottom > NEAR_BOTTOM_THRESHOLD_PX) {
        elements.scrollToBottomBtn.classList.add('visible');
    } else {
        elements.scrollToBottomBtn.classList.remove('visible');
    }
}

/**
 * 视口收缩（软键盘弹出）时保持贴底
 * 收缩前贴底的判定：当前距底减去收缩量即收缩前距底（layout 视口未变时该估计偏松，同样应补偿）
 */
function initViewportShrinkCompensation() {
    const visualViewport = window.visualViewport;
    let lastHeight = visualViewport ? visualViewport.height : window.innerHeight;

    const onViewportResize = () => {
        const height = visualViewport ? visualViewport.height : window.innerHeight;
        const shrunkBy = lastHeight - height;
        lastHeight = height;
        if (shrunkBy <= 0 || !elements.messagesArea) return;

        const area = elements.messagesArea;
        const distanceFromBottom = area.scrollHeight - area.scrollTop - area.clientHeight;
        if (distanceFromBottom - shrunkBy < NEAR_BOTTOM_THRESHOLD_PX) {
            scrollToBottom();
        }
    };

    if (visualViewport) {
        visualViewport.addEventListener('resize', onViewportResize);
    } else {
        window.addEventListener('resize', onViewportResize);
    }
}

/**
 * 初始化滚动控制
 */
export function initScrollControl() {
    // 监听滚动请求事件
    eventBus.on('ui:scroll-to-bottom', () => {
        scrollToBottom();
    });

    // 监听消息区域滚动（节流）
    elements.messagesArea?.addEventListener('scroll', () => {
        if (scrollTimeout) return;
        scrollTimeout = setTimeout(() => {
            updateScrollButtonVisibility();
            scrollTimeout = null;
        }, 100);
    });

    // 绑定滚动到底部按钮
    elements.scrollToBottomBtn?.addEventListener('click', scrollToBottom);

    // 初始检查
    updateScrollButtonVisibility();

    initViewportShrinkCompensation();

    // 将函数暴露到全局作用域供 HTML onclick 使用
    window.scrollToBottom = scrollToBottom;

    logger.debug('Scroll control initialized');
}
