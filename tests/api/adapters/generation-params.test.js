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

        it('启用且有档位时以顶层 verbosity 发送', () => {
            expect(
                generate('openai', {
                    settings: { verbosityEnabled: true, outputVerbosity: 'high' }
                }).verbosityCfg
            ).toEqual({ verbosity: 'high' });
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
    it('共用 openai 参数组，输出上限字段为 max_output_tokens', () => {
        const { modelParams } = generate('openai-responses', {
            paramsKey: 'openai',
            params: { temperature: 0.8, max_tokens: 2048 }
        });
        expect(modelParams).toEqual({ temperature: 0.8, max_output_tokens: 2048 });
    });

    it('Responses 不支持 penalty 参数，丢弃并提示', () => {
        const result = generate('openai-responses', {
            paramsKey: 'openai',
            params: OPENAI_FULL_PARAMS
        });
        expect(result.modelParams).toEqual({
            temperature: 0.7,
            top_p: 0.9,
            max_output_tokens: 1024
        });
        expect(result.notices).toEqual([
            expect.objectContaining({ key: 'openai-responses.penalties' })
        ]);
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

// ========== OpenAI 按型号约束 ==========

describe('OpenAI 按型号约束', () => {
    const chat = (model, { settings = {}, params = null, nativeTools = false } = {}) => {
        const stateRef = { ...createState(), ...settings };
        if (params) stateRef.modelParams.openai = { ...stateRef.modelParams.openai, ...params };
        return getAdapter('openai').buildGenerationParams(
            captureGenerationSettings('openai', stateRef),
            { model, profile: resolveModelProfile('openai', model), nativeTools }
        );
    };
    const responses = (model, options = {}) =>
        generate('openai-responses', { model, paramsKey: 'openai', ...options });

    describe('Chat Completions', () => {
        it('已识别的型号用 max_completion_tokens，未识别的沿用 max_tokens', () => {
            const params = { max_tokens: 1000 };
            expect(chat('gpt-5.5', { params }).modelParams).toEqual({
                max_completion_tokens: 1000
            });
            expect(chat('my-proxy-model', { params }).modelParams).toEqual({ max_tokens: 1000 });
        });

        it('max 强度对未识别的型号原样发送，对不支持的型号收敛并提示', () => {
            const settings = { thinkingEnabled: true, thinkingStrength: 'max' };
            expect(chat('my-proxy-model', { settings }).thinkingCfg).toEqual({
                reasoning_effort: 'max'
            });
            const result = chat('gpt-5.5', { settings });
            expect(result.thinkingCfg).toEqual({ reasoning_effort: 'xhigh' });
            expect(result.notices).toEqual([
                expect.objectContaining({
                    key: 'openai.effort',
                    message: expect.stringContaining('max')
                })
            ]);
        });

        it('没有更低档位时向上收敛，不会收敛到 none', () => {
            const settings = { thinkingEnabled: true, thinkingStrength: 'minimal' };
            expect(chat('gpt-6.1-sol', { settings }).thinkingCfg).toEqual({
                reasoning_effort: 'low'
            });
            expect(chat('gpt-5.5', { settings }).thinkingCfg).toEqual({
                reasoning_effort: 'low'
            });
        });

        it('非推理型号不发 reasoning_effort 与 verbosity 并提示', () => {
            const result = chat('gpt-4o', {
                settings: {
                    thinkingEnabled: true,
                    verbosityEnabled: true,
                    outputVerbosity: 'low'
                }
            });
            expect(result.thinkingCfg).toBeNull();
            expect(result.verbosityCfg).toBeNull();
            expect(result.notices.map((notice) => notice.key)).toEqual([
                'openai.reasoning-unsupported',
                'openai.verbosity'
            ]);
        });

        it('只在推理强度为 none 时接受采样参数的型号按实际生效的强度判断', () => {
            const params = { temperature: 0.5, top_p: 0.9, frequency_penalty: 0.2 };
            const byDefault = chat('gpt-5.5', { params });
            expect(byDefault.modelParams).toEqual({});
            expect(byDefault.notices).toEqual([
                expect.objectContaining({ key: 'openai.sampling' })
            ]);
            // gpt-5.4 的默认推理强度就是 none
            expect(chat('gpt-5.4', { params }).modelParams).toEqual(params);
            expect(
                chat('gpt-5.5', { params, settings: { thinkingNoneMode: true } }).modelParams
            ).toEqual(params);
        });

        it('完全不接受采样参数的型号丢弃并提示', () => {
            const result = chat('gpt-5', { params: { temperature: 0.5 } });
            expect(result.modelParams).toEqual({});
            expect(result.notices[0].message).toContain('不接受');
        });

        it('关闭推理时只对已识别且支持 none 的型号发送 none', () => {
            const settings = { thinkingNoneMode: true };
            expect(chat('gpt-5.5', { settings }).thinkingCfg).toEqual({
                reasoning_effort: 'none'
            });
            expect(chat('my-proxy-model', { settings }).thinkingCfg).toBeNull();
            const astra = chat('gpt-6-astra', { settings });
            expect(astra.thinkingCfg).toBeNull();
            expect(astra.notices).toEqual([expect.objectContaining({ key: 'openai.effort-none' })]);
        });

        it('只在推理强度为 none 时能带工具的型号带原生工具时改为 none 并提示', () => {
            const settings = { thinkingEnabled: true, thinkingStrength: 'high' };
            const withTools = chat('gpt-6-sol', { settings, nativeTools: true });
            expect(withTools.thinkingCfg).toEqual({ reasoning_effort: 'none' });
            expect(withTools.notices).toEqual([
                expect.objectContaining({ key: 'openai.chat-tools-effort' })
            ]);
            expect(chat('gpt-6-sol', { settings }).thinkingCfg).toEqual({
                reasoning_effort: 'high'
            });
        });
    });

    describe('Responses', () => {
        it('关闭推理时未识别的型号沿用 none 设置，已识别但不支持 none 的型号省略并提示', () => {
            const settings = { thinkingNoneMode: true };
            expect(responses('my-proxy-model', { settings }).thinkingCfg).toEqual({
                reasoning: { effort: 'none' }
            });
            const astra = responses('gpt-6-astra', { settings });
            expect(astra.thinkingCfg).toBeNull();
            expect(astra.notices).toEqual([expect.objectContaining({ key: 'openai.effort-none' })]);
        });

        it('推理强度收敛到型号支持的档位', () => {
            expect(
                responses('gpt-6-astra', {
                    settings: { thinkingEnabled: true, thinkingStrength: 'minimal' }
                }).thinkingCfg
            ).toEqual({ reasoning: { effort: 'low', summary: 'auto' } });
        });

        it('输出详细度写在 text.verbosity', () => {
            expect(
                responses('gpt-5.5', {
                    settings: { verbosityEnabled: true, outputVerbosity: 'low' }
                }).verbosityCfg
            ).toEqual({ text: { verbosity: 'low' } });
        });

        it('采样参数按实际生效的推理强度判断', () => {
            expect(
                responses('gpt-5.5', {
                    params: { temperature: 0.5 },
                    settings: { thinkingEnabled: true, thinkingStrength: 'low' }
                }).modelParams
            ).toEqual({});
            expect(
                responses('gpt-5.5', {
                    params: { temperature: 0.5 },
                    settings: { thinkingNoneMode: true }
                }).modelParams
            ).toEqual({ temperature: 0.5 });
        });
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

    it('未识别的型号不产生提示', () => {
        expect(generate('claude', { params: { temperature: 0.5 } }).notices).toEqual([]);
    });

    describe('按型号约束', () => {
        const binding = { prefix_mismatch_behavior: 'drop_block' };

        it('默认开启思考的型号关闭开关时发 adaptive + 最低 effort', () => {
            expect(generate('claude', { model: 'claude-opus-5-5' }).thinkingCfg).toEqual({
                thinking: { type: 'adaptive', block_binding: binding },
                output_config: { effort: 'low' }
            });
        });

        it('默认不思考的型号关闭开关时不发 thinking', () => {
            expect(generate('claude', { model: 'claude-opus-4-7' }).thinkingCfg).toBeNull();
        });

        it('只有校验会话前缀的型号带 block_binding', () => {
            const settings = { thinkingEnabled: true, claudeAdaptiveThinking: true };
            expect(
                generate('claude', { model: 'claude-sonnet-5-5', settings }).thinkingCfg.thinking
                    .block_binding
            ).toEqual(binding);
            expect(
                generate('claude', { model: 'claude-opus-5', settings }).thinkingCfg.thinking
            ).not.toHaveProperty('block_binding');
        });

        it('预算制设置在只支持 adaptive 的型号上换算为 effort 并提示', () => {
            const result = generate('claude', {
                model: 'claude-sonnet-5',
                settings: { thinkingEnabled: true, thinkingStrength: 'medium' }
            });
            expect(result.thinkingCfg).toEqual({
                thinking: { type: 'adaptive' },
                output_config: { effort: 'medium' }
            });
            expect(result.notices).toEqual([
                expect.objectContaining({ key: 'claude.budget-unsupported' })
            ]);
        });

        it.each([
            [2048, 'low'],
            [5119, 'low'],
            [5120, 'medium'],
            [12287, 'medium'],
            [12288, 'high'],
            [65536, 'high']
        ])('自定义预算 %i 换算为 %s', (budget, effort) => {
            expect(
                generate('claude', {
                    model: 'claude-opus-4-8',
                    settings: {
                        thinkingEnabled: true,
                        thinkingStrength: 'custom',
                        thinkingBudget: budget
                    }
                }).thinkingCfg.output_config.effort
            ).toBe(effort);
        });

        it('adaptive 设置在预算制型号上换算为思考预算并提示', () => {
            const result = generate('claude', {
                model: 'claude-haiku-4-5',
                settings: {
                    thinkingEnabled: true,
                    claudeAdaptiveThinking: true,
                    claudeEffortLevel: 'medium'
                }
            });
            expect(result.thinkingCfg).toEqual({
                thinking: { type: 'enabled', budget_tokens: 8192 }
            });
            expect(result.notices).toEqual([
                expect.objectContaining({ key: 'claude.adaptive-unsupported' })
            ]);
        });

        it('effort 收敛到型号支持的档位', () => {
            expect(
                generate('claude', {
                    model: 'claude-sonnet-4-6',
                    settings: {
                        thinkingEnabled: true,
                        claudeAdaptiveThinking: true,
                        claudeEffortLevel: 'xhigh'
                    }
                }).thinkingCfg.output_config.effort
            ).toBe('high');
        });

        it('拒绝采样参数的型号整体丢弃并提示', () => {
            const result = generate('claude', {
                model: 'claude-opus-5-5',
                params: { temperature: 0.7, top_p: 0.9, top_k: 40 }
            });
            expect(result.modelParams).toEqual({ max_tokens: 64000 });
            expect(result.notices).toEqual([
                expect.objectContaining({
                    key: 'claude.sampling',
                    message: expect.stringContaining('temperature / top_p / top_k')
                })
            ]);
        });

        it('开启思考时 temperature 固定为 1、top_p 抬到 0.95、去掉 top_k 并提示', () => {
            const result = generate('claude', {
                model: 'claude-sonnet-4-6',
                settings: { thinkingEnabled: true },
                params: { temperature: 0.7, top_p: 0.8, top_k: 40 }
            });
            expect(result.modelParams).toEqual({ max_tokens: 64000, temperature: 1, top_p: 0.95 });
            expect(result.notices).toEqual([
                expect.objectContaining({ key: 'claude.thinking-sampling' })
            ]);
        });

        it('未开启思考时采样参数原样发送且不提示', () => {
            const result = generate('claude', {
                model: 'claude-sonnet-4-6',
                params: { temperature: 0.7, top_p: 0.8, top_k: 40 }
            });
            expect(result.modelParams).toEqual({
                max_tokens: 64000,
                temperature: 0.7,
                top_p: 0.8,
                top_k: 40
            });
            expect(result.notices).toEqual([]);
        });

        it('显示思考摘要时请求 summarized', () => {
            expect(
                generate('claude', {
                    model: 'claude-opus-5-5',
                    settings: { claudeShowThinking: true }
                }).thinkingCfg.thinking.display
            ).toBe('summarized');
        });
    });
});
