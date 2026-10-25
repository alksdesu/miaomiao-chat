/**
 * 各 adapter.buildGenerationParams 测试：设置面板快照 → 自家 wire 字段
 */
// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../js/core/state.js', () => ({ state: {}, elements: {} }));

vi.mock('../../../js/utils/logger.js', () => ({
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

vi.mock('../../../js/providers/manager.js', () => ({
    getCurrentProvider: vi.fn(() => null)
}));

import { getAdapter } from '../../../js/api/adapters/index.js';
import { captureGenerationSettings } from '../../../js/api/params.js';
import { resolveModelProfile } from '../../../js/api/model-profiles.js';

function createState() {
    return {
        modelParams: {
            openai: {
                temperature: null,
                max_tokens: null,
                top_p: null,
                frequency_penalty: null,
                presence_penalty: null
            },
            'openai-image': {
                size: null,
                customSize: '',
                quality: null,
                output_format: null,
                output_compression: null,
                background: null,
                moderation: null,
                input_fidelity: null,
                n: 1,
                partial_images: 0
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
        claudeShowThinking: false,
        verbosityEnabled: false,
        outputVerbosity: 'medium',
        streamEnabled: true
    };
}

/**
 * @param {string} format
 * @param {Object} [options]
 * @param {string} [options.model]
 * @param {Object} [options.settings]   顶层 state 覆盖
 * @param {Object} [options.params]     state.modelParams[paramsKey] 覆盖
 * @param {string} [options.paramsKey]
 */
function generate(format, { model = '', settings = {}, params = null, paramsKey = format } = {}) {
    const stateRef = { ...createState(), ...settings };
    if (params) {
        stateRef.modelParams[paramsKey] = { ...stateRef.modelParams[paramsKey], ...params };
    }
    return getAdapter(format).buildGenerationParams(captureGenerationSettings(format, stateRef), {
        model,
        profile: resolveModelProfile(format, model)
    });
}

const OPENAI_FULL_PARAMS = {
    temperature: 0.7,
    max_tokens: 1024,
    top_p: 0.9,
    frequency_penalty: 0.5,
    presence_penalty: 0.3
};

// ========== OpenAI Chat ==========

describe('OpenAI Chat', () => {
    describe('modelParams', () => {
        it('所有参数为 null 时返回空对象', () => {
            expect(generate('openai').modelParams).toEqual({});
        });

        it('非 null 参数被包含', () => {
            expect(generate('openai', { params: OPENAI_FULL_PARAMS }).modelParams).toEqual(
                OPENAI_FULL_PARAMS
            );
        });

        it('部分参数为 null 时只包含非 null', () => {
            expect(generate('openai', { params: { temperature: 0.5 } }).modelParams).toEqual({
                temperature: 0.5
            });
        });

        it('temperature 为 0 时仍包含', () => {
            expect(generate('openai', { params: { temperature: 0 } }).modelParams).toEqual({
                temperature: 0
            });
        });
    });

    describe('thinkingCfg', () => {
        it('未启用时为 null', () => {
            expect(generate('openai').thinkingCfg).toBeNull();
        });

        it.each(['minimal', 'low', 'medium', 'high', 'xhigh'])('%s 强度原样发送', (strength) => {
            expect(
                generate('openai', {
                    settings: { thinkingEnabled: true, thinkingStrength: strength }
                }).thinkingCfg
            ).toEqual({ reasoning_effort: strength });
        });

        it('custom 强度转为 high', () => {
            expect(
                generate('openai', {
                    settings: { thinkingEnabled: true, thinkingStrength: 'custom' }
                }).thinkingCfg
            ).toEqual({ reasoning_effort: 'high' });
        });

        it('无效强度转为 high', () => {
            expect(
                generate('openai', {
                    settings: { thinkingEnabled: true, thinkingStrength: 'invalid' }
                }).thinkingCfg
            ).toEqual({ reasoning_effort: 'high' });
        });
    });

    describe('verbosityCfg', () => {
        it('未启用时为 null', () => {
            expect(generate('openai').verbosityCfg).toBeNull();
        });

        it('启用且有档位', () => {
            expect(
                generate('openai', {
                    settings: { verbosityEnabled: true, outputVerbosity: 'high' }
                }).verbosityCfg
            ).toEqual({ text: { verbosity: 'high' } });
        });

        it('启用但档位为空字符串时为 null', () => {
            expect(
                generate('openai', { settings: { verbosityEnabled: true, outputVerbosity: '' } })
                    .verbosityCfg
            ).toBeNull();
        });
    });
});

// ========== OpenAI Responses ==========

describe('OpenAI Responses', () => {
    it('共用 openai 参数组', () => {
        const { modelParams } = generate('openai-responses', {
            paramsKey: 'openai',
            params: { temperature: 0.8, max_tokens: 2048 }
        });
        expect(modelParams).toEqual({ temperature: 0.8, max_tokens: 2048 });
    });

    it('penalty 参数照常发送', () => {
        expect(
            generate('openai-responses', { paramsKey: 'openai', params: OPENAI_FULL_PARAMS })
                .modelParams
        ).toEqual(OPENAI_FULL_PARAMS);
    });

    describe('thinkingCfg', () => {
        it('未启用且 none 模式关闭时为 null', () => {
            expect(generate('openai-responses').thinkingCfg).toBeNull();
        });

        it('未启用但 none 模式开启时发送 effort none', () => {
            expect(
                generate('openai-responses', { settings: { thinkingNoneMode: true } }).thinkingCfg
            ).toEqual({ reasoning: { effort: 'none' } });
        });

        it('启用时返回 reasoning 对象并请求摘要', () => {
            expect(
                generate('openai-responses', {
                    settings: { thinkingEnabled: true, thinkingStrength: 'high' }
                }).thinkingCfg
            ).toEqual({ reasoning: { effort: 'high', summary: 'auto' } });
        });

        it('custom 强度转为 high', () => {
            expect(
                generate('openai-responses', {
                    settings: { thinkingEnabled: true, thinkingStrength: 'custom' }
                }).thinkingCfg.reasoning.effort
            ).toBe('high');
        });
    });

    it('verbosity 启用时发送 text.verbosity', () => {
        expect(
            generate('openai-responses', {
                settings: { verbosityEnabled: true, outputVerbosity: 'low' }
            }).verbosityCfg
        ).toEqual({ text: { verbosity: 'low' } });
    });
});

// ========== OpenClaw ==========

describe('OpenClaw', () => {
    it('共用 openai 参数组但不发送 penalty', () => {
        const { modelParams } = generate('openclaw', {
            paramsKey: 'openai',
            params: { ...OPENAI_FULL_PARAMS, top_p: null }
        });
        expect(modelParams).toEqual({ temperature: 0.7, max_tokens: 1024 });
    });

    it('思维链未启用时为 null', () => {
        expect(generate('openclaw').thinkingCfg).toBeNull();
    });

    it('启用时透传 budget_tokens', () => {
        expect(
            generate('openclaw', { settings: { thinkingEnabled: true, thinkingBudget: 12345 } })
                .thinkingCfg
        ).toEqual({ thinking: { budget_tokens: 12345 } });
    });

    it('budget 为空时使用默认 8192', () => {
        expect(
            generate('openclaw', { settings: { thinkingEnabled: true, thinkingBudget: 0 } })
                .thinkingCfg.thinking.budget_tokens
        ).toBe(8192);
    });

    it('协议不消费 verbosity', () => {
        expect(
            generate('openclaw', { settings: { verbosityEnabled: true, outputVerbosity: 'low' } })
                .verbosityCfg
        ).toBeNull();
    });
});

// ========== OpenAI Image ==========

describe('OpenAI Image', () => {
    it('使用独立图片参数，不继承聊天采样参数', () => {
        const stateOverrides = {
            settings: { thinkingEnabled: true, verbosityEnabled: true, outputVerbosity: 'low' },
            params: {
                size: 'custom',
                customSize: '1536x864',
                quality: 'high',
                output_format: 'webp',
                output_compression: 75,
                n: 2,
                partial_images: 1
            }
        };
        const result = generate('openai-image', stateOverrides);
        expect(result).toEqual({
            modelParams: {
                size: '1536x864',
                quality: 'high',
                output_format: 'webp',
                output_compression: 75,
                n: 2,
                partial_images: 1
            },
            thinkingCfg: null,
            verbosityCfg: null
        });
    });

    it('非流式时不发送 partial_images', () => {
        expect(
            generate('openai-image', {
                settings: { streamEnabled: false },
                params: { partial_images: 2 }
            }).modelParams.partial_images
        ).toBeUndefined();
    });
});

// ========== Gemini ==========

describe('Gemini', () => {
    describe('modelParams', () => {
        it('所有参数为 null 时采样参数用默认值，maxOutputTokens 不传', () => {
            expect(generate('gemini').modelParams).toEqual({
                temperature: 1,
                topK: 40,
                topP: 0.95
            });
        });

        it('maxOutputTokens 显式设置时传', () => {
            expect(
                generate('gemini', {
                    params: { temperature: 0.3, topK: 20, topP: null, maxOutputTokens: 4096 }
                }).modelParams
            ).toEqual({ temperature: 0.3, topK: 20, topP: 0.95, maxOutputTokens: 4096 });
        });
    });

    describe('thinkingCfg', () => {
        const thinking = (model, strength, extra = {}) =>
            generate('gemini', {
                model,
                settings: { thinkingEnabled: true, thinkingStrength: strength, ...extra }
            }).thinkingCfg;

        it('未启用时为 null', () => {
            expect(generate('gemini', { model: 'gemini-2.5-flash' }).thinkingCfg).toBeNull();
        });

        it('Gemini 2.5 使用 thinkingBudget', () => {
            expect(thinking('gemini-2.5-flash', 'high')).toEqual({
                thinkingConfig: { thinkingBudget: 16384, includeThoughts: true }
            });
        });

        it('Gemini 2.5 medium 使用 8192，low 使用 4096', () => {
            expect(thinking('gemini-2.5-pro', 'medium').thinkingConfig.thinkingBudget).toBe(8192);
            expect(thinking('gemini-2.5-flash', 'low').thinkingConfig.thinkingBudget).toBe(4096);
        });

        it('Gemini 3 使用 thinkingLevel', () => {
            expect(thinking('gemini-3-flash', 'high')).toEqual({
                thinkingConfig: { thinkingLevel: 'HIGH', includeThoughts: true }
            });
            expect(thinking('gemini-3-pro', 'low').thinkingConfig.thinkingLevel).toBe('LOW');
        });

        it('minimal 规范化为 low，xhigh 规范化为 high', () => {
            expect(thinking('gemini-2.5-flash', 'minimal').thinkingConfig.thinkingBudget).toBe(
                4096
            );
            expect(thinking('gemini-2.5-flash', 'xhigh').thinkingConfig.thinkingBudget).toBe(16384);
        });

        it('custom 使用自定义 budget', () => {
            expect(
                thinking('gemini-2.5-flash', 'custom', { thinkingBudget: 50000 }).thinkingConfig
                    .thinkingBudget
            ).toBe(50000);
        });
    });

    it('不发送 verbosity', () => {
        expect(
            generate('gemini', { settings: { verbosityEnabled: true, outputVerbosity: 'low' } })
                .verbosityCfg
        ).toBeNull();
    });
});

// ========== Claude ==========

describe('Claude', () => {
    describe('modelParams', () => {
        it('max_tokens 未设置时回落流式默认值', () => {
            expect(generate('claude').modelParams.max_tokens).toBe(64000);
        });

        it('max_tokens 未设置且非流式时回落较保守的默认值', () => {
            expect(
                generate('claude', { settings: { streamEnabled: false } }).modelParams.max_tokens
            ).toBe(16000);
        });

        it('max_tokens 显式设置时优先使用', () => {
            expect(
                generate('claude', { params: { max_tokens: 4096 } }).modelParams.max_tokens
            ).toBe(4096);
        });

        it('adaptive thinking 开启时仍然发送 max_tokens（Messages API 必填）', () => {
            expect(
                generate('claude', {
                    settings: { thinkingEnabled: true, claudeAdaptiveThinking: true },
                    params: { max_tokens: 4096 }
                }).modelParams.max_tokens
            ).toBe(4096);
        });

        it('temperature 非 null 时包含', () => {
            expect(
                generate('claude', { params: { temperature: 0.5 } }).modelParams.temperature
            ).toBe(0.5);
        });

        it('thinking 模式强制 temperature 为 1', () => {
            expect(
                generate('claude', {
                    settings: { thinkingEnabled: true },
                    params: { temperature: 0.5 }
                }).modelParams.temperature
            ).toBe(1);
        });

        it('thinking 模式 temperature 为 null 时不强制', () => {
            expect(
                generate('claude', { settings: { thinkingEnabled: true } }).modelParams.temperature
            ).toBeUndefined();
        });

        it('top_k 非 null 时包含', () => {
            expect(generate('claude', { params: { top_k: 50 } }).modelParams.top_k).toBe(50);
        });
    });

    describe('thinkingCfg', () => {
        const thinking = (settings) =>
            generate('claude', { settings: { thinkingEnabled: true, ...settings } }).thinkingCfg;

        it('未启用时为 null', () => {
            expect(generate('claude').thinkingCfg).toBeNull();
        });

        it('传统 budget_tokens 模式', () => {
            expect(thinking({ thinkingStrength: 'high' })).toEqual({
                thinking: { type: 'enabled', budget_tokens: 16384 }
            });
        });

        it('low 使用 2048 tokens，medium 使用 8192 tokens', () => {
            expect(thinking({ thinkingStrength: 'low' }).thinking.budget_tokens).toBe(2048);
            expect(thinking({ thinkingStrength: 'medium' }).thinking.budget_tokens).toBe(8192);
        });

        it('custom 使用自定义 budget', () => {
            expect(
                thinking({ thinkingStrength: 'custom', thinkingBudget: 65536 }).thinking
                    .budget_tokens
            ).toBe(65536);
        });

        it('adaptive thinking 模式', () => {
            expect(thinking({ claudeAdaptiveThinking: true, claudeEffortLevel: 'high' })).toEqual({
                thinking: { type: 'adaptive' },
                output_config: { effort: 'high' }
            });
        });

        it('adaptive thinking 低 effort', () => {
            expect(
                thinking({ claudeAdaptiveThinking: true, claudeEffortLevel: 'low' }).output_config
                    .effort
            ).toBe('low');
        });

        it('adaptive thinking 无效 effort 回落 high', () => {
            expect(
                thinking({ claudeAdaptiveThinking: true, claudeEffortLevel: 'minimal' })
                    .output_config.effort
            ).toBe('high');
        });

        it('显示思考摘要时请求 summarized', () => {
            expect(
                thinking({ claudeAdaptiveThinking: true, claudeShowThinking: true }).thinking
            ).toEqual({ type: 'adaptive', display: 'summarized' });
        });
    });

    it('不发送 verbosity', () => {
        expect(
            generate('claude', { settings: { verbosityEnabled: true, outputVerbosity: 'low' } })
                .verbosityCfg
        ).toBeNull();
    });
});
