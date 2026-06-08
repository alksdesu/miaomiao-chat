/**
 * calculator.js 测试
 * 计算器工具：表达式验证、计算、结果格式化
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.hoisted 在模块解析之前执行
const mockMath = vi.hoisted(() => ({
    evaluate: vi.fn(),
    config: vi.fn()
}));

// 必须在模块加载前设置 window.math
vi.hoisted(() => {
    globalThis.window = globalThis.window || {};
    globalThis.window.math = mockMath;
});

vi.mock('../../../js/tools/build-tool.js', () => ({
    buildToolFromLegacy: vi.fn((id, def, handler, opts) => ({
        id,
        name: def.name || id,
        description: def.description || '',
        parameters: def.parameters,
        type: 'builtin',
        enabled: true,
        call: handler,
        isReadOnly: opts?.isReadOnly
    }))
}));

vi.mock('../../../js/utils/logger.js', () => ({
    logger: {
        debug: vi.fn(),
        error: vi.fn(),
        warn: vi.fn()
    }
}));

import {
    calculatorTool,
    calculatorHandler,
    testCalculator
} from '../../../js/tools/builtin/calculator.js';

beforeEach(() => {
    vi.clearAllMocks();
});

describe('calculatorTool 定义', () => {
    it('名称为 calculator', () => {
        expect(calculatorTool.name).toBe('calculator');
    });

    it('有描述', () => {
        expect(calculatorTool.description).toBeTruthy();
    });

    it('parameters 包含 expression', () => {
        expect(calculatorTool.parameters.properties.expression).toBeDefined();
        expect(calculatorTool.parameters.properties.expression.type).toBe('string');
    });

    it('expression 为必填', () => {
        expect(calculatorTool.parameters.required).toContain('expression');
    });
});

describe('calculatorHandler', () => {
    it('正常计算返回结果', async () => {
        mockMath.evaluate.mockReturnValue(5);
        const result = await calculatorHandler({ expression: '2 + 3' });
        expect(result.expression).toBe('2 + 3');
        expect(result.result).toBe(5);
        expect(result.formatted).toBe('5');
    });

    it('小数结果格式化', async () => {
        mockMath.evaluate.mockReturnValue(3.14159265);
        const result = await calculatorHandler({ expression: 'pi' });
        expect(result.result).toBe(3.14159265);
        expect(result.formatted).not.toContain('e');
    });

    it('极大数整数结果', async () => {
        mockMath.evaluate.mockReturnValue(1e15);
        const result = await calculatorHandler({ expression: '10^15' });
        // 整数走 toString()
        expect(result.formatted).toBe('1000000000000000');
    });

    it('极大非整数使用科学计数法', async () => {
        mockMath.evaluate.mockReturnValue(1.23456789e15 + 0.5);
        const result = await calculatorHandler({ expression: 'big' });
        // > 1e10 且非整数 → toExponential
        expect(result.formatted).toContain('e');
    });

    it('极小数使用科学计数法', async () => {
        mockMath.evaluate.mockReturnValue(1e-15);
        const result = await calculatorHandler({ expression: '10^-15' });
        expect(result.formatted).toContain('e');
    });

    it('整数结果不带小数点', async () => {
        mockMath.evaluate.mockReturnValue(42);
        const result = await calculatorHandler({ expression: '6 * 7' });
        expect(result.formatted).toBe('42');
    });

    it('Infinity 抛出错误', async () => {
        mockMath.evaluate.mockReturnValue(Infinity);
        await expect(calculatorHandler({ expression: '1/0' })).rejects.toThrow('计算错误');
    });

    it('NaN 抛出错误', async () => {
        mockMath.evaluate.mockReturnValue(NaN);
        await expect(calculatorHandler({ expression: 'bad' })).rejects.toThrow('计算错误');
    });

    it('math.evaluate 抛出异常时包装错误', async () => {
        mockMath.evaluate.mockImplementation(() => {
            throw new Error('Unexpected end of expression');
        });
        await expect(calculatorHandler({ expression: '2 +' })).rejects.toThrow('计算错误');
    });
});

describe('表达式验证', () => {
    it('空字符串抛出错误', async () => {
        await expect(calculatorHandler({ expression: '' })).rejects.toThrow('计算错误');
    });

    it('纯空白抛出错误', async () => {
        await expect(calculatorHandler({ expression: '   ' })).rejects.toThrow('计算错误');
    });

    it('非字符串抛出错误', async () => {
        await expect(calculatorHandler({ expression: null })).rejects.toThrow('计算错误');
    });

    it('undefined 抛出错误', async () => {
        await expect(calculatorHandler({ expression: undefined })).rejects.toThrow('计算错误');
    });

    it('超长表达式 (>500) 抛出错误', async () => {
        const longExpr = '1+'.repeat(300);
        await expect(calculatorHandler({ expression: longExpr })).rejects.toThrow('计算错误');
    });

    it('包含 eval 被拒绝', async () => {
        await expect(calculatorHandler({ expression: 'eval("1+1")' })).rejects.toThrow('计算错误');
    });

    it('包含 Function 被拒绝', async () => {
        await expect(calculatorHandler({ expression: 'Function("return 1")()' })).rejects.toThrow(
            '计算错误'
        );
    });

    it('包含 require 被拒绝', async () => {
        await expect(calculatorHandler({ expression: 'require("fs")' })).rejects.toThrow(
            '计算错误'
        );
    });

    it('包含 import 被拒绝', async () => {
        await expect(calculatorHandler({ expression: 'import("evil")' })).rejects.toThrow(
            '计算错误'
        );
    });

    it('包含 document 被拒绝', async () => {
        await expect(calculatorHandler({ expression: 'document.cookie' })).rejects.toThrow(
            '计算错误'
        );
    });

    it('包含 window 被拒绝', async () => {
        await expect(calculatorHandler({ expression: 'window.location' })).rejects.toThrow(
            '计算错误'
        );
    });

    it('包含 __proto__ 被拒绝', async () => {
        await expect(calculatorHandler({ expression: '__proto__' })).rejects.toThrow('计算错误');
    });

    it('包含 constructor 被拒绝', async () => {
        await expect(calculatorHandler({ expression: 'constructor' })).rejects.toThrow('计算错误');
    });

    it('包含 prototype 被拒绝', async () => {
        await expect(calculatorHandler({ expression: 'prototype' })).rejects.toThrow('计算错误');
    });

    it('包含 fetch 被拒绝', async () => {
        await expect(calculatorHandler({ expression: 'fetch("url")' })).rejects.toThrow('计算错误');
    });

    it('包含 localStorage 被拒绝', async () => {
        await expect(
            calculatorHandler({ expression: 'localStorage.getItem("x")' })
        ).rejects.toThrow('计算错误');
    });

    it('包含 setTimeout 被拒绝', async () => {
        await expect(calculatorHandler({ expression: 'setTimeout(fn, 0)' })).rejects.toThrow(
            '计算错误'
        );
    });

    it('大小写不敏感检测', async () => {
        await expect(calculatorHandler({ expression: 'EVAL("1")' })).rejects.toThrow('计算错误');
    });

    it('合法表达式通过验证', async () => {
        mockMath.evaluate.mockReturnValue(10);
        const result = await calculatorHandler({ expression: '5 * 2' });
        expect(result.result).toBe(10);
    });
});

describe('testCalculator', () => {
    it('不抛出异常', () => {
        mockMath.evaluate.mockReturnValue(5);
        expect(() => testCalculator()).not.toThrow();
    });
});
