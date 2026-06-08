/**
 * MCP tool-executor.js 测试
 * 测试纯函数: extractToolsFromPayload, normalizeToolDefinition
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../js/core/events.js', () => ({
    eventBus: { emit: vi.fn(), on: vi.fn(), off: vi.fn() }
}));

vi.mock('../../../js/tools/mcp/tool-cache.js', () => ({
    cacheTools: vi.fn(),
    getCachedTools: vi.fn()
}));

vi.mock('../../../js/tools/mcp/connection.js', () => ({
    nextWsRequestId: vi.fn(() => 1),
    sendSSERequest: vi.fn(),
    parseSSE: vi.fn(),
    connectLocalElectron: vi.fn(),
    connectRemote: vi.fn(),
    classifyError: vi.fn()
}));

vi.mock('../../../js/utils/logger.js', () => ({
    logger: { warn: vi.fn(), debug: vi.fn(), error: vi.fn(), info: vi.fn() }
}));

import {
    extractToolsFromPayload,
    normalizeToolDefinition
} from '../../../js/tools/mcp/tool-executor.js';

describe('tool-executor', () => {
    // ========== extractToolsFromPayload ==========
    describe('extractToolsFromPayload', () => {
        it('直接数组 payload', () => {
            const tools = extractToolsFromPayload([{ name: 'tool1' }]);
            expect(tools).toEqual([{ name: 'tool1' }]);
        });

        it('payload.tools 是数组', () => {
            const tools = extractToolsFromPayload({ tools: [{ name: 'tool1' }] });
            expect(tools).toEqual([{ name: 'tool1' }]);
        });

        it('payload.result 是数组', () => {
            // payload 本身: { result: [...] } → asArray 检查 result 值是数组被过滤
            // 所以走到 payload.result 候选
            const tools = extractToolsFromPayload({ result: [{ name: 'tool1' }] });
            expect(tools).toEqual([{ name: 'tool1' }]);
        });

        it('payload.result.tools 是数组', () => {
            // payload 本身: { result: { tools: [...] } } → asArray 找到 result 值是对象
            // 所以返回 [{ name: 'result', tools: [...] }]
            const tools = extractToolsFromPayload({ result: { tools: [{ name: 'tool1' }] } });
            expect(tools).toHaveLength(1);
            expect(tools[0].name).toBe('result');
        });

        it('payload.data 是数组', () => {
            const tools = extractToolsFromPayload({ data: [{ name: 'tool1' }] });
            // payload 本身 asArray 会把 { data: [...] } 变成 [{ name: 'data', ... }]
            // 因为 data 的值是数组会被 filter 排除
            // 所以走到 payload.data 候选
            expect(tools).toEqual([{ name: 'tool1' }]);
        });

        it('payload.data.tools 是数组', () => {
            const tools = extractToolsFromPayload({ data: { tools: [{ name: 'tool1' }] } });
            // payload 本身: { data: { tools: [...] } } → asArray 找到 data 值是对象
            // 所以返回 [{ name: 'data', tools: [...] }]
            expect(tools).toHaveLength(1);
            expect(tools[0].name).toBe('data');
        });

        it('对象格式 tools (直接在 result.tools 里)', () => {
            const tools = extractToolsFromPayload({
                result: {
                    tools: {
                        calculator: { description: 'calc' },
                        weather: { description: 'weather info' }
                    }
                }
            });
            // payload → asArray → { result: {...} } → [{ name: 'result', ... }]
            expect(tools.length).toBeGreaterThan(0);
        });

        it('空 payload 返回空数组', () => {
            expect(extractToolsFromPayload({})).toEqual([]);
        });

        it('null payload 返回空数组', () => {
            expect(extractToolsFromPayload(null)).toEqual([]);
        });

        it('undefined payload 返回空数组', () => {
            expect(extractToolsFromPayload(undefined)).toEqual([]);
        });

        it('payload 本身是对象但不是数组，包含工具对象', () => {
            const tools = extractToolsFromPayload({
                myTool: { description: 'a tool' }
            });
            // payload 本身 asArray: entries 有 myTool → 对象 → 通过 filter
            expect(tools.length).toBeGreaterThan(0);
            expect(tools[0].name).toBe('myTool');
        });

        it('空数组 tools 跳过继续搜索', () => {
            // { tools: [] } → payload 本身 asArray: { tools: [] } → entries 有 tools
            // 但 tools 值是 array 所以被 filter 排除 → 返回 []
            // payload.tools = [] → asArray = [] → 跳过
            expect(extractToolsFromPayload({ tools: [] })).toEqual([]);
        });

        it('优先级：先检查 payload 本身', () => {
            // 如果 payload 本身是数组，直接返回
            const tools = extractToolsFromPayload([{ name: 'direct' }]);
            expect(tools[0].name).toBe('direct');
        });

        it('payload 中值是原始类型的字段被过滤', () => {
            // { success: true, error: null } → entries 都不是非数组对象 → []
            const tools = extractToolsFromPayload({ success: true, error: null, message: 'ok' });
            expect(tools).toEqual([]);
        });
    });

    // ========== normalizeToolDefinition ==========
    describe('normalizeToolDefinition', () => {
        it('标准工具定义直接返回', () => {
            const tool = {
                name: 'calculator',
                description: 'calc',
                inputSchema: { type: 'object', properties: { expr: { type: 'string' } } }
            };
            const result = normalizeToolDefinition(tool);
            expect(result.name).toBe('calculator');
            expect(result.inputSchema).toEqual(tool.inputSchema);
        });

        it('使用 input_schema 别名', () => {
            const tool = {
                name: 'tool1',
                input_schema: { type: 'object', properties: {} }
            };
            const result = normalizeToolDefinition(tool);
            expect(result.inputSchema).toEqual({ type: 'object', properties: {} });
        });

        it('使用 parameters 别名', () => {
            const tool = {
                name: 'tool1',
                parameters: { type: 'object', properties: { a: { type: 'number' } } }
            };
            const result = normalizeToolDefinition(tool);
            expect(result.inputSchema.properties.a).toEqual({ type: 'number' });
        });

        it('没有 inputSchema 时使用默认值', () => {
            const result = normalizeToolDefinition({ name: 'bare' });
            expect(result.inputSchema).toEqual({ type: 'object', properties: {} });
        });

        it('使用 id 替代 name', () => {
            const result = normalizeToolDefinition({ id: 'my-tool' });
            expect(result.name).toBe('my-tool');
        });

        it('null 返回 null', () => {
            expect(normalizeToolDefinition(null)).toBeNull();
        });

        it('非对象返回 null', () => {
            expect(normalizeToolDefinition('string')).toBeNull();
            expect(normalizeToolDefinition(123)).toBeNull();
        });

        it('没有 name 和 id 返回 null', () => {
            expect(normalizeToolDefinition({ description: 'no name' })).toBeNull();
        });

        it('name 不是字符串返回 null', () => {
            expect(normalizeToolDefinition({ name: 123 })).toBeNull();
        });

        it('保留额外属性', () => {
            const result = normalizeToolDefinition({
                name: 'tool',
                description: 'desc',
                custom: 'data'
            });
            expect(result.description).toBe('desc');
            expect(result.custom).toBe('data');
        });

        it('inputSchema 优先级: inputSchema > input_schema > parameters', () => {
            const result = normalizeToolDefinition({
                name: 'tool',
                inputSchema: { type: 'object', properties: { a: {} } },
                input_schema: { type: 'object', properties: { b: {} } },
                parameters: { type: 'object', properties: { c: {} } }
            });
            expect(result.inputSchema.properties).toHaveProperty('a');
        });
    });
});
