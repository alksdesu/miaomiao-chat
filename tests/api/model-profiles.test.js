/**
 * model-profiles.js 模型能力表测试
 */
import { describe, it, expect } from 'vitest';
import { resolveModelProfile, listProfileIds } from '../../js/api/model-profiles.js';

function isDeepFrozen(value) {
    if (!value || typeof value !== 'object') return true;
    return Object.isFrozen(value) && Object.values(value).every(isDeepFrozen);
}

describe('resolveModelProfile 通用行为', () => {
    it('结果深度冻结', () => {
        expect(isDeepFrozen(resolveModelProfile('claude', 'claude-opus-5-5'))).toBe(true);
        expect(isDeepFrozen(resolveModelProfile('gemini', 'unknown-model'))).toBe(true);
    });

    it('不在能力表中的格式返回空能力', () => {
        expect(resolveModelProfile('openclaw', 'anything')).toEqual({
            id: null,
            known: false,
            family: null
        });
    });

    it('未识别的模型返回该格式的宽松默认值', () => {
        const profile = resolveModelProfile('claude', 'claude-3-7-sonnet-latest');
        expect(profile.known).toBe(false);
        expect(profile.id).toBeNull();
        expect(profile.family).toBe('claude');
        expect(profile.sampling).toBe(true);
        expect(profile.assistantPrefill).toBe(true);
        expect(profile.reasoning.modes).toEqual(['adaptive', 'budget']);
    });

    it('空模型 ID 视为未识别', () => {
        expect(resolveModelProfile('openai', '').known).toBe(false);
        expect(resolveModelProfile('openai', undefined).known).toBe(false);
    });

    it('别名优先于模型 ID，大小写与首尾空白不敏感', () => {
        const profile = resolveModelProfile('claude', 'my-proxy-model', {
            alias: '  Claude-Sonnet-5-5 '
        });
        expect(profile.id).toBe('claude-sonnet-5-5');
        expect(profile.known).toBe(true);
    });

    it('别名为空时回落模型 ID', () => {
        expect(resolveModelProfile('openai', 'gpt-5.5', { alias: '' }).id).toBe('gpt-5.5');
        expect(resolveModelProfile('openai', 'gpt-5.5', { alias: null }).id).toBe('gpt-5.5');
    });

    it('多次解析互不影响', () => {
        const a = resolveModelProfile('gemini', 'gemini-4-argon');
        const b = resolveModelProfile('gemini', 'gemini-4-argon');
        expect(a).toEqual(b);
        expect(a).not.toBe(b);
    });
});

describe('Claude', () => {
    it.each([
        ['claude-opus-5-5', 'claude-opus-5-5'],
        ['claude-opus-5-6', 'claude-opus-5-5'],
        ['anthropic/claude-sonnet-5-5', 'claude-sonnet-5-5'],
        ['claude-sonnet-4-5-20250929', 'claude-sonnet-4-5'],
        ['us.anthropic.claude-haiku-4-5-20251001-v1:0', 'claude-haiku-4-5'],
        ['claude-opus-4-5@20251101', 'claude-opus-4-5'],
        ['claude-opus-4-20250514', 'claude-opus-4-1'],
        ['claude-sonnet-4-20250514', 'claude-sonnet-4-5'],
        ['claude-fable-5-1', 'claude-fable-5-1'],
        ['claude-fable-5', 'claude-fable-5'],
        ['claude-mythos-5-1', 'claude-mythos-5-1'],
        ['claude-opus-4-8', 'claude-opus-4-8'],
        ['claude-opus-4-7', 'claude-opus-4-7'],
        ['claude-sonnet-4-6', 'claude-sonnet-4-6']
    ])('%s 命中 %s', (modelId, expected) => {
        expect(resolveModelProfile('claude', modelId).id).toBe(expected);
    });

    it('5.5 系列：始终思考、仅 adaptive、强制绑定、采样与预填充不可用、使用 computer toolset', () => {
        const profile = resolveModelProfile('claude', 'claude-opus-5-5');
        expect(profile.reasoning).toEqual({
            modes: ['adaptive'],
            alwaysOn: true,
            efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
            display: true,
            blockBinding: true
        });
        expect(profile.sampling).toBe(false);
        expect(profile.assistantPrefill).toBe(false);
        expect(profile.computerUse).toEqual({ type: 'computer_toolset_20260801', beta: null });
    });

    it('Opus 4.8 / 4.7：仅 adaptive 但默认不思考', () => {
        const profile = resolveModelProfile('claude', 'claude-opus-4-8');
        expect(profile.reasoning.modes).toEqual(['adaptive']);
        expect(profile.reasoning.alwaysOn).toBe(false);
        expect(profile.sampling).toBe(false);
    });

    it('4.6 系列：adaptive 与 budget 并存，effort 无 xhigh，不接受末尾预填充', () => {
        const profile = resolveModelProfile('claude', 'claude-opus-4-6');
        expect(profile.reasoning.modes).toEqual(['adaptive', 'budget']);
        expect(profile.reasoning.efforts).toEqual(['low', 'medium', 'high', 'max']);
        expect(profile.sampling).toBe(true);
        expect(profile.assistantPrefill).toBe(false);
    });

    it('4.5 及更早：仅 budget，computer 工具版本按型号区分', () => {
        expect(resolveModelProfile('claude', 'claude-opus-4-5').computerUse).toEqual({
            type: 'computer_20251124',
            beta: 'computer-use-2025-11-24'
        });
        for (const modelId of ['claude-sonnet-4-5', 'claude-haiku-4-5', 'claude-opus-4-1']) {
            const profile = resolveModelProfile('claude', modelId);
            expect(profile.reasoning.modes).toEqual(['budget']);
            expect(profile.computerUse).toEqual({
                type: 'computer_20250124',
                beta: 'computer-use-2025-01-24'
            });
        }
    });
});

