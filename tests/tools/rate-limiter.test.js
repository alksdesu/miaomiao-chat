/**
 * rate-limiter.js 测试
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock setInterval to prevent the cleanup timer from running
vi.useFakeTimers();

import {
    checkRateLimit,
    resetRateLimit,
    getRateLimitStatus,
    clearAllRateLimits,
    getAllRateLimitStatus
} from '../../js/tools/rate-limiter.js';

beforeEach(() => {
    clearAllRateLimits();
});

// ========== checkRateLimit ==========

describe('checkRateLimit', () => {
    it('无配置不抛异常', () => {
        expect(() => checkRateLimit('tool1', null)).not.toThrow();
        expect(() => checkRateLimit('tool1', {})).not.toThrow();
        expect(() => checkRateLimit('tool1', { max: 5 })).not.toThrow();
    });

    it('未知时间单位不抛异常', () => {
        expect(() => checkRateLimit('tool1', { max: 5, unit: 'unknown' })).not.toThrow();
    });

    it('正常调用不抛异常', () => {
        expect(() => checkRateLimit('tool1', { max: 5, unit: 'minute' })).not.toThrow();
    });

    it('超过限制抛异常', () => {
        const limit = { max: 2, unit: 'minute' };
        checkRateLimit('tool1', limit);
        checkRateLimit('tool1', limit);
        expect(() => checkRateLimit('tool1', limit)).toThrow(/速率限制/);
    });

    it('不同工具独立计数', () => {
        const limit = { max: 1, unit: 'minute' };
        checkRateLimit('tool1', limit);
        expect(() => checkRateLimit('tool2', limit)).not.toThrow();
    });

    it('过期后重新计数', () => {
        const limit = { max: 1, unit: 'minute' };
        checkRateLimit('tool1', limit);
        // 推进 61 秒
        vi.advanceTimersByTime(61000);
        expect(() => checkRateLimit('tool1', limit)).not.toThrow();
    });

    it('小时单位有效', () => {
        const limit = { max: 2, unit: 'hour' };
        checkRateLimit('tool1', limit);
        checkRateLimit('tool1', limit);
        expect(() => checkRateLimit('tool1', limit)).toThrow(/速率限制/);
    });

    it('天单位有效', () => {
        const limit = { max: 1, unit: 'day' };
        checkRateLimit('tool1', limit);
        expect(() => checkRateLimit('tool1', limit)).toThrow(/速率限制/);
    });

    it('错误消息包含等待时间', () => {
        const limit = { max: 1, unit: 'minute' };
        checkRateLimit('tool1', limit);
        try {
            checkRateLimit('tool1', limit);
        } catch (e) {
            expect(e.message).toContain('秒');
            expect(e.message).toContain('分钟');
        }
    });
});

// ========== resetRateLimit ==========

describe('resetRateLimit', () => {
    it('重置后可重新调用', () => {
        const limit = { max: 1, unit: 'minute' };
        checkRateLimit('tool1', limit);
        resetRateLimit('tool1');
        expect(() => checkRateLimit('tool1', limit)).not.toThrow();
    });

    it('重置不存在的工具不报错', () => {
        expect(() => resetRateLimit('nonexistent')).not.toThrow();
    });
});

// ========== getRateLimitStatus ==========

describe('getRateLimitStatus', () => {
    it('未记录的工具返回 null', () => {
        expect(getRateLimitStatus('unknown')).toBeNull();
    });

    it('记录后返回状态', () => {
        checkRateLimit('tool1', { max: 5, unit: 'minute' });
        const status = getRateLimitStatus('tool1');
        expect(status).not.toBeNull();
        expect(status.current).toBe(1);
        expect(status.max).toBe(5);
        expect(status.windowMs).toBe(60000);
        expect(status.nextResetMs).toBeGreaterThan(0);
    });

    it('多次调用后 current 递增', () => {
        const limit = { max: 5, unit: 'minute' };
        checkRateLimit('tool1', limit);
        checkRateLimit('tool1', limit);
        checkRateLimit('tool1', limit);
        expect(getRateLimitStatus('tool1').current).toBe(3);
    });

    it('过期后 current 为 0', () => {
        checkRateLimit('tool1', { max: 5, unit: 'minute' });
        vi.advanceTimersByTime(61000);
        const status = getRateLimitStatus('tool1');
        expect(status.current).toBe(0);
        expect(status.nextResetMs).toBe(0);
    });
});

// ========== clearAllRateLimits ==========

describe('clearAllRateLimits', () => {
    it('清除后所有状态为 null', () => {
        checkRateLimit('tool1', { max: 5, unit: 'minute' });
        checkRateLimit('tool2', { max: 5, unit: 'minute' });
        clearAllRateLimits();
        expect(getRateLimitStatus('tool1')).toBeNull();
        expect(getRateLimitStatus('tool2')).toBeNull();
    });
});

// ========== getAllRateLimitStatus ==========

describe('getAllRateLimitStatus', () => {
    it('空时返回空 Map', () => {
        const all = getAllRateLimitStatus();
        expect(all.size).toBe(0);
    });

    it('返回所有工具的状态', () => {
        checkRateLimit('tool1', { max: 5, unit: 'minute' });
        checkRateLimit('tool2', { max: 3, unit: 'hour' });
        const all = getAllRateLimitStatus();
        expect(all.size).toBe(2);
        expect(all.has('tool1')).toBe(true);
        expect(all.has('tool2')).toBe(true);
    });
});
