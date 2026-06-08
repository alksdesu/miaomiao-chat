/**
 * datetime.js 测试
 */
import { describe, it, expect } from 'vitest';

import { datetimeHandler } from '../../../js/tools/builtin/datetime.js';

describe('datetimeHandler', () => {
    // current
    it('current 操作', async () => {
        const result = await datetimeHandler({ operation: 'current' });
        expect(result.success).toBe(true);
        expect(result.timestamp).toBeGreaterThan(0);
        expect(result.iso).toBeDefined();
        expect(result.locale).toBeDefined();
        expect(result.timezone).toBeDefined();
    });

    // format
    it('format iso', async () => {
        const result = await datetimeHandler({
            operation: 'format',
            date: '2024-01-15T12:00:00Z',
            format: 'iso'
        });
        expect(result.success).toBe(true);
        expect(result.iso).toBeDefined();
    });

    it('format locale', async () => {
        const result = await datetimeHandler({
            operation: 'format',
            date: '2024-01-15T12:00:00Z',
            format: 'locale'
        });
        expect(result.success).toBe(true);
    });

    it('format timestamp', async () => {
        const result = await datetimeHandler({
            operation: 'format',
            date: '2024-01-15T12:00:00Z',
            format: 'timestamp'
        });
        expect(result.formatted).toBeDefined();
    });

    it('format custom', async () => {
        const result = await datetimeHandler({
            operation: 'format',
            date: '2024-01-15T12:00:00Z',
            format: 'custom'
        });
        expect(result.formatted).toMatch(/\d{4}-\d{2}-\d{2}/);
    });

    it('format date', async () => {
        const result = await datetimeHandler({
            operation: 'format',
            date: '2024-01-15T12:00:00Z',
            format: 'date'
        });
        expect(result.success).toBe(true);
    });

    it('format time', async () => {
        const result = await datetimeHandler({
            operation: 'format',
            date: '2024-01-15T12:00:00Z',
            format: 'time'
        });
        expect(result.success).toBe(true);
    });

    it('format 无 date 抛异常', async () => {
        await expect(datetimeHandler({ operation: 'format' })).rejects.toThrow('date 参数');
    });

    it('format 使用时间戳', async () => {
        const result = await datetimeHandler({
            operation: 'format',
            date: '1705320000000',
            format: 'iso'
        });
        expect(result.success).toBe(true);
    });

    it('format 无效日期抛异常', async () => {
        await expect(datetimeHandler({ operation: 'format', date: 'invalid' })).rejects.toThrow();
    });

    // timezone
    it('timezone 转换', async () => {
        const result = await datetimeHandler({
            operation: 'timezone',
            date: '2024-01-15T12:00:00Z',
            timezone: 'America/New_York'
        });
        expect(result.success).toBe(true);
        expect(result.targetTimezone).toBe('America/New_York');
        expect(result.converted).toBeDefined();
    });

    it('timezone 缺少参数', async () => {
        await expect(
            datetimeHandler({ operation: 'timezone', date: '2024-01-15' })
        ).rejects.toThrow('timezone');
        await expect(datetimeHandler({ operation: 'timezone', timezone: 'UTC' })).rejects.toThrow(
            'date'
        );
    });

    // calculate
    it('calculate 加天数', async () => {
        const result = await datetimeHandler({
            operation: 'calculate',
            date: '2024-01-15T12:00:00Z',
            calculation: { amount: 5, unit: 'days' }
        });
        expect(result.success).toBe(true);
        expect(result.result).toContain('2024-01-20');
    });

    it('calculate 减小时', async () => {
        const result = await datetimeHandler({
            operation: 'calculate',
            date: '2024-01-15T12:00:00Z',
            calculation: { amount: -3, unit: 'hours' }
        });
        expect(result.success).toBe(true);
        expect(result.result).toContain('09:00:00');
    });

    it('calculate 秒', async () => {
        const result = await datetimeHandler({
            operation: 'calculate',
            date: '2024-01-15T12:00:00Z',
            calculation: { amount: 30, unit: 'seconds' }
        });
        expect(result.success).toBe(true);
    });

    it('calculate 分钟', async () => {
        const result = await datetimeHandler({
            operation: 'calculate',
            date: '2024-01-15T12:00:00Z',
            calculation: { amount: 15, unit: 'minutes' }
        });
        expect(result.success).toBe(true);
    });

    it('calculate 周', async () => {
        const result = await datetimeHandler({
            operation: 'calculate',
            date: '2024-01-15T12:00:00Z',
            calculation: { amount: 2, unit: 'weeks' }
        });
        expect(result.success).toBe(true);
        expect(result.result).toContain('2024-01-29');
    });

    it('calculate 月', async () => {
        const result = await datetimeHandler({
            operation: 'calculate',
            date: '2024-01-15T12:00:00Z',
            calculation: { amount: 1, unit: 'months' }
        });
        expect(result.success).toBe(true);
        expect(result.result).toContain('2024-02');
    });

    it('calculate 年', async () => {
        const result = await datetimeHandler({
            operation: 'calculate',
            date: '2024-01-15T12:00:00Z',
            calculation: { amount: 1, unit: 'years' }
        });
        expect(result.success).toBe(true);
        expect(result.result).toContain('2025');
    });

    it('calculate 未知单位', async () => {
        await expect(
            datetimeHandler({
                operation: 'calculate',
                date: '2024-01-15T12:00:00Z',
                calculation: { amount: 1, unit: 'unknown' }
            })
        ).rejects.toThrow('不支持的时间单位');
    });

    it('calculate 缺少参数', async () => {
        await expect(
            datetimeHandler({ operation: 'calculate', date: '2024-01-15' })
        ).rejects.toThrow('calculation');
    });

    // unknown operation
    it('未知操作', async () => {
        await expect(datetimeHandler({ operation: 'unknown' })).rejects.toThrow('不支持的操作');
    });
});
