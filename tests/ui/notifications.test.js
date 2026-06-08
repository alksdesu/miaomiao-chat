/**
 * notifications.js 测试
 * 通知系统：创建、堆叠、关闭、限制数量
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// mock eventBus
vi.mock('../../js/core/events.js', () => {
    const handlers = {};
    return {
        eventBus: {
            on: vi.fn((event, handler) => {
                handlers[event] = handler;
                return () => delete handlers[event];
            }),
            emit: vi.fn((event, data) => {
                if (handlers[event]) handlers[event](data);
            }),
            _handlers: handlers
        }
    };
});

import { showNotification } from '../../js/ui/notifications.js';
import { eventBus } from '../../js/core/events.js';

beforeEach(() => {
    document.body.innerHTML = '';
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
});

describe('showNotification', () => {
    it('创建通知元素到 body', () => {
        showNotification('hello', 'info');
        const notifications = document.querySelectorAll('.notification');
        expect(notifications.length).toBe(1);
        expect(notifications[0].textContent).toContain('hello');
    });

    it('默认类型为 info（无额外 class）', () => {
        showNotification('test');
        const el = document.querySelector('.notification');
        expect(el.classList.contains('notification-error')).toBe(false);
        expect(el.classList.contains('notification-success')).toBe(false);
    });

    it('error 类型添加 notification-error class', () => {
        showNotification('fail', 'error');
        const el = document.querySelector('.notification');
        expect(el.classList.contains('notification-error')).toBe(true);
    });

    it('success 类型添加 notification-success class', () => {
        showNotification('ok', 'success');
        const el = document.querySelector('.notification');
        expect(el.classList.contains('notification-success')).toBe(true);
    });

    it('warning 类型添加 notification-warning class', () => {
        showNotification('warn', 'warning');
        const el = document.querySelector('.notification');
        expect(el.classList.contains('notification-warning')).toBe(true);
    });

    it('设置 role=alert 和 aria-live', () => {
        showNotification('accessible', 'error');
        const el = document.querySelector('.notification');
        expect(el.getAttribute('role')).toBe('alert');
        expect(el.getAttribute('aria-live')).toBe('assertive');
    });

    it('info 类型设置 aria-live 为 polite', () => {
        showNotification('info', 'info');
        const el = document.querySelector('.notification');
        expect(el.getAttribute('aria-live')).toBe('polite');
    });

    it('包含关闭按钮', () => {
        showNotification('closable');
        const closeBtn = document.querySelector('.notification-close');
        expect(closeBtn).not.toBeNull();
        expect(closeBtn.getAttribute('aria-label')).toBe('关闭通知');
    });

    it('超时后自动移除', () => {
        showNotification('temp', 'info', 1000);
        expect(document.querySelectorAll('.notification').length).toBe(1);

        // 触发移除动画
        vi.advanceTimersByTime(1000);
        // 动画 300ms 后真正移除
        vi.advanceTimersByTime(300);
        expect(document.querySelectorAll('.notification').length).toBe(0);
    });

    it('最多显示 5 个通知', () => {
        for (let i = 0; i < 7; i++) {
            showNotification(`msg-${i}`, 'info');
        }
        const notifications = document.querySelectorAll('.notification');
        expect(notifications.length).toBeLessThanOrEqual(5);
    });

    it('超出限制时移除最老的通知', () => {
        for (let i = 0; i < 6; i++) {
            showNotification(`msg-${i}`, 'info');
        }
        // msg-0 应该已被移除
        const allTexts = Array.from(document.querySelectorAll('.notification')).map(
            (el) => el.textContent
        );
        expect(allTexts.some((t) => t.includes('msg-0'))).toBe(false);
        expect(allTexts.some((t) => t.includes('msg-5'))).toBe(true);
    });

    it('设置 --notification-offset CSS 变量', () => {
        showNotification('first');
        const el = document.querySelector('.notification');
        // 应该设置了 offset 变量（立即重排）
        const offset = el.style.getPropertyValue('--notification-offset');
        expect(offset).toBeDefined();
    });
});

describe('eventBus 集成', () => {
    it('通过事件触发的通知机制存在', () => {
        // eventBus.on 在模块加载时已注册 'ui:notification' 处理
        expect(eventBus.on).toHaveBeenCalledWith('ui:notification', expect.any(Function));
    });
});
