/**
 * validator.js 测试
 */
import { describe, it, expect } from 'vitest';

import { safeValidate, formatValidationErrors } from '../../js/tools/validator.js';

// ========== safeValidate ==========

describe('safeValidate', () => {
    it('无 schema 通过', () => {
        expect(safeValidate({ a: 1 }, null).valid).toBe(true);
        expect(safeValidate({ a: 1 }, undefined).valid).toBe(true);
    });

    it('schema 非对象通过', () => {
        expect(safeValidate({}, 'string').valid).toBe(true);
    });

    it('空 object schema 通过', () => {
        const result = safeValidate({ a: 1 }, { type: 'object' });
        expect(result.valid).toBe(true);
    });

    it('非对象参数失败', () => {
        const result = safeValidate('string', { type: 'object' });
        expect(result.valid).toBe(false);
        expect(result.errors[0].message).toContain('对象');
    });

    it('null 参数失败', () => {
        const result = safeValidate(null, { type: 'object' });
        expect(result.valid).toBe(false);
    });

    it('必填字段验证', () => {
        const schema = {
            type: 'object',
            required: ['name', 'age'],
            properties: {
                name: { type: 'string' },
                age: { type: 'number' }
            }
        };
        const result = safeValidate({ name: 'test' }, schema);
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.path === 'age')).toBe(true);
    });

    it('必填字段全部通过', () => {
        const schema = {
            type: 'object',
            required: ['name'],
            properties: { name: { type: 'string' } }
        };
        expect(safeValidate({ name: 'test' }, schema).valid).toBe(true);
    });

    it('额外属性禁止', () => {
        const schema = {
            type: 'object',
            properties: { a: { type: 'string' } },
            additionalProperties: false
        };
        const result = safeValidate({ a: 'ok', b: 'extra' }, schema);
        expect(result.valid).toBe(false);
        expect(result.errors[0].path).toBe('b');
    });

    it('额外属性允许(默认)', () => {
        const schema = {
            type: 'object',
            properties: { a: { type: 'string' } }
        };
        expect(safeValidate({ a: 'ok', b: 'extra' }, schema).valid).toBe(true);
    });

    // 类型验证
    it('字符串类型正确', () => {
        const schema = { type: 'object', properties: { s: { type: 'string' } } };
        expect(safeValidate({ s: 'hello' }, schema).valid).toBe(true);
    });

    it('字符串类型错误', () => {
        const schema = { type: 'object', properties: { s: { type: 'string' } } };
        const result = safeValidate({ s: 123 }, schema);
        expect(result.valid).toBe(false);
        expect(result.errors[0].message).toContain('类型错误');
    });

    it('数字类型正确', () => {
        const schema = { type: 'object', properties: { n: { type: 'number' } } };
        expect(safeValidate({ n: 42 }, schema).valid).toBe(true);
    });

    it('布尔类型正确', () => {
        const schema = { type: 'object', properties: { b: { type: 'boolean' } } };
        expect(safeValidate({ b: true }, schema).valid).toBe(true);
    });

    it('integer 接受整数', () => {
        const schema = { type: 'object', properties: { i: { type: 'integer' } } };
        expect(safeValidate({ i: 5 }, schema).valid).toBe(true);
    });

    it('integer 拒绝小数', () => {
        const schema = { type: 'object', properties: { i: { type: 'integer' } } };
        const result = safeValidate({ i: 5.5 }, schema);
        expect(result.valid).toBe(false);
        expect(result.errors[0].message).toContain('整数');
    });

    // 字符串约束
    it('minLength 验证', () => {
        const schema = { type: 'object', properties: { s: { type: 'string', minLength: 3 } } };
        expect(safeValidate({ s: 'ab' }, schema).valid).toBe(false);
        expect(safeValidate({ s: 'abc' }, schema).valid).toBe(true);
    });

    it('maxLength 验证', () => {
        const schema = { type: 'object', properties: { s: { type: 'string', maxLength: 3 } } };
        expect(safeValidate({ s: 'abcd' }, schema).valid).toBe(false);
        expect(safeValidate({ s: 'abc' }, schema).valid).toBe(true);
    });

    it('pattern 验证', () => {
        const schema = {
            type: 'object',
            properties: { s: { type: 'string', pattern: '^[a-z]+$' } }
        };
        expect(safeValidate({ s: 'abc' }, schema).valid).toBe(true);
        expect(safeValidate({ s: 'ABC' }, schema).valid).toBe(false);
    });

    it('enum 验证', () => {
        const schema = {
            type: 'object',
            properties: { s: { type: 'string', enum: ['a', 'b', 'c'] } }
        };
        expect(safeValidate({ s: 'a' }, schema).valid).toBe(true);
        expect(safeValidate({ s: 'd' }, schema).valid).toBe(false);
    });

    // 数字约束
    it('minimum 验证', () => {
        const schema = { type: 'object', properties: { n: { type: 'number', minimum: 0 } } };
        expect(safeValidate({ n: -1 }, schema).valid).toBe(false);
        expect(safeValidate({ n: 0 }, schema).valid).toBe(true);
    });

    it('maximum 验证', () => {
        const schema = { type: 'object', properties: { n: { type: 'number', maximum: 100 } } };
        expect(safeValidate({ n: 101 }, schema).valid).toBe(false);
        expect(safeValidate({ n: 100 }, schema).valid).toBe(true);
    });

    // 数组验证
    it('数组类型正确', () => {
        const schema = { type: 'object', properties: { a: { type: 'array' } } };
        expect(safeValidate({ a: [1, 2] }, schema).valid).toBe(true);
    });

    it('数组 minItems', () => {
        const schema = { type: 'object', properties: { a: { type: 'array', minItems: 2 } } };
        expect(safeValidate({ a: [1] }, schema).valid).toBe(false);
        expect(safeValidate({ a: [1, 2] }, schema).valid).toBe(true);
    });

    it('数组 maxItems', () => {
        const schema = { type: 'object', properties: { a: { type: 'array', maxItems: 2 } } };
        expect(safeValidate({ a: [1, 2, 3] }, schema).valid).toBe(false);
    });

    it('数组 items 类型验证', () => {
        const schema = {
            type: 'object',
            properties: {
                a: { type: 'array', items: { type: 'string' } }
            }
        };
        expect(safeValidate({ a: ['a', 'b'] }, schema).valid).toBe(true);
        expect(safeValidate({ a: ['a', 1] }, schema).valid).toBe(false);
    });

    // 嵌套对象验证
    it('嵌套对象属性验证', () => {
        const schema = {
            type: 'object',
            properties: {
                nested: {
                    type: 'object',
                    properties: { x: { type: 'number' } },
                    required: ['x']
                }
            }
        };
        expect(safeValidate({ nested: { x: 1 } }, schema).valid).toBe(true);
        expect(safeValidate({ nested: {} }, schema).valid).toBe(false);
    });

    // 非对象顶层 schema
    it('顶层 string schema', () => {
        expect(safeValidate('hello', { type: 'string' }).valid).toBe(true);
        expect(safeValidate(123, { type: 'string' }).valid).toBe(false);
    });

    // null 类型
    it('null 类型识别', () => {
        const schema = { type: 'object', properties: { n: { type: 'string' } } };
        const result = safeValidate({ n: null }, schema);
        expect(result.valid).toBe(false);
    });
});

// ========== formatValidationErrors ==========

describe('formatValidationErrors', () => {
    it('空错误返回通过', () => {
        expect(formatValidationErrors([])).toBe('参数验证通过');
        expect(formatValidationErrors(null)).toBe('参数验证通过');
    });

    it('格式化错误信息', () => {
        const errors = [
            { path: 'name', message: '缺少必填字段: name' },
            { path: '', message: '参数必须是对象' }
        ];
        const result = formatValidationErrors(errors);
        expect(result).toContain('参数验证失败');
        expect(result).toContain('name');
        expect(result).toContain('参数必须是对象');
    });

    it('带路径的错误包含字段名', () => {
        const errors = [{ path: 'age', message: '类型错误' }];
        const result = formatValidationErrors(errors);
        expect(result).toContain('字段 "age"');
    });

    it('无路径的错误不包含字段前缀', () => {
        const errors = [{ path: '', message: '顶层错误' }];
        const result = formatValidationErrors(errors);
        expect(result).not.toContain('字段 ""');
        expect(result).toContain('顶层错误');
    });
});
