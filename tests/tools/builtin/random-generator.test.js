/**
 * random-generator.js 测试
 */
import { describe, it, expect } from 'vitest';

import { randomGeneratorHandler } from '../../../js/tools/builtin/random-generator.js';

describe('randomGeneratorHandler', () => {
    // number
    it('生成随机数默认范围', async () => {
        const result = await randomGeneratorHandler({ type: 'number' });
        expect(result.success).toBe(true);
        expect(result.result).toBeGreaterThanOrEqual(0);
        expect(result.result).toBeLessThanOrEqual(100);
    });

    it('生成随机数指定范围', async () => {
        const result = await randomGeneratorHandler({ type: 'number', min: 10, max: 20 });
        expect(result.result).toBeGreaterThanOrEqual(10);
        expect(result.result).toBeLessThanOrEqual(20);
    });

    it('整数参数生成整数', async () => {
        const result = await randomGeneratorHandler({ type: 'number', min: 1, max: 10 });
        expect(Number.isInteger(result.result)).toBe(true);
    });

    it('浮点参数生成浮点数', async () => {
        const result = await randomGeneratorHandler({ type: 'number', min: 1.5, max: 2.5 });
        expect(result.result).toBeGreaterThanOrEqual(1.5);
        expect(result.result).toBeLessThanOrEqual(2.5);
    });

    // string
    it('生成随机字符串默认', async () => {
        const result = await randomGeneratorHandler({ type: 'string' });
        expect(result.success).toBe(true);
        expect(result.result.length).toBe(10);
    });

    it('生成随机字符串指定长度', async () => {
        const result = await randomGeneratorHandler({ type: 'string', length: 20 });
        expect(result.result.length).toBe(20);
    });

    it('生成随机字符串 numeric', async () => {
        const result = await randomGeneratorHandler({
            type: 'string',
            length: 10,
            charset: 'numeric'
        });
        expect(result.result).toMatch(/^\d+$/);
    });

    it('生成随机字符串 lowercase', async () => {
        const result = await randomGeneratorHandler({
            type: 'string',
            length: 10,
            charset: 'lowercase'
        });
        expect(result.result).toMatch(/^[a-z]+$/);
    });

    it('生成随机字符串 uppercase', async () => {
        const result = await randomGeneratorHandler({
            type: 'string',
            length: 10,
            charset: 'uppercase'
        });
        expect(result.result).toMatch(/^[A-Z]+$/);
    });

    it('生成随机字符串 hex', async () => {
        const result = await randomGeneratorHandler({ type: 'string', length: 10, charset: 'hex' });
        expect(result.result).toMatch(/^[0-9a-f]+$/);
    });

    // uuid
    it('生成 UUID', async () => {
        const result = await randomGeneratorHandler({ type: 'uuid' });
        expect(result.result).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
        );
    });

    // password
    it('生成密码默认', async () => {
        const result = await randomGeneratorHandler({ type: 'password' });
        expect(result.success).toBe(true);
        expect(result.result.length).toBe(16);
    });

    it('生成密码指定长度', async () => {
        const result = await randomGeneratorHandler({ type: 'password', length: 32 });
        expect(result.result.length).toBe(32);
    });

    it('生成密码不含符号', async () => {
        const result = await randomGeneratorHandler({ type: 'password', include_symbols: false });
        expect(result.success).toBe(true);
    });

    // color
    it('生成颜色 hex', async () => {
        const result = await randomGeneratorHandler({ type: 'color' });
        expect(result.result).toMatch(/^#[0-9a-f]{6}$/);
    });

    it('生成颜色 rgb', async () => {
        const result = await randomGeneratorHandler({ type: 'color', format: 'rgb' });
        expect(result.result).toMatch(/^rgb\(\d+, \d+, \d+\)$/);
    });

    it('生成颜色 hsl', async () => {
        const result = await randomGeneratorHandler({ type: 'color', format: 'hsl' });
        expect(result.result).toMatch(/^hsl\(\d+, \d+%, \d+%\)$/);
    });

    // boolean
    it('生成布尔值', async () => {
        const result = await randomGeneratorHandler({ type: 'boolean' });
        expect(typeof result.result).toBe('boolean');
    });

    // choice
    it('生成选择', async () => {
        const result = await randomGeneratorHandler({ type: 'choice', choices: ['a', 'b', 'c'] });
        expect(['a', 'b', 'c']).toContain(result.result);
    });

    it('无选项抛异常', async () => {
        await expect(randomGeneratorHandler({ type: 'choice' })).rejects.toThrow('choices');
    });

    it('空选项抛异常', async () => {
        await expect(randomGeneratorHandler({ type: 'choice', choices: [] })).rejects.toThrow(
            'choices'
        );
    });

    // array
    it('生成随机数组', async () => {
        const result = await randomGeneratorHandler({ type: 'array', count: 3 });
        expect(result.result).toHaveLength(3);
    });

    it('生成字符串数组', async () => {
        const result = await randomGeneratorHandler({
            type: 'array',
            count: 2,
            array_type: 'string'
        });
        expect(result.result).toHaveLength(2);
        expect(typeof result.result[0]).toBe('string');
    });

    it('生成 UUID 数组', async () => {
        const result = await randomGeneratorHandler({
            type: 'array',
            count: 2,
            array_type: 'uuid'
        });
        expect(result.result).toHaveLength(2);
    });

    it('生成布尔数组', async () => {
        const result = await randomGeneratorHandler({
            type: 'array',
            count: 3,
            array_type: 'boolean'
        });
        expect(result.result).toHaveLength(3);
    });

    // unknown type
    it('未知类型抛异常', async () => {
        await expect(randomGeneratorHandler({ type: 'unknown' })).rejects.toThrow(
            '不支持的生成类型'
        );
    });
});
