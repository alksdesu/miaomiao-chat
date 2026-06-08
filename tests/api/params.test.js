/**
 * params.js 参数构建器测试
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// mock state — 工厂函数内只能用字面量，后续通过 import 获取引用
vi.mock('../../js/core/state.js', () => ({
    state: {
        modelParams: {
            openai: {
                temperature: null,
                max_tokens: null,
                top_p: null,
                frequency_penalty: null,
                presence_penalty: null
            },
            gemini: { temperature: null, topK: null, topP: null, maxOutputTokens: null },
            claude: { temperature: null, max_tokens: null, top_p: null, top_k: null }
        },
        thinkingEnabled: false,
        thinkingStrength: 'high',
        thinkingBudget: 32768,
        thinkingNoneMode: false,
        claudeAdaptiveThinking: false,
        claudeEffortLevel: 'high',
        verbosityEnabled: false,
        outputVerbosity: 'medium',
        customHeaders: []
    }
}));

import { state } from '../../js/core/state.js';
import {
    buildModelParams,
    buildThinkingConfig,
    buildVerbosityConfig,
    getCustomHeadersObject
} from '../../js/api/params.js';

beforeEach(() => {
    Object.assign(state, {
        modelParams: {
            openai: {
                temperature: null,
                max_tokens: null,
                top_p: null,
                frequency_penalty: null,
                presence_penalty: null
            },
            gemini: { temperature: null, topK: null, topP: null, maxOutputTokens: null },
            claude: { temperature: null, max_tokens: null, top_p: null, top_k: null }
        },
        thinkingEnabled: false,
        thinkingStrength: 'high',
        thinkingBudget: 32768,
        thinkingNoneMode: false,
        claudeAdaptiveThinking: false,
        claudeEffortLevel: 'high',
        verbosityEnabled: false,
        outputVerbosity: 'medium',
        customHeaders: []
    });
});

// ========== buildModelParams ==========

describe('buildModelParams', () => {
    describe('openai 格式', () => {
        it('所有参数为 null 时返回空对象', () => {
            const result = buildModelParams('openai');
            expect(result).toEqual({});
        });

        it('非 null 参数被包含', () => {
            state.modelParams.openai = {
                temperature: 0.7,
                max_tokens: 1024,
                top_p: 0.9,
                frequency_penalty: 0.5,
                presence_penalty: 0.3
            };
            const result = buildModelParams('openai');
            expect(result).toEqual({
                temperature: 0.7,
                max_tokens: 1024,
                top_p: 0.9,
                frequency_penalty: 0.5,
                presence_penalty: 0.3
            });
        });

        it('部分参数为 null 时只包含非 null', () => {
            state.modelParams.openai.temperature = 0.5;
            const result = buildModelParams('openai');
            expect(result).toEqual({ temperature: 0.5 });
        });

        it('temperature 为 0 时仍包含', () => {
            state.modelParams.openai.temperature = 0;
            const result = buildModelParams('openai');
            expect(result).toEqual({ temperature: 0 });
        });
    });

    describe('openai-responses 格式', () => {
        it('使用 openai 参数格式', () => {
            state.modelParams.openai.temperature = 0.8;
            state.modelParams.openai.max_tokens = 2048;
            const result = buildModelParams('openai-responses');
            expect(result.temperature).toBe(0.8);
            expect(result.max_tokens).toBe(2048);
        });
    });

    describe('openclaw 格式', () => {
        it('不包含 penalty 参数', () => {
            state.modelParams.openai = {
                temperature: 0.7,
                max_tokens: 1024,
                top_p: null,
                frequency_penalty: 0.5,
                presence_penalty: 0.3
            };
            const result = buildModelParams('openclaw');
            expect(result.temperature).toBe(0.7);
            expect(result.max_tokens).toBe(1024);
            expect(result.frequency_penalty).toBeUndefined();
            expect(result.presence_penalty).toBeUndefined();
        });
    });

    describe('gemini 格式', () => {
        it('所有参数为 null 时使用默认值', () => {
            const result = buildModelParams('gemini');
            expect(result).toEqual({
                temperature: 1,
                topK: 40,
                topP: 0.95,
                maxOutputTokens: 8192
            });
        });

        it('非 null 参数覆盖默认值', () => {
            state.modelParams.gemini = {
                temperature: 0.3,
                topK: 20,
                topP: null,
                maxOutputTokens: null
            };
            const result = buildModelParams('gemini');
            expect(result).toEqual({
                temperature: 0.3,
                topK: 20,
                topP: 0.95,
                maxOutputTokens: 8192
            });
        });
    });

    describe('claude 格式', () => {
        it('max_tokens 有默认值 8192', () => {
            const result = buildModelParams('claude');
            expect(result).toEqual({ max_tokens: 8192 });
        });

        it('temperature 非 null 时包含', () => {
            state.modelParams.claude.temperature = 0.5;
            const result = buildModelParams('claude');
            expect(result.temperature).toBe(0.5);
        });

        it('thinking 模式强制 temperature 为 1', () => {
            state.thinkingEnabled = true;
            state.modelParams.claude.temperature = 0.5;
            const result = buildModelParams('claude');
            expect(result.temperature).toBe(1);
        });

        it('thinking 模式 temperature 为 null 时不强制', () => {
            state.thinkingEnabled = true;
            const result = buildModelParams('claude');
            expect(result.temperature).toBeUndefined();
        });

        it('top_k 非 null 时包含', () => {
            state.modelParams.claude.top_k = 50;
            const result = buildModelParams('claude');
            expect(result.top_k).toBe(50);
        });
    });

    describe('未知格式', () => {
        it('返回空对象', () => {
            const result = buildModelParams('unknown');
            expect(result).toEqual({});
        });
    });
});

// ========== buildThinkingConfig ==========

describe('buildThinkingConfig', () => {
    describe('OpenAI Chat Completions (openai)', () => {
        it('未启用时返回 null', () => {
            expect(buildThinkingConfig('openai')).toBeNull();
        });

        it('启用 high 强度', () => {
            state.thinkingEnabled = true;
            state.thinkingStrength = 'high';
            expect(buildThinkingConfig('openai')).toEqual({ reasoning_effort: 'high' });
        });

        it('启用 medium 强度', () => {
            state.thinkingEnabled = true;
            state.thinkingStrength = 'medium';
            expect(buildThinkingConfig('openai')).toEqual({ reasoning_effort: 'medium' });
        });

        it('启用 low 强度', () => {
            state.thinkingEnabled = true;
            state.thinkingStrength = 'low';
            expect(buildThinkingConfig('openai')).toEqual({ reasoning_effort: 'low' });
        });

        it('启用 xhigh 强度', () => {
            state.thinkingEnabled = true;
            state.thinkingStrength = 'xhigh';
            expect(buildThinkingConfig('openai')).toEqual({ reasoning_effort: 'xhigh' });
        });

        it('启用 minimal 强度', () => {
            state.thinkingEnabled = true;
            state.thinkingStrength = 'minimal';
            expect(buildThinkingConfig('openai')).toEqual({ reasoning_effort: 'minimal' });
        });

        it('custom 强度转为 high', () => {
            state.thinkingEnabled = true;
            state.thinkingStrength = 'custom';
            expect(buildThinkingConfig('openai')).toEqual({ reasoning_effort: 'high' });
        });

        it('无效强度转为 high', () => {
            state.thinkingEnabled = true;
            state.thinkingStrength = 'invalid';
            expect(buildThinkingConfig('openai')).toEqual({ reasoning_effort: 'high' });
        });
    });

    describe('OpenAI Responses API (openai-responses)', () => {
        it('未启用且 noneMode 关闭返回 null', () => {
            state.thinkingNoneMode = false;
            expect(buildThinkingConfig('openai-responses')).toBeNull();
        });

        it('未启用但 noneMode 开启返回 none', () => {
            state.thinkingNoneMode = true;
            expect(buildThinkingConfig('openai-responses')).toEqual({
                reasoning: { effort: 'none' }
            });
        });

        it('启用时返回 reasoning 对象', () => {
            state.thinkingEnabled = true;
            state.thinkingStrength = 'high';
            const result = buildThinkingConfig('openai-responses');
            expect(result).toEqual({ reasoning: { effort: 'high', summary: 'auto' } });
        });

        it('custom 强度转为 high', () => {
            state.thinkingEnabled = true;
            state.thinkingStrength = 'custom';
            const result = buildThinkingConfig('openai-responses');
            expect(result.reasoning.effort).toBe('high');
        });
    });

    describe('Gemini', () => {
        it('未启用时返回 null', () => {
            expect(buildThinkingConfig('gemini')).toBeNull();
        });

        it('Gemini 2.5 使用 thinkingBudget', () => {
            state.thinkingEnabled = true;
            state.thinkingStrength = 'high';
            const result = buildThinkingConfig('gemini', 'gemini-2.5-flash');
            expect(result).toEqual({
                thinkingConfig: { thinkingBudget: 16384, includeThoughts: true }
            });
        });

        it('Gemini 2.5 medium 使用 8192', () => {
            state.thinkingEnabled = true;
            state.thinkingStrength = 'medium';
            expect(
                buildThinkingConfig('gemini', 'gemini-2.5-pro').thinkingConfig.thinkingBudget
            ).toBe(8192);
        });

        it('Gemini 2.5 low 使用 4096', () => {
            state.thinkingEnabled = true;
            state.thinkingStrength = 'low';
            expect(
                buildThinkingConfig('gemini', 'gemini-2.5-flash').thinkingConfig.thinkingBudget
            ).toBe(4096);
        });

        it('Gemini 3 使用 thinkingLevel', () => {
            state.thinkingEnabled = true;
            state.thinkingStrength = 'high';
            const result = buildThinkingConfig('gemini', 'gemini-3-flash');
            expect(result).toEqual({
                thinkingConfig: { thinkingLevel: 'HIGH', includeThoughts: true }
            });
        });

        it('Gemini 3 low 使用 LOW', () => {
            state.thinkingEnabled = true;
            state.thinkingStrength = 'low';
            expect(buildThinkingConfig('gemini', 'gemini-3-pro').thinkingConfig.thinkingLevel).toBe(
                'LOW'
            );
        });

        it('minimal 规范化为 low', () => {
            state.thinkingEnabled = true;
            state.thinkingStrength = 'minimal';
            expect(
                buildThinkingConfig('gemini', 'gemini-2.5-flash').thinkingConfig.thinkingBudget
            ).toBe(4096);
        });

        it('xhigh 规范化为 high', () => {
            state.thinkingEnabled = true;
            state.thinkingStrength = 'xhigh';
            expect(
                buildThinkingConfig('gemini', 'gemini-2.5-flash').thinkingConfig.thinkingBudget
            ).toBe(16384);
        });

        it('custom 使用自定义 budget', () => {
            state.thinkingEnabled = true;
            state.thinkingStrength = 'custom';
            state.thinkingBudget = 50000;
            expect(
                buildThinkingConfig('gemini', 'gemini-2.5-flash').thinkingConfig.thinkingBudget
            ).toBe(50000);
        });
    });

    describe('Claude', () => {
        it('未启用时返回 null', () => {
            expect(buildThinkingConfig('claude')).toBeNull();
        });

        it('传统 budget_tokens 模式', () => {
            state.thinkingEnabled = true;
            state.thinkingStrength = 'high';
            state.claudeAdaptiveThinking = false;
            expect(buildThinkingConfig('claude')).toEqual({
                thinking: { type: 'enabled', budget_tokens: 16384 }
            });
        });

        it('adaptive thinking 模式', () => {
            state.thinkingEnabled = true;
            state.claudeAdaptiveThinking = true;
            state.claudeEffortLevel = 'high';
            expect(buildThinkingConfig('claude')).toEqual({
                thinking: { type: 'adaptive' },
                output_config: { effort: 'high' }
            });
        });

        it('adaptive thinking 低 effort', () => {
            state.thinkingEnabled = true;
            state.claudeAdaptiveThinking = true;
            state.claudeEffortLevel = 'low';
            expect(buildThinkingConfig('claude').output_config.effort).toBe('low');
        });

        it('low 使用 2048 tokens', () => {
            state.thinkingEnabled = true;
            state.thinkingStrength = 'low';
            expect(buildThinkingConfig('claude').thinking.budget_tokens).toBe(2048);
        });

        it('medium 使用 8192 tokens', () => {
            state.thinkingEnabled = true;
            state.thinkingStrength = 'medium';
            expect(buildThinkingConfig('claude').thinking.budget_tokens).toBe(8192);
        });

        it('custom 使用自定义 budget', () => {
            state.thinkingEnabled = true;
            state.thinkingStrength = 'custom';
            state.thinkingBudget = 65536;
            expect(buildThinkingConfig('claude').thinking.budget_tokens).toBe(65536);
        });
    });

    describe('OpenClaw', () => {
        it('未启用时返回 null', () => {
            expect(buildThinkingConfig('openclaw')).toBeNull();
        });

        it('启用时透传 budget_tokens', () => {
            state.thinkingEnabled = true;
            state.thinkingBudget = 12345;
            expect(buildThinkingConfig('openclaw')).toEqual({ thinking: { budget_tokens: 12345 } });
        });

        it('budget 为空时使用默认 8192', () => {
            state.thinkingEnabled = true;
            state.thinkingBudget = 0;
            expect(buildThinkingConfig('openclaw').thinking.budget_tokens).toBe(8192);
        });
    });

    describe('未知格式', () => {
        it('返回 null', () => {
            state.thinkingEnabled = true;
            expect(buildThinkingConfig('unknown')).toBeNull();
        });
    });
});

// ========== buildVerbosityConfig ==========

describe('buildVerbosityConfig', () => {
    it('未启用时返回 null', () => {
        expect(buildVerbosityConfig()).toBeNull();
    });

    it('启用且有 verbosity 值', () => {
        state.verbosityEnabled = true;
        state.outputVerbosity = 'high';
        expect(buildVerbosityConfig()).toEqual({ text: { verbosity: 'high' } });
    });

    it('启用但 outputVerbosity 为空字符串返回 null', () => {
        state.verbosityEnabled = true;
        state.outputVerbosity = '';
        expect(buildVerbosityConfig()).toBeNull();
    });
});

// ========== getCustomHeadersObject ==========

describe('getCustomHeadersObject', () => {
    it('空数组返回空对象', () => {
        state.customHeaders = [];
        expect(getCustomHeadersObject()).toEqual({});
    });

    it('有效 key-value 对', () => {
        state.customHeaders = [
            { key: 'X-Custom', value: 'test' },
            { key: 'Authorization', value: 'Bearer xxx' }
        ];
        expect(getCustomHeadersObject()).toEqual({
            'X-Custom': 'test',
            Authorization: 'Bearer xxx'
        });
    });

    it('跳过空 key', () => {
        state.customHeaders = [
            { key: '', value: 'test' },
            { key: 'X-Valid', value: 'ok' }
        ];
        expect(getCustomHeadersObject()).toEqual({ 'X-Valid': 'ok' });
    });

    it('跳过空 value', () => {
        state.customHeaders = [
            { key: 'X-Empty', value: '' },
            { key: 'X-Valid', value: 'ok' }
        ];
        expect(getCustomHeadersObject()).toEqual({ 'X-Valid': 'ok' });
    });

    it('重复 key 使用最后一个值', () => {
        state.customHeaders = [
            { key: 'X-Dup', value: 'first' },
            { key: 'X-Dup', value: 'second' }
        ];
        expect(getCustomHeadersObject()).toEqual({ 'X-Dup': 'second' });
    });
});
