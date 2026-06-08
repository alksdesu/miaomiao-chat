/**
 * openai-shared.js 测试
 *
 * 覆盖 Stage 3 修复点：stringifyToolResult 新增 typeof result.error === 'string'
 * 分支，让 executeToolCalls 失败返回的 errorMessage 模板字符串原文进入 API 请求
 * （不被多包一层 JSON 引号）。
 */
// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../js/api/format-converter.js', () => ({
    getMappedId: vi.fn((p, format) => `${format}_${p.id}`),
    generateIdSet: vi.fn((id) => ({
        openai: 'call_' + (id || 'new'),
        claude: 'toolu_' + (id || 'new'),
        gemini: 'gemini_' + (id || 'new')
    }))
}));

vi.mock('../../../js/utils/file-helpers.js', () => ({
    parseDataURL: vi.fn(() => null)
}));

import { stringifyToolResult } from '../../../js/api/adapters/openai-shared.js';

describe('stringifyToolResult', () => {
    it('null 返回 fallback', () => {
        expect(stringifyToolResult(null)).toBe('Tool execution was interrupted');
    });

    it('undefined 返回 fallback', () => {
        expect(stringifyToolResult(undefined)).toBe('Tool execution was interrupted');
    });

    it('字符串直接返回', () => {
        expect(stringifyToolResult('hello')).toBe('hello');
    });

    it('result.content 字符串直接返回', () => {
        expect(stringifyToolResult({ content: 'plain text' })).toBe('plain text');
    });

    it('is_error: true + error 字符串优先返回（不被 content 抢占）', () => {
        // 用户自定义工具混合返回：执行失败时即使带 content 也应优先返回 error 字符串
        const result = {
            content: 'partial output before failure',
            error: 'Tool "broken" failed. Do NOT retry.',
            is_error: true
        };
        expect(stringifyToolResult(result)).toBe('Tool "broken" failed. Do NOT retry.');
    });

    it('result.error 字符串直接返回（无 is_error 历史兼容）', () => {
        // executeToolCalls 失败 result schema: {error, is_error, original_error, failed_args}
        const errorResult = {
            error: 'Tool "missing" call failed. Do NOT retry this tool call.',
            is_error: true,
            original_error: 'not found',
            failed_args: {}
        };
        // 必须原文返回，不能被 JSON.stringify 包成 {"error":"..."}
        expect(stringifyToolResult(errorResult)).toBe(
            'Tool "missing" call failed. Do NOT retry this tool call.'
        );
    });

    it('content + error 同时存在且无 is_error 时返回 content（向后兼容）', () => {
        // 混合 schema 但未显式标 is_error：保持当前行为返回主体输出
        const result = { content: 'main output', error: 'mild warning' };
        expect(stringifyToolResult(result)).toBe('main output');
    });

    it('result.content 对象 JSON 序列化', () => {
        expect(stringifyToolResult({ content: { x: 1 } })).toBe('{"x":1}');
    });

    it('result.error 非字符串（兜底）走 JSON.stringify 包 {error:...}', () => {
        expect(stringifyToolResult({ error: { code: 500 } })).toBe('{"error":{"code":500}}');
    });

    it('整个对象 JSON 序列化兜底', () => {
        expect(stringifyToolResult({ foo: 'bar' })).toBe('{"foo":"bar"}');
    });

    it('自定义 fallback', () => {
        expect(stringifyToolResult(null, 'CUSTOM')).toBe('CUSTOM');
    });
});
