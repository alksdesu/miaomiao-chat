/**
 * manager.js 测试 (tools)
 * 工具注册、查询、启用/禁用、格式转换
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../js/core/events.js', () => ({
    eventBus: {
        on: vi.fn(),
        emit: vi.fn()
    }
}));

vi.mock('../../js/utils/helpers.js', () => ({
    generateId: vi.fn(() => 'test-id-123')
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
        type: 'builtin',
        enabled: true,
        hidden: false,
        call: handler
    }))
}));

import {
    registerTool,
    registerBuiltinTool,
    registerCustomTool,
    getAllTools,
    getEnabledTools,
    getTool,
    getToolObject,
    getToolHandler,
    getToolsForAPI,
    setToolEnabled,
    isToolEnabled,
    removeTool,
    getToolStats
} from '../../js/tools/manager.js';

beforeEach(() => {
    vi.clearAllMocks();
    // 清空内部 tools Map — 通过重新注册来测试
});

describe('registerTool', () => {
    it('注册工具后可查询', () => {
        registerTool({
            id: 'test-tool',
            name: 'test-tool',
            description: 'test',
            parameters: { type: 'object', properties: {} },
            type: 'builtin',
            enabled: true,
            call: vi.fn()
        });
        const tool = getTool('test-tool');
        expect(tool).not.toBeNull();
        expect(tool.id).toBe('test-tool');
    });

    it('注册时确保 id 字段', () => {
        registerTool({ name: 'unnamed', description: 'desc', call: vi.fn() });
        const tool = getTool('unnamed');
        expect(tool).not.toBeNull();
        expect(tool.id).toBe('unnamed');
    });

    it('重复注册覆盖旧工具', () => {
        registerTool({ id: 'dup', name: 'dup', description: 'v1', call: vi.fn() });
        registerTool({ id: 'dup', name: 'dup', description: 'v2', call: vi.fn() });
        const tool = getTool('dup');
        expect(tool.description).toBe('v2');
    });
});

describe('registerBuiltinTool', () => {
    it('注册内置工具', () => {
        const handler = vi.fn();
        registerBuiltinTool('calc', { name: 'calc', description: 'calculator' }, handler);
        const tool = getTool('calc');
        expect(tool).not.toBeNull();
    });
});

describe('registerCustomTool', () => {
    it('注册自定义工具返回 ID', () => {
        const id = registerCustomTool({ name: 'my-tool', description: 'custom' });
        expect(typeof id).toBe('string');
    });

    it('使用提供的 ID', () => {
        const id = registerCustomTool({ id: 'explicit-id', name: 'my-tool' });
        expect(id).toBe('explicit-id');
    });
});

describe('getAllTools / getEnabledTools', () => {
    it('getAllTools 返回所有工具', () => {
        registerTool({ id: 'all-1', name: 'all-1', enabled: true, call: vi.fn() });
        registerTool({ id: 'all-2', name: 'all-2', enabled: false, call: vi.fn() });
        const all = getAllTools();
        expect(all.length).toBeGreaterThanOrEqual(2);
    });

    it('getEnabledTools 只返回启用的', () => {
        registerTool({ id: 'en-1', name: 'en-1', enabled: true, call: vi.fn() });
        registerTool({ id: 'en-2', name: 'en-2', enabled: false, call: vi.fn() });
        const enabled = getEnabledTools();
        const en2 = enabled.find((t) => t.id === 'en-2');
        expect(en2).toBeUndefined();
    });
});

describe('getTool', () => {
    it('通过 ID 查找', () => {
        registerTool({ id: 'find-by-id', name: 'finder', call: vi.fn() });
        expect(getTool('find-by-id')).not.toBeNull();
    });

    it('通过名称查找', () => {
        registerTool({ id: 'name-lookup-id', name: 'name-lookup', call: vi.fn() });
        const tool = getTool('name-lookup');
        expect(tool).not.toBeNull();
    });

    it('不存在的工具返回 null', () => {
        expect(getTool('nonexistent-xyz')).toBeNull();
    });
});

describe('getToolObject / getToolHandler', () => {
    it('getToolObject 与 getTool 相同', () => {
        registerTool({ id: 'obj-test', name: 'obj-test', call: vi.fn() });
        expect(getToolObject('obj-test')).toBe(getTool('obj-test'));
    });

    it('getToolHandler 返回 call 函数', () => {
        const fn = vi.fn();
        registerTool({ id: 'handler-test', name: 'handler-test', call: fn });
        expect(getToolHandler('handler-test')).toBe(fn);
    });

    it('不存在的工具返回 null', () => {
        expect(getToolHandler('missing-handler')).toBeNull();
    });
});

describe('setToolEnabled / isToolEnabled', () => {
    it('启用工具', () => {
        registerTool({ id: 'toggle-1', name: 'toggle-1', enabled: false, call: vi.fn() });
        setToolEnabled('toggle-1', true);
        expect(isToolEnabled('toggle-1')).toBe(true);
    });

    it('禁用工具', () => {
        registerTool({ id: 'toggle-2', name: 'toggle-2', enabled: true, call: vi.fn() });
        setToolEnabled('toggle-2', false);
        expect(isToolEnabled('toggle-2')).toBe(false);
    });

    it('不存在的工具不报错', () => {
        expect(() => setToolEnabled('nonexistent-toggle', true)).not.toThrow();
    });

    it('normalizes string "true" to boolean', () => {
        registerTool({ id: 'norm-1', name: 'norm-1', enabled: false, call: vi.fn() });
        setToolEnabled('norm-1', 'true');
        expect(isToolEnabled('norm-1')).toBe(true);
    });
});

describe('removeTool', () => {
    it('移除自定义工具', () => {
        registerTool({
            id: 'remove-me',
            name: 'remove-me',
            type: 'custom',
            enabled: true,
            call: vi.fn()
        });
        removeTool('remove-me');
        expect(getTool('remove-me')).toBeNull();
    });

    it('不能移除内置工具', () => {
        registerTool({
            id: 'builtin-keep',
            name: 'builtin-keep',
            type: 'builtin',
            enabled: true,
            call: vi.fn()
        });
        removeTool('builtin-keep');
        expect(getTool('builtin-keep')).not.toBeNull();
    });

    it('不存在的工具不报错', () => {
        expect(() => removeTool('nothing-here')).not.toThrow();
    });
});

describe('getToolsForAPI', () => {
    it('openai 格式返回 function 类型', () => {
        registerTool({
            id: 'api-fmt-1',
            name: 'api-fmt-1',
            description: 'test tool',
            enabled: true,
            call: vi.fn()
        });
        const tools = getToolsForAPI('openai');
        const found = tools.find((t) => t.function?.name === 'api-fmt-1');
        expect(found).toBeDefined();
        expect(found.type).toBe('function');
    });

    it('claude 格式返回 input_schema', () => {
        registerTool({
            id: 'api-fmt-2',
            name: 'api-fmt-2',
            description: 'claude test',
            enabled: true,
            call: vi.fn()
        });
        const tools = getToolsForAPI('claude');
        const found = tools.find((t) => t.name === 'api-fmt-2');
        expect(found).toBeDefined();
        expect(found.input_schema).toBeDefined();
    });

    it('gemini 格式返回 parameters', () => {
        registerTool({
            id: 'api-fmt-3',
            name: 'api-fmt-3',
            description: 'gemini test',
            enabled: true,
            call: vi.fn()
        });
        const tools = getToolsForAPI('gemini');
        const found = tools.find((t) => t.name === 'api-fmt-3');
        expect(found).toBeDefined();
        expect(found.parameters).toBeDefined();
    });

    it('未知格式返回空数组', () => {
        const tools = getToolsForAPI('unknown');
        expect(tools).toEqual([]);
    });
});

describe('getToolStats', () => {
    it('返回统计信息', () => {
        const stats = getToolStats();
        expect(typeof stats.total).toBe('number');
        expect(typeof stats.enabled).toBe('number');
        expect(typeof stats.builtin).toBe('number');
        expect(typeof stats.mcp).toBe('number');
        expect(typeof stats.custom).toBe('number');
    });
});
