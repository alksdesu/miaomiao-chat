/**
 * stream/stats.js 流统计模块测试
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../js/core/state.js', () => ({
    state: {
        streamStats: {},
        currentAssistantMessage: null
    }
}));

import { state } from '../../js/core/state.js';
import {
    StreamStats,
    estimateTokenCount,
    resetStreamStats,
    finalizeStreamStats,
    getCurrentStreamStatsData,
    renderStreamStatsFromData
} from '../../js/stream/stats.js';

beforeEach(() => {
    state.streamStats = {};
    state.currentAssistantMessage = null;
});

// ========== estimateTokenCount ==========

describe('estimateTokenCount', () => {
    it('空字符串返回 0', () => {
        expect(estimateTokenCount('')).toBe(0);
    });

    it('null 返回 0', () => {
        expect(estimateTokenCount(null)).toBe(0);
    });

    it('undefined 返回 0', () => {
        expect(estimateTokenCount(undefined)).toBe(0);
    });

    it('英文按词计数', () => {
        expect(estimateTokenCount('hello world')).toBe(2);
    });

    it('中文按字计数', () => {
        expect(estimateTokenCount('你好世界')).toBe(4);
    });

    it('中英混合', () => {
        const count = estimateTokenCount('hello 你好 world');
        expect(count).toBe(4);
    });

    it('多个空格不影响', () => {
        expect(estimateTokenCount('hello   world')).toBe(2);
    });
});

// ========== resetStreamStats ==========

describe('resetStreamStats', () => {
    it('重置统计', () => {
        resetStreamStats();
        expect(state.streamStats.requestStartTime).toBeTypeOf('number');
        expect(state.streamStats.firstTokenTime).toBe(0);
        expect(state.streamStats.endTime).toBe(0);
        expect(state.streamStats.tokenCount).toBe(0);
        expect(state.streamStats.isFirstToken).toBe(true);
    });
});

// ========== StreamStats.recordFirstToken ==========

describe('StreamStats.recordFirstToken', () => {
    it('记录首个 token 时间', () => {
        const stats = new StreamStats();
        stats.recordFirstToken();
        expect(stats.firstTokenTime).toBeGreaterThan(0);
        expect(stats.isFirstToken).toBe(false);
    });

    it('第二次调用不覆盖', () => {
        const stats = new StreamStats();
        stats.recordFirstToken();
        const firstTime = stats.firstTokenTime;
        stats.recordFirstToken();
        expect(stats.firstTokenTime).toBe(firstTime);
    });
});

// ========== StreamStats.recordTokens ==========

describe('StreamStats.recordTokens', () => {
    it('增加 token 计数', () => {
        const stats = new StreamStats();
        stats.recordTokens('hello world');
        expect(stats.tokenCount).toBe(2);
    });

    it('累积计数', () => {
        const stats = new StreamStats();
        stats.recordTokens('hello');
        stats.recordTokens('world');
        expect(stats.tokenCount).toBe(2);
    });

    it('空文本不增加', () => {
        const stats = new StreamStats();
        stats.recordTokens('');
        expect(stats.tokenCount).toBe(0);
    });

    it('null 不增加', () => {
        const stats = new StreamStats();
        stats.recordTokens(null);
        expect(stats.tokenCount).toBe(0);
    });
});

// ========== StreamStats.recalculateTokenCount ==========

describe('StreamStats.recalculateTokenCount', () => {
    it('根据文本重算', () => {
        const stats = new StreamStats();
        const count = stats.recalculateTokenCount({
            textContent: 'hello world',
            thinkingContent: ''
        });
        expect(count).toBe(2);
        expect(stats.tokenCount).toBe(2);
    });

    it('合并 thinkingContent', () => {
        const stats = new StreamStats();
        const count = stats.recalculateTokenCount({
            textContent: 'answer',
            thinkingContent: 'let me think'
        });
        expect(count).toBeGreaterThan(1);
    });

    it('过滤 "(调用工具)"', () => {
        const stats = new StreamStats();
        const count = stats.recalculateTokenCount({ textContent: '(调用工具)' });
        expect(count).toBe(0);
    });

    it('contentParts 回退', () => {
        const stats = new StreamStats();
        const count = stats.recalculateTokenCount({
            textContent: '',
            thinkingContent: '',
            contentParts: [
                { type: 'text', text: 'hello' },
                { type: 'thinking', text: 'world' }
            ]
        });
        expect(count).toBeGreaterThan(0);
    });

    it('contentParts 过滤工具占位', () => {
        const stats = new StreamStats();
        const count = stats.recalculateTokenCount({
            textContent: '',
            contentParts: [{ type: 'text', text: '(调用工具)' }]
        });
        expect(count).toBe(0);
    });

    it('无参数返回 0', () => {
        const stats = new StreamStats();
        const count = stats.recalculateTokenCount();
        expect(count).toBe(0);
    });
});

// ========== finalizeStreamStats ==========

describe('finalizeStreamStats', () => {
    it('设置 endTime', () => {
        resetStreamStats();
        finalizeStreamStats();
        expect(state.streamStats.endTime).toBeGreaterThan(0);
    });
});

// ========== getCurrentStreamStatsData ==========

describe('getCurrentStreamStatsData', () => {
    it('无 requestStartTime 返回 null', () => {
        state.streamStats = {};
        expect(getCurrentStreamStatsData()).toBeNull();
    });

    it('有完整统计返回数据', () => {
        state.streamStats = {
            requestStartTime: 1000,
            firstTokenTime: 1500,
            endTime: 3000,
            tokenCount: 100
        };
        const data = getCurrentStreamStatsData();
        expect(data.ttft).toBe('0.50');
        expect(data.totalTime).toBe('2.00');
        expect(data.tokens).toBe(100);
        expect(parseFloat(data.tps)).toBeCloseTo(66.7, 0);
    });

    it('无 firstTokenTime 时 ttft 为 -', () => {
        state.streamStats = {
            requestStartTime: 1000,
            firstTokenTime: 0,
            endTime: 2000,
            tokenCount: 50
        };
        const data = getCurrentStreamStatsData();
        expect(data.ttft).toBe('-');
    });

    it('无 endTime 时 totalTime 为 -', () => {
        state.streamStats = {
            requestStartTime: 1000,
            firstTokenTime: 1200,
            endTime: 0,
            tokenCount: 50
        };
        const data = getCurrentStreamStatsData();
        expect(data.totalTime).toBe('-');
        expect(data.tps).toBe('-');
    });
});

// ========== StreamStats.getPartialData ==========

describe('StreamStats.getPartialData', () => {
    it('无 requestStartTime 返回 null', () => {
        const stats = new StreamStats();
        stats.requestStartTime = 0;
        expect(stats.getPartialData()).toBeNull();
    });

    it('返回部分统计', () => {
        const stats = new StreamStats();
        stats.requestStartTime = 1000;
        stats.firstTokenTime = 1500;
        stats.tokenCount = 50;
        const data = stats.getPartialData();
        expect(data.ttft).toBe('0.50');
        expect(data.totalTime).toBe('-');
        expect(data.tps).toBe('-');
        expect(data.tokens).toBe(50);
        expect(data.isPartial).toBe(true);
    });
});

// ========== renderStreamStatsFromData ==========

describe('renderStreamStatsFromData', () => {
    it('null 返回空字符串', () => {
        expect(renderStreamStatsFromData(null)).toBe('');
    });

    it('有效数据返回 HTML', () => {
        const html = renderStreamStatsFromData({
            ttft: '0.50',
            totalTime: '2.00',
            tokens: 100,
            tps: '50.0'
        });
        expect(html).toContain('stream-stats');
        expect(html).toContain('0.50');
        expect(html).toContain('2.00');
        expect(html).toContain('100');
        expect(html).toContain('50.0');
    });
});
