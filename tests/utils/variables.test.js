/**
 * variables.js 模板变量处理测试
 */
import { describe, it, expect } from 'vitest';

import { processVariables, getPrefillMessages } from '../../js/utils/variables.js';

// ========== processVariables ==========

describe('processVariables', () => {
    it('空字符串返回空', () => {
        expect(processVariables('')).toBe('');
    });

    it('null 返回空', () => {
        expect(processVariables(null)).toBe('');
    });

    it('undefined 返回空', () => {
        expect(processVariables(undefined)).toBe('');
    });

    it('替换 {{char}}', () => {
        expect(processVariables('你好 {{char}}', { charName: 'Alice' })).toBe('你好 Alice');
    });

    it('替换 {{user}}', () => {
        expect(processVariables('{{user}} 说', { userName: 'Bob' })).toBe('Bob 说');
    });

    it('默认 charName 为 Assistant', () => {
        expect(processVariables('{{char}}')).toBe('Assistant');
    });

    it('默认 userName 为 User', () => {
        expect(processVariables('{{user}}')).toBe('User');
    });

    it('替换 {{date}} 为当前日期', () => {
        const result = processVariables('今天是 {{date}}');
        // 应该包含年月日数字
        expect(result).toMatch(/今天是 \d+/);
        expect(result).not.toContain('{{date}}');
    });

    it('替换 {{time}} 为当前时间', () => {
        const result = processVariables('现在是 {{time}}');
        expect(result).not.toContain('{{time}}');
        expect(result).toMatch(/现在是 \d+:\d+/);
    });

    it('多次替换同一变量', () => {
        const result = processVariables('{{char}} 和 {{char}}', { charName: 'AI' });
        expect(result).toBe('AI 和 AI');
    });

    it('同时替换多个变量', () => {
        const result = processVariables('{{user}}: 你好 {{char}}', {
            charName: 'AI',
            userName: 'Human'
        });
        expect(result).toBe('Human: 你好 AI');
    });

    it('无匹配变量时原样返回', () => {
        expect(processVariables('普通文本')).toBe('普通文本');
    });

    it('部分变量不存在时只替换存在的', () => {
        // {{unknown}} 不在替换列表中，不会被替换
        const result = processVariables('{{char}} {{unknown}}', { charName: 'AI' });
        expect(result).toContain('AI');
        expect(result).toContain('{{unknown}}');
    });
});

// ========== getPrefillMessages ==========

describe('getPrefillMessages', () => {
    it('空数组返回空', () => {
        expect(getPrefillMessages([], 'openai', {})).toEqual([]);
    });

    it('null 返回空', () => {
        expect(getPrefillMessages(null, 'openai', {})).toEqual([]);
    });

    it('undefined 返回空', () => {
        expect(getPrefillMessages(undefined, 'openai', {})).toEqual([]);
    });

    it('过滤 system 消息', () => {
        const msgs = [
            { role: 'system', content: 'sys' },
            { role: 'user', content: 'hello' }
        ];
        const result = getPrefillMessages(msgs, 'openai', {});
        expect(result).toHaveLength(1);
        expect(result[0].role).toBe('user');
    });

    describe('OpenAI 格式', () => {
        it('保留 role 和 content', () => {
            const msgs = [
                { role: 'user', content: 'hi {{char}}' },
                { role: 'assistant', content: 'hello {{user}}' }
            ];
            const result = getPrefillMessages(msgs, 'openai', {
                charName: 'AI',
                userName: 'Human'
            });
            expect(result[0]).toEqual({ role: 'user', content: 'hi AI' });
            expect(result[1]).toEqual({ role: 'assistant', content: 'hello Human' });
        });
    });

    describe('Claude 格式', () => {
        it('与 OpenAI 相同格式', () => {
            const msgs = [{ role: 'user', content: '{{char}}' }];
            const result = getPrefillMessages(msgs, 'claude', { charName: 'Claude' });
            expect(result[0]).toEqual({ role: 'user', content: 'Claude' });
        });
    });

    describe('Gemini 格式', () => {
        it('assistant 转为 model 角色', () => {
            const msgs = [{ role: 'assistant', content: 'hello' }];
            const result = getPrefillMessages(msgs, 'gemini', {});
            expect(result[0].role).toBe('model');
        });

        it('user 保持不变', () => {
            const msgs = [{ role: 'user', content: 'hi' }];
            const result = getPrefillMessages(msgs, 'gemini', {});
            expect(result[0].role).toBe('user');
        });

        it('内容包装为 parts 数组', () => {
            const msgs = [{ role: 'user', content: '{{char}}' }];
            const result = getPrefillMessages(msgs, 'gemini', { charName: 'Gemini' });
            expect(result[0]).toEqual({
                role: 'user',
                parts: [{ text: 'Gemini' }]
            });
        });

        it('变量替换在格式转换中生效', () => {
            const msgs = [{ role: 'assistant', content: '我是 {{char}}' }];
            const result = getPrefillMessages(msgs, 'gemini', { charName: 'Bot' });
            expect(result[0]).toEqual({
                role: 'model',
                parts: [{ text: '我是 Bot' }]
            });
        });
    });
});
