/**
 * request-pipeline.js 测试
 *
 * 验证 executeRequest 编排顺序、能力过滤时机、SystemContext / Prefill / Tools 装配。
 * 用 stub adapter 隔离 pipeline 逻辑与具体 adapter 实现。
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------- mocks ----------

vi.mock('../../js/core/state.js', () => ({
    state: {
        messages: [],
        systemPrompt: '',
        monitorEnabled: false,
        prefillEnabled: false,
        streamEnabled: true,
        xmlToolCallingEnabled: false
    }
}));

vi.mock('../../js/utils/logger.js', () => ({
    logger: { warn: vi.fn(), debug: vi.fn(), error: vi.fn(), info: vi.fn() }
}));

vi.mock('../../js/utils/variables.js', () => ({
    processVariables: vi.fn((s) => `processed:${s}`),
    templateNamesOf: (source) => ({ charName: source?.charName, userName: source?.userName })
}));

vi.mock('../../js/utils/message-filter.js', () => ({
    filterMessagesByCapabilities: vi.fn((msgs) => msgs.filter((m) => m.role !== '__drop__'))
}));

vi.mock('../../js/providers/manager.js', () => ({
    getCurrentModelCapabilities: vi.fn(() => null),
    getCurrentProvider: vi.fn(() => ({ id: 'provider-1', name: 'Provider', apiFormat: 'stub' })),
    getModelDisplayName: vi.fn((model) => model),
    getActiveApiKey: vi.fn(() => 'key')
}));

vi.mock('../../js/utils/prefill.js', () => ({
    getOpeningMessages: vi.fn(() => [{ role: 'user', content: '__opening__' }]),
    getPrefillMessages: vi.fn(() => [{ role: 'assistant', content: '__trailing__' }])
}));

vi.mock('../../js/api/params.js', () => ({
    captureGenerationSettings: vi.fn((apiFormat) => ({
        userParams: { temperature: 0.7, apiFormat },
        reasoning: { enabled: false },
        verbosity: null,
        streamEnabled: true
    })),
    getCustomHeadersObject: vi.fn(() => ({ 'X-Custom': 'value' }))
}));

vi.mock('../../js/tools/manager.js', () => ({
    getToolsForAPI: vi.fn(() => [{ name: 'system_tool' }])
}));

vi.mock('../../js/devtools/context-builder.js', () => ({
    buildDevToolsContext: vi.fn(() => '\n\n[MONITOR CONTEXT]\n')
}));

vi.mock('../../js/api/request-notices.js', () => ({ emitRequestNotices: vi.fn() }));

import { executeRequest, captureRequestProfile } from '../../js/api/request-pipeline.js';
import { state } from '../../js/core/state.js';
import { filterMessagesByCapabilities } from '../../js/utils/message-filter.js';
import { getCurrentModelCapabilities, getCurrentProvider } from '../../js/providers/manager.js';
import { captureGenerationSettings } from '../../js/api/params.js';
import { emitRequestNotices } from '../../js/api/request-notices.js';

// ---------- stub adapter 工厂 ----------

/**
 * 构造可观察的 stub adapter。每个方法都是 vi.fn 以便断言调用顺序与参数。
 */
function createStubAdapter(overrides = {}) {
    return {
        name: 'Stub',
        apiFormat: 'stub',

        parserClass: class {},
        streamParser: vi.fn(),

        partsToAPIMessages: vi.fn((msgs) => msgs.map((m) => ({ role: m.role, _stub: true }))),
        parseResponse: vi.fn(() => null),

        collectBuiltinTools: vi.fn(() => [{ name: 'builtin_tool' }]),
        formatSystemTools: vi.fn((tools) => tools),
        buildGenerationParams: vi.fn((settings) => ({
            modelParams: { temperature: settings.userParams.temperature },
            thinkingCfg: null,
            verbosityCfg: null
        })),
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
    it('关闭聊天特性时跳过 system、prefill 和 tools', async () => {
        state.systemPrompt = 'system';
        state.monitorEnabled = true;
        state.prefillEnabled = true;
        const adapter = createStubAdapter({
            requestFeatures: {
                system: false,
                prefill: false,
                tools: false
            }
        });

        await executeRequest(adapter, {
            endpoint: 'https://example.com/v1/images/generations',
            apiKey: 'key',
            model: 'custom-image-model'
        });

        expect(adapter.collectBuiltinTools).not.toHaveBeenCalled();
        expect(adapter.formatSystemTools).not.toHaveBeenCalled();
        expect(adapter.buildGenerationParams).toHaveBeenCalledTimes(1);
        expect(adapter.buildRequestBody).toHaveBeenCalledWith(
            expect.objectContaining({ systemCtx: {}, prefill: null, tools: [] })
        );
        expect(adapter.resolveEndpoint).toHaveBeenCalledWith(
            'https://example.com/v1/images/generations',
            'custom-image-model',
            true,
            expect.any(Object),
            expect.objectContaining({
                state: expect.objectContaining({ streamEnabled: true }),
                requestProfile: expect.any(Object)
            })
        );
    });
});

