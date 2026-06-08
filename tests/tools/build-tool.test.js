/**
 * build-tool.js 测试
 */
import { describe, it, expect } from 'vitest';

import { buildTool, buildToolFromLegacy } from '../../js/tools/build-tool.js';

// ========== buildTool ==========

describe('buildTool', () => {
    it('最小参数构建', () => {
        const tool = buildTool({ name: 'test', call: () => {} });
        expect(tool.name).toBe('test');
        expect(typeof tool.call).toBe('function');
    });

    it('无 name 抛异常', () => {
        expect(() => buildTool({ call: () => {} })).toThrow('name is required');
    });

    it('无 call 抛异常', () => {
        expect(() => buildTool({ name: 'test' })).toThrow('must have call()');
    });

    it('handler 兼容 call', () => {
        const fn = () => 'result';
        const tool = buildTool({ name: 'test', handler: fn });
        expect(typeof tool.call).toBe('function');
    });

    it('填充默认值', () => {
        const tool = buildTool({ name: 'test', call: () => {} });
        expect(tool.description).toBe('');
        expect(tool.type).toBe('builtin');
        expect(tool.hidden).toBe(false);
        expect(tool.enabled).toBe(false);
        expect(tool.rateLimit).toBeNull();
        expect(tool.timeout).toBeNull();
        expect(tool.validate).toBeNull();
        expect(tool.checkPermissions).toBeNull();
    });

    it('自定义属性覆盖默认值', () => {
        const tool = buildTool({
            name: 'test',
            call: () => {},
            description: 'my tool',
            type: 'mcp',
            hidden: true,
            enabled: true,
            rateLimit: { max: 10, unit: 'minute' }
        });
        expect(tool.description).toBe('my tool');
        expect(tool.type).toBe('mcp');
        expect(tool.hidden).toBe(true);
        expect(tool.enabled).toBe(true);
        expect(tool.rateLimit.max).toBe(10);
    });

    it('inputSchema 自动设置为 parameters', () => {
        const params = { type: 'object', properties: { q: { type: 'string' } } };
        const tool = buildTool({ name: 'test', call: () => {}, parameters: params });
        expect(tool.inputSchema).toBe(params);
    });

    it('显式 inputSchema 优先', () => {
        const inputSchema = { type: 'object', properties: { x: { type: 'number' } } };
        const tool = buildTool({
            name: 'test',
            call: () => {},
            parameters: { type: 'object' },
            inputSchema
        });
        expect(tool.inputSchema).toBe(inputSchema);
    });

    it('isReadOnly 默认返回 false', () => {
        const tool = buildTool({ name: 'test', call: () => {} });
        expect(tool.isReadOnly()).toBe(false);
    });

    it('自定义 isReadOnly', () => {
        const tool = buildTool({ name: 'test', call: () => {}, isReadOnly: () => true });
        expect(tool.isReadOnly()).toBe(true);
    });
});

// ========== buildToolFromLegacy ==========

describe('buildToolFromLegacy', () => {
    it('从旧格式构建', () => {
        const definition = {
            name: 'calc',
            description: 'Calculator',
            parameters: { type: 'object' }
        };
        const handler = () => 42;
        const tool = buildToolFromLegacy('calc-id', definition, handler);
        expect(tool.id).toBe('calc-id');
        expect(tool.name).toBe('calc');
        expect(tool.description).toBe('Calculator');
        expect(tool.call).toBe(handler);
        expect(tool.type).toBe('builtin');
    });

    it('覆盖属性', () => {
        const definition = { name: 'tool1', description: 'desc' };
        const handler = () => {};
        const tool = buildToolFromLegacy('id1', definition, handler, {
            hidden: true,
            enabled: true
        });
        expect(tool.hidden).toBe(true);
        expect(tool.enabled).toBe(true);
    });

    it('inputSchema 使用 definition.inputSchema', () => {
        const definition = { name: 'tool1', description: 'desc', inputSchema: { type: 'object' } };
        const handler = () => {};
        const tool = buildToolFromLegacy('id1', definition, handler);
        expect(tool.inputSchema).toEqual({ type: 'object' });
    });
});
