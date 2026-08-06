import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    clearSessionWriteQueueForTests,
    withSessionWriteLock
} from '../../js/state/session-write-queue.js';

describe('withSessionWriteLock', () => {
    beforeEach(() => clearSessionWriteQueueForTests());

    it('同一会话串行写入，不同会话并行写入', async () => {
        const order = [];
        let releaseFirst;
        const first = withSessionWriteLock('session-a', async () => {
            order.push('a1-start');
            await new Promise((resolve) => {
                releaseFirst = resolve;
            });
            order.push('a1-end');
        });
        const second = withSessionWriteLock('session-a', async () => order.push('a2'));
        const other = withSessionWriteLock('session-b', async () => order.push('b1'));

        await vi.waitFor(() => expect(order).toContain('b1'));
        expect(order).not.toContain('a2');
        releaseFirst();
        await Promise.all([first, second, other]);

        expect(order.indexOf('a2')).toBeGreaterThan(order.indexOf('a1-end'));
    });

    it('前一次写入失败后仍会执行下一次', async () => {
        const first = withSessionWriteLock('session-a', async () => {
            throw new Error('write failed');
        });
        const secondOperation = vi.fn(async () => 'saved');
        const second = withSessionWriteLock('session-a', secondOperation);

        await expect(first).rejects.toThrow('write failed');
        await expect(second).resolves.toBe('saved');
        expect(secondOperation).toHaveBeenCalledOnce();
    });
});
