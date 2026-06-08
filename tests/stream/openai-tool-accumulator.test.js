/**
 * stream/openai-tool-accumulator.js — OpenAI delta 累积器测试
 * （原 tests/stream/tool-call-handler.test.js 的 ToolCallAccumulator 部分）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { createToolCallAccumulator } from '../../js/stream/openai-tool-accumulator.js';

beforeEach(() => {
    vi.clearAllMocks();
});

describe('ToolCallAccumulator', () => {
    it('创建空累积器', () => {
        const acc = createToolCallAccumulator();
        expect(acc.getCompletedCalls()).toEqual([]);
    });

    it('累积单个工具调用', () => {
        const acc = createToolCallAccumulator();

        acc.processDelta([
            {
                index: 0,
                id: 'call_1',
                type: 'function',
                function: { name: 'search', arguments: '{"q":' }
            }
        ]);

        acc.processDelta([
            {
                index: 0,
                function: { arguments: '"test"}' }
            }
        ]);

        const calls = acc.getCompletedCalls();
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({
            id: 'call_1',
            type: 'function',
            name: 'search',
            arguments: { q: 'test' },
            parseError: false
        });
    });

    it('累积多个工具调用', () => {
        const acc = createToolCallAccumulator();

        acc.processDelta([
            { index: 0, id: 'call_1', function: { name: 'search', arguments: '{"q":"a"}' } },
            { index: 1, id: 'call_2', function: { name: 'calc', arguments: '{"expr":"1+1"}' } }
        ]);

        const calls = acc.getCompletedCalls();
        expect(calls).toHaveLength(2);
        expect(calls[0].name).toBe('search');
        expect(calls[1].name).toBe('calc');
    });

    it('处理空参数字符串', () => {
        const acc = createToolCallAccumulator();

        acc.processDelta([
            {
                index: 0,
                id: 'call_1',
                function: { name: 'no_args', arguments: '' }
            }
        ]);

        const calls = acc.getCompletedCalls();
        expect(calls[0].arguments).toEqual({});
    });

    it('处理无效 JSON 参数', () => {
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const acc = createToolCallAccumulator();

        acc.processDelta([
            {
                index: 0,
                id: 'call_1',
                function: { name: 'broken', arguments: '{invalid}' }
            }
        ]);

        const calls = acc.getCompletedCalls();
        expect(calls[0].arguments).toEqual({});
        expect(calls[0].parseError).toBe(true);
        consoleSpy.mockRestore();
    });

    it('忽略非数组输入', () => {
        const acc = createToolCallAccumulator();
        acc.processDelta(null);
        acc.processDelta(undefined);
        acc.processDelta('not an array');
        expect(acc.getCompletedCalls()).toEqual([]);
    });

    it('跳过无名称的工具调用', () => {
        const acc = createToolCallAccumulator();

        acc.processDelta([
            {
                index: 0,
                id: 'call_1',
                function: { arguments: '{}' }
            }
        ]);

        expect(acc.getCompletedCalls()).toEqual([]);
    });

    it('clear 清空所有累积', () => {
        const acc = createToolCallAccumulator();

        acc.processDelta([
            {
                index: 0,
                id: 'call_1',
                function: { name: 'tool', arguments: '{}' }
            }
        ]);

        acc.clear();
        expect(acc.getCompletedCalls()).toEqual([]);
    });

    it('增量拼接函数名称', () => {
        const acc = createToolCallAccumulator();

        acc.processDelta([{ index: 0, id: 'c1', function: { name: 'sea' } }]);
        acc.processDelta([{ index: 0, function: { name: 'rch' } }]);
        acc.processDelta([{ index: 0, function: { arguments: '{}' } }]);

        const calls = acc.getCompletedCalls();
        expect(calls[0].name).toBe('search');
    });

    it('ID 覆盖更新', () => {
        const acc = createToolCallAccumulator();

        acc.processDelta([{ index: 0, id: 'old_id', function: { name: 'tool' } }]);
        acc.processDelta([{ index: 0, id: 'new_id', function: { arguments: '{}' } }]);

        const calls = acc.getCompletedCalls();
        expect(calls[0].id).toBe('new_id');
    });
});
