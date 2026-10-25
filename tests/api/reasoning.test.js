/**
 * reasoning.js 推理设置快照与档位换算测试
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../js/core/state.js', () => ({
    state: {
        thinkingEnabled: true,
        thinkingStrength: 'medium',
        thinkingBudget: 4000,
        thinkingNoneMode: false,
        claudeAdaptiveThinking: false,
        claudeEffortLevel: 'high',
        claudeShowThinking: true
    }
}));

import {
    captureReasoningIntent,
    normalizeBudgetStrength,
    resolveThinkingBudget
} from '../../js/api/reasoning.js';

const BUDGETS = { low: 100, medium: 200, high: 300 };

function intent(overrides = {}) {
    return {
        enabled: true,
        strength: 'high',
        budget: 9999,
        sendNoneWhenDisabled: false,
        adaptive: false,
        adaptiveEffort: 'high',
        showSummary: false,
        ...overrides
    };
}

describe('captureReasoningIntent', () => {
    it('缺省读取全局 state', () => {
        expect(captureReasoningIntent()).toEqual({
            enabled: true,
            strength: 'medium',
            budget: 4000,
            sendNoneWhenDisabled: false,
            adaptive: false,
            adaptiveEffort: 'high',
            showSummary: true
        });
    });

    it('开关字段转为布尔值', () => {
        const result = captureReasoningIntent({ thinkingStrength: 'low' });
        expect(result.enabled).toBe(false);
        expect(result.sendNoneWhenDisabled).toBe(false);
        expect(result.adaptive).toBe(false);
        expect(result.showSummary).toBe(false);
        expect(result.strength).toBe('low');
    });
});

describe('normalizeBudgetStrength', () => {
    it('minimal 归到 low，xhigh 归到 high', () => {
        expect(normalizeBudgetStrength('minimal')).toBe('low');
        expect(normalizeBudgetStrength('xhigh')).toBe('high');
    });

    it('其他档位原样返回', () => {
        for (const strength of ['low', 'medium', 'high', 'custom', 'max']) {
            expect(normalizeBudgetStrength(strength)).toBe(strength);
        }
    });
});

describe('resolveThinkingBudget', () => {
    it('按档位取预算', () => {
        expect(resolveThinkingBudget(intent({ strength: 'low' }), BUDGETS)).toBe(100);
        expect(resolveThinkingBudget(intent({ strength: 'medium' }), BUDGETS)).toBe(200);
        expect(resolveThinkingBudget(intent({ strength: 'high' }), BUDGETS)).toBe(300);
    });

    it('minimal / xhigh 先归到相邻档位', () => {
        expect(resolveThinkingBudget(intent({ strength: 'minimal' }), BUDGETS)).toBe(100);
        expect(resolveThinkingBudget(intent({ strength: 'xhigh' }), BUDGETS)).toBe(300);
    });

    it('custom 使用用户预算', () => {
        expect(resolveThinkingBudget(intent({ strength: 'custom', budget: 1234 }), BUDGETS)).toBe(
            1234
        );
    });

    it('未知档位回落 fallback', () => {
        expect(resolveThinkingBudget(intent({ strength: 'max' }), BUDGETS)).toBe(16384);
        expect(resolveThinkingBudget(intent({ strength: 'max' }), BUDGETS, 42)).toBe(42);
    });
});
