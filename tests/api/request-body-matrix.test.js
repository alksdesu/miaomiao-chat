/**
 * 请求体矩阵快照：真实 adapter × 格式 × 代表模型 × 设置组合 → 最终发出的 URL / headers / body
 * 重构必须保持快照一致；行为修复只允许出现预期内的快照差异
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => {
    const createModelParams = () => ({
        openai: {
            temperature: null,
            max_tokens: null,
            top_p: null,
            frequency_penalty: null,
            presence_penalty: null
        },
        'openai-image': {
            size: null,
            customSize: '',
            quality: null,
            output_format: null,
            output_compression: null,
            background: null,
            moderation: null,
            input_fidelity: null,
            n: 1,
            partial_images: 0
        },
        gemini: { temperature: null, maxOutputTokens: null, topP: null, topK: null },
        claude: { temperature: null, max_tokens: null, top_p: null, top_k: null }
    });

    const createDefaultState = () => ({
        messages: [],
        messageStore: null,
        currentSessionId: 'session-1',
        selectedModel: '',
        apiFormat: 'openai',
        systemPrompt: '',
        monitorEnabled: false,
        prefillEnabled: false,
        systemPrefillMessages: [],
        prefillMessages: [],
        streamEnabled: true,
        replyCount: 1,
        xmlToolCallingEnabled: false,
        codeExecutionEnabled: false,
        webSearchEnabled: false,
        computerUseEnabled: false,
        computerUsePermissions: {
            mouse: true,
            keyboard: true,
            screenshot: true,
            bash: true,
            textEditor: true
        },
        geminiApiKeyInHeader: false,
        geminiSystemPartsEnabled: false,
        geminiSystemParts: [],
        fastImageCompression: false,
        streamIdleTimeout: 120000,
        requestTimeout: 300000,
        customHeaders: [],
        modelParams: createModelParams(),
        thinkingEnabled: false,
        thinkingStrength: 'high',
        thinkingBudget: 32768,
        thinkingNoneMode: false,
        claudeAdaptiveThinking: false,
        claudeEffortLevel: 'high',
        claudeShowThinking: true,
        verbosityEnabled: false,
        outputVerbosity: 'medium',
        imageSize: '2K'
    });

    return {
        state: createDefaultState(),
        elements: { imageSizeSelect: null },
        provider: { id: 'provider-1', name: 'Provider', apiFormat: 'openai' },
        capabilities: null,
        electron: false,
        systemToolsEnabled: false,
        createDefaultState
    };
});

vi.mock('../../js/core/state.js', () => ({ state: h.state, elements: h.elements }));

vi.mock('../../js/utils/logger.js', () => ({
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

vi.mock('../../js/utils/variables.js', () => ({ processVariables: (text) => text }));

vi.mock('../../js/providers/manager.js', () => ({
    getCurrentProvider: () => h.provider,
    getCurrentModelCapabilities: () => h.capabilities,
    getModelDisplayName: (model) => model,
    getActiveApiKey: () => 'test-key'
}));

vi.mock('../../js/devtools/context-builder.js', () => ({
    buildDevToolsContext: () => '\n\n[MONITOR CONTEXT]'
}));

vi.mock('../../js/tools/manager.js', () => ({
    getToolsForAPI: (apiFormat) => {
        if (!h.systemToolsEnabled) return [];
        const parameters = {
            type: 'object',
            properties: { city: { type: 'string' } },
            required: ['city']
        };
        const description = 'Get the weather for a city';
        switch (apiFormat) {
            case 'openai':
                return [
                    { type: 'function', function: { name: 'get_weather', description, parameters } }
                ];
            case 'openai-responses':
                return [{ type: 'function', name: 'get_weather', description, parameters }];
            case 'gemini':
                return [{ name: 'get_weather', description, parameters }];
            case 'claude':
                return [{ name: 'get_weather', description, input_schema: parameters }];
            default:
                return [];
        }
    }
}));

vi.mock('../../js/state/session-message-repository.js', () => ({
    materializeSessionMessages: async (_sessionId, messages) => messages
}));

vi.mock('../../js/state/media-blob-store.js', () => ({
    resolveMessagesMediaForApi: async (messages) => messages
}));

vi.mock('../../js/providers/provider-sync.js', () => ({
    waitForProviderHistoryCleanup: () => Promise.resolve()
}));

vi.mock('../../js/state/storage.js', () => ({
    loadSessionMessages: async () => ({ messages: [] })
}));

vi.mock('../../js/utils/images.js', () => ({
    compressImage: async (data, mimeType) => ({ data, mimeType })
}));

vi.mock('../../js/utils/platform.js', async (importOriginal) => {
    const actual = await importOriginal();
    return { ...actual, isElectron: () => h.electron };
});

import { executeRequest, captureRequestProfile } from '../../js/api/request-pipeline.js';
import { getAdapter } from '../../js/api/adapters/index.js';
import {
    textPart,
    thinkingPart,
    mediaPart,
    toolCallPart,
    createMeta,
    MediaKind,
    ToolState
} from '../../js/messages/schema.js';

// ---------- 固定输入 ----------

const IMG_A = 'data:image/png;base64,QUFBQQ==';
const IMG_B = 'data:image/png;base64,QkJCQg==';

const ENDPOINTS = {
    openai: 'https://api.openai.com/v1/chat/completions',
    'openai-responses': 'https://api.openai.com/v1/chat/completions',
    claude: 'https://api.anthropic.com/v1/messages',
    gemini: 'https://generativelanguage.googleapis.com',
    'openai-image': 'https://api.openai.com/v1/images/generations'
};

let messageSeq = 0;

function msg(role, parts, meta = createMeta()) {
    messageSeq += 1;
    return {
        id: `msg-${messageSeq}`,
        role,
        ts: 1700000000000 + messageSeq,
        parts,
        meta,
        replies: null,
        error: null,
        _schemaVersion: 1
    };
}

function signatureFormatOf(format) {
    if (format === 'claude' || format === 'gemini') return format;
    return 'openai';
}

function weatherCall(id, city, result, extra = {}) {
    return toolCallPart(
        id,
        'get_weather',
        { city },
        {
            state: ToolState.DONE,
            result: { content: result },
            idMap: { openai: `call_${id}`, claude: `toolu_${id}`, gemini: id },
            call_id: `call_${id}`,
            responseItemId: `fc_item_${id}`,
            ...extra
        }
    );
}

const HISTORIES = {
    basic: () => [
        msg('user', [textPart('Hello')]),
        msg('assistant', [textPart('Hi! How can I help?')]),
        msg('user', [textPart('Tell me a joke')])
    ],

    rich: (format) => {
        const sigFormat = signatureFormatOf(format);
        const reasoningMeta = (id, turn = 0) =>
            createMeta({
                raw: {
                    openai: {
                        reasoningItems: [
                            { id, summary: [], encrypted_content: `enc_${id}`, _turn: turn }
                        ]
                    }
                }
            });
        return [
            msg('user', [
                textPart('Describe this image'),
                mediaPart(MediaKind.IMAGE, IMG_A, 'image/png')
            ]),
            msg(
                'assistant',
                [
                    thinkingPart('Looking at the image', `sig-a-${sigFormat}`, {
                        signatureFormat: sigFormat
                    }),
                    textPart('It is a cat.')
                ],
                reasoningMeta('rs_1')
            ),
            msg('user', [textPart('What is the weather in Paris?')]),
            msg(
                'assistant',
                [
                    thinkingPart('Need the weather tool', `sig-b-${sigFormat}`, {
                        signatureFormat: sigFormat
                    }),
                    weatherCall(
                        'w1',
                        'Paris',
                        'Sunny, 22C',
                        format === 'gemini' ? { thoughtSignature: 'sig-fc-w1' } : {}
                    ),
                    textPart('It is sunny in Paris.', { _turn: 1 })
                ],
                reasoningMeta('rs_2')
            ),
            msg('user', [textPart('And tomorrow?')])
        ];
    },

    'gemini-signatures': () => [
        msg('user', [textPart('Compare Paris and Rome')]),
        msg('assistant', [
            thinkingPart('Plan both lookups', 'sig-plan', { signatureFormat: 'gemini' }),
            weatherCall('wa', 'Paris', 'Sunny', { thoughtSignature: 'sig-call-a' }),
            weatherCall('wb', 'Rome', 'Rain')
        ]),
        msg('assistant', [
            thinkingPart('Summarize', 'sig-summary', { signatureFormat: 'gemini' }),
            textPart('Paris is sunny. '),
            textPart('Rome is rainy.')
        ]),
        msg('user', [textPart('Thanks')])
    ],

    'image-history': () => [
        msg('user', [textPart('Draw a cat')]),
        msg('assistant', [textPart('Here it is'), mediaPart(MediaKind.IMAGE, IMG_A, 'image/png')]),
        msg('user', [textPart('Make it blue'), mediaPart(MediaKind.IMAGE, IMG_B, 'image/png')])
    ],

    'image-prompt': () => [
        msg('user', [textPart('A watercolor fox')]),
        msg('assistant', [mediaPart(MediaKind.IMAGE, IMG_A, 'image/png')]),
        msg('user', [textPart('Same fox at night'), mediaPart(MediaKind.IMAGE, IMG_B, 'image/png')])
    ]
};

const PREFILL = {
    systemPrefillMessages: [
        { role: 'user', content: 'Opening user line' },
        { role: 'assistant', content: 'Opening assistant line' }
    ],
    prefillMessages: [{ role: 'assistant', content: 'Sure, here is' }]
};

// ---------- 用例 ----------

/**
 * @typedef {Object} MatrixCase
 * @property {string} name
 * @property {string} format
 * @property {string} model
 * @property {string} [endpoint]
 * @property {Object} [settings]   顶层 state 覆盖
 * @property {Object} [params]     state.modelParams[paramsKey] 覆盖
 * @property {string} [paramsKey]
 * @property {string} [history]
 * @property {Object|null} [capabilities]
 * @property {boolean} [electron]
 * @property {boolean} [systemTools]
 * @property {string|null} [imageSize]  elements.imageSizeSelect.value；null 表示控件不存在
 */