// ========== 能力过滤时机 ==========

describe('能力过滤时机', () => {
    it.each(['claude', 'gemini', 'openai', 'openai-responses'])(
        '%s：在 partsToAPIMessages 之前按新格式消息过滤',
        async (apiFormat) => {
            const adapter = createStubAdapter({ apiFormat });
            getCurrentModelCapabilities.mockReturnValue({ imageInput: false });
            state.messages = [
                { role: 'user', content: 'keep' },
                { role: '__drop__', content: 'drop me' }
            ];

            await executeRequest(adapter, {
                endpoint: 'https://api.example.com',
                apiKey: 'k',
                model: 'm'
            });

            const filteredInput = filterMessagesByCapabilities.mock.calls[0][0];
            expect(filteredInput.every((m) => m._stub === undefined)).toBe(true);
            const calledWith = adapter.partsToAPIMessages.mock.calls[0][0];
            expect(calledWith).toHaveLength(1);
            expect(calledWith[0].role).toBe('user');
            expect(filterMessagesByCapabilities).toHaveBeenCalledTimes(1);
        }
    );

    it('capabilities=null 时跳过过滤', async () => {
        const adapter = createStubAdapter();
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
            injectReasoning: true,
            isXmlMode: false,
            profile: expect.objectContaining({ family: 'openai' }),
            declaredTools: expect.any(Array)
        });

        const otherAdapter = createStubAdapter({ apiFormat: 'openai' });
        await executeRequest(otherAdapter, {
            endpoint: 'https://api.example.com',
            apiKey: 'k',
            model: 'm'
        });
        expect(otherAdapter.partsToAPIMessages.mock.calls[0][1]).toEqual({
            injectReasoning: false,
            isXmlMode: false,
            profile: expect.objectContaining({ family: 'openai' }),
            declaredTools: expect.any(Array)
        });
    });

    it('declaredTools 为本次实际下发的原生工具，XML 模式下为空', async () => {
        const nativeTool = { name: 'search', input_schema: { type: 'object' } };
        const adapter = createStubAdapter({ collectBuiltinTools: vi.fn(() => [nativeTool]) });
        await executeRequest(adapter, {
            endpoint: 'https://api.example.com',
            apiKey: 'k',
            model: 'm'
        });
        const declared = adapter.partsToAPIMessages.mock.calls[0][1].declaredTools;
        expect(declared[0]).toEqual(nativeTool);
        expect(declared).toEqual(adapter.buildRequestBody.mock.calls[0][0].tools);

        state.xmlToolCallingEnabled = true;
        const xmlAdapter = createStubAdapter({ collectBuiltinTools: vi.fn(() => [nativeTool]) });
        await executeRequest(xmlAdapter, {
            endpoint: 'https://api.example.com',
            apiKey: 'k',
            model: 'm'
        });
        expect(xmlAdapter.partsToAPIMessages.mock.calls[0][1].declaredTools).toEqual([]);
    });

    it('过滤掉标准 error 消息', async () => {
        const adapter = createStubAdapter();
        state.messages = [
            { role: 'user', parts: [{ type: 'text', text: 'ok' }], error: null },
            {
                role: 'assistant',
                parts: [{ type: 'text', text: 'err' }],
                error: { type: 'api' }
            },
            {
                role: 'assistant',
                parts: [{ type: 'text', text: 'err2' }],
                error: { type: 'api' }
            }
        ];

        await executeRequest(adapter, {
            endpoint: 'https://api.example.com',
            apiKey: 'k',
            model: 'm'
        });

        const calledWith = adapter.partsToAPIMessages.mock.calls[0][0];
        expect(calledWith).toHaveLength(1);
        expect(calledWith[0].parts[0].text).toBe('ok');
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
        expect(ctx.systemCtx).toEqual({
            systemPrompt: 'processed:Be helpful',
            monitorContext: null
        });
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
});

