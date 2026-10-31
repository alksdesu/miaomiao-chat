/**
 * utils/abort.js 测试：取消信号工具
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

import {
    createAbortError,
    throwIfAborted,
    throwIfAbortedBeforeRun,
    linkAbortSignal
} from '../../js/utils/abort.js';

afterEach(() => {
    vi.useRealTimers();
});

describe('throwIfAborted / throwIfAbortedBeforeRun', () => {
    it('未中止时不抛错', () => {
        expect(() => throwIfAborted(new AbortController().signal)).not.toThrow();
        expect(() => throwIfAbortedBeforeRun(null)).not.toThrow();
    });

    it('中止时抛 AbortError；动作开始前的检查额外标记 notExecuted', () => {
        const controller = new AbortController();
        controller.abort(new Error('timeout reason'));

        expect(() => throwIfAborted(controller.signal)).toThrow(
            expect.objectContaining({ name: 'AbortError' })
        );
        let caught = null;
        try {
            throwIfAbortedBeforeRun(controller.signal);
        } catch (error) {
            caught = error;
        }
        expect(caught).toMatchObject({ name: 'AbortError', notExecuted: true });
        expect(createAbortError().notExecuted).toBeUndefined();
    });
});

describe('linkAbortSignal', () => {
    it('父信号中止时子信号随之中止，reason 相同', () => {
        const parent = new AbortController();
        const linked = linkAbortSignal(parent.signal, { timeoutMs: 1000 });
        const reason = new DOMException('stop', 'AbortError');

        parent.abort(reason);

        expect(linked.signal.aborted).toBe(true);
        expect(linked.signal.reason).toBe(reason);
        linked.dispose();
    });

    it('超时只中止子信号，reason 为 TimeoutError', () => {
        vi.useFakeTimers();
        const parent = new AbortController();
        const linked = linkAbortSignal(parent.signal, { timeoutMs: 1000 });

        vi.advanceTimersByTime(1000);

        expect(linked.signal.aborted).toBe(true);
        expect(linked.signal.reason.name).toBe('TimeoutError');
        expect(parent.signal.aborted).toBe(false);
    });

    it('stopTimer 后不再超时，但仍随父信号中止；dispose 后与父信号脱钩', () => {
        vi.useFakeTimers();
        const parent = new AbortController();
        const streaming = linkAbortSignal(parent.signal, { timeoutMs: 1000 });
        const finished = linkAbortSignal(parent.signal, { timeoutMs: 1000 });

        streaming.stopTimer();
        finished.dispose();
        vi.advanceTimersByTime(5000);
        expect(streaming.signal.aborted).toBe(false);
        expect(finished.signal.aborted).toBe(false);

        parent.abort();
        expect(streaming.signal.aborted).toBe(true);
        expect(finished.signal.aborted).toBe(false);
    });

    it('父信号已中止时立即中止；没有父信号或不计时也可用', () => {
        const parent = new AbortController();
        parent.abort();
        expect(linkAbortSignal(parent.signal).signal.aborted).toBe(true);

        const standalone = linkAbortSignal(null, { timeoutMs: 0 });
        expect(standalone.signal.aborted).toBe(false);
        standalone.dispose();
    });
});
