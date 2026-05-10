/**
 * 通知提示系统
 * 显示临时的成功/错误消息，支持堆叠和自定义持续时间
 */

import { eventBus } from '../core/events.js';

const activeNotifications = [];
const MAX_NOTIFICATIONS = 5;
const NOTIFICATION_SPACING = 12;
let repositionFrameId = 0;

/**
 * 立即计算所有活跃通知的位置
 */
function applyNotificationPositions() {
    let offset = 0;
    activeNotifications.forEach((notification) => {
        notification.style.setProperty('--notification-offset', `${offset}px`);
        offset += notification.offsetHeight + NOTIFICATION_SPACING;
    });
}

/**
 * 重新计算所有活跃通知的位置
 * @param {{ immediate?: boolean }} options - 是否立即执行重排
 */
function repositionNotifications(options = {}) {
    if (repositionFrameId) {
        cancelAnimationFrame(repositionFrameId);
        repositionFrameId = 0;
    }

    if (options.immediate) {
        applyNotificationPositions();
        return;
    }

    repositionFrameId = requestAnimationFrame(() => {
        repositionFrameId = 0;
        applyNotificationPositions();
    });
}

/**
 * 显示通知消息
 * @param {string} message - 通知内容
 * @param {string} type - 通知类型 ('info' | 'error' | 'success' | 'warning')
 * @param {number} duration - 显示持续时间（毫秒）
 */
export function showNotification(message, type = 'info', duration = 3000) {
    // 限制最大通知数量
    if (activeNotifications.length >= MAX_NOTIFICATIONS) {
        const oldest = activeNotifications.shift();
        if (oldest && oldest.parentNode) {
            oldest.remove();
            repositionNotifications();
        }
    }

    const notification = document.createElement('div');

    const typeClass =
        type === 'error'
            ? 'notification-error'
            : type === 'success'
              ? 'notification-success'
              : type === 'warning'
                ? 'notification-warning'
                : '';
    notification.className = `notification${typeClass ? ' ' + typeClass : ''}`;
    notification.setAttribute('role', 'alert');
    notification.setAttribute('aria-live', type === 'error' ? 'assertive' : 'polite');

    const messageSpan = document.createElement('span');
    messageSpan.textContent = message;
    notification.appendChild(messageSpan);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'notification-close';
    // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
    closeBtn.innerHTML = '×';
    closeBtn.setAttribute('aria-label', '关闭通知');

    const removeNotification = () => {
        if (!notification.parentNode) return;
        notification.style.animation = 'slideOut 0.3s ease-out';
        setTimeout(() => {
            notification.remove();
            const idx = activeNotifications.indexOf(notification);
            if (idx > -1) {
                activeNotifications.splice(idx, 1);
                repositionNotifications();
            }
        }, 300);
    };

    closeBtn.onclick = removeNotification;
    notification.appendChild(closeBtn);

    activeNotifications.push(notification);
    document.body.appendChild(notification);
    repositionNotifications({ immediate: true });

    setTimeout(removeNotification, duration);
}

// ========== 事件监听 ==========

eventBus.on('ui:notification', ({ message, type, duration }) => {
    showNotification(message, type || 'info', duration || 3000);
});