/** @type {MatrixCase[]} */
const CASES = [
    // ===== OpenAI Chat =====
    { name: 'chat defaults', format: 'openai', model: 'gpt-5.5' },
    {
        name: 'chat non-stream',
        format: 'openai',
        model: 'gpt-5.5',
        settings: { streamEnabled: false }
    },
    {
        name: 'chat sampling params gpt-5.5',
        format: 'openai',
        model: 'gpt-5.5',
        params: {
            temperature: 0.7,
            top_p: 0.9,
            max_tokens: 1000,
            frequency_penalty: 0.5,
            presence_penalty: 0.3
        }
    },
    {
        name: 'chat sampling params unknown model',
        format: 'openai',
        model: 'deepseek-chat',
        params: {
            temperature: 0.7,
            top_p: 0.9,
            max_tokens: 1000,
            frequency_penalty: 0.5,
            presence_penalty: 0.3
        }
    },
    {
        name: 'chat sampling params gpt-4o',
        format: 'openai',
        model: 'gpt-4o',
        params: { temperature: 0.7, max_tokens: 1000 }
    },
    {
        name: 'chat sampling params gpt-6-sol effort none',
        format: 'openai',
        model: 'gpt-6-sol',
        settings: { thinkingNoneMode: true },
        params: { temperature: 0.2, max_tokens: 2000 }
    },
    {
        name: 'chat thinking high',
        format: 'openai',
        model: 'gpt-5.5',
        settings: { thinkingEnabled: true, thinkingStrength: 'high' }
    },
    {
        name: 'chat thinking minimal gpt-5',
        format: 'openai',
        model: 'gpt-5',
        settings: { thinkingEnabled: true, thinkingStrength: 'minimal' }
    },
    {
        name: 'chat thinking minimal gpt-6.1-sol',
        format: 'openai',
        model: 'gpt-6.1-sol',
        settings: { thinkingEnabled: true, thinkingStrength: 'minimal' }
    },
    {
        name: 'chat thinking xhigh gpt-6-astra',
        format: 'openai',
        model: 'gpt-6-astra',
        settings: { thinkingEnabled: true, thinkingStrength: 'xhigh' }
    },
    {
        name: 'chat thinking custom budget',
        format: 'openai',
        model: 'gpt-5.5',
        settings: { thinkingEnabled: true, thinkingStrength: 'custom', thinkingBudget: 12000 }
    },
    {
        name: 'chat thinking off with none mode',
        format: 'openai',
        model: 'gpt-5.5',
        settings: { thinkingNoneMode: true }
    },
    {
        name: 'chat thinking off with none mode gpt-6-astra',
        format: 'openai',
        model: 'gpt-6-astra',
        settings: { thinkingNoneMode: true }
    },
    {
        name: 'chat verbosity low',
        format: 'openai',
        model: 'gpt-5.5',
        settings: { verbosityEnabled: true, outputVerbosity: 'low' }
    },
    {
        name: 'chat verbosity low gpt-4o',
        format: 'openai',
        model: 'gpt-4o',
        settings: { verbosityEnabled: true, outputVerbosity: 'low' }
    },
    {
        name: 'chat system monitor prefill',
        format: 'openai',
        model: 'gpt-5.5',
        settings: {
            systemPrompt: 'You are helpful.',
            monitorEnabled: true,
            prefillEnabled: true,
            ...PREFILL
        }
    },
    {
        name: 'chat native tools with builtins gpt-6-astra',
        format: 'openai',
        model: 'gpt-6-astra',
        systemTools: true,
        settings: { webSearchEnabled: true, codeExecutionEnabled: true }
    },
    {
        name: 'chat native tools gpt-6-sol',
        format: 'openai',
        model: 'gpt-6-sol',
        systemTools: true
    },
    {
        name: 'chat native tools gpt-5.5',
        format: 'openai',
        model: 'gpt-5.5',
        systemTools: true
    },
    {
        name: 'chat xml tools',
        format: 'openai',
        model: 'gpt-5.5',
        systemTools: true,
        settings: { xmlToolCallingEnabled: true }
    },
    { name: 'chat rich history', format: 'openai', model: 'gpt-5.5', history: 'rich' },
    {
        name: 'chat image history with capabilities',
        format: 'openai',
        model: 'gpt-5.5',
        history: 'image-history',
        capabilities: { imageInput: true, imageOutput: false }
    },

    // ===== OpenAI Responses =====
    { name: 'responses defaults', format: 'openai-responses', model: 'gpt-5.5' },
    {
        name: 'responses non-stream',
        format: 'openai-responses',
        model: 'gpt-5.5',
        settings: { streamEnabled: false }
    },
    {
        name: 'responses sampling params gpt-5.5',
        format: 'openai-responses',
        model: 'gpt-5.5',
        paramsKey: 'openai',
        params: {
            temperature: 0.7,
            top_p: 0.9,
            max_tokens: 1000,
            frequency_penalty: 0.5,
            presence_penalty: 0.3
        }
    },
    {
        name: 'responses sampling params unknown model',
        format: 'openai-responses',
        model: 'my-proxy-model',
        paramsKey: 'openai',
        params: {
            temperature: 0.7,
            top_p: 0.9,
            max_tokens: 1000,
            frequency_penalty: 0.5,
            presence_penalty: 0.3
        }
    },
    {
        name: 'responses thinking high',
        format: 'openai-responses',
        model: 'gpt-5.5',
        settings: { thinkingEnabled: true, thinkingStrength: 'high' }
    },
    {
        name: 'responses thinking off with none mode gpt-6-astra',
        format: 'openai-responses',
        model: 'gpt-6-astra',
        settings: { thinkingNoneMode: true }
    },
    {
        name: 'responses thinking xhigh gpt-6.1-sol',
        format: 'openai-responses',
        model: 'gpt-6.1-sol',
        settings: { thinkingEnabled: true, thinkingStrength: 'xhigh' }
    },
    {
        name: 'responses verbosity low',
        format: 'openai-responses',
        model: 'gpt-5.5',
        settings: { verbosityEnabled: true, outputVerbosity: 'low' }
    },
    {
        name: 'responses system monitor prefill',
        format: 'openai-responses',
        model: 'gpt-5.5',
        settings: {
            systemPrompt: 'You are helpful.',
            monitorEnabled: true,
            prefillEnabled: true,
            ...PREFILL
        }
    },
    {
        name: 'responses rich history',
        format: 'openai-responses',
        model: 'gpt-5.5',
        history: 'rich'
    },
    {
        name: 'responses native tools with builtins gpt-6.1-sol',
        format: 'openai-responses',
        model: 'gpt-6.1-sol',
        systemTools: true,
        settings: { webSearchEnabled: true, codeExecutionEnabled: true }
    },
    {
        name: 'responses image history with capabilities',
        format: 'openai-responses',
        model: 'gpt-5.5',
        history: 'image-history',
        capabilities: { imageInput: true, imageOutput: false }
    },

    // ===== Claude =====
    { name: 'claude defaults opus-5-5', format: 'claude', model: 'claude-opus-5-5' },
    {
        name: 'claude non-stream sonnet-5-5',
        format: 'claude',
        model: 'claude-sonnet-5-5',
        settings: { streamEnabled: false }
    },
    {
        name: 'claude sampling params opus-5-5',
        format: 'claude',
        model: 'claude-opus-5-5',
        params: { temperature: 0.7, top_p: 0.9, top_k: 40, max_tokens: 4000 }
    },
    {
        name: 'claude sampling params sonnet-4-5 dated',
        format: 'claude',
        model: 'claude-sonnet-4-5-20250929',
        params: { temperature: 0.7, top_p: 0.9, top_k: 40, max_tokens: 4000 }
    },
    {
        name: 'claude sampling params with budget thinking opus-4-6',
        format: 'claude',
        model: 'claude-opus-4-6',
        settings: { thinkingEnabled: true, thinkingStrength: 'medium' },
        params: { temperature: 0.7, top_p: 0.8, top_k: 40 }
    },
    {
        name: 'claude budget thinking high opus-5-5',
        format: 'claude',
        model: 'claude-opus-5-5',
        settings: { thinkingEnabled: true, thinkingStrength: 'high' }
    },
    {
        name: 'claude budget thinking custom fable-5-1',
        format: 'claude',
        model: 'claude-fable-5-1',
        settings: { thinkingEnabled: true, thinkingStrength: 'custom', thinkingBudget: 5000 }
    },
    {
        name: 'claude budget thinking medium haiku-4-5',
        format: 'claude',
        model: 'claude-haiku-4-5',
        settings: { thinkingEnabled: true, thinkingStrength: 'medium' }
    },
    {
        name: 'claude adaptive xhigh opus-4-6',
        format: 'claude',
        model: 'claude-opus-4-6',
        settings: {
            thinkingEnabled: true,
            claudeAdaptiveThinking: true,
            claudeEffortLevel: 'xhigh'
        }
    },
    {
        name: 'claude adaptive max hidden fable-5-1',
        format: 'claude',
        model: 'claude-fable-5-1',
        settings: {
            thinkingEnabled: true,
            claudeAdaptiveThinking: true,
            claudeEffortLevel: 'max',
            claudeShowThinking: false
        }
    },
    {
        name: 'claude adaptive high sonnet-5-5',
        format: 'claude',
        model: 'claude-sonnet-5-5',
        settings: {
            thinkingEnabled: true,
            claudeAdaptiveThinking: true,
            claudeEffortLevel: 'high'
        }
    },
    {
        name: 'claude adaptive high haiku-4-5',
        format: 'claude',
        model: 'claude-haiku-4-5',
        settings: {
            thinkingEnabled: true,
            claudeAdaptiveThinking: true,
            claudeEffortLevel: 'high'
        }
    },
    { name: 'claude thinking off haiku-5-5', format: 'claude', model: 'claude-haiku-5-5' },
    { name: 'claude thinking off opus-4-8', format: 'claude', model: 'claude-opus-4-8' },
    {
        name: 'claude adaptive on unknown model',
        format: 'claude',
        model: 'claude-proxy-custom',
        settings: {
            thinkingEnabled: true,
            claudeAdaptiveThinking: true,
            claudeEffortLevel: 'medium'
        },
        params: { temperature: 0.5 }
    },
    {
        name: 'claude system monitor prefill sonnet-5-5',
        format: 'claude',
        model: 'claude-sonnet-5-5',
        settings: {
            systemPrompt: 'You are helpful.',
            monitorEnabled: true,
            prefillEnabled: true,
            ...PREFILL
        }
    },
    {
        name: 'claude prefill sonnet-4-5',
        format: 'claude',
        model: 'claude-sonnet-4-5',
        settings: { prefillEnabled: true, ...PREFILL }
    },
    {
        name: 'claude rich history adaptive opus-5-5',
        format: 'claude',
        model: 'claude-opus-5-5',
        history: 'rich',
        settings: {
            thinkingEnabled: true,
            claudeAdaptiveThinking: true,
            claudeEffortLevel: 'high'
        }
    },
    {
        name: 'claude native tools with builtins sonnet-5-5',
        format: 'claude',
        model: 'claude-sonnet-5-5',
        systemTools: true,
        settings: { webSearchEnabled: true, codeExecutionEnabled: true }
    },
    {
        name: 'claude computer use opus-5-5',
        format: 'claude',
        model: 'claude-opus-5-5',
        electron: true,
        settings: { computerUseEnabled: true }
    },
    {
        name: 'claude computer use sonnet-4-5 dated',
        format: 'claude',
        model: 'claude-sonnet-4-5-20250929',
        electron: true,
        settings: { computerUseEnabled: true }
    },
    {
        name: 'claude computer use opus-4-6',
        format: 'claude',
        model: 'claude-opus-4-6',
        electron: true,
        settings: { computerUseEnabled: true }
    },
    {
        name: 'claude computer use xml mode',
        format: 'claude',
        model: 'claude-opus-5-5',
        electron: true,
        settings: { computerUseEnabled: true, xmlToolCallingEnabled: true }
    },
    {
        name: 'claude xml tools',
        format: 'claude',
        model: 'claude-opus-5-5',
        systemTools: true,
        settings: { xmlToolCallingEnabled: true }
    },
    {
        name: 'claude image history with capabilities',
        format: 'claude',
        model: 'claude-sonnet-5-5',
        history: 'image-history',
        capabilities: { imageInput: true, imageOutput: false }
    },

    // ===== Gemini =====
    {
        name: 'gemini defaults 3.8-flash with 2K select',
        format: 'gemini',
        model: 'gemini-3.8-flash',
        imageSize: '2K'
    },
    {
        name: 'gemini defaults 3.8-flash without image size',
        format: 'gemini',
        model: 'gemini-3.8-flash',
        imageSize: ''
    },
    {
        name: 'gemini non-stream 4-argon',
        format: 'gemini',
        model: 'gemini-4-argon',
        imageSize: '',
        settings: { streamEnabled: false }
    },
    {
        name: 'gemini sampling params 4-argon',
        format: 'gemini',
        model: 'gemini-4-argon',
        imageSize: '',
        params: { temperature: 0.7, topP: 0.9, topK: 20, maxOutputTokens: 8192 }
    },
    {
        name: 'gemini sampling params 2.5-flash',
        format: 'gemini',
        model: 'gemini-2.5-flash',
        imageSize: '',
        params: { temperature: 0.7, topP: 0.9, topK: 20, maxOutputTokens: 8192 }
    },
    {
        name: 'gemini thinking high 4-argon',
        format: 'gemini',
        model: 'gemini-4-argon',
        imageSize: '',
        settings: { thinkingEnabled: true, thinkingStrength: 'high' }
    },
    {
        name: 'gemini thinking medium 3.8-flash',
        format: 'gemini',
        model: 'gemini-3.8-flash',
        imageSize: '',
        settings: { thinkingEnabled: true, thinkingStrength: 'medium' }
    },
    {
        name: 'gemini thinking minimal 3.6-flash',
        format: 'gemini',
        model: 'gemini-3.6-flash',
        imageSize: '',
        settings: { thinkingEnabled: true, thinkingStrength: 'minimal' }
    },
    {
        name: 'gemini thinking minimal 3.8-flash',
        format: 'gemini',
        model: 'gemini-3.8-flash',
        imageSize: '',
        settings: { thinkingEnabled: true, thinkingStrength: 'minimal' }
    },
    {
        name: 'gemini thinking low nano-banana-2.1',
        format: 'gemini',
        model: 'gemini-nano-banana-2.1',
        imageSize: '2K',
        settings: { thinkingEnabled: true, thinkingStrength: 'low' }
    },
    {
        name: 'gemini thinking custom 2.5-flash',
        format: 'gemini',
        model: 'gemini-2.5-flash',
        imageSize: '',
        settings: { thinkingEnabled: true, thinkingStrength: 'custom', thinkingBudget: 12000 }
    },
    {
        name: 'gemini thinking low 3.1-flash-lite-image 4K',
        format: 'gemini',
        model: 'gemini-3.1-flash-lite-image',
        imageSize: '4K',
        settings: { thinkingEnabled: true, thinkingStrength: 'low' }
    },
    {
        name: 'gemini thinking off 4-argon',
        format: 'gemini',
        model: 'gemini-4-argon',
        imageSize: ''
    },
    {
        name: 'gemini unknown proxy model with 2K select',
        format: 'gemini',
        model: 'gemini-proxy-x',
        imageSize: '2K'
    },
    {
        name: 'gemini api key in header',
        format: 'gemini',
        model: 'gemini-3.8-flash',
        imageSize: '',
        settings: { geminiApiKeyInHeader: true }
    },
    {
        name: 'gemini vertex endpoint',
        format: 'gemini',
        model: 'gemini-3.8-flash',
        imageSize: '',
        endpoint:
            'https://aiplatform.googleapis.com/v1beta1/projects/demo/locations/global/publishers/google'
    },
    {
        name: 'gemini system parts monitor prefill',
        format: 'gemini',
        model: 'gemini-3.8-flash',
        imageSize: '',
        settings: {
            systemPrompt: 'You are helpful.',
            monitorEnabled: true,
            geminiSystemPartsEnabled: true,
            geminiSystemParts: [{ text: 'Part one' }, { text: 'Part two' }],
            prefillEnabled: true,
            ...PREFILL
        }
    },
    {
        name: 'gemini rich history',
        format: 'gemini',
        model: 'gemini-3.8-flash',
        imageSize: '',
        history: 'rich'
    },
    {
        name: 'gemini signature placement',
        format: 'gemini',
        model: 'gemini-4-argon',
        imageSize: '',
        history: 'gemini-signatures'
    },
    {
        name: 'gemini native tools with builtins',
        format: 'gemini',
        model: 'gemini-3.8-flash',
        imageSize: '',
        systemTools: true,
        settings: { webSearchEnabled: true, codeExecutionEnabled: true }
    },
    {
        name: 'gemini xml tools',
        format: 'gemini',
        model: 'gemini-3.8-flash',
        imageSize: '',
        systemTools: true,
        settings: { xmlToolCallingEnabled: true }
    },
    {
        name: 'gemini image history with capabilities',
        format: 'gemini',
        model: 'gemini-3.8-flash',
        imageSize: '',
        history: 'image-history',
        capabilities: { imageInput: true, imageOutput: false }
    },

    // ===== OpenAI Image =====
    {
        name: 'image defaults sunburst',
        format: 'openai-image',
        model: 'gpt-image-2.5-sunburst',
        history: 'image-prompt',
        paramsKey: 'openai-image',
        params: { size: '1024x1024', quality: 'high' }
    },
    {
        name: 'image edit gpt-image-2 with input fidelity',
        format: 'openai-image',
        model: 'gpt-image-2',
        history: 'image-prompt',
        paramsKey: 'openai-image',
        params: { size: '1536x1024', quality: 'medium', input_fidelity: 'high' }
    },
    {
        name: 'image edit gpt-image-1.5 with input fidelity',
        format: 'openai-image',
        model: 'gpt-image-1.5',
        history: 'image-prompt',
        paramsKey: 'openai-image',
        params: { size: '1024x1536', input_fidelity: 'high', output_format: 'webp' }
    }
];

