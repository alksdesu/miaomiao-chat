/**
 * prefill.js (utils) 测试
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../js/core/state.js', () => ({
    state: {
        apiFormat: 'openai',
        prefillEnabled: true,
        systemPrefillMessages: [],
        prefillMessages: []
    }
}));

vi.mock('../../js/utils/variables.js', () => ({
    processVariables: vi.fn((text) => text)
}));

import { state } from '../../js/core/state.js';
import { getOpeningMessages, getPrefillMessages } from '../../js/utils/prefill.js';

beforeEach(() => {
    state.apiFormat = 'openai';
    state.prefillEnabled = true;
    state.systemPrefillMessages = [];
    state.prefillMessages = [];
});

// ========== getOpeningMessages ==========

describe('getOpeningMessages', () => {
    it('禁用时返回空', () => {
        state.prefillEnabled = false;
        state.systemPrefillMessages = [{ role: 'user', content: 'hi' }];
        expect(getOpeningMessages()).toEqual([]);
    });

    it('无消息时返回空', () => {
        state.systemPrefillMessages = [];
        expect(getOpeningMessages()).toEqual([]);
    });

    it('null 消息返回空', () => {
        state.systemPrefillMessages = null;
        expect(getOpeningMessages()).toEqual([]);
    });

    it('过滤 system 角色', () => {
        state.systemPrefillMessages = [
            { role: 'system', content: 'system msg' },
            { role: 'user', content: 'user msg' }
        ];
        const msgs = getOpeningMessages();
        expect(msgs).toHaveLength(1);
        expect(msgs[0].role).toBe('user');
    });

    it('过滤空内容', () => {
        state.systemPrefillMessages = [
            { role: 'user', content: '' },
            { role: 'user', content: '  ' },
            { role: 'user', content: 'valid' }
        ];
        expect(getOpeningMessages()).toHaveLength(1);
    });

    it('OpenAI 格式', () => {
        state.systemPrefillMessages = [{ role: 'user', content: 'hello' }];
        const msgs = getOpeningMessages('openai');
        expect(msgs[0]).toEqual({ role: 'user', content: 'hello' });
    });

    it('Claude 格式同 OpenAI', () => {
        state.systemPrefillMessages = [{ role: 'assistant', content: 'hi' }];
        const msgs = getOpeningMessages('claude');
        expect(msgs[0]).toEqual({ role: 'assistant', content: 'hi' });
    });

    it('Gemini 格式转换 assistant 为 model', () => {
        state.systemPrefillMessages = [{ role: 'assistant', content: 'hi' }];
        const msgs = getOpeningMessages('gemini');
        expect(msgs[0].role).toBe('model');
        expect(msgs[0].parts[0].text).toBe('hi');
    });

    it('Gemini 格式 user 保持', () => {
        state.systemPrefillMessages = [{ role: 'user', content: 'hi' }];
        const msgs = getOpeningMessages('gemini');
        expect(msgs[0].role).toBe('user');
    });

    it('默认使用 state.apiFormat', () => {
        state.apiFormat = 'gemini';
        state.systemPrefillMessages = [{ role: 'assistant', content: 'hi' }];
        const msgs = getOpeningMessages();
        expect(msgs[0].role).toBe('model');
    });
});

// ========== getPrefillMessages ==========

describe('getPrefillMessages', () => {
    it('禁用时返回空', () => {
        state.prefillEnabled = false;
        state.prefillMessages = [{ role: 'assistant', content: 'pre' }];
        expect(getPrefillMessages()).toEqual([]);
    });

    it('空列表返回空', () => {
        state.prefillMessages = [];
        expect(getPrefillMessages()).toEqual([]);
    });

    it('过滤 system 和空内容', () => {
        state.prefillMessages = [
            { role: 'system', content: 'sys' },
            { role: 'assistant', content: '' },
            { role: 'assistant', content: 'valid' }
        ];
        expect(getPrefillMessages()).toHaveLength(1);
    });

    it('OpenAI 格式', () => {
        state.prefillMessages = [{ role: 'assistant', content: 'pre' }];
        const msgs = getPrefillMessages('openai');
        expect(msgs[0]).toEqual({ role: 'assistant', content: 'pre' });
    });

    it('Gemini 格式', () => {
        state.prefillMessages = [{ role: 'assistant', content: 'pre' }];
        const msgs = getPrefillMessages('gemini');
        expect(msgs[0].role).toBe('model');
        expect(msgs[0].parts[0].text).toBe('pre');
    });
});
