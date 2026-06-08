/**
 * tools/manager 格式转换补充测试
 * cleanSchemaForGemini, convertTo*Format 等
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../js/core/events.js', () => ({
    eventBus: {
        on: vi.fn(),
        emit: vi.fn()
    }
}));

vi.mock('../../js/utils/helpers.js', () => ({
    generateId: vi.fn(() => 'fmt-test-id')
}));

vi.mock('../../js/tools/mcp/client.js', () => ({
    mcpClient: {
        callTool: vi.fn(),
        getToolsByServer: vi.fn(() => [])
    }
}));

vi.mock('../../js/state/storage.js', () => ({
    savePreference: vi.fn(),
    loadPreference: vi.fn(() => null)
}));

vi.mock('../../js/core/state.js', () => ({
    state: {
        xmlToolCallingEnabled: false,
        computerUseEnabled: false
    }
}));

vi.mock('../../js/tools/build-tool.js', () => ({
    buildTool: vi.fn((config) => ({
        id: config.id,
        name: config.name || config.id,
        description: config.description || '',
        parameters: config.parameters || { type: 'object', properties: {} },
        inputSchema: config.parameters || { type: 'object', properties: {} },
        input_schema: config.input_schema ||
            config.parameters || { type: 'object', properties: {} },
        type: config.type || 'builtin',
        enabled: config.enabled !== undefined ? config.enabled : true,
        hidden: config.hidden || false,
        call: config.call || vi.fn(),
        serverId: config.serverId
    })),
    buildToolFromLegacy: vi.fn((toolId, definition, handler) => ({
        id: toolId,
        name: definition.name || toolId,
        description: definition.description || '',
        parameters: definition.parameters || { type: 'object', properties: {} },
        inputSchema: definition.parameters || { type: 'object', properties: {} },
        input_schema: definition.parameters || { type: 'object', properties: {} },
        type: 'builtin',
        enabled: true,
        hidden: false,
        call: handler
    }))
}));

import { state } from '../../js/core/state.js';
import {
    registerTool,
    getToolsForAPI,
    getToolStats,
    isToolEnabled,
    getAllTools,
    getEnabledTools,
    removeTool,
    clearMCPTools,
    debugTools
} from '../../js/tools/manager.js';

function registerTestTool(overrides = {}) {
    const id = overrides.id || 'fmt-' + Math.random().toString(36).substr(2, 6);
    registerTool({
        id,
        name: overrides.name || id,
        description: overrides.description || 'test tool',
        parameters: overrides.parameters || {
            type: 'object',
            properties: {
                input: { type: 'string', description: 'input text' }
            },
            required: ['input']
        },
        type: overrides.type || 'builtin',
        enabled: overrides.enabled !== undefined ? overrides.enabled : true,
        hidden: overrides.hidden || false,
        call: overrides.call || vi.fn(),
        ...(overrides.serverId ? { serverId: overrides.serverId } : {})
    });
    return id;
}

describe('getToolsForAPI 格式转换', () => {
    let toolId;

    beforeEach(() => {
        vi.clearAllMocks();
        toolId = registerTestTool({ id: 'fmt-test', name: 'fmt-test' });
    });

    it('openai 格式包含 type: function', () => {
        const tools = getToolsForAPI('openai');
        const t = tools.find((t) => t.function?.name === 'fmt-test');
        expect(t).toBeDefined();
        expect(t.type).toBe('function');
        expect(t.function.parameters).toBeDefined();
    });

    it('openai 格式包含 description', () => {
        const tools = getToolsForAPI('openai');
        const t = tools.find((t) => t.function?.name === 'fmt-test');
        expect(t.function.description).toBe('test tool');
    });

    it('openai-responses 格式', () => {
        const tools = getToolsForAPI('openai-responses');
        const t = tools.find((t) => t.name === 'fmt-test');
        expect(t).toBeDefined();
        expect(t.type).toBe('function');
        expect(t.parameters).toBeDefined();
    });

    it('gemini 格式', () => {
        const tools = getToolsForAPI('gemini');
        const t = tools.find((t) => t.name === 'fmt-test');
        expect(t).toBeDefined();
        expect(t.parameters).toBeDefined();
        expect(t.description).toBe('test tool');
    });

    it('claude 格式包含 input_schema', () => {
        const tools = getToolsForAPI('claude');
        const t = tools.find((t) => t.name === 'fmt-test');
        expect(t).toBeDefined();
        expect(t.input_schema).toBeDefined();
    });

    it('openclaw 格式与 openai 一致', () => {
        const tools = getToolsForAPI('openclaw');
        const t = tools.find((t) => t.function?.name === 'fmt-test');
        expect(t).toBeDefined();
        expect(t.type).toBe('function');
    });

    it('未知格式返回空数组', () => {
        expect(getToolsForAPI('unknown-format')).toEqual([]);
    });

    it('禁用的工具不包含在结果中', () => {
        registerTestTool({ id: 'disabled-tool', name: 'disabled-tool', enabled: false });
        const tools = getToolsForAPI('openai');
        const t = tools.find((t) => t.function?.name === 'disabled-tool');
        expect(t).toBeUndefined();
    });

    it('hidden 工具如果启用了仍包含', () => {
        registerTestTool({ id: 'hidden-tool', name: 'hidden-tool', enabled: true, hidden: true });
        const tools = getToolsForAPI('openai');
        const t = tools.find((t) => t.function?.name === 'hidden-tool');
        expect(t).toBeDefined();
    });
});

describe('gemini 格式 schema 清理', () => {
    it('移除 anyOf', () => {
        const id = registerTestTool({
            id: 'anyof-tool',
            name: 'anyof-tool',
            parameters: {
                type: 'object',
                properties: {
                    value: {
                        anyOf: [{ type: 'string' }, { type: 'null' }]
                    }
                }
            }
        });
        const tools = getToolsForAPI('gemini');
        const t = tools.find((t) => t.name === 'anyof-tool');
        expect(t.parameters.properties.value.anyOf).toBeUndefined();
        expect(t.parameters.properties.value.type).toBe('string');
    });

    it('移除 oneOf', () => {
        const id = registerTestTool({
            id: 'oneof-tool',
            name: 'oneof-tool',
            parameters: {
                type: 'object',
                properties: {
                    mode: {
                        oneOf: [{ type: 'string', description: 'text mode' }, { type: 'null' }]
                    }
                }
            }
        });
        const tools = getToolsForAPI('gemini');
        const t = tools.find((t) => t.name === 'oneof-tool');
        expect(t.parameters.properties.mode.oneOf).toBeUndefined();
    });

    it('合并 allOf', () => {
        const id = registerTestTool({
            id: 'allof-tool',
            name: 'allof-tool',
            parameters: {
                type: 'object',
                properties: {
                    config: {
                        allOf: [
                            { type: 'object', properties: { a: { type: 'string' } } },
                            { properties: { b: { type: 'number' } }, required: ['b'] }
                        ]
                    }
                }
            }
        });
        const tools = getToolsForAPI('gemini');
        const t = tools.find((t) => t.name === 'allof-tool');
        const config = t.parameters.properties.config;
        expect(config.allOf).toBeUndefined();
        expect(config.properties.a).toBeDefined();
        expect(config.properties.b).toBeDefined();
    });

    it('移除 $schema', () => {
        const id = registerTestTool({
            id: 'schema-tool',
            name: 'schema-tool',
            parameters: {
                $schema: 'http://json-schema.org/draft-07/schema#',
                type: 'object',
                properties: {}
            }
        });
        const tools = getToolsForAPI('gemini');
        const t = tools.find((t) => t.name === 'schema-tool');
        expect(t.parameters.$schema).toBeUndefined();
    });

    it('移除 additionalProperties', () => {
        const id = registerTestTool({
            id: 'addl-tool',
            name: 'addl-tool',
            parameters: {
                type: 'object',
                properties: {},
                additionalProperties: false
            }
        });
        const tools = getToolsForAPI('gemini');
        const t = tools.find((t) => t.name === 'addl-tool');
        expect(t.parameters.additionalProperties).toBeUndefined();
    });

    it('移除 title', () => {
        const id = registerTestTool({
            id: 'title-tool',
            name: 'title-tool',
            parameters: {
                type: 'object',
                title: 'MySchema',
                properties: {}
            }
        });
        const tools = getToolsForAPI('gemini');
        const t = tools.find((t) => t.name === 'title-tool');
        expect(t.parameters.title).toBeUndefined();
    });

    it('递归清理嵌套 properties', () => {
        const id = registerTestTool({
            id: 'nested-tool',
            name: 'nested-tool',
            parameters: {
                type: 'object',
                properties: {
                    nested: {
                        type: 'object',
                        title: 'should be removed',
                        $schema: 'should be removed',
                        properties: {
                            deep: { type: 'string', default: 'removed' }
                        }
                    }
                }
            }
        });
        const tools = getToolsForAPI('gemini');
        const t = tools.find((t) => t.name === 'nested-tool');
        expect(t.parameters.properties.nested.title).toBeUndefined();
        expect(t.parameters.properties.nested.properties.deep.default).toBeUndefined();
    });

    it('递归清理 items', () => {
        const id = registerTestTool({
            id: 'items-tool',
            name: 'items-tool',
            parameters: {
                type: 'object',
                properties: {
                    list: {
                        type: 'array',
                        items: {
                            type: 'string',
                            default: 'should be removed'
                        }
                    }
                }
            }
        });
        const tools = getToolsForAPI('gemini');
        const t = tools.find((t) => t.name === 'items-tool');
        expect(t.parameters.properties.list.items.default).toBeUndefined();
    });

    it('处理 null/非对象 schema', () => {
        const id = registerTestTool({
            id: 'null-schema',
            name: 'null-schema',
            parameters: null
        });
        const tools = getToolsForAPI('gemini');
        const t = tools.find((t) => t.name === 'null-schema');
        // 应该不抛出
        expect(t).toBeDefined();
    });
});

describe('getToolStats', () => {
    it('统计可见工具', () => {
        registerTestTool({ id: 'stat-a', name: 'stat-a', type: 'builtin', enabled: true });
        registerTestTool({ id: 'stat-b', name: 'stat-b', type: 'custom', enabled: false });
        registerTestTool({ id: 'stat-c', name: 'stat-c', type: 'mcp', enabled: true });
        const stats = getToolStats();
        expect(stats.total).toBeGreaterThanOrEqual(3);
        expect(stats.builtin).toBeGreaterThanOrEqual(1);
        expect(stats.custom).toBeGreaterThanOrEqual(1);
        expect(stats.mcp).toBeGreaterThanOrEqual(1);
    });

    it('hidden 工具不计入统计', () => {
        const before = getToolStats().total;
        registerTestTool({ id: 'stat-hidden', name: 'stat-hidden', hidden: true });
        const after = getToolStats().total;
        expect(after).toBe(before);
    });
});

describe('debugTools', () => {
    it('不抛出', () => {
        registerTestTool({ id: 'debug-1', name: 'debug-1' });
        expect(() => debugTools()).not.toThrow();
    });
});

describe('computer use 过滤', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        registerTestTool({ id: 'computer', name: 'computer', enabled: true });
    });

    it('claude 格式 + xmlToolCallingEnabled=false 过滤 computer', () => {
        state.xmlToolCallingEnabled = false;
        const tools = getToolsForAPI('claude');
        const t = tools.find((t) => t.name === 'computer');
        expect(t).toBeUndefined();
    });

    it('claude 格式 + xmlToolCallingEnabled=true 包含 computer', () => {
        state.xmlToolCallingEnabled = true;
        const tools = getToolsForAPI('claude');
        const t = tools.find((t) => t.name === 'computer');
        expect(t).toBeDefined();
        state.xmlToolCallingEnabled = false;
    });

    it('非 claude 格式 + computerUseEnabled=false 过滤 computer', () => {
        state.computerUseEnabled = false;
        const tools = getToolsForAPI('openai');
        const t = tools.find((t) => t.function?.name === 'computer');
        expect(t).toBeUndefined();
    });

    it('非 claude 格式 + computerUseEnabled=true 包含 computer', () => {
        state.computerUseEnabled = true;
        const tools = getToolsForAPI('openai');
        const t = tools.find((t) => t.function?.name === 'computer');
        expect(t).toBeDefined();
        state.computerUseEnabled = false;
    });
});