// ---------- 执行 ----------

let fetchSpy;

function resetEnvironment() {
    const fresh = h.createDefaultState();
    for (const key of Object.keys(h.state)) delete h.state[key];
    Object.assign(h.state, fresh);
    h.elements.imageSizeSelect = null;
    h.capabilities = null;
    h.electron = false;
    h.systemToolsEnabled = false;
    messageSeq = 0;
}

function sortKeys(obj) {
    return Object.fromEntries(Object.entries(obj).sort(([a], [b]) => a.localeCompare(b)));
}

function applyCase(spec) {
    Object.assign(h.state, spec.settings || {});
    h.state.apiFormat = spec.format;
    h.state.selectedModel = spec.model;
    if (spec.params) {
        const key = spec.paramsKey || spec.format;
        h.state.modelParams[key] = { ...h.state.modelParams[key], ...spec.params };
    }
    h.provider = { id: 'provider-1', name: 'Provider', apiFormat: spec.format };
    h.capabilities = spec.capabilities ?? null;
    h.electron = !!spec.electron;
    h.systemToolsEnabled = !!spec.systemTools;
    if (spec.imageSize !== undefined && spec.imageSize !== null) {
        h.elements.imageSizeSelect = { value: spec.imageSize };
    }
}

async function captureRequest(spec) {
    resetEnvironment();
    applyCase(spec);
    const historyFactory = HISTORIES[spec.history || 'basic'];
    const sourceMessages = historyFactory(spec.format);
    await executeRequest(getAdapter(spec.format), {
        endpoint: spec.endpoint || ENDPOINTS[spec.format],
        apiKey: 'test-key',
        model: spec.model,
        sessionId: 'session-1',
        sourceMessages
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, options] = fetchSpy.mock.calls[0];
    return {
        url,
        headers: sortKeys(options.headers),
        body: JSON.parse(options.body)
    };
}

beforeEach(() => {
    fetchSpy = vi.fn(() => Promise.resolve(new Response('{}', { status: 200 })));
    globalThis.fetch = fetchSpy;
    if (globalThis.window) {
        Object.defineProperty(window, 'screen', {
            configurable: true,
            value: { width: 1920, height: 1080 }
        });
    }
});

describe('请求体矩阵快照', () => {
    it('用例名唯一', () => {
        const names = CASES.map((c) => c.name);
        expect(new Set(names).size).toBe(names.length);
    });

    for (const spec of CASES) {
        it(spec.name, async () => {
            const captured = await captureRequest(spec);
            expect(captured).toMatchSnapshot();
        });
    }
});

describe('OpenClaw 请求参数快照', () => {
    const OPENCLAW_CASES = [
        { name: 'openclaw defaults', settings: {} },
        {
            name: 'openclaw params and budget thinking',
            settings: { thinkingEnabled: true, thinkingBudget: 9000 },
            params: { temperature: 0.4, top_p: 0.8, max_tokens: 2048, frequency_penalty: 0.2 }
        }
    ];

    for (const spec of OPENCLAW_CASES) {
        it(spec.name, () => {
            resetEnvironment();
            Object.assign(h.state, spec.settings);
            if (spec.params) {
                h.state.modelParams.openai = { ...h.state.modelParams.openai, ...spec.params };
            }
            h.provider = { id: 'provider-1', name: 'Provider', apiFormat: 'openclaw' };
            const profile = captureRequestProfile(getAdapter('openclaw'), 'openclaw-model');
            expect({
                modelParams: profile.modelParams,
                thinkingCfg: profile.thinkingCfg,
                verbosityCfg: profile.verbosityCfg
            }).toMatchSnapshot();
        });
    }
});
