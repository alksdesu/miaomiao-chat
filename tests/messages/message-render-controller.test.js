// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../js/utils/logger.js', () => ({
    logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }
}));

import { MessageRenderController } from '../../js/messages/message-render-controller.js';

describe('MessageRenderController', () => {
    let callbacks;

    beforeEach(() => {
        vi.useFakeTimers();
        callbacks = [];
        globalThis.IntersectionObserver = class {
            constructor(callback) {
                callbacks.push(callback);
            }
            observe = vi.fn();
            unobserve = vi.fn();
            disconnect = vi.fn();
        };
    });

    afterEach(() => {
        vi.useRealTimers();
        delete globalThis.IntersectionObserver;
        document.body.innerHTML = '';
    });

    it('仅在进入观察范围后 hydration 且只执行一次', async () => {
        const root = document.createElement('div');
        const message = document.createElement('div');
        root.appendChild(message);
        const hydrate = vi.fn();
        const controller = new MessageRenderController({ root });

        controller.register(message, hydrate);
        expect(hydrate).not.toHaveBeenCalled();
        callbacks[0]([{ target: message, isIntersecting: true }]);
        await Promise.resolve();
        await Promise.resolve();

        expect(hydrate).toHaveBeenCalledTimes(1);
        expect(message.dataset.hydrationState).toBe('hydrated');
        expect(controller.getStats()).toMatchObject({ pending: 0, hydrated: 1, total: 1 });
        expect(await controller.hydrate(message)).toBe(false);
    });

    it('priority 消息立即 hydration', async () => {
        const root = document.createElement('div');
        const message = document.createElement('div');
        const hydrate = vi.fn();
        const controller = new MessageRenderController({ root });

        controller.register(message, hydrate, { priority: true });
        await Promise.resolve();
        await Promise.resolve();
        expect(hydrate).toHaveBeenCalledOnce();
    });

    it('无 IntersectionObserver 时按 fallback 队列处理', async () => {
        delete globalThis.IntersectionObserver;
        const root = document.createElement('div');
        const controller = new MessageRenderController({ root });
        const hydrates = Array.from({ length: 12 }, () => vi.fn());
        hydrates.forEach((hydrate) => controller.register(document.createElement('div'), hydrate));

        await vi.runAllTimersAsync();
        expect(hydrates.every((hydrate) => hydrate.mock.calls.length === 1)).toBe(true);
        expect(controller.getStats()).toMatchObject({
            pending: 0,
            hydrated: 12,
            strategy: 'chunked-fallback'
        });
    });

    it('离开范围后 dehydration，重新进入时恢复', async () => {
        const root = document.createElement('div');
        const message = document.createElement('div');
        const hydrate = vi.fn();
        const dehydrate = vi.fn();
        const controller = new MessageRenderController({ root, dehydrateDelay: 20 });

        controller.register(message, hydrate, { dehydrate });
        callbacks[0]([{ target: message, isIntersecting: true }]);
        await Promise.resolve();
        await Promise.resolve();

        callbacks[0]([{ target: message, isIntersecting: false }]);
        await vi.advanceTimersByTimeAsync(20);
        expect(dehydrate).toHaveBeenCalledOnce();
        expect(message.dataset.hydrationState).toBe('dehydrated');

        callbacks[0]([{ target: message, isIntersecting: true }]);
        await Promise.resolve();
        await Promise.resolve();
        expect(hydrate).toHaveBeenCalledTimes(2);
    });

    it('pinned 消息不会被自动 dehydration', async () => {
        const root = document.createElement('div');
        const message = document.createElement('div');
        const dehydrate = vi.fn();
        const controller = new MessageRenderController({ root, dehydrateDelay: 0 });

        controller.register(message, vi.fn(), { dehydrate, priority: true, pinned: true });
        await Promise.resolve();
        await Promise.resolve();
        callbacks[0]([{ target: message, isIntersecting: false }]);
        await vi.runAllTimersAsync();

        expect(dehydrate).not.toHaveBeenCalled();
        expect(controller.getStats().pinned).toBe(1);
    });
});
