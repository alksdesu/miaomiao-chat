// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../js/utils/logger.js', () => ({
    logger: { warn: vi.fn(), debug: vi.fn(), error: vi.fn(), info: vi.fn() }
}));

import { MessageVirtualizer } from '../../js/ui/message-virtualizer.js';

describe('MessageVirtualizer', () => {
    let root;

    beforeEach(() => {
        root = document.createElement('div');
        Object.defineProperty(root, 'clientHeight', { configurable: true, value: 400 });
        root.scrollTo = vi.fn(({ top }) => {
            root.scrollTop = top;
        });
        document.body.appendChild(root);
        globalThis.ResizeObserver = class {
            observe = vi.fn();
            unobserve = vi.fn();
            disconnect = vi.fn();
        };
    });

    afterEach(() => {
        delete globalThis.ResizeObserver;
        document.body.innerHTML = '';
    });

    it('只挂载可见范围和 overscan 内消息', () => {
        const renderItem = vi.fn((item, index) => {
            const element = document.createElement('article');
            element.dataset.messageId = item.id;
            element.textContent = String(index);
            return element;
        });
        const virtualizer = new MessageVirtualizer({
            root,
            renderItem,
            estimateHeight: 100,
            overscan: 100
        });

        virtualizer.init(
            Array.from({ length: 100 }, (_, index) => ({ id: `m${index}` })),
            { initialIndex: 99 }
        );

        expect(virtualizer.getStats().renderedMessages).toBeLessThan(20);
        expect(root.querySelector('.virtual-spacer-top')).not.toBeNull();
        expect(virtualizer.getElement(99)).not.toBeNull();
    });

    it('跳转到未挂载消息并修正锚点前高度变化', () => {
        const virtualizer = new MessageVirtualizer({
            root,
            renderItem: (_item, index) => {
                const element = document.createElement('article');
                element.textContent = String(index);
                return element;
            },
            estimateHeight: 100,
            overscan: 0
        });
        virtualizer.init(Array.from({ length: 20 }, (_, index) => ({ id: `m${index}` })));

        expect(virtualizer.scrollToIndex(15, 'instant')).toBe(true);
        expect(virtualizer.getElement(15)).not.toBeNull();
        const scrollTop = root.scrollTop;
        virtualizer.updateMeasuredHeight(0, 180);
        expect(root.scrollTop).toBe(scrollTop + 80);
    });

    it('编辑中的离屏消息保持挂载', () => {
        const virtualizer = new MessageVirtualizer({
            root,
            renderItem: () => document.createElement('article'),
            estimateHeight: 100,
            overscan: 0
        });
        virtualizer.init(Array.from({ length: 20 }, (_, index) => ({ id: `m${index}` })));
        const first = virtualizer.getElement(0);
        first.classList.add('editing');

        virtualizer.scrollToIndex(19, 'instant');
        expect(first.isConnected).toBe(true);
    });

    it('离屏消息解除交互保护后自动回收', () => {
        vi.useFakeTimers();
        const virtualizer = new MessageVirtualizer({
            root,
            renderItem: () => document.createElement('article'),
            estimateHeight: 100,
            overscan: 0
        });
        virtualizer.init(Array.from({ length: 20 }, (_, index) => ({ id: `m${index}` })));
        const first = virtualizer.getElement(0);
        first.classList.add('editing');
        virtualizer.scrollToIndex(19, 'instant');

        first.classList.remove('editing');
        vi.advanceTimersByTime(500);

        expect(first.isConnected).toBe(false);
        virtualizer.destroy();
        vi.useRealTimers();
    });
});
