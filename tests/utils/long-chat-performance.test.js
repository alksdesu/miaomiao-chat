import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LongChatPerformanceMonitor } from '../../js/utils/long-chat-performance.js';

describe('LongChatPerformanceMonitor', () => {
    let monitor;

    beforeEach(() => {
        monitor = new LongChatPerformanceMonitor({ sampleLimit: 3 });
    });

    it('记录 span、统计值和元数据', () => {
        const nowSpy = vi.spyOn(performance, 'now').mockReturnValueOnce(10).mockReturnValueOnce(35);
        const finish = monitor.startSpan('restore', { sessionId: 's1' });

        expect(finish({ messageCount: 20 })).toBe(25);
        expect(finish()).toBe(0);
        expect(monitor.getSnapshot().durations.restore).toMatchObject({
            count: 1,
            latest: 25,
            average: 25,
            p95: 25
        });
        expect(monitor.samples.get('restore')[0].metadata).toEqual({
            sessionId: 's1',
            messageCount: 20
        });
        nowSpy.mockRestore();
    });

    it('限制每类样本数量并计算 p95', () => {
        [10, 20, 30, 40].forEach((duration) => monitor.recordDuration('load', duration));

        expect(monitor.getSnapshot().durations.load).toEqual({
            count: 3,
            latest: 40,
            min: 20,
            max: 40,
            average: 30,
            p95: 40
        });
    });

    it('维护 gauge、counter 并可重置', () => {
        monitor.setGauge('messageDomCount', 80);
        monitor.increment('hydratedMessages', 2);
        monitor.increment('hydratedMessages');

        expect(monitor.getSnapshot()).toMatchObject({
            gauges: { messageDomCount: 80 },
            counters: { hydratedMessages: 3 }
        });

        monitor.reset();
        expect(monitor.getSnapshot()).toEqual({ durations: {}, gauges: {}, counters: {} });
    });

    it('measureAsync 在失败时也结束计时', async () => {
        await expect(
            monitor.measureAsync('load', async () => {
                throw new Error('failed');
            })
        ).rejects.toThrow('failed');
        expect(monitor.getSnapshot().durations.load.count).toBe(1);
    });
});
