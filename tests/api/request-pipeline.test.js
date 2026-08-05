/**
 * request-pipeline.js 测试
 *
 * 验证 executeRequest 编排顺序、filterPosition 分支、SystemContext / Prefill / Tools 装配。
 * 用 stub adapter 隔离 pipeline 逻辑与具体 adapter 实现。
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------- mocks ----------

vi.mock('../../js/core/state.js', () => ({
    state: {
        messages: [],
        systemPrompt: '',
        monitorEnabled: false,
        prefillEnabled: false,
        streamEnabled: true,
        xmlToolCallingEnabled: false,
        geminiSystemPartsEnabled: false,
        geminiSystemParts: []
    }
}));

vi.mock('../../js/utils/logger.js', () => ({
    logger: { warn: vi.fn(), debug: vi.fn(), error: vi.fn(), info: vi.fn() }
}));

vi.mock('../../js/utils/variables.js', () => ({
    processVariables: vi.fn((s) => `processed:${s}`)
}));

vi.mock('../../js/utils/message-filter.js', () => ({
    filterMessagesByCapabilities: vi.fn((msgs) => msgs.filter((m) => m.role !== '__drop__'))
}));

vi.mock('../../js/providers/manager.js', () => ({
    getCurrentModelCapabilities: vi.fn(() => null)
}));

vi.mock('../../js/utils/prefill.js', () => ({
    getOpeningMessages: vi.fn(() => [{ role: 'user', content: '__opening__' }]),
    getPrefillMessages: vi.fn(() => [{ role: 'assistant', content: '__trailing__' }])
}));

vi.mock('../../js/api/params.js', () => ({
    buildModelParams: vi.fn(() => ({ temperature: 0.7 })),
    buildThinkingConfig: vi.fn(() => null),
    buildVerbosityConfig: vi.fn(() => null),
    getCustomHeadersObject: vi.fn(() => ({ 'X-Custom': 'value' }))
}));

vi.mock('../../js/tools/manager.js', () => ({
    getToolsForAPI: vi.fn(() => [{ name: 'system_tool' }])
}));

vi.mock('../../js/devtools/context-builder.js', () => ({
    buildDevToolsContext: vi.fn(() => '\n\n[MONITOR CONTEXT]\n')
}));

import { executeRequest } from '../../js/api/request-pipeline.js';
import { state } from '../../js/core/state.js';
import { filterMessagesByCapabilities } from '../../js/utils/message-filter.js';
import { getCurrentModelCapabilities } from '../../js/providers/manager.js';
import { buildThinkingConfig, buildVerbosityConfig } from '../../js/api/params.js';

// ---------- stub adapter 工厂 ----------

/**
 * 构造可观察的 stub adapter。每个方法都是 vi.fn 以便断言调用顺序与参数。
 */
function createStubAdapter(overrides = {}) {
    return {
        name: 'Stub',
        apiFormat: 'stub',
        filterPosition: 'before',

        parserClass: class {},
        streamParser: vi.fn(),

        partsToAPIMessages: vi.fn((msgs) => msgs.map((m) => ({ role: m.role, _stub: true }))),
        parseResponse: vi.fn(() => null),

        collectBuiltinTools: vi.fn(() => [{ name: 'builtin_tool' }]),
        formatSystemTools: vi.fn((tools) => tools),
        buildRequestBody: vi.fn(({ messages, model, modelParams, tools }) => ({
            model,
            messages,
            tools,
            ...modelParams
        })),
        resolveEndpoint: vi.fn((endpoint) => endpoint),
        buildHeaders: vi.fn((apiKey) => ({ Authorization: `Bearer ${apiKey}` })),
        buildQueryString: vi.fn(() => ''),

        ...overrides
    };
}

// ---------- 公共 setup ----------

let fetchSpy;

beforeEach(() => {
    vi.clearAllMocks();
    state.messages = [{ role: 'user', content: 'hi' }];
    state.systemPrompt = '';
    state.monitorEnabled = false;
    state.prefillEnabled = false;
    state.streamEnabled = true;
    state.xmlToolCallingEnabled = false;
    state.geminiSystemPartsEnabled = false;
    state.geminiSystemParts = [];

    getCurrentModelCapabilities.mockReturnValue(null);
    filterMessagesByCapabilities.mockImplementation((msgs) =>
        msgs.filter((m) => m.role !== '__drop__')
    );

    fetchSpy = vi.fn(() => Promise.resolve(new Response('{}', { status: 200 })));
    globalThis.fetch = fetchSpy;
});