describe('OpenAI', () => {
    it.each([
        ['gpt-5.5', 'gpt-5.5'],
        ['openai/gpt-5.5', 'gpt-5.5'],
        ['gpt-5', 'gpt-5'],
        ['gpt-5-mini', 'gpt-5'],
        ['gpt-5.6', 'gpt-5.6'],
        ['gpt-5.6-terra', 'gpt-5.6-terra'],
        ['gpt-6-astra', 'gpt-6-astra'],
        ['gpt-6.1-sol', 'gpt-6.1-sol'],
        ['gpt-6-sol', 'gpt-6-sol'],
        ['o3', 'o-series'],
        ['o4-mini', 'o-series'],
        ['gpt-4o', 'gpt-4o'],
        ['gpt-4o-mini', 'gpt-4o'],
        ['gpt-4.1', 'gpt-4.1']
    ])('%s 命中 %s', (modelId, expected) => {
        expect(resolveModelProfile('openai', modelId).id).toBe(expected);
    });

    it.each(['gpt-5.5-pro', 'gpt-5-chat-latest', 'gpt-5.1-codex', 'deepseek-chat'])(
        '%s 不套用基础型号约束',
        (modelId) => {
            expect(resolveModelProfile('openai', modelId).known).toBe(false);
        }
    );

    it('Responses 与 Chat 共用同一张表', () => {
        expect(resolveModelProfile('openai-responses', 'gpt-6-sol')).toEqual(
            resolveModelProfile('openai', 'gpt-6-sol')
        );
    });

    it('Astra / 6.1 Sol 不支持 none，采样参数与 Chat 工具不可用', () => {
        const profile = resolveModelProfile('openai', 'gpt-6-astra');
        expect(profile.reasoning.efforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
        expect(profile.sampling).toBe('never');
        expect(profile.chatTools).toBe('never');
    });

    it('6 Sol / Luna 仅在 effort none 时接受采样参数与 Chat 工具', () => {
        const profile = resolveModelProfile('openai', 'gpt-6-luna');
        expect(profile.reasoning.efforts[0]).toBe('none');
        expect(profile.sampling).toBe('effort-none');
        expect(profile.chatTools).toBe('effort-none');
    });

    it('推理模型使用 max_completion_tokens 并请求流式 usage，未识别模型保持旧字段', () => {
        expect(resolveModelProfile('openai', 'gpt-5.5').maxTokensParam).toBe(
            'max_completion_tokens'
        );
        expect(resolveModelProfile('openai', 'gpt-5.5').streamUsage).toBe(true);
        expect(resolveModelProfile('openai', 'my-model').maxTokensParam).toBe('max_tokens');
        expect(resolveModelProfile('openai', 'my-model').streamUsage).toBe(false);
    });

    it('默认 effort 与可选档位按型号区分', () => {
        expect(resolveModelProfile('openai', 'gpt-5.4').reasoning.defaultEffort).toBe('none');
        expect(resolveModelProfile('openai', 'gpt-5.5').reasoning.defaultEffort).toBe('medium');
        expect(resolveModelProfile('openai', 'gpt-5').reasoning.efforts).toEqual([
            'minimal',
            'low',
            'medium',
            'high'
        ]);
    });
});

describe('Gemini', () => {
    it.each([
        ['gemini-3.1-flash-lite-image', 'gemini-3.1-flash-lite-image'],
        ['gemini-3.1-flash-lite', 'gemini-3.1-flash-lite'],
        ['gemini-3.1-flash-image', 'gemini-3.1-flash-image'],
        ['gemini-3-pro-image', 'gemini-3-pro-image'],
        ['gemini-3-pro', 'gemini-3-pro'],
        ['gemini-3.1-pro-preview', 'gemini-3.1-pro'],
        ['models/gemini-2.5-pro', 'gemini-2.5-pro'],
        ['gemini-2.5-flash-lite', 'gemini-2.5-flash-lite'],
        ['gemini-2.5-flash-image', 'gemini-2.5-flash-image'],
        ['gemini-nano-banana-2.1', 'gemini-nano-banana-2.1'],
        ['gemini-4-argon', 'gemini-4-argon']
    ])('%s 命中 %s', (modelId, expected) => {
        expect(resolveModelProfile('gemini', modelId).id).toBe(expected);
    });

    it('未识别模型沿用旧推断规则与面板出图配置', () => {
        const profile = resolveModelProfile('gemini', 'gemini-proxy-x');
        expect(profile.known).toBe(false);
        expect(profile.thinking.mode).toBe('auto');
        expect(profile.image.output).toBeNull();
    });

    it('Argon：level 档位、忽略采样参数、长解码与超时下限', () => {
        const profile = resolveModelProfile('gemini', 'gemini-4-argon');
        expect(profile.thinking).toEqual({
            mode: 'level',
            levels: ['low', 'medium', 'high'],
            budgetRange: null
        });
        expect(profile.sampling).toBe('ignored');
        expect(profile.longDecode).toBe(true);
        expect(profile.minTimeoutMs).toBe(20 * 60 * 1000);
        expect(profile.image.output).toBe(false);
    });

    it('2.5 系列使用预算区间', () => {
        expect(resolveModelProfile('gemini', 'gemini-2.5-pro').thinking).toEqual({
            mode: 'budget',
            levels: null,
            budgetRange: [128, 32768]
        });
        expect(resolveModelProfile('gemini', 'gemini-2.5-flash').thinking.budgetRange).toEqual([
            0, 24576
        ]);
    });

    it('出图模型声明尺寸与宽高比', () => {
        const nano = resolveModelProfile('gemini', 'gemini-nano-banana-2.1');
        expect(nano.image.output).toBe(true);
        expect(nano.image.sizes).toEqual(['1K', '2K', '4K']);
        expect(nano.image.aspectRatios).toContain('8:1');

        const lite = resolveModelProfile('gemini', 'gemini-3.1-flash-lite-image');
        expect(lite.image.sizes).toEqual(['1K']);
        expect(lite.image.aspectRatios).not.toContain('8:1');

        expect(resolveModelProfile('gemini', 'gemini-2.5-flash-image').image.sizes).toEqual([]);
    });
});

describe('OpenAI Image', () => {
    it('2.5 系列支持 xhigh / max 画质，不接受 input_fidelity', () => {
        const profile = resolveModelProfile('openai-image', 'gpt-image-2.5-sunburst');
        expect(profile.qualities).toEqual(['auto', 'low', 'medium', 'high', 'xhigh', 'max']);
        expect(profile.inputFidelity).toBe(false);
    });

    it('gpt-image-2 不接受 input_fidelity，1.x 接受', () => {
        expect(resolveModelProfile('openai-image', 'gpt-image-2').inputFidelity).toBe(false);
        expect(resolveModelProfile('openai-image', 'gpt-image-1.5').inputFidelity).toBe(true);
        expect(resolveModelProfile('openai-image', 'gpt-image-1-mini').id).toBe('gpt-image-1-mini');
    });

    it('未识别模型不限制画质', () => {
        expect(resolveModelProfile('openai-image', 'dall-e-3').qualities).toBeNull();
    });
});

describe('listProfileIds', () => {
    it('列出可作为别名的官方型号', () => {
        expect(listProfileIds('claude')).toContain('claude-opus-5-5');
        expect(listProfileIds('gemini')).toContain('gemini-4-argon');
        expect(listProfileIds('openai-responses')).toContain('gpt-5.5');
    });

    it('不暴露内部分组 ID', () => {
        expect(listProfileIds('openai')).not.toContain('o-series');
    });

    it('无能力表的格式返回空数组', () => {
        expect(listProfileIds('openclaw')).toEqual([]);
    });
});
