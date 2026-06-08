/**
 * tool-result-builder.js 测试
 * 需要 mock 掉外部依赖：state, getCurrentProvider, getOrCreateMappedId, escapeXML
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// mock 所有外部依赖
vi.mock('../../js/core/state.js', () => ({
    state: { xmlToolCallingEnabled: false }
}));

vi.mock('../../js/providers/manager.js', () => ({
    getCurrentProvider: vi.fn(() => ({ apiFormat: 'openai' }))
}));

vi.mock('../../js/api/format-converter.js', () => ({
    getOrCreateMappedId: vi.fn((id) => `mapped_${id}`)
}));

vi.mock('../../js/tools/xml-formatter.js', () => ({
    escapeXML: vi.fn((s) =>
        typeof s === 'string'
            ? s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            : ''
    )
}));

import { buildToolResultMessages } from '../../js/tools/tool-result-builder.js';
import { state } from '../../js/core/state.js';
import { getCurrentProvider } from '../../js/providers/manager.js';

const TOOL_CALLS = [{ id: 'tc_1', name: 'search', arguments: { q: 'test' } }];
const TOOL_RESULTS = [{ id: 'tc_1', name: 'search', result: { data: 'ok' }, isError: false }];

beforeEach(() => {
    state.xmlToolCallingEnabled = false;
    getCurrentProvider.mockReturnValue({ apiFormat: 'openai' });
});

// ========== OpenAI Chat Completions ==========

describe('OpenAI Chat Completions 格式', () => {
    it('生成 assistant + tool 消息', () => {
        const msgs = buildToolResultMessages('openai', TOOL_CALLS, TOOL_RESULTS);
        expect(msgs).toHaveLength(2);

        // assistant 消息
        expect(msgs[0].role).toBe('assistant');
        expect(msgs[0].tool_calls).toHaveLength(1);
        expect(msgs[0].tool_calls[0].function.name).toBe('search');

        // tool 结果消息
        expect(msgs[1].role).toBe('tool');
        expect(msgs[1].tool_call_id).toBe('mapped_tc_1');
        expect(JSON.parse(msgs[1].content)).toEqual({ data: 'ok' });
    });
});

// ========== OpenAI Responses API ==========

describe('OpenAI Responses API 格式', () => {
    it('生成 function_call + function_call_output', () => {
        getCurrentProvider.mockReturnValue({ apiFormat: 'openai-responses' });

        const msgs = buildToolResultMessages('openai', TOOL_CALLS, TOOL_RESULTS);
        expect(msgs).toHaveLength(2);

        expect(msgs[0].type).toBe('function_call');
        expect(msgs[0].name).toBe('search');
        expect(msgs[0].call_id).toBe('tc_1');

        expect(msgs[1].type).toBe('function_call_output');
        expect(msgs[1].call_id).toBe('mapped_tc_1');
    });
});

// ========== Claude ==========

describe('Claude 格式', () => {
    it('生成 assistant(tool_use) + user(tool_result)', () => {
        const msgs = buildToolResultMessages('claude', TOOL_CALLS, TOOL_RESULTS);
        expect(msgs).toHaveLength(2);

        // assistant content 包含 tool_use
        expect(msgs[0].role).toBe('assistant');
        expect(msgs[0].content[0].type).toBe('tool_use');
        expect(msgs[0].content[0].name).toBe('search');
        expect(msgs[0].content[0].input).toEqual({ q: 'test' });

        // user content 包含 tool_result
        expect(msgs[1].role).toBe('user');
        expect(msgs[1].content[0].type).toBe('tool_result');
        expect(msgs[1].content[0].tool_use_id).toBe('tc_1');
    });
});

// ========== Gemini ==========

describe('Gemini 格式', () => {
    it('生成 model(functionCall) + user(functionResponse)', () => {
        const msgs = buildToolResultMessages('gemini', TOOL_CALLS, TOOL_RESULTS);
        expect(msgs).toHaveLength(2);

        expect(msgs[0].role).toBe('model');
        expect(msgs[0].parts[0].functionCall.name).toBe('search');

        expect(msgs[1].role).toBe('user');
        expect(msgs[1].parts[0].functionResponse.name).toBe('search');
        expect(msgs[1].parts[0].functionResponse.response.result).toEqual({ data: 'ok' });
    });
});

// ========== XML 模式 ==========

describe('XML 模式', () => {
    it('所有格式统一使用 XML', () => {
        state.xmlToolCallingEnabled = true;

        const msgs = buildToolResultMessages('openai', TOOL_CALLS, TOOL_RESULTS);
        expect(msgs).toHaveLength(2);
        expect(msgs[0].role).toBe('assistant');
        expect(msgs[0].content).toContain('<tool_use>');
        expect(msgs[0].content).toContain('search');

        expect(msgs[1].role).toBe('user');
        expect(msgs[1].content).toContain('<tool_use_result>');
    });

    it('XML 模式下 claude 格式也走 XML', () => {
        state.xmlToolCallingEnabled = true;

        const msgs = buildToolResultMessages('claude', TOOL_CALLS, TOOL_RESULTS);
        expect(msgs[0].content).toContain('<tool_use>');
    });
});

// ========== 边界情况 ==========

describe('边界情况', () => {
    it('未知格式默认走 OpenAI', () => {
        const msgs = buildToolResultMessages('unknown_format', TOOL_CALLS, TOOL_RESULTS);
        expect(msgs[0].role).toBe('assistant');
        expect(msgs[0].tool_calls).toBeDefined();
    });

    it('多个工具调用', () => {
        const calls = [
            { id: 'tc_1', name: 'search', arguments: { q: 'a' } },
            { id: 'tc_2', name: 'calc', arguments: { expr: '1+1' } }
        ];
        const results = [
            { id: 'tc_1', name: 'search', result: 'found' },
            { id: 'tc_2', name: 'calc', result: 2 }
        ];
        const msgs = buildToolResultMessages('claude', calls, results);
        expect(msgs[0].content).toHaveLength(2);
        expect(msgs[1].content).toHaveLength(2);
    });
});
