/**
 * virtual-scroll.js 测试
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../js/core/state.js', () => ({
    state: {
        messages: [],
        currentSessionIndex: 0,
        longChatRenderingMode: 'auto'
    }
}));

vi.mock('../../js/core/elements.js', () => ({
    elements: {
        chatWindow: null
    }
}));

vi.mock('../../js/core/events.js', () => ({
    eventBus: { emit: vi.fn(), on: vi.fn(), off: vi.fn() }
}));

vi.mock('../../js/utils/logger.js', () => ({
    logger: { warn: vi.fn(), debug: vi.fn(), error: vi.fn(), info: vi.fn() }
}));

vi.mock('../../js/utils/lazy-image.js', () => ({
    preloadImagesInRange: vi.fn()
}));

import {
    getVirtualScrollStats,
    disableVirtualScroll,
    initVirtualScroll
} from '../../js/ui/virtual-scroll.js';
import { state } from '../../js/core/state.js';
import { elements } from '../../js/core/elements.js';

beforeEach(() => {
    disableVirtualScroll();
    state.messages = [];
    state.longChatRenderingMode = 'auto';
    elements.chatWindow = null;
});

describe('virtual-scroll', () => {
    describe('getVirtualScrollStats', () => {
        it('返回状态对象', () => {
            const stats = getVirtualScrollStats();
            expect(stats).toBeDefined();
            expect(typeof stats.isActive).toBe('boolean');
            expect(typeof stats.totalMessages).toBe('number');
            expect(typeof stats.renderedMessages).toBe('number');
            expect(stats.visibleRange).toBeDefined();
            expect(typeof stats.measuredHeights).toBe('number');
            expect(typeof stats.estimatedTotalHeight).toBe('number');
        });

        it('无消息时统计为零', () => {
            const stats = getVirtualScrollStats();
            expect(stats.totalMessages).toBe(0);
            expect(stats.estimatedTotalHeight).toBe(0);
        });
    });

    describe('disableVirtualScroll', () => {
        it('不抛错', () => {
            expect(() => disableVirtualScroll()).not.toThrow();
        });

        it('禁用后 isActive 为 false', () => {
            disableVirtualScroll();
            expect(getVirtualScrollStats().isActive).toBe(false);
        });
    });

    describe('initVirtualScroll', () => {
        it('无 chatWindow 时不抛错', () => {
            expect(() => initVirtualScroll()).not.toThrow();
        });

        it('兼容模式始终完整渲染并保留 content-visibility 兜底', () => {
            elements.chatWindow = document.createElement('div');
            state.messages = Array.from({ length: 100 }, (_, index) => ({ id: `m${index}` }));
            state.longChatRenderingMode = 'compatibility';
            const renderAll = vi.fn();

            expect(
                initVirtualScroll(null, {
                    messages: state.messages,
                    renderAll
                })
            ).toBe(false);
            expect(renderAll).toHaveBeenCalledOnce();
            expect(getVirtualScrollStats().strategy).toBe('content-visibility-fallback');
            expect(elements.chatWindow.classList.contains('virtual-scroll-active')).toBe(true);
        });
    });
});