// ========== 格式专属设置 ==========

describe('格式专属设置', () => {
    it('adapter.captureFormatSettings 读取 state，结果经 requestProfile 透传到请求构造', async () => {
        const adapter = createStubAdapter({
            captureFormatSettings: vi.fn((stateRef) => ({ marker: stateRef.systemPrompt }))
        });
        state.systemPrompt = 'from-state';

        await executeRequest(adapter, {
            endpoint: 'https://api.example.com',
            apiKey: 'k',
            model: 'm'
        });

        expect(adapter.captureFormatSettings).toHaveBeenCalledWith(state);
        const expected = { marker: 'from-state' };
        expect(adapter.buildRequestBody.mock.calls[0][0].formatSettings).toEqual(expected);
        expect(adapter.buildHeaders.mock.calls[0][1].requestProfile.formatSettings).toEqual(
            expected
        );
        expect(adapter.buildQueryString.mock.calls[0][1].requestProfile.formatSettings).toEqual(
            expected
        );
    });

    it('adapter 未实现 captureFormatSettings 时 formatSettings 为 null', async () => {
        const adapter = createStubAdapter();

        await executeRequest(adapter, {
            endpoint: 'https://api.example.com',
            apiKey: 'k',
            model: 'm'
        });

        expect(adapter.buildRequestBody.mock.calls[0][0].formatSettings).toBeNull();
    });

    it('formatSettings 在捕获时固化，之后修改 state 不影响复用同一 requestProfile 的请求', async () => {
        const adapter = createStubAdapter({
            captureFormatSettings: (stateRef) => ({ prompt: stateRef.systemPrompt })
        });
        state.systemPrompt = 'before';
        const requestProfile = captureRequestProfile(adapter, 'm');
        state.systemPrompt = 'after';

        await executeRequest(adapter, {
            endpoint: 'https://api.example.com',
            apiKey: 'k',
            model: 'm',
            requestProfile
        });

        expect(adapter.buildRequestBody.mock.calls[0][0].formatSettings).toEqual({
            prompt: 'before'
        });
    });
});

// ========== 生成参数 ==========