// ========== executeRequest 编排顺序 ==========

describe('executeRequest 编排顺序', () => {
    it('按 filter → partsToAPIMessages → buildRequestBody → resolveEndpoint → buildHeaders → fetch 顺序执行', async () => {
        const adapter = createStubAdapter();
        const order = [];

        adapter.partsToAPIMessages.mockImplementation((msgs) => {
            order.push('partsToAPIMessages');
            return msgs.map((m) => ({ role: m.role }));
        });
        adapter.collectBuiltinTools.mockImplementation(() => {
            order.push('collectBuiltinTools');
            return [];
        });
        adapter.buildRequestBody.mockImplementation((ctx) => {
            order.push('buildRequestBody');
            return { model: ctx.model, messages: ctx.messages };
        });
        adapter.resolveEndpoint.mockImplementation((ep) => {
            order.push('resolveEndpoint');
            return ep;
        });
        adapter.buildHeaders.mockImplementation((key) => {
            order.push('buildHeaders');
            return { Authorization: `Bearer ${key}` };
        });
        adapter.buildQueryString.mockImplementation(() => {
            order.push('buildQueryString');
            return '';
        });
        fetchSpy.mockImplementation(() => {
            order.push('fetch');
            return Promise.resolve(new Response('{}'));
        });

        await executeRequest(adapter, {
            endpoint: 'https://api.example.com/v1/chat',
            apiKey: 'sk-test',
            model: 'test-model'
        });

        // partsToAPIMessages 必须在 buildRequestBody 之前；collectBuiltinTools 在 buildRequestBody 之前
        const partsIdx = order.indexOf('partsToAPIMessages');
        const builtinIdx = order.indexOf('collectBuiltinTools');
        const bodyIdx = order.indexOf('buildRequestBody');
        const endpointIdx = order.indexOf('resolveEndpoint');
        const headerIdx = order.indexOf('buildHeaders');
        const fetchIdx = order.indexOf('fetch');

        expect(partsIdx).toBeLessThan(bodyIdx);
        expect(builtinIdx).toBeLessThan(bodyIdx);
        expect(bodyIdx).toBeLessThan(endpointIdx);
        expect(endpointIdx).toBeLessThan(fetchIdx);
        expect(headerIdx).toBeLessThan(fetchIdx);
    });

    it('fetch 收到 adapter.resolveEndpoint 返回的 URL', async () => {
        const adapter = createStubAdapter();
        adapter.resolveEndpoint.mockReturnValue('https://resolved.example.com/v2');

        await executeRequest(adapter, {
            endpoint: 'https://original.example.com',
            apiKey: 'k',
            model: 'm'
        });

        expect(fetchSpy.mock.calls[0][0]).toBe('https://resolved.example.com/v2');
    });

    it('queryString 非空时拼到 URL', async () => {
        const adapter = createStubAdapter();
        adapter.buildQueryString.mockReturnValue('key=abc&v=1');

        await executeRequest(adapter, {
            endpoint: 'https://api.example.com',
            apiKey: 'k',
            model: 'm'
        });

        expect(fetchSpy.mock.calls[0][0]).toBe('https://api.example.com?key=abc&v=1');
    });

    it('fetch options 包含 method=POST + Content-Type + adapter.buildHeaders + customHeaders', async () => {
        const adapter = createStubAdapter();
        adapter.buildHeaders.mockReturnValue({
            Authorization: 'Bearer test-key',
            'X-Adapter': 'stub'
        });

        await executeRequest(adapter, {
            endpoint: 'https://api.example.com',
            apiKey: 'test-key',
            model: 'm'
        });

        const [, options] = fetchSpy.mock.calls[0];
        expect(options.method).toBe('POST');
        expect(options.headers['Content-Type']).toBe('application/json');
        expect(options.headers.Authorization).toBe('Bearer test-key');
        expect(options.headers['X-Adapter']).toBe('stub');
        expect(options.headers['X-Custom']).toBe('value'); // 来自 getCustomHeadersObject mock
    });

    it('body 来自 adapter.buildRequestBody JSON 序列化', async () => {
        const adapter = createStubAdapter();
        adapter.buildRequestBody.mockReturnValue({ foo: 'bar', n: 42 });

        await executeRequest(adapter, {
            endpoint: 'https://api.example.com',
            apiKey: 'k',
            model: 'm'
        });

        expect(JSON.parse(fetchSpy.mock.calls[0][1].body)).toEqual({ foo: 'bar', n: 42 });
    });

    it('signal 传给 fetch options', async () => {
        const adapter = createStubAdapter();
        const controller = new AbortController();

        await executeRequest(adapter, {
            endpoint: 'https://api.example.com',
            apiKey: 'k',
            model: 'm',
            signal: controller.signal
        });

        expect(fetchSpy.mock.calls[0][1].signal).toBe(controller.signal);
    });

    it('未传 signal 时 options 无 signal 字段', async () => {
        const adapter = createStubAdapter();

        await executeRequest(adapter, {
            endpoint: 'https://api.example.com',
            apiKey: 'k',
            model: 'm'
        });

        expect(fetchSpy.mock.calls[0][1].signal).toBeUndefined();
    });
});

