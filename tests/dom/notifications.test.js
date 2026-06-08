// @vitest-environment jsdom
/**
 * notifications.js jsdom 测试
 * 测试通知系统的 DOM 操作和堆叠逻辑
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// mock eventBus（模块顶层注册了监听器）
vi.mock('../../js/core/events.js', () => {
    const handlers = new Map();
    return {
        eventBus: {
            on: vi.fn((event, cb) => {
                if (!handlers.has(event)) handlers.set(event, new Set());
                handlers.get(event).add(cb);
                return () => handlers.get(event)?.delete(cb);
            }),
            emit: vi.fn((event, data) => {
                handlers.get(event)?.forEach((cb) => cb(data));
            }),
            off: vi.fn()
        }
    };
});

import { showNotification } from '../../js/ui/notifications.js';
import { eventBus } from '../../js/core/events.js';

describe('notifications (jsdom)', () => {
    beforeEach(() => {
        // 清理 body 中的通知
        document.body.innerHTML = '';
        vi.useFakeTimers();
        // jsdom 不支持 requestAnimationFrame，mock 成同步
        vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
            cb(performance.now());
            return 1;
        });
        vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    // ========== DOM 元素创建 ==========

    it('创建通知 DOM 元素并添加到 body', () => {
        showNotification('hello');
        const notifications = document.querySelectorAll('.notification');
        expect(notifications.length).toBe(1);
    });

    it('通知包含消息文本', () => {
        showNotification('测试消息');
        const notification = document.querySelector('.notification');
        const span = notification.querySelector('span');
        expect(span.textContent).toBe('测试消息');
    });

    it('通知包含关闭按钮', () => {
        showNotification('msg');
        const closeBtn = document.querySelector('.notification-close');
        expect(closeBtn).not.toBeNull();
        expect(closeBtn.getAttribute('aria-label')).toBe('关闭通知');
    });

    it('通知设置了 role=alert', () => {
        showNotification('msg');
        const notification = document.querySelector('.notification');
        expect(notification.getAttribute('role')).toBe('alert');
    });

    // ========== 类型样式 ==========

    it('error 类型添加 notification-error 类', () => {
        showNotification('err', 'error');
        const notification = document.querySelector('.notification');
        expect(notification.classList.contains('notification-error')).toBe(true);
    });

    it('success 类型添加 notification-success 类', () => {
        showNotification('ok', 'success');
        const notification = document.querySelector('.notification');
        expect(notification.classList.contains('notification-success')).toBe(true);
    });

    it('warning 类型添加 notification-warning 类', () => {
        showNotification('warn', 'warning');
        const notification = document.querySelector('.notification');
        expect(notification.classList.contains('notification-warning')).toBe(true);
    });

    it('info 类型添加 notification-info 类', () => {
        showNotification('info msg', 'info');
        const notification = document.querySelector('.notification');
        expect(notification.classList.contains('notification-info')).toBe(true);
    });

    // ========== aria-live ==========

    it('error 类型 aria-live=assertive', () => {
        showNotification('err', 'error');
        const notification = document.querySelector('.notification');
        expect(notification.getAttribute('aria-live')).toBe('assertive');
    });

    it('非 error 类型 aria-live=polite', () => {
        showNotification('info', 'info');
        const notification = document.querySelector('.notification');
        expect(notification.getAttribute('aria-live')).toBe('polite');
    });

    // ========== 多通知堆叠 ==========

    it('多个通知并存', () => {
        showNotification('msg1');
        showNotification('msg2');
        showNotification('msg3');
        const notifications = document.querySelectorAll('.notification');
        expect(notifications.length).toBe(3);
    });

    it('超过 5 个通知时移除最早的', () => {
        for (let i = 0; i < 6; i++) {
            showNotification(`msg${i}`);
        }
        const notifications = document.querySelectorAll('.notification');
        expect(notifications.length).toBe(5);
        // 第一个应该被移除，剩下 msg1-msg5
        const texts = [...notifications].map((n) => n.querySelector('span').textContent);
        expect(texts).not.toContain('msg0');
        expect(texts).toContain('msg5');
    });

    // ========== 自动消失 ==========

    it('通知在指定时间后自动消失', () => {
        showNotification('auto-remove', 'info', 1000);
        expect(document.querySelectorAll('.notification').length).toBe(1);

        // 触发 setTimeout（自动消失）
        vi.advanceTimersByTime(1000);
        // 触发 slideOut 动画后的 setTimeout
        vi.advanceTimersByTime(300);

        expect(document.querySelectorAll('.notification').length).toBe(0);
    });

    // ========== 手动关闭 ==========

    it('点击关闭按钮移除通知', () => {
        showNotification('close-me');
        const closeBtn = document.querySelector('.notification-close');
        closeBtn.click();

        // 等待 slideOut 动画
        vi.advanceTimersByTime(300);

        expect(document.querySelectorAll('.notification').length).toBe(0);
    });

    // ========== eventBus 集成 ==========

    it('通过 eventBus ui:notification 事件触发通知', () => {
        eventBus.emit('ui:notification', {
            message: 'event-msg',
            type: 'success',
            duration: 2000
        });
        const notification = document.querySelector('.notification');
        expect(notification).not.toBeNull();
        expect(notification.classList.contains('notification-success')).toBe(true);
        expect(notification.querySelector('span').textContent).toBe('event-msg');
    });

    it('eventBus 事件使用默认 type 和 duration', () => {
        eventBus.emit('ui:notification', { message: 'default' });
        const notification = document.querySelector('.notification');
        expect(notification).not.toBeNull();
        // 默认 info 类型，挂 notification-info 类（与 success 同绿色区分开）
        expect(notification.classList.contains('notification-info')).toBe(true);
    });

    // ========== 位置属性 ==========

    it('通知设置 --notification-offset CSS 自定义属性', () => {
        showNotification('pos1');
        const notification = document.querySelector('.notification');
        const offset = notification.style.getPropertyValue('--notification-offset');
        // 偏移值取决于之前堆叠的通知数量，只验证格式正确
        expect(offset).toMatch(/^\d+px$/);
    });
});
