/**
 * tool-call-handler.js 工具调用处理器测试
 * 测试 ToolCallAccumulator 和工具结果处理
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// mock 依赖
vi.mock('../../js/core/events.js', () => ({
    eventBus: { emit: vi.fn(), on: vi.fn(), off: vi.fn() }
}));

vi.mock('../../js/core/state.js', () => ({
    state: {
        apiFormat: 'openai',
        isToolCallPending: false,
        currentAssistantMessage: null
    }
}));

vi.mock('../../js/core/state-mutations.js', () => ({
    setIsToolCallPending: vi.fn()
}));

vi.mock('../../js/core/request-state-machine.js', () => ({
    requestStateMachine: { transition: vi.fn(), forceReset: vi.fn() },
    RequestState: { TOOL_CALLING: 'TOOL_CALLING' }
}));

vi.mock('../../js/tools/executor.js', () => ({
    executeTool: vi.fn(async () => ({ text: 'result' }))
}));

vi.mock('../../js/ui/tool-display.js', () => ({
    createToolCallUI: vi.fn(async () => {}),
    updateToolCallStatus: vi.fn()
}));

vi.mock('../../js/api/format-converter.js', () => ({
    getOrCreateMappedId: vi.fn(() => 'mapped-id')
}));

vi.mock('../../js/tools/undo.js', () => ({
    snapshotBeforeToolCall: vi.fn()
}));

vi.mock('../../js/providers/manager.js', () => ({
    getCurrentProvider: vi.fn(() => ({ apiFormat: 'openai' })),
    getActiveApiKey: vi.fn(() => 'test-key')
}));

vi.mock('../../js/tools/tool-result-builder.js', () => ({
    buildToolResultMessages: vi.fn(() => [])
}));

vi.mock('../../js/api/handler.js', () => ({
    resendWithToolResults: vi.fn(async () => {})
}));

import { createToolCallAccumulator, executeToolCalls } from '../../js/stream/tool-call-handler.js';
import { executeTool } from '../../js/tools/executor.js';
import { createToolCallUI, updateToolCallStatus } from '../../js/ui/tool-display.js';

beforeEach(() => {
    vi.clearAllMocks();
});

// ========== ToolCallAccumulator ==========

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
        expect(calls[0]).toEqual({
            id: 'call_1',
            type: 'function',
            name: 'search',
            arguments: { q: 'test' }
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

// ========== executeToolCalls ==========

describe('executeToolCalls', () => {
    it('执行单个工具调用并返回结果', async () => {
        const toolCalls = [{ id: 'tc_1', name: 'search', arguments: { q: 'test' } }];
        executeTool.mockResolvedValueOnce({ text: 'found it' });

        const results = await executeToolCalls(toolCalls);

        expect(results).toHaveLength(1);
        expect(results[0].id).toBe('tc_1');
        expect(results[0].isError).toBe(false);
        expect(createToolCallUI).toHaveBeenCalledWith(
            expect.objectContaining({ id: 'tc_1', name: 'search' })
        );
        expect(updateToolCallStatus).toHaveBeenCalledWith('tc_1', 'completed', expect.any(Object));
    });

    it('并行执行多个工具调用', async () => {
        const toolCalls = [
            { id: 'tc_1', name: 'search', arguments: { q: 'a' } },
            { id: 'tc_2', name: 'calc', arguments: { expr: '1+1' } }
        ];
        executeTool.mockResolvedValue({ text: 'result' });

        const results = await executeToolCalls(toolCalls);

        expect(results).toHaveLength(2);
        expect(createToolCallUI).toHaveBeenCalledTimes(2);
    });

    it('处理工具执行失败', async () => {
        const toolCalls = [{ id: 'tc_1', name: 'broken_tool', arguments: {} }];
        executeTool.mockRejectedValueOnce(new Error('Tool not found'));

        const results = await executeToolCalls(toolCalls);

        expect(results).toHaveLength(1);
        expect(results[0].isError).toBe(true);
        expect(results[0].result.is_error).toBe(true);
        expect(updateToolCallStatus).toHaveBeenCalledWith('tc_1', 'failed', expect.any(Object));
    });

    it('处理缺少参数错误', async () => {
        const toolCalls = [{ id: 'tc_1', name: 'strict_tool', arguments: {} }];
        executeTool.mockRejectedValueOnce(new Error('Missing required parameter: query'));

        const results = await executeToolCalls(toolCalls);

        expect(results[0].result.error).toContain('Missing required parameter');
        expect(results[0].result.error).toContain('Do NOT retry');
    });

    it('处理工具不存在错误', async () => {
        const toolCalls = [{ id: 'tc_1', name: 'missing', arguments: {} }];
        executeTool.mockRejectedValueOnce(new Error('Tool "missing" 不存在'));

        const results = await executeToolCalls(toolCalls);

        expect(results[0].result.error).toContain('not available');
    });

    it('处理 MCP content 数组格式结果', async () => {
        const toolCalls = [{ id: 'tc_1', name: 'mcp_tool', arguments: {} }];
        executeTool.mockResolvedValueOnce({
            content: [
                { type: 'text', text: 'hello' },
                { type: 'image', data: 'base64data', mimeType: 'image/png' }
            ]
        });

        const results = await executeToolCalls(toolCalls);

        expect(results[0].isError).toBe(false);
    });
});
