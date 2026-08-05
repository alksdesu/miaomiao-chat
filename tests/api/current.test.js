/**
 * api/current.js 当前请求上下文测试
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../js/core/state.js', () => ({
    state: {
        apiFormat: 'openai'
    },
    elements: {
        modelSelect: null
    }
}));

vi.mock('../../js/providers/manager.js', () => ({
    getCurrentProvider: vi.fn(() => null),
    getActiveApiKey: vi.fn(() => '')
}));

import { getCurrentEndpoint, getCurrentApiKey, getCurrentModel } from '../../js/api/current.js';
import { state, elements } from '../../js/core/state.js';
import { getCurrentProvider, getActiveApiKey } from '../../js/providers/manager.js';

beforeEach(() => {
    vi.clearAllMocks();
    state.apiFormat = 'openai';
    elements.modelSelect = null;
});

describe('getCurrentEndpoint', () => {
    it('返回提供商端点', () => {
        getCurrentProvider.mockReturnValue({ endpoint: 'https://custom.api/v1' });
        expect(getCurrentEndpoint()).toBe('https://custom.api/v1');
    });

    it('提供商无端点时返回默认 OpenAI 端点', () => {
        getCurrentProvider.mockReturnValue({ endpoint: '' });
        state.apiFormat = 'openai';
        expect(getCurrentEndpoint()).toBe('https://api.openai.com/v1/chat/completions');
    });

    it('返回默认 Gemini 端点', () => {
        getCurrentProvider.mockReturnValue(null);
        state.apiFormat = 'gemini';
        expect(getCurrentEndpoint()).toBe('https://generativelanguage.googleapis.com');
    });

    it('返回默认 Claude 端点', () => {
        getCurrentProvider.mockReturnValue(null);
        state.apiFormat = 'claude';
        expect(getCurrentEndpoint()).toBe('https://api.anthropic.com/v1/messages');
    });

    it('返回默认 OpenAI Responses 端点', () => {
        getCurrentProvider.mockReturnValue(null);
        state.apiFormat = 'openai-responses';
        expect(getCurrentEndpoint()).toBe('https://api.openai.com/v1/responses');
    });

    it('返回默认 OpenAI Image 端点', () => {
        getCurrentProvider.mockReturnValue(null);
        state.apiFormat = 'openai-image';
        expect(getCurrentEndpoint()).toBe('https://api.openai.com/v1/images/generations');
    });

    it('返回默认 OpenClaw 端点', () => {
        getCurrentProvider.mockReturnValue(null);
        state.apiFormat = 'openclaw';
        expect(getCurrentEndpoint()).toBe('ws://localhost:18789');
    });

    it('未知格式返回空字符串', () => {
        getCurrentProvider.mockReturnValue(null);
        state.apiFormat = 'unknown';
        expect(getCurrentEndpoint()).toBe('');
    });
});

describe('getCurrentApiKey', () => {
    it('从提供商获取 API key', () => {
        getCurrentProvider.mockReturnValue({ id: 'provider-1' });
        getActiveApiKey.mockReturnValue('sk-test-key');

        expect(getCurrentApiKey()).toBe('sk-test-key');
        expect(getActiveApiKey).toHaveBeenCalledWith('provider-1');
    });

    it('无提供商时返回空字符串', () => {
        getCurrentProvider.mockReturnValue(null);
        expect(getCurrentApiKey()).toBe('');
    });
});

describe('getCurrentModel', () => {
    it('优先使用下拉列表选中的模型', () => {
        elements.modelSelect = { value: 'gpt-4o' };
        expect(getCurrentModel()).toBe('gpt-4o');
    });

    it('下拉为空时使用提供商第一个模型', () => {
        elements.modelSelect = { value: '' };
        getCurrentProvider.mockReturnValue({ models: ['claude-3-opus', 'claude-3-sonnet'] });
        expect(getCurrentModel()).toBe('claude-3-opus');
    });

    it('提供商模型为对象时返回完整自定义 id', () => {
        elements.modelSelect = { value: '' };
        getCurrentProvider.mockReturnValue({
            models: [{ id: 'vendor/custom-image:model@2', name: 'Custom' }]
        });
        expect(getCurrentModel()).toBe('vendor/custom-image:model@2');
    });

    it('都为空时返回空字符串', () => {
        elements.modelSelect = null;
        getCurrentProvider.mockReturnValue(null);
        expect(getCurrentModel()).toBe('');
    });

    it('提供商无模型列表时返回空字符串', () => {
        elements.modelSelect = { value: '' };
        getCurrentProvider.mockReturnValue({ models: [] });
        expect(getCurrentModel()).toBe('');
    });
});
