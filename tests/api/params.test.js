/**
 * params.js 请求参数采集测试
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// mock state — 工厂函数内只能用字面量，后续通过 import 获取引用
vi.mock('../../js/core/state.js', () => ({
    state: { customHeaders: [] }
}));

import { state } from '../../js/core/state.js';
import { captureGenerationSettings, getCustomHeadersObject } from '../../js/api/params.js';

function createState(overrides = {}) {
    return {
        modelParams: {
            openai: {
                temperature: 0.7,
                max_tokens: null,
                top_p: null,
                frequency_penalty: null,
                presence_penalty: null
            },
            'openai-image': { size: '1024x1024', quality: 'high', n: 1 },
            gemini: { temperature: 0.3, topK: null, topP: null, maxOutputTokens: null },
            claude: { temperature: null, max_tokens: 4096, top_p: null, top_k: null }
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
        streamEnabled: true,
        ...overrides
    };
}

beforeEach(() => {
    state.customHeaders = [];
});

// ========== captureGenerationSettings ==========

describe('captureGenerationSettings', () => {
    describe('userParams 来源', () => {
        it('按 apiFormat 取同名参数组', () => {
            const stateRef = createState();
            expect(captureGenerationSettings('claude', stateRef).userParams).toEqual(
                stateRef.modelParams.claude
            );
            expect(captureGenerationSettings('gemini', stateRef).userParams).toEqual(
                stateRef.modelParams.gemini
            );
            expect(captureGenerationSettings('openai-image', stateRef).userParams).toEqual(
                stateRef.modelParams['openai-image']
            );
        });

        it('Responses 与 OpenClaw 没有独立参数组时共用 openai 参数', () => {
            const stateRef = createState();
            expect(captureGenerationSettings('openai-responses', stateRef).userParams).toEqual(
                stateRef.modelParams.openai
            );
            expect(captureGenerationSettings('openclaw', stateRef).userParams).toEqual(
                stateRef.modelParams.openai
            );
        });

        it('modelParams 缺失时返回空对象', () => {
            expect(
                captureGenerationSettings('claude', createState({ modelParams: undefined }))
                    .userParams
            ).toEqual({});
        });

        it('返回副本，修改快照不影响 state', () => {
            const stateRef = createState();
            const settings = captureGenerationSettings('claude', stateRef);
            settings.userParams.max_tokens = 1;
            expect(stateRef.modelParams.claude.max_tokens).toBe(4096);
        });
    });

    describe('reasoning', () => {
        it('映射思维链相关设置', () => {
            const stateRef = createState({
                thinkingEnabled: true,
                thinkingStrength: 'custom',
                thinkingBudget: 12000,
                thinkingNoneMode: true,
                claudeAdaptiveThinking: true,
                claudeEffortLevel: 'max',
                claudeShowThinking: true
            });
            expect(captureGenerationSettings('claude', stateRef).reasoning).toEqual({
                enabled: true,
                strength: 'custom',
                budget: 12000,
                sendNoneWhenDisabled: true,
                adaptive: true,
                adaptiveEffort: 'max',
                showSummary: true
            });
        });
    });

    describe('verbosity', () => {
        it('未启用时为 null', () => {
            expect(captureGenerationSettings('openai', createState()).verbosity).toBeNull();
        });

        it('启用且有档位时返回档位', () => {
            const stateRef = createState({ verbosityEnabled: true, outputVerbosity: 'high' });
            expect(captureGenerationSettings('openai', stateRef).verbosity).toBe('high');
        });

        it('启用但档位为空字符串时为 null', () => {
            const stateRef = createState({ verbosityEnabled: true, outputVerbosity: '' });
            expect(captureGenerationSettings('openai', stateRef).verbosity).toBeNull();
        });
    });

    it('streamEnabled 转为布尔值', () => {
        expect(
            captureGenerationSettings('claude', createState({ streamEnabled: undefined }))
                .streamEnabled
        ).toBe(false);
        expect(captureGenerationSettings('claude', createState()).streamEnabled).toBe(true);
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