describe('生成参数', () => {
    it('按 adapter.apiFormat 采集设置并交给 adapter.buildGenerationParams', async () => {
        const adapter = createStubAdapter({ apiFormat: 'claude' });

        await executeRequest(adapter, {
            endpoint: 'https://api.example.com',
            apiKey: 'k',
            model: 'claude-opus-5-5'
        });

        expect(captureGenerationSettings).toHaveBeenCalledWith('claude');
        const [settings, ctx] = adapter.buildGenerationParams.mock.calls[0];
        expect(settings.userParams.apiFormat).toBe('claude');
        expect(ctx.model).toBe('claude-opus-5-5');
        expect(ctx.profile).toMatchObject({
            id: 'claude-opus-5-5',
            known: true,
            family: 'claude'
        });
    });

    it('adapter 输出的 modelParams / thinkingCfg / verbosityCfg 原样进入请求构造', async () => {
        const adapter = createStubAdapter({
            buildGenerationParams: vi.fn(() => ({
                modelParams: { max_tokens: 100 },
                thinkingCfg: { reasoning_effort: 'low' },
                verbosityCfg: { text: { verbosity: 'low' } }
            }))
        });

        await executeRequest(adapter, {
            endpoint: 'https://api.example.com',
            apiKey: 'k',
            model: 'm'
        });

        const ctx = adapter.buildRequestBody.mock.calls[0][0];
        expect(ctx.modelParams).toEqual({ max_tokens: 100 });
        expect(ctx.thinkingCfg).toEqual({ reasoning_effort: 'low' });
        expect(ctx.verbosityCfg).toEqual({ text: { verbosity: 'low' } });
    });

    it('requestProfile 复用时不再重新计算生成参数', async () => {
        const adapter = createStubAdapter();
        const requestProfile = captureRequestProfile(adapter, 'm');
        adapter.buildGenerationParams.mockClear();

        await executeRequest(adapter, {
            endpoint: 'https://api.example.com',
            apiKey: 'k',
            model: 'm',
            requestProfile
        });

        expect(adapter.buildGenerationParams).not.toHaveBeenCalled();
        expect(adapter.buildRequestBody.mock.calls[0][0].modelParams).toEqual({
            temperature: 0.7
        });
    });

    it('未识别格式的模型能力为宽松默认值', () => {
        const adapter = createStubAdapter();
        const requestProfile = captureRequestProfile(adapter, 'm');

        expect(requestProfile.profile).toEqual({ id: null, known: false, family: null });
    });

    it('模型配置里的官方型号别名优先于模型 ID', () => {
        getCurrentProvider.mockReturnValueOnce({
            id: 'provider-1',
            name: 'Provider',
            apiFormat: 'claude',
            models: [{ id: 'my-proxy-model', profileAlias: ' claude-sonnet-5-5 ' }]
        });
        const adapter = createStubAdapter({ apiFormat: 'claude' });

        const requestProfile = captureRequestProfile(adapter, 'my-proxy-model');

        expect(requestProfile.profile).toMatchObject({ id: 'claude-sonnet-5-5', known: true });
    });

    it('能力表先于工具收集解析，工具版本可按型号选择', () => {
        const adapter = createStubAdapter({ apiFormat: 'claude' });

        captureRequestProfile(adapter, 'claude-opus-5-5');

        expect(adapter.collectBuiltinTools).toHaveBeenCalledWith(
            expect.any(Object),
            expect.objectContaining({
                profile: expect.objectContaining({ id: 'claude-opus-5-5' })
            })
        );
    });

    it('nativeTools 只在有工具且不是 XML 模式时为 true', () => {
        const adapter = createStubAdapter();
        captureRequestProfile(adapter, 'm');
        expect(adapter.buildGenerationParams.mock.calls[0][1].nativeTools).toBe(true);

        state.xmlToolCallingEnabled = true;
        captureRequestProfile(adapter, 'm');
        expect(adapter.buildGenerationParams.mock.calls[1][1].nativeTools).toBe(false);

        const noToolsAdapter = createStubAdapter({ requestFeatures: { tools: false } });
        state.xmlToolCallingEnabled = false;
        captureRequestProfile(noToolsAdapter, 'm');
        expect(noToolsAdapter.buildGenerationParams.mock.calls[0][1].nativeTools).toBe(false);
    });
});

describe('型号超时下限', () => {
    it('型号要求的最短超时高于用户设置时，请求与流式空闲超时都取型号下限', () => {
        state.requestTimeout = 300000;
        state.streamIdleTimeout = 120000;
        const adapter = createStubAdapter({ apiFormat: 'gemini' });

        const requestProfile = captureRequestProfile(adapter, 'gemini-4-argon');

        expect(requestProfile.state.requestTimeout).toBe(20 * 60 * 1000);
        expect(requestProfile.state.streamIdleTimeout).toBe(20 * 60 * 1000);
    });

    it('用户设置更长或型号没有要求时保持用户设置', () => {
        state.requestTimeout = 30 * 60 * 1000;
        state.streamIdleTimeout = 120000;
        const adapter = createStubAdapter({ apiFormat: 'gemini' });

        expect(captureRequestProfile(adapter, 'gemini-4-argon').state.requestTimeout).toBe(
            30 * 60 * 1000
        );
        const flash = captureRequestProfile(adapter, 'gemini-3.8-flash');
        expect(flash.state.requestTimeout).toBe(30 * 60 * 1000);
        expect(flash.state.streamIdleTimeout).toBe(120000);
    });
});