describe('adapter 请求能力声明', () => {
    it('关闭聊天特性时跳过 system、prefill、tools、thinking 和 verbosity', async () => {
        state.systemPrompt = 'system';
        state.monitorEnabled = true;
        state.prefillEnabled = true;
        const adapter = createStubAdapter({
            requestFeatures: {
                system: false,
                prefill: false,
                tools: false,
                thinking: false,
                verbosity: false
            }
        });

        await executeRequest(adapter, {
            endpoint: 'https://example.com/v1/images/generations',
            apiKey: 'key',
            model: 'custom-image-model'
        });

        expect(adapter.collectBuiltinTools).not.toHaveBeenCalled();
        expect(adapter.formatSystemTools).not.toHaveBeenCalled();
        expect(buildThinkingConfig).not.toHaveBeenCalled();
        expect(buildVerbosityConfig).not.toHaveBeenCalled();
        expect(adapter.buildRequestBody).toHaveBeenCalledWith(
            expect.objectContaining({ systemCtx: {}, prefill: null, tools: [] })
        );
        expect(adapter.resolveEndpoint).toHaveBeenCalledWith(
            'https://example.com/v1/images/generations',
            'custom-image-model',
            true,
            expect.any(Object),
            { state }
        );
    });
});

// ========== filterPosition 分支 ==========

