/**
 * tools/orchestrator.js 工具调用编排器测试
 * 覆盖 executeToolCalls 并行执行/错误处理 + writeToolResultsBackToState 写回 part.result
 * （原 tests/stream/tool-call-handler.test.js 的非 accumulator 部分迁移）
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
        currentAssistantMessage: null,
        messages: []
    }
}));

// updateMessageAt mock 真实合并 updates 到 state.messages[i]，
// 让基于 state.messages 的断言能继续验证 mutator 写回结果
vi.mock('../../js/core/state-mutations.js', async () => {
    const { state } = await import('../../js/core/state.js');
    return {
        updateMessageAt: vi.fn((index, updates) => {
            if (index < 0 || index >= state.messages.length) return;
            state.messages[index] = { ...state.messages[index], ...updates };
        })
    };
});

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

vi.mock('../../js/tools/undo.js', () => ({
    snapshotBeforeToolCall: vi.fn()
}));

vi.mock('../../js/providers/manager.js', () => ({
    getCurrentProvider: vi.fn(() => ({ apiFormat: 'openai' })),
    getActiveApiKey: vi.fn(() => 'test-key')
}));

vi.mock('../../js/messages/schema.js', () => ({
    validateToolPairings: vi.fn(() => ({ valid: true, orphans: [] }))
}));

vi.mock('../../js/messages/sync.js', () => ({
    writeToolResultsToBackgroundSession: vi.fn(async () => {})
}));

vi.mock('../../js/api/handler.js', () => ({
    resendWithToolResults: vi.fn(async () => {})
}));

import { executeToolCalls, writeToolResultsBackToState } from '../../js/tools/orchestrator.js';
import { executeTool } from '../../js/tools/executor.js';
import { createToolCallUI, updateToolCallStatus } from '../../js/ui/tool-display.js';
import { state } from '../../js/core/state.js';

beforeEach(() => {
    vi.clearAllMocks();
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

// ========== writeToolResultsBackToState ==========

describe('writeToolResultsBackToState', () => {
    beforeEach(() => {
        state.messages = [];
    });

    it('把 result 写回最后一条 assistant 的对应 part', () => {
        state.messages = [
            { role: 'user', parts: [{ type: 'text', text: 'q' }] },
            {
                role: 'assistant',
                parts: [
                    { type: 'text', text: '调用工具' },
                    {
                        type: 'tool_call',
                        id: 'tc_1',
                        name: 'search',
                        args: {},
                        state: 'pending',
                        result: null
                    }
                ]
            }
        ];

        writeToolResultsBackToState([
            { id: 'tc_1', name: 'search', result: { content: 'ok' }, isError: false }
        ]);

        const assistant = state.messages[1];
        expect(assistant.parts[1].result).toEqual({ content: 'ok' });
        expect(assistant.parts[1].state).toBe('done');
    });

    it('忽略不匹配 id 的 result', () => {
        state.messages = [
            {
                role: 'assistant',
                parts: [
                    {
                        type: 'tool_call',
                        id: 'tc_real',
                        name: 'search',
                        state: 'pending',
                        result: null
                    }
                ]
            }
        ];

        writeToolResultsBackToState([
            { id: 'tc_fake', name: 'search', result: { content: 'ignored' }, isError: false }
        ]);

        expect(state.messages[0].parts[0].result).toBeNull();
        expect(state.messages[0].parts[0].state).toBe('pending');
    });

    it('倒序找最近 assistant 消息，跳过 user/system', () => {
        state.messages = [
            {
                role: 'assistant',
                parts: [
                    {
                        type: 'tool_call',
                        id: 'tc_old',
                        name: 'old',
                        state: 'done',
                        result: { content: 'old' }
                    }
                ]
            },
            { role: 'user', parts: [{ type: 'text', text: 'next' }] },
            {
                role: 'assistant',
                parts: [
                    {
                        type: 'tool_call',
                        id: 'tc_new',
                        name: 'new',
                        state: 'pending',
                        result: null
                    }
                ]
            }
        ];

        writeToolResultsBackToState([
            { id: 'tc_new', name: 'new', result: { content: 'fresh' }, isError: false }
        ]);

        // 第一条 assistant 不被覆盖
        expect(state.messages[0].parts[0].result).toEqual({ content: 'old' });
        // 第二条 assistant 收到结果
        expect(state.messages[2].parts[0].result).toEqual({ content: 'fresh' });
    });

    it('错误 result 写 state=error', () => {
        state.messages = [
            {
                role: 'assistant',
                parts: [
                    {
                        type: 'tool_call',
                        id: 'tc_1',
                        name: 'broken',
                        state: 'pending',
                        result: null
                    }
                ]
            }
        ];

        writeToolResultsBackToState([
            {
                id: 'tc_1',
                name: 'broken',
                result: { error: 'Tool failed. Do NOT retry.', is_error: true },
                isError: true
            }
        ]);

        expect(state.messages[0].parts[0].state).toBe('error');
        expect(state.messages[0].parts[0].result.is_error).toBe(true);
    });

    it('跨越纯文本 assistant 找到含 tool_call 的更早 assistant 写回', () => {
        // 场景：pause_turn 后落了一条纯 thinking/text assistant，
        // 前一条带 pending tool_call 的 assistant 才是 writeBack 目标
        state.messages = [
            {
                role: 'assistant',
                parts: [
                    {
                        type: 'tool_call',
                        id: 'tc_real',
                        name: 'search',
                        state: 'pending',
                        result: null
                    }
                ]
            },
            {
                role: 'assistant',
                parts: [{ type: 'text', text: 'pause_turn 后的纯文本' }]
            }
        ];

        writeToolResultsBackToState([
            { id: 'tc_real', name: 'search', result: { content: 'found' }, isError: false }
        ]);

        // 纯文本 assistant 被跳过，前一条含 tool_call 的写回
        expect(state.messages[0].parts[0].result).toEqual({ content: 'found' });
        expect(state.messages[0].parts[0].state).toBe('done');
    });
});

// ========== writeToolResultsBackToState multi-turn coverage ==========

describe('writeToolResultsBackToState multi-turn coverage', () => {
    beforeEach(() => {
        state.messages = [];
    });

    it('matches tool_call in oldest assistant when newer assistants have no tool_call', () => {
        state.messages = [
            {
                role: 'assistant',
                parts: [
                    { type: 'text', text: '调用工具中' },
                    {
                        type: 'tool_call',
                        id: 'tc_oldest',
                        name: 'search',
                        args: {},
                        state: 'pending',
                        result: null
                    }
                ]
            },
            { role: 'user', parts: [{ type: 'text', text: '继续' }] },
            { role: 'assistant', parts: [{ type: 'text', text: '中间纯文本回复' }] },
            { role: 'user', parts: [{ type: 'text', text: '再继续' }] },
            { role: 'assistant', parts: [{ type: 'text', text: '另一段纯文本' }] }
        ];

        const matched = writeToolResultsBackToState([
            { id: 'tc_oldest', name: 'search', result: { content: 'old result' }, isError: false }
        ]);

        expect(matched).toBe(1);
        expect(state.messages[0].parts[1].result).toEqual({ content: 'old result' });
        expect(state.messages[0].parts[1].state).toBe('done');
        expect(state.messages[2].parts[0].text).toBe('中间纯文本回复');
        expect(state.messages[4].parts[0].text).toBe('另一段纯文本');
    });

    it('matches tool_call in multiple assistants when continuation produced multi-turn (id 唯一不会错配)', () => {
        state.messages = [
            {
                role: 'assistant',
                parts: [
                    {
                        type: 'tool_call',
                        id: 'tc_a',
                        name: 'search',
                        args: { q: 'a' },
                        state: 'pending',
                        result: null
                    }
                ]
            },
            {
                role: 'assistant',
                parts: [
                    { type: 'text', text: '继续调用' },
                    {
                        type: 'tool_call',
                        id: 'tc_b',
                        name: 'calc',
                        args: { expr: '1+1' },
                        state: 'pending',
                        result: null
                    }
                ]
            },
            {
                role: 'assistant',
                parts: [
                    {
                        type: 'tool_call',
                        id: 'tc_c',
                        name: 'fetch',
                        args: { url: 'x' },
                        state: 'pending',
                        result: null
                    }
                ]
            }
        ];

        const matched = writeToolResultsBackToState([
            { id: 'tc_a', name: 'search', result: { content: 'res-a' }, isError: false },
            { id: 'tc_b', name: 'calc', result: { content: 'res-b' }, isError: false },
            { id: 'tc_c', name: 'fetch', result: { content: 'res-c' }, isError: false }
        ]);

        expect(matched).toBe(3);
        expect(state.messages[0].parts[0].result).toEqual({ content: 'res-a' });
        expect(state.messages[0].parts[0].state).toBe('done');
        expect(state.messages[1].parts[1].result).toEqual({ content: 'res-b' });
        expect(state.messages[1].parts[1].state).toBe('done');
        expect(state.messages[2].parts[0].result).toEqual({ content: 'res-c' });
        expect(state.messages[2].parts[0].state).toBe('done');
    });

    it('returns partial matched count when only some toolResults find matching parts', () => {
        state.messages = [
            {
                role: 'assistant',
                parts: [
                    {
                        type: 'tool_call',
                        id: 'tc_have_1',
                        name: 'search',
                        state: 'pending',
                        result: null
                    }
                ]
            },
            {
                role: 'assistant',
                parts: [
                    {
                        type: 'tool_call',
                        id: 'tc_have_2',
                        name: 'calc',
                        state: 'pending',
                        result: null
                    }
                ]
            }
        ];

        const matched = writeToolResultsBackToState([
            { id: 'tc_have_1', name: 'search', result: { content: 'r1' }, isError: false },
            { id: 'tc_missing', name: 'ghost', result: { content: 'never' }, isError: false },
            { id: 'tc_have_2', name: 'calc', result: { content: 'r2' }, isError: false }
        ]);

        expect(matched).toBe(2);
        expect(state.messages[0].parts[0].result).toEqual({ content: 'r1' });
        expect(state.messages[0].parts[0].state).toBe('done');
        expect(state.messages[1].parts[0].result).toEqual({ content: 'r2' });
        expect(state.messages[1].parts[0].state).toBe('done');
    });

    it('does not break on first match (verifies all含 tool_call 的 assistant 都被遍历)', () => {
        state.messages = [
            {
                role: 'assistant',
                parts: [
                    {
                        type: 'tool_call',
                        id: 'tc_first',
                        name: 'search',
                        state: 'pending',
                        result: null
                    }
                ]
            },
            { role: 'user', parts: [{ type: 'text', text: '继续' }] },
            {
                role: 'assistant',
                parts: [
                    {
                        type: 'tool_call',
                        id: 'tc_second',
                        name: 'fetch',
                        state: 'pending',
                        result: null
                    }
                ]
            }
        ];

        const matched = writeToolResultsBackToState([
            { id: 'tc_first', name: 'search', result: { content: 'first-done' }, isError: false },
            { id: 'tc_second', name: 'fetch', result: { content: 'second-done' }, isError: true }
        ]);

        expect(matched).toBe(2);
        expect(state.messages[0].parts[0].result).toEqual({ content: 'first-done' });
        expect(state.messages[0].parts[0].state).toBe('done');
        expect(state.messages[2].parts[0].result).toEqual({ content: 'second-done' });
        expect(state.messages[2].parts[0].state).toBe('error');
    });
});
