/**
 * scroll.js 测试
 * 滚动控制：scrollToBottom、按钮显隐
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../js/core/elements.js', () => ({
    elements: {
        messagesArea: null,
        scrollToBottomBtn: null
    }
}));

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

import { elements } from '../../js/core/elements.js';
import { scrollToBottom, initScrollControl } from '../../js/ui/scroll.js';

beforeEach(() => {
    // 设置模拟 DOM 元素
    elements.messagesArea = {
        scrollTo: vi.fn(),
        scrollHeight: 2000,
        scrollTop: 0,
        clientHeight: 500,
        addEventListener: vi.fn()
    };
    elements.scrollToBottomBtn = {
        classList: {
            add: vi.fn(),
            remove: vi.fn()
        },
        addEventListener: vi.fn()
    };
});

describe('scrollToBottom', () => {
    it('调用 scrollTo 到底部', () => {
        scrollToBottom();
        expect(elements.messagesArea.scrollTo).toHaveBeenCalledWith({
            top: 2000,
            behavior: 'smooth'
        });
    });

    it('messagesArea 为 null 时不报错', () => {
        elements.messagesArea = null;
        expect(() => scrollToBottom()).not.toThrow();
    });
});

describe('initScrollControl', () => {
    it('初始化不报错', () => {
        expect(() => initScrollControl()).not.toThrow();
    });

    it('绑定滚动到底部按钮点击事件', () => {
        initScrollControl();
        expect(elements.scrollToBottomBtn.addEventListener).toHaveBeenCalledWith(
            'click',
            expect.any(Function)
        );
    });

    it('绑定消息区域滚动事件', () => {
        initScrollControl();
        expect(elements.messagesArea.addEventListener).toHaveBeenCalledWith(
            'scroll',
            expect.any(Function)
        );
    });

    it('暴露 scrollToBottom 到 window', () => {
        initScrollControl();
        expect(window.scrollToBottom).toBeDefined();
    });
});
