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

    // info 类型显式挂 .notification-info 让 CSS .notification-info 生效；
    // 之前 info 走 fallback 空字符串 → 只挂 .notification 默认背景与 success 同色，
    // 用户看到 storage:remote-updated 等 info 提示视觉上像成功通知容易混淆
    const typeClass =
        type === 'error'
            ? 'notification-error'
            : type === 'success'
              ? 'notification-success'
              : type === 'warning'
                ? 'notification-warning'
                : 'notification-info';
    notification.className = `notification ${typeClass}`;
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

    // duration <= 0 或 Infinity 表示永久显示直到用户手动关闭（IDB 版本变更等关键警告需要）
    if (Number.isFinite(duration) && duration > 0) {
        setTimeout(removeNotification, duration);
    }
}

// ========== 事件监听 ==========

eventBus.on('ui:notification', ({ message, type, duration }) => {
    // nullish coalescing 让 duration=0 透传到 showNotification 实现永久显示语义
    // 之前 duration || 3000 会把 0 兜底成 3000 让永久警告 3 秒自动消失
    showNotification(message, type || 'info', duration ?? 3000);
});