describe('请求预检提示', () => {
    it('工具收集阶段的提示排在生成参数提示之前', async () => {
        const adapter = createStubAdapter({
            collectBuiltinTools: vi.fn((stateRef, { notices }) => {
                notices.push({ key: 'tools', message: '工具已调整' });
                return [];
            }),
            buildGenerationParams: vi.fn(() => ({
                modelParams: {},
                thinkingCfg: null,
                verbosityCfg: null,
                notices: [{ key: 'params', message: '参数已调整' }]
            }))
        });

        await executeRequest(adapter, {
            endpoint: 'https://api.example.com',
            apiKey: 'k',
            model: 'm',
            sessionId: 'session-9',
            sourceMessages: state.messages
        });

        expect(emitRequestNotices).toHaveBeenCalledWith(
            'session-9',
            [
                { key: 'tools', message: '工具已调整' },
                { key: 'params', message: '参数已调整' }
            ],
            { modelName: 'm' }
        );
    });

    it('生成参数与请求体组装的提示合并后按会话弹出', async () => {
        const adapter = createStubAdapter({
            buildGenerationParams: vi.fn(() => ({
                modelParams: {},
                thinkingCfg: null,
                verbosityCfg: null,
                notices: [{ key: 'params', message: '参数已调整' }]
            })),
            buildRequestBody: vi.fn((ctx) => {
                ctx.notices.push({ key: 'body', message: '请求体已调整' });
                return { model: ctx.model };
            })
        });

        await executeRequest(adapter, {
            endpoint: 'https://api.example.com',
            apiKey: 'k',
            model: 'm',
            sessionId: 'session-9',
            sourceMessages: state.messages
        });

        expect(emitRequestNotices).toHaveBeenCalledWith(
            'session-9',
            [
                { key: 'params', message: '参数已调整' },
                { key: 'body', message: '请求体已调整' }
            ],
            { modelName: 'm' }
        );
    });

    it('复用 requestProfile 时不会累积上一次请求体的提示', async () => {
        const adapter = createStubAdapter({
            buildRequestBody: vi.fn((ctx) => {
                ctx.notices.push({ key: 'body', message: '请求体已调整' });
                return { model: ctx.model };
            })
        });
        const requestProfile = captureRequestProfile(adapter, 'm');
        const request = {
            endpoint: 'https://api.example.com',
            apiKey: 'k',
            model: 'm',
            requestProfile
        };

        await executeRequest(adapter, request);
        await executeRequest(adapter, request);

        expect(emitRequestNotices.mock.calls[1][1]).toEqual([
            { key: 'body', message: '请求体已调整' }
        ]);
        expect(requestProfile.notices).toEqual([]);
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

    it('内置工具已占用的名字交给 getToolsForAPI 保留，没有 name 的内置工具不计入', async () => {
        const adapter = createStubAdapter();
        adapter.collectBuiltinTools.mockReturnValue([
            { name: 'web_search' },
            { type: 'computer_toolset_20260801' },
            { name: 'bash' }
        ]);
        const { getToolsForAPI } = await import('../../js/tools/manager.js');

        await executeRequest(adapter, {
            endpoint: 'https://api.example.com',
            apiKey: 'k',
            model: 'm'
        });

        expect(getToolsForAPI).toHaveBeenCalledWith(adapter.apiFormat, {
            reservedNames: ['web_search', 'bash']
        });
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
    it('buildRequestBody 收到 model / 生成参数 / isXmlMode / profile / formatSettings / state / endpoint', async () => {
        const adapter = createStubAdapter({ apiFormat: 'openai' });
        state.xmlToolCallingEnabled = true;

        await executeRequest(adapter, {
            endpoint: 'https://api.example.com/v1',
            apiKey: 'k',
            model: 'gpt-4o'
        });

        const ctx = adapter.buildRequestBody.mock.calls[0][0];
        expect(ctx.model).toBe('gpt-4o');
        expect(ctx.modelParams).toEqual({ temperature: 0.7 });
        expect(ctx.thinkingCfg).toBeNull();
        expect(ctx.verbosityCfg).toBeNull();
        expect(ctx.isXmlMode).toBe(true);
        expect(ctx.profile).toMatchObject({ id: 'gpt-4o', known: true, family: 'openai' });
        expect(ctx.formatSettings).toBeNull();
        expect(ctx.state).toEqual(
            expect.objectContaining({ streamEnabled: true, xmlToolCallingEnabled: true })
        );
        expect(ctx.state).not.toBe(state);
        expect(ctx.endpoint).toBe('https://api.example.com/v1');
    });

    it('buildRequestBody 收到模型编辑里设置的能力', async () => {
        getCurrentModelCapabilities.mockReturnValue({ imageInput: true, imageOutput: false });
        const adapter = createStubAdapter();

        await executeRequest(adapter, {
            endpoint: 'https://api.example.com',
            apiKey: 'k',
            model: 'm'
        });

        expect(adapter.buildRequestBody.mock.calls[0][0].capabilities).toEqual({
            imageInput: true,
            imageOutput: false
        });
    });
});

// ========== computer 工具的显示器尺寸 ==========

describe('computer 工具的显示器尺寸', () => {
    const GEOMETRY = {
        scaleFactor: 0.7447,
        width: 1429,
        height: 804,
        originalWidth: 1920,
        originalHeight: 1080
    };

    function adapterWithTool(type) {
        return createStubAdapter({
            apiFormat: 'claude',
            collectBuiltinTools: vi.fn(() => [{ type, name: 'computer' }])
        });
    }

    function requestOf(adapter, model) {
        return {
            endpoint: 'https://api.example.com',
            apiKey: 'k',
            model,
            requestProfile: captureRequestProfile(adapter, model)
        };
    }

    afterEach(() => {
        delete window.electronAPI;
    });

    it('旧版 computer 工具按截图尺寸声明，同一任务的续作只取一次', async () => {
        const getScreenGeometry = vi.fn(async () => ({ success: true, ...GEOMETRY }));
        window.electronAPI = { computerUse_getScreenGeometry: getScreenGeometry };
        const adapter = adapterWithTool('computer_20250124');
        const request = requestOf(adapter, 'claude-sonnet-4-5');

        await executeRequest(adapter, request);
        await executeRequest(adapter, request);

        expect(getScreenGeometry).toHaveBeenCalledTimes(1);
        const [first, second] = adapter.buildRequestBody.mock.calls.map(([ctx]) => ctx);
        expect(first.computerDisplay).toEqual(GEOMETRY);
        expect(second.computerDisplay).toBe(first.computerDisplay);
    });

    it('工具集不声明尺寸，不读取截图尺寸', async () => {
        const getScreenGeometry = vi.fn(async () => ({ success: true, ...GEOMETRY }));
        window.electronAPI = { computerUse_getScreenGeometry: getScreenGeometry };
        const adapter = adapterWithTool('computer_toolset_20260801');

        await executeRequest(adapter, requestOf(adapter, 'claude-opus-5-5'));

        expect(getScreenGeometry).not.toHaveBeenCalled();
        expect(adapter.buildRequestBody.mock.calls[0][0].computerDisplay).toBeNull();
    });

    it('请求里没有 computer 工具时不读取截图尺寸', async () => {
        const getScreenGeometry = vi.fn(async () => ({ success: true, ...GEOMETRY }));
        window.electronAPI = { computerUse_getScreenGeometry: getScreenGeometry };
        const adapter = createStubAdapter({ apiFormat: 'claude' });

        await executeRequest(adapter, requestOf(adapter, 'claude-sonnet-4-5'));

        expect(getScreenGeometry).not.toHaveBeenCalled();
        expect(adapter.buildRequestBody.mock.calls[0][0].computerDisplay).toBeNull();
    });

    it('取不到截图尺寸时本次传 null，下次请求重新获取，取到后同一任务沿用', async () => {
        const { logger } = await import('../../js/utils/logger.js');
        const getScreenGeometry = vi
            .fn()
            .mockResolvedValueOnce({ success: false, error: 'No display' })
            .mockResolvedValue({ success: true, ...GEOMETRY });
        window.electronAPI = { computerUse_getScreenGeometry: getScreenGeometry };
        const adapter = adapterWithTool('computer_20251124');
        const request = requestOf(adapter, 'claude-opus-4-6');

        await executeRequest(adapter, request);
        await executeRequest(adapter, request);
        await executeRequest(adapter, request);

        expect(getScreenGeometry).toHaveBeenCalledTimes(2);
        const displays = adapter.buildRequestBody.mock.calls.map(([ctx]) => ctx.computerDisplay);
        expect(displays[0]).toBeNull();
        expect(displays[1]).toEqual(GEOMETRY);
        expect(displays[2]).toBe(displays[1]);
        expect(logger.warn).toHaveBeenCalledWith(
            expect.stringContaining('获取截图尺寸失败'),
            expect.any(Error)
        );
        expect(fetchSpy).toHaveBeenCalledTimes(3);
    });
});
