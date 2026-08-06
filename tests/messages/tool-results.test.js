import { describe, expect, it } from 'vitest';
import { applyToolResultsToMessages } from '../../js/messages/tool-results.js';

describe('applyToolResultsToMessages', () => {
    it('只更新匹配的工具结果且不修改输入消息', () => {
        const messages = [
            {
                role: 'assistant',
                parts: [
                    { type: 'tool_call', id: 'call-a', state: 'pending', result: null },
                    { type: 'tool_call', id: 'call-b', state: 'pending', result: null }
                ]
            }
        ];

        const applied = applyToolResultsToMessages(messages, [
            { id: 'call-a', result: { content: 'ok' }, isError: false }
        ]);

        expect(applied.matched).toBe(1);
        expect(applied.changedIndexes).toEqual([0]);
        expect(applied.messages[0].parts[0]).toMatchObject({
            state: 'done',
            result: { content: 'ok' }
        });
        expect(applied.messages[0].parts[1].state).toBe('pending');
        expect(messages[0].parts[0].state).toBe('pending');
    });

    it('支持跨多轮工具调用并保留无关消息引用', () => {
        const userMessage = { role: 'user', parts: [{ type: 'text', text: 'next' }] };
        const messages = [
            {
                role: 'assistant',
                parts: [{ type: 'tool_call', id: 'call-a', state: 'pending' }]
            },
            userMessage,
            {
                role: 'assistant',
                parts: [{ type: 'tool_call', id: 'call-b', state: 'pending' }]
            }
        ];

        const applied = applyToolResultsToMessages(messages, [
            { id: 'call-a', result: 'a', isError: false },
            { id: 'call-b', result: 'b', isError: true }
        ]);

        expect(applied.matched).toBe(2);
        expect(applied.messages[0].parts[0].state).toBe('done');
        expect(applied.messages[2].parts[0].state).toBe('error');
        expect(applied.messages[1]).toBe(userMessage);
    });
});