describe('filterPosition 分支', () => {
    it("'before' 模式：在 partsToAPIMessages 之前过滤 state.messages", async () => {
        const adapter = createStubAdapter({ filterPosition: 'before' });
        getCurrentModelCapabilities.mockReturnValue({ supportsImage: false });
        state.messages = [
            { role: 'user', content: 'keep' },
            { role: '__drop__', content: 'drop me' }
        ];

        await executeRequest(adapter, {
            endpoint: 'https://api.example.com',
            apiKey: 'k',
            model: 'm'
        });

        // partsToAPIMessages 接收已过滤后的 state.messages（旧格式 schema）
        const calledWith = adapter.partsToAPIMessages.mock.calls[0][0];
        expect(calledWith).toHaveLength(1);
        expect(calledWith[0].role).toBe('user');
    });

    it("'after' 模式：在 partsToAPIMessages 之后过滤其输出", async () => {
        const adapter = createStubAdapter({ filterPosition: 'after' });
        getCurrentModelCapabilities.mockReturnValue({ supportsImage: false });
        adapter.partsToAPIMessages.mockReturnValue([
            { role: 'user', content: 'converted' },
            { role: '__drop__', content: 'drop after convert' }
        ]);

        await executeRequest(adapter, {
            endpoint: 'https://api.example.com',
            apiKey: 'k',
            model: 'm'
        });

        // buildRequestBody.messages 是过滤后的转换结果
        const ctx = adapter.buildRequestBody.mock.calls[0][0];
        expect(ctx.messages).toHaveLength(1);
        expect(ctx.messages[0].role).toBe('user');
    });

    it('capabilities=null 时跳过过滤', async () => {
        const adapter = createStubAdapter({ filterPosition: 'before' });
        getCurrentModelCapabilities.mockReturnValue(null);
        state.messages = [
            { role: 'user', content: 'a' },
            { role: '__drop__', content: 'b' }
        ];

        await executeRequest(adapter, {
            endpoint: 'https://api.example.com',
            apiKey: 'k',
            model: 'm'
        });

        // 跳过过滤：partsToAPIMessages 收到 isError 过滤后但 capabilities 未过滤的消息
        const calledWith = adapter.partsToAPIMessages.mock.calls[0][0];
        expect(calledWith).toHaveLength(2);
    });

    it("partsToAPIMessages 的 opts.injectReasoning 仅在 'openai-responses' 时为 true", async () => {
        const responsesAdapter = createStubAdapter({ apiFormat: 'openai-responses' });
        await executeRequest(responsesAdapter, {
            endpoint: 'https://api.example.com',
            apiKey: 'k',
            model: 'm'
        });
        expect(responsesAdapter.partsToAPIMessages.mock.calls[0][1]).toEqual({
            injectReasoning: true
        });

        const otherAdapter = createStubAdapter({ apiFormat: 'openai' });
        await executeRequest(otherAdapter, {
            endpoint: 'https://api.example.com',
            apiKey: 'k',
            model: 'm'
        });
        expect(otherAdapter.partsToAPIMessages.mock.calls[0][1]).toEqual({
            injectReasoning: false
        });
    });

    it('过滤掉 isError / error 消息', async () => {
        const adapter = createStubAdapter();
        state.messages = [
            { role: 'user', content: 'ok' },
            { role: 'assistant', content: 'err', isError: true },
            { role: 'assistant', content: 'err2', error: { type: 'api' } }
        ];

        await executeRequest(adapter, {
            endpoint: 'https://api.example.com',
            apiKey: 'k',
            model: 'm'
        });

        const calledWith = adapter.partsToAPIMessages.mock.calls[0][0];
        expect(calledWith).toHaveLength(1);
        expect(calledWith[0].content).toBe('ok');
    });
});

// ========== SystemContext 装配 ==========

describe('SystemContext 装配', () => {
    it('systemPrompt 非空时经 processVariables 处理后传 adapter', async () => {
        const adapter = createStubAdapter();
        state.systemPrompt = 'Be helpful';

        await executeRequest(adapter, {
            endpoint: 'https://api.example.com',
            apiKey: 'k',
            model: 'm'
        });

        const ctx = adapter.buildRequestBody.mock.calls[0][0];
        expect(ctx.systemCtx.systemPrompt).toBe('processed:Be helpful');
        expect(ctx.systemCtx.monitorContext).toBeNull();
        expect(ctx.systemCtx.geminiSystemParts).toBeNull();
    });

    it('systemPrompt 为空时 systemCtx.systemPrompt = null', async () => {
        const adapter = createStubAdapter();
        state.systemPrompt = '';

        await executeRequest(adapter, {
            endpoint: 'https://api.example.com',
            apiKey: 'k',
            model: 'm'
        });

        expect(adapter.buildRequestBody.mock.calls[0][0].systemCtx.systemPrompt).toBeNull();
    });

    it('monitorEnabled=true 时注入 monitorContext', async () => {
        const adapter = createStubAdapter();
        state.monitorEnabled = true;

        await executeRequest(adapter, {
            endpoint: 'https://api.example.com',
            apiKey: 'k',
            model: 'm'
        });

        const ctx = adapter.buildRequestBody.mock.calls[0][0];
        expect(ctx.systemCtx.monitorContext).toBe('\n\n[MONITOR CONTEXT]\n');
    });

    it('geminiSystemPartsEnabled + 非空数组时拼出 geminiSystemParts', async () => {
        const adapter = createStubAdapter();
        state.geminiSystemPartsEnabled = true;
        state.geminiSystemParts = [{ text: 'P1' }, { text: 'P2' }, { text: '' }];

        await executeRequest(adapter, {
            endpoint: 'https://api.example.com',
            apiKey: 'k',
            model: 'm'
        });

        const ctx = adapter.buildRequestBody.mock.calls[0][0];
        expect(ctx.systemCtx.geminiSystemParts).toEqual([
            { text: 'processed:P1' },
            { text: 'processed:P2' }
        ]);
    });

    it('geminiSystemPartsEnabled=false 时 geminiSystemParts 为 null', async () => {
        const adapter = createStubAdapter();
        state.geminiSystemPartsEnabled = false;
        state.geminiSystemParts = [{ text: 'P1' }];

        await executeRequest(adapter, {
            endpoint: 'https://api.example.com',
            apiKey: 'k',
            model: 'm'
        });

        expect(adapter.buildRequestBody.mock.calls[0][0].systemCtx.geminiSystemParts).toBeNull();
    });
});

