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

vi.mock('../../../js/utils/logger.js', () => ({
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

import {
    stringifyToolResult,
    assembleOpenAIConversation,
    applyOpenAITools,
    resolveOpenAIEffort,
    canSendOpenAINoneEffort,
    buildOpenAISampling,
    resolveOpenAIVerbosity,
    pushResponsesFunctionCallPair
} from '../../../js/api/adapters/openai-shared.js';
import { resolveModelProfile } from '../../../js/api/model-profiles.js';

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

describe('assembleOpenAIConversation', () => {
    const history = () => [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' }
    ];
    const noPrefill = null;

    it('systemPrompt 与 monitor 合并为首条 system 消息', () => {
        const out = assembleOpenAIConversation(
            history(),
            { systemPrompt: 'SYS', monitorContext: '+MON' },
            noPrefill
        );
        expect(out[0]).toEqual({ role: 'system', content: 'SYS+MON' });
        expect(out).toHaveLength(3);
    });

    it('只有 monitor 时单独成为 system 消息', () => {
        const out = assembleOpenAIConversation(
            history(),
            { systemPrompt: null, monitorContext: 'MON' },
            noPrefill
        );
        expect(out[0]).toEqual({ role: 'system', content: 'MON' });
    });

    it('开场对话插在 system 之后，末尾预填充追加在最后', () => {
        const out = assembleOpenAIConversation(
            history(),
            { systemPrompt: 'SYS', monitorContext: null },
            {
                opening: [{ role: 'user', content: 'open' }],
                trailing: [{ role: 'assistant', content: 'tail' }]
            }
        );
        expect(out.map((m) => m.content)).toEqual(['SYS', 'open', 'hi', 'hello', 'tail']);
    });

    it('没有 system 时开场对话插在最前', () => {
        const out = assembleOpenAIConversation(
            history(),
            { systemPrompt: null, monitorContext: null },
            { opening: [{ role: 'user', content: 'open' }], trailing: [] }
        );
        expect(out[0].content).toBe('open');
    });

    it('不修改传入的消息数组', () => {
        const messages = history();
        assembleOpenAIConversation(messages, { systemPrompt: 'SYS', monitorContext: null }, null);
        expect(messages).toHaveLength(2);
    });
});

describe('applyOpenAITools', () => {
    const tools = [{ type: 'function', function: { name: 'get_weather', parameters: {} } }];

    it('无工具时不改动请求体', () => {
        const body = {};
        applyOpenAITools(body, [], [], { isXmlMode: false, logTag: 't' });
        expect(body).toEqual({});
    });

    it('原生模式写入 tools / tool_choice 与附加字段', () => {
        const body = {};
        applyOpenAITools(body, [], tools, {
            isXmlMode: false,
            logTag: 't',
            nativeFields: { parallel_tool_calls: true }
        });
        expect(body).toEqual({ tools, tool_choice: 'auto', parallel_tool_calls: true });
    });

    it('XML 模式把工具描述注入 system 消息且不写 tools 字段', () => {
        const body = {};
        const conversation = [{ role: 'system', content: 'SYS' }];
        applyOpenAITools(body, conversation, tools, { isXmlMode: true, logTag: 't' });
        expect(body.tools).toBeUndefined();
        expect(conversation[0].content).toContain('get_weather');
    });
});

// ========== 生成参数辅助 ==========

describe('resolveOpenAIEffort', () => {
    it('未识别的型号原样发送，custom 与未知档位回落 high', () => {
        const notices = [];
        expect(resolveOpenAIEffort('max', null, notices)).toBe('max');
        expect(resolveOpenAIEffort('custom', null, notices)).toBe('high');
        expect(resolveOpenAIEffort('none', null, notices)).toBe('high');
        expect(notices).toEqual([]);
    });

    it('优先收敛到更低的支持档位，没有时向上收敛', () => {
        const notices = [];
        expect(
            resolveOpenAIEffort('max', ['none', 'low', 'medium', 'high', 'xhigh'], notices)
        ).toBe('xhigh');
        expect(resolveOpenAIEffort('minimal', ['low', 'medium'], notices)).toBe('low');
        expect(resolveOpenAIEffort('minimal', ['none', 'low'], notices)).toBe('low');
        expect(notices).toHaveLength(3);
    });
});

describe('canSendOpenAINoneEffort', () => {
    it('未识别或支持 none 的型号可以发送', () => {
        const notices = [];
        expect(canSendOpenAINoneEffort(resolveModelProfile('openai', 'x-model'), notices)).toBe(
            true
        );
        expect(canSendOpenAINoneEffort(resolveModelProfile('openai', 'gpt-5.5'), notices)).toBe(
            true
        );
        expect(notices).toEqual([]);
    });

    it('已识别但不支持 none 的型号不发送并提示', () => {
        const notices = [];
        expect(canSendOpenAINoneEffort(resolveModelProfile('openai', 'gpt-6-astra'), notices)).toBe(
            false
        );
        expect(notices).toEqual([expect.objectContaining({ key: 'openai.effort-none' })]);
    });
});

describe('buildOpenAISampling', () => {
    const userParams = {
        temperature: 0.5,
        top_p: 0.9,
        frequency_penalty: 0.1,
        presence_penalty: null,
        max_tokens: 100
    };

    it('总是接受时只发送用户设置过的值，不含 max_tokens', () => {
        expect(
            buildOpenAISampling(userParams, { rule: 'always', effectiveEffort: null, notices: [] })
        ).toEqual({ temperature: 0.5, top_p: 0.9, frequency_penalty: 0.1 });
    });

    it('不支持 penalty 时只保留 temperature 与 top_p', () => {
        expect(
            buildOpenAISampling(userParams, {
                rule: 'always',
                effectiveEffort: null,
                penalties: false,
                notices: []
            })
        ).toEqual({ temperature: 0.5, top_p: 0.9 });
    });

    it('effort-none 规则按实际生效的推理强度决定', () => {
        const notices = [];
        expect(
            buildOpenAISampling(userParams, {
                rule: 'effort-none',
                effectiveEffort: 'none',
                notices
            })
        ).toEqual({ temperature: 0.5, top_p: 0.9, frequency_penalty: 0.1 });
        expect(
            buildOpenAISampling(userParams, {
                rule: 'effort-none',
                effectiveEffort: 'medium',
                notices
            })
        ).toEqual({});
        expect(notices).toEqual([expect.objectContaining({ key: 'openai.sampling' })]);
    });

    it('没有设置采样参数时不提示', () => {
        const notices = [];
        expect(
            buildOpenAISampling(
                { temperature: null, top_p: null },
                { rule: 'never', effectiveEffort: null, notices }
            )
        ).toEqual({});
        expect(notices).toEqual([]);
    });
});

describe('resolveOpenAIVerbosity', () => {
    it('型号不支持时返回 null 并提示', () => {
        const notices = [];
        expect(resolveOpenAIVerbosity('low', { verbosity: false }, notices)).toBeNull();
        expect(notices).toHaveLength(1);
        expect(resolveOpenAIVerbosity('low', { verbosity: true }, [])).toBe('low');
        expect(resolveOpenAIVerbosity(null, { verbosity: true }, [])).toBeNull();
    });
});

describe('pushResponsesFunctionCallPair', () => {
    const part = {
        id: 'w1',
        call_id: 'call_w1',
        responseItemId: 'fc_w1',
        name: 'get_weather',
        args: { city: 'Paris' },
        result: { content: 'Sunny' }
    };

    it('默认带上 function_call 的 item id', () => {
        const out = [];
        pushResponsesFunctionCallPair(out, part);
        expect(out[0]).toMatchObject({ type: 'function_call', id: 'fc_w1', call_id: 'call_w1' });
        expect(out[1]).toEqual({
            type: 'function_call_output',
            call_id: 'call_w1',
            output: 'Sunny'
        });
    });

    it('同轮推理项无法回放时不带 item id', () => {
        const out = [];
        pushResponsesFunctionCallPair(out, part, { includeItemId: false });
        expect(out[0]).not.toHaveProperty('id');
    });
});