// ========== Prefill 收集 ==========

describe('Prefill 收集', () => {
    it('prefillEnabled=true 时收集 opening + trailing', async () => {
        const adapter = createStubAdapter();
        state.prefillEnabled = true;

        await executeRequest(adapter, {
            endpoint: 'https://api.example.com',
            apiKey: 'k',
            model: 'm'
        });

        const ctx = adapter.buildRequestBody.mock.calls[0][0];
        expect(ctx.prefill).not.toBeNull();
        expect(ctx.prefill.opening).toEqual([{ role: 'user', content: '__opening__' }]);
        expect(ctx.prefill.trailing).toEqual([{ role: 'assistant', content: '__trailing__' }]);
    });

    it('prefillEnabled=false 时 prefill = null', async () => {
        const adapter = createStubAdapter();
        state.prefillEnabled = false;

        await executeRequest(adapter, {
            endpoint: 'https://api.example.com',
            apiKey: 'k',
            model: 'm'
        });

        expect(adapter.buildRequestBody.mock.calls[0][0].prefill).toBeNull();
    });
});

// ========== Tools 收集 ==========

describe('Tools 收集', () => {
    it('tools = adapter.collectBuiltinTools + adapter.formatSystemTools(getToolsForAPI)', async () => {
        const adapter = createStubAdapter();
        adapter.collectBuiltinTools.mockReturnValue([{ name: 'web_search' }]);
        adapter.formatSystemTools.mockImplementation((tools) =>
            tools.map((t) => ({ ...t, wrapped: true }))
        );

        await executeRequest(adapter, {
            endpoint: 'https://api.example.com',
            apiKey: 'k',
            model: 'm'
        });

        const ctx = adapter.buildRequestBody.mock.calls[0][0];
        // builtin 直接 push，system tools 经 formatSystemTools 包装
        expect(ctx.tools).toEqual([{ name: 'web_search' }, { name: 'system_tool', wrapped: true }]);
    });

    it('getToolsForAPI 抛错时 tools 只含 builtin（不阻塞请求）', async () => {
        const adapter = createStubAdapter();
        adapter.collectBuiltinTools.mockReturnValue([{ name: 'web_search' }]);

        const { getToolsForAPI } = await import('../../js/tools/manager.js');
        getToolsForAPI.mockImplementationOnce(() => {
            throw new Error('tool manager broken');
        });

        await executeRequest(adapter, {
            endpoint: 'https://api.example.com',
            apiKey: 'k',
            model: 'm'
        });

        const ctx = adapter.buildRequestBody.mock.calls[0][0];
        expect(ctx.tools).toEqual([{ name: 'web_search' }]);
    });
});

// ========== RequestBodyContext 内容 ==========

describe('RequestBodyContext 完整字段', () => {
    it('buildRequestBody 收到 model / modelParams / thinkingCfg / verbosityCfg / isXmlMode / state / endpoint', async () => {
        const adapter = createStubAdapter();
        state.xmlToolCallingEnabled = true;

        await executeRequest(adapter, {
            endpoint: 'https://api.example.com/v1',
            apiKey: 'k',
            model: 'gpt-4'
        });

        const ctx = adapter.buildRequestBody.mock.calls[0][0];
        expect(ctx.model).toBe('gpt-4');
        expect(ctx.modelParams).toEqual({ temperature: 0.7 });
        expect(ctx.thinkingCfg).toBeNull();
        expect(ctx.verbosityCfg).toBeNull();
        expect(ctx.isXmlMode).toBe(true);
        expect(ctx.state).toBe(state); // 引用同一个 state
        expect(ctx.endpoint).toBe('https://api.example.com/v1');
    });
});
