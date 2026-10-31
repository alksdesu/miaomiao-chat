/**
 * config.js 配置管理测试
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// mock 所有依赖 — 工厂函数内只用字面量
vi.mock('../../js/core/state.js', () => ({
    state: {
        apiFormat: 'openai',
        imageSize: '2K',
        pdfMode: 'standard',
        replyCount: 1,
        selectedModel: '',
        streamEnabled: true,
        thinkingEnabled: false,
        thinkingStrength: 'high',
        thinkingBudget: 32768,
        thinkingNoneMode: false,
        claudeAdaptiveThinking: false,
        claudeEffortLevel: 'high',
        webSearchEnabled: false,
        geminiApiKeyInHeader: false,
        verbosityEnabled: false,
        outputVerbosity: 'medium',
        xmlToolCallingEnabled: false,
        endpoints: { openai: '', gemini: '', claude: '' },
        apiKeys: { openai: '', gemini: '', claude: '' },
        customModels: { openai: '', gemini: '', claude: '' },
        modelParams: {
            openai: {
                temperature: null,
                max_tokens: null,
                top_p: null,
                frequency_penalty: null,
                presence_penalty: null
            },
            gemini: { temperature: null, topK: null, topP: null, maxOutputTokens: null },
            claude: { temperature: null, max_tokens: null, top_p: null, top_k: null }
        },
        customHeaders: [],
        prefillEnabled: true,
        systemPrompt: '',
        prefillMessages: [],
        charName: 'Assistant',
        userName: 'User',
        savedPrefillPresets: [],
        currentPrefillPresetName: '',
        systemPrefillMessages: [],
        savedSystemPrefillPresets: [],
        currentSystemPrefillPresetName: '',
        geminiSystemPartsEnabled: false,
        geminiSystemParts: [],
        savedGeminiPartsPresets: [],
        currentGeminiPartsPresetName: '',
        providers: [],
        currentProviderId: null,
        fastImageCompression: false,
        codeExecutionEnabled: false,
        computerUseEnabled: false,
        computerUsePermissions: {},
        bashConfig: {},
        quickMessages: [],
        quickMessagesCategories: ['常用', '问候', '告别'],
        storageMode: 'indexedDB',
        pendingModelSelection: null,
        prefillPresets: [],
        activePrefillPresetId: null,
        claudeShowThinking: true
    },
    elements: {
        apiEndpoint: { value: '' },
        apiKey: { value: '' },
        modelSelect: { value: '' },
        imageSizeSelect: null,
        replyCountSelect: null,
        geminiApiKeyInHeaderToggle: null
    }
}));

vi.mock('../../js/core/events.js', () => ({
    eventBus: { emit: vi.fn(), on: vi.fn() }
}));

vi.mock('../../js/utils/logger.js', () => ({
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

vi.mock('../../js/state/storage.js', () => ({
    saveConfig: vi.fn(() => Promise.resolve()),
    loadConfig: vi.fn(() => Promise.resolve(null)),
    saveSavedConfigs: vi.fn(() => Promise.resolve()),
    loadSavedConfigs: vi.fn(() => Promise.resolve(null))
}));

vi.mock('../../js/state/config-ui-sync.js', () => ({ syncUIWithState: vi.fn() }));

import { state, elements } from '../../js/core/state.js';
import {
    buildConfigObject,
    getDefaultCapabilities,
    applyConfigToState,
    generateExportFilename,
    loadConfig
} from '../../js/state/config.js';

function resetState() {
    Object.assign(state, {
        apiFormat: 'openai',
        imageSize: '2K',
        pdfMode: 'standard',
        replyCount: 1,
        streamEnabled: true,
        thinkingEnabled: false,
        thinkingStrength: 'high',
        thinkingBudget: 32768,
        providers: [],
        currentProviderId: null,
        endpoints: { openai: '', gemini: '', claude: '' },
        apiKeys: { openai: '', gemini: '', claude: '' },
        customModels: { openai: '', gemini: '', claude: '' },
        modelParams: {
            openai: {
                temperature: null,
                max_tokens: null,
                top_p: null,
                frequency_penalty: null,
                presence_penalty: null
            },
            gemini: { temperature: null, topK: null, topP: null, maxOutputTokens: null },
            claude: { temperature: null, max_tokens: null, top_p: null, top_k: null }
        },
        customHeaders: [],
        prefillEnabled: true,
        systemPrompt: '',
        prefillMessages: [],
        charName: 'Assistant',
        userName: 'User',
        savedPrefillPresets: [],
        currentPrefillPresetName: '',
        systemPrefillMessages: [],
        savedSystemPrefillPresets: [],
        currentSystemPrefillPresetName: '',
        geminiSystemPartsEnabled: false,
        geminiSystemParts: [],
        savedGeminiPartsPresets: [],
        currentGeminiPartsPresetName: '',
        fastImageCompression: false,
        codeExecutionEnabled: false,
        computerUseEnabled: false,
        computerUsePermissions: {},
        bashConfig: {},
        quickMessages: [],
        quickMessagesCategories: ['常用', '问候', '告别'],
        verbosityEnabled: false,
        outputVerbosity: 'medium',
        xmlToolCallingEnabled: false,
        webSearchEnabled: false,
        geminiApiKeyInHeader: false,
        claudeAdaptiveThinking: false,
        claudeEffortLevel: 'high',
        thinkingNoneMode: false,
        selectedModel: '',
        pendingModelSelection: null,
        prefillPresets: [],
        activePrefillPresetId: null,
        claudeShowThinking: true
    });
    Object.assign(elements, {
        apiEndpoint: { value: '' },
        apiKey: { value: '' },
        modelSelect: { value: '' },
        imageSizeSelect: null,
        replyCountSelect: null
    });
}

beforeEach(resetState);

// ========== buildConfigObject ==========

describe('buildConfigObject', () => {
    it('包含 configVersion', () => {
        expect(buildConfigObject().configVersion).toBe(3);
    });

    it('包含 updatedAt 时间戳', () => {
        const before = Date.now();
        expect(buildConfigObject().updatedAt).toBeGreaterThanOrEqual(before);
    });

    it('包含 apiFormat', () => {
        state.apiFormat = 'claude';
        expect(buildConfigObject().apiFormat).toBe('claude');
    });

    it('包含功能开关', () => {
        state.streamEnabled = false;
        state.thinkingEnabled = true;
        state.webSearchEnabled = true;
        const config = buildConfigObject();
        expect(config.streamEnabled).toBe(false);
        expect(config.thinkingEnabled).toBe(true);
        expect(config.webSearchEnabled).toBe(true);
    });

    it('深拷贝 modelParams', () => {
        state.modelParams.openai.temperature = 0.7;
        const config = buildConfigObject();
        expect(config.modelParams.openai.temperature).toBe(0.7);
        state.modelParams.openai.temperature = 0.9;
        expect(config.modelParams.openai.temperature).toBe(0.7);
    });

    it('深拷贝 providers', () => {
        state.providers = [{ id: 'p1', name: 'Test', models: [] }];
        const config = buildConfigObject();
        expect(config.providers).toHaveLength(1);
        state.providers[0].name = 'Changed';
        expect(config.providers[0].name).toBe('Test');
    });

    it('深拷贝 prefillMessages', () => {
        state.prefillMessages = [{ role: 'user', content: 'hi' }];
        const config = buildConfigObject();
        state.prefillMessages[0].content = 'changed';
        expect(config.prefillMessages[0].content).toBe('hi');
    });

    it('包含三格式端点', () => {
        state.endpoints = {
            openai: 'https://a.com',
            gemini: 'https://b.com',
            claude: 'https://c.com'
        };
        const config = buildConfigObject();
        expect(config.endpoints.openai).toBe('https://a.com');
    });

    it('elements 为 null 时使用空字符串', () => {
        elements.apiEndpoint = null;
        elements.apiKey = null;
        const config = buildConfigObject();
        expect(config.apiEndpoint).toBe('');
        expect(config.apiKey).toBe('');
    });
});

// ========== getDefaultCapabilities ==========

describe('getDefaultCapabilities', () => {
    it('OpenAI 支持图片输入不支持输出', () => {
        expect(getDefaultCapabilities('openai')).toEqual({ imageInput: true, imageOutput: false });
    });

    it('OpenAI Image 支持图片输入输出', () => {
        expect(getDefaultCapabilities('openai-image')).toEqual({
            imageInput: true,
            imageOutput: true
        });
    });

    it('Gemini 完全支持多模态', () => {
        expect(getDefaultCapabilities('gemini')).toEqual({ imageInput: true, imageOutput: true });
    });

    it('Claude 支持图片输入不支持输出', () => {
        expect(getDefaultCapabilities('claude')).toEqual({ imageInput: true, imageOutput: false });
    });

    it.each(['openai-responses', 'openclaw'])('%s 与 OpenAI Chat 一致', (apiFormat) => {
        expect(getDefaultCapabilities(apiFormat)).toEqual({ imageInput: true, imageOutput: false });
    });

    it('未知格式默认都不支持', () => {
        expect(getDefaultCapabilities('unknown')).toEqual({
            imageInput: false,
            imageOutput: false
        });
    });

    it('undefined 返回默认', () => {
        expect(getDefaultCapabilities(undefined)).toEqual({
            imageInput: false,
            imageOutput: false
        });
    });
});

// ========== 配置升级 ==========

describe('配置升级 v2 → v3', () => {
    const legacyCaps = () => ({ imageInput: false, imageOutput: false });
    const provider = (apiFormat, capabilities) => ({
        id: `p-${apiFormat}`,
        name: apiFormat,
        apiFormat,
        enabled: true,
        models: [{ id: 'm1', name: 'm1', capabilities }]
    });

    it.each(['openai-responses', 'openclaw'])(
        '%s 模型的旧默认能力改为该格式默认值',
        (apiFormat) => {
            applyConfigToState({
                configVersion: 2,
                providers: [provider(apiFormat, legacyCaps())]
            });
            expect(state.providers[0].models[0].capabilities).toEqual({
                imageInput: true,
                imageOutput: false
            });
        }
    );

    it('其他格式的全关能力视为用户设置，保持不变', () => {
        applyConfigToState({
            configVersion: 2,
            providers: [provider('claude', legacyCaps())]
        });
        expect(state.providers[0].models[0].capabilities).toEqual(legacyCaps());
    });

    it('已经修改过的能力保持不变', () => {
        const caps = { imageInput: true, imageOutput: true };
        applyConfigToState({
            configVersion: 2,
            providers: [provider('openai-responses', caps)]
        });
        expect(state.providers[0].models[0].capabilities).toEqual(caps);
    });

    it('v3 配置不再改写全关能力', () => {
        applyConfigToState({
            configVersion: 3,
            providers: [provider('openai-responses', legacyCaps())]
        });
        expect(state.providers[0].models[0].capabilities).toEqual(legacyCaps());
    });

    it('v1 配置连续升级到 v3', () => {
        applyConfigToState({
            configVersion: 1,
            providers: [{ id: 'p1', name: 'r', apiFormat: 'openai-responses', models: ['gpt-5.5'] }]
        });
        expect(state.providers[0].models[0]).toEqual({
            id: 'gpt-5.5',
            name: 'gpt-5.5',
            capabilities: { imageInput: true, imageOutput: false }
        });
    });
});

// ========== applyConfigToState ==========

describe('applyConfigToState', () => {
    describe('生图参数复查', () => {
        beforeEach(async () => {
            const { eventBus } = await import('../../js/core/events.js');
            eventBus.emit.mockClear();
            state.modelParams['openai-image'] = {
                size: null,
                customSize: '',
                background: null,
                output_format: null
            };
        });

        it('已保存的过小自定义尺寸回到默认并提示', async () => {
            const { eventBus } = await import('../../js/core/events.js');

            const result = applyConfigToState({
                configVersion: 3,
                providers: [],
                modelParams: { 'openai-image': { size: 'custom', customSize: '512x512' } }
            });

            expect(result).toEqual({ imageParamsCorrected: true });
            expect(state.modelParams['openai-image']).toEqual(
                expect.objectContaining({ size: null, customSize: '' })
            );
            expect(eventBus.emit).toHaveBeenCalledWith(
                'ui:notification',
                expect.objectContaining({
                    type: 'warning',
                    message: expect.stringContaining('512x512')
                })
            );
        });

        it('透明背景配 JPEG 的旧配置改为 PNG', () => {
            const result = applyConfigToState({
                configVersion: 3,
                providers: [],
                modelParams: {
                    'openai-image': { background: 'transparent', output_format: 'jpeg' }
                }
            });

            expect(result.imageParamsCorrected).toBe(true);
            expect(state.modelParams['openai-image'].output_format).toBe('png');
        });

        it('合法参数不纠正也不提示', async () => {
            const { eventBus } = await import('../../js/core/events.js');

            const result = applyConfigToState({
                configVersion: 3,
                providers: [],
                modelParams: { 'openai-image': { size: 'custom', customSize: '1536x864' } }
            });

            expect(result.imageParamsCorrected).toBe(false);
            expect(state.modelParams['openai-image'].customSize).toBe('1536x864');
            expect(eventBus.emit).not.toHaveBeenCalledWith('ui:notification', expect.anything());
        });
    });

    it('拒绝越界或错误类型的 Bash 配置', () => {
        expect(() =>
            applyConfigToState({
                configVersion: 2,
                bashConfig: { timeout: 301 },
                providers: []
            })
        ).toThrow('bashConfig.timeout');

        expect(() =>
            applyConfigToState({
                configVersion: 2,
                bashConfig: { workingDirectory: 42 },
                providers: []
            })
        ).toThrow('workingDirectory');
    });

    it('应用基本功能开关', () => {
        applyConfigToState({
            configVersion: 2,
            streamEnabled: false,
            thinkingEnabled: true,
            thinkingStrength: 'medium',
            thinkingBudget: 16384,
            webSearchEnabled: true,
            providers: []
        });
        expect(state.streamEnabled).toBe(false);
        expect(state.thinkingEnabled).toBe(true);
        expect(state.thinkingStrength).toBe('medium');
        expect(state.thinkingBudget).toBe(16384);
        expect(state.webSearchEnabled).toBe(true);
    });

    it('应用出图宽高比，旧配置缺少该字段时恢复为按模型默认', () => {
        applyConfigToState({ configVersion: 2, imageAspectRatio: '16:9', providers: [] });
        expect(state.imageAspectRatio).toBe('16:9');
        applyConfigToState({ configVersion: 2, providers: [] });
        expect(state.imageAspectRatio).toBe('');
    });

    it('功能开关缺失时使用默认值', () => {
        applyConfigToState({ configVersion: 2, providers: [] });
        expect(state.streamEnabled).toBe(true);
        expect(state.thinkingEnabled).toBe(false);
        expect(state.webSearchEnabled).toBe(false);
    });

    it('应用三格式端点', () => {
        applyConfigToState({
            configVersion: 2,
            endpoints: {
                openai: 'https://a.com',
                gemini: 'https://b.com',
                claude: 'https://c.com'
            },
            providers: []
        });
        expect(state.endpoints.openai).toBe('https://a.com');
    });

    it('端点缺失时使用默认值', () => {
        applyConfigToState({ configVersion: 2, providers: [] });
        expect(state.endpoints).toEqual({ openai: '', gemini: '', claude: '' });
    });

    it('应用模型参数（深度合并）', () => {
        state.modelParams.openai.temperature = 0.5;
        applyConfigToState({
            configVersion: 2,
            modelParams: { openai: { max_tokens: 2048 } },
            providers: []
        });
        expect(state.modelParams.openai.temperature).toBe(0.5);
        expect(state.modelParams.openai.max_tokens).toBe(2048);
    });

    it('应用预填充消息', () => {
        applyConfigToState({
            configVersion: 2,
            prefillEnabled: false,
            systemPrompt: 'You are helpful',
            prefillMessages: [{ role: 'user', content: 'hi' }],
            charName: 'Bot',
            userName: 'Human',
            providers: []
        });
        expect(state.prefillEnabled).toBe(false);
        expect(state.systemPrompt).toBe('You are helpful');
        expect(state.prefillMessages).toHaveLength(1);
        expect(state.charName).toBe('Bot');
        expect(state.userName).toBe('Human');
    });

    it('应用 providers', () => {
        applyConfigToState({
            configVersion: 2,
            providers: [{ id: 'p1', name: 'Test', apiFormat: 'openai', models: [], enabled: true }],
            currentProviderId: 'p1'
        });
        expect(state.providers).toHaveLength(1);
        expect(state.currentProviderId).toBe('p1');
    });

    it('自动迁移旧 providers 没有 models 字段', () => {
        applyConfigToState({
            configVersion: 2,
            providers: [{ id: 'p1', name: 'Test', customModel: 'gpt-4o' }]
        });
        expect(state.providers[0].models).toEqual(['gpt-4o']);
    });

    it('自动迁移旧 providers 没有 apiKeys 字段', () => {
        applyConfigToState({
            configVersion: 2,
            providers: [{ id: 'p1', name: 'Test', apiKey: 'sk-test', models: [] }]
        });
        expect(state.providers[0].apiKeys).toHaveLength(1);
        expect(state.providers[0].apiKeys[0].key).toBe('sk-test');
    });

    it('自动添加 keyRotation 字段', () => {
        applyConfigToState({
            configVersion: 2,
            providers: [{ id: 'p1', name: 'Test', models: [], apiKeys: [] }]
        });
        expect(state.providers[0].keyRotation).toEqual({
            enabled: false,
            strategy: 'round-robin',
            rotateOnError: true,
            currentIndex: 0
        });
    });

    it('v1 配置自动升级到 v2', () => {
        applyConfigToState({
            providers: [
                {
                    id: 'p1',
                    name: 'Test',
                    apiFormat: 'openai',
                    models: ['gpt-4o', 'gpt-3.5-turbo']
                }
            ]
        });
        expect(state.providers[0].models[0]).toHaveProperty('id');
        expect(state.providers[0].models[0].id).toBe('gpt-4o');
    });

    it('PDF 模式向后兼容 pdfRenderToImage', () => {
        applyConfigToState({ configVersion: 2, pdfRenderToImage: true, providers: [] });
        expect(state.pdfMode).toBe('render');
    });

    it('PDF 模式向后兼容 pdfImageModeEnabled', () => {
        applyConfigToState({ configVersion: 2, pdfImageModeEnabled: true, providers: [] });
        expect(state.pdfMode).toBe('compat');
    });

    it('pdfMode 优先级高于旧字段', () => {
        applyConfigToState({
            configVersion: 2,
            pdfMode: 'standard',
            pdfRenderToImage: true,
            providers: []
        });
        expect(state.pdfMode).toBe('standard');
    });

    it('应用 selectedModel', () => {
        applyConfigToState({ configVersion: 2, selectedModel: 'claude-3-opus', providers: [] });
        expect(state.selectedModel).toBe('claude-3-opus');
    });

    it('应用 verbosity 配置', () => {
        applyConfigToState({
            configVersion: 2,
            verbosityEnabled: true,
            outputVerbosity: 'high',
            providers: []
        });
        expect(state.verbosityEnabled).toBe(true);
        expect(state.outputVerbosity).toBe('high');
    });

    it('应用 Claude 特有配置', () => {
        applyConfigToState({
            configVersion: 2,
            claudeAdaptiveThinking: true,
            claudeEffortLevel: 'low',
            thinkingNoneMode: true,
            providers: []
        });
        expect(state.claudeAdaptiveThinking).toBe(true);
        expect(state.claudeEffortLevel).toBe('low');
        expect(state.thinkingNoneMode).toBe(true);
    });

    it('应用 computerUsePermissions 合并', () => {
        state.computerUsePermissions = { allow: true };
        applyConfigToState({
            configVersion: 2,
            computerUsePermissions: { allowScreenshots: true },
            providers: []
        });
        expect(state.computerUsePermissions.allow).toBe(true);
        expect(state.computerUsePermissions.allowScreenshots).toBe(true);
    });

    it('应用 quickMessages', () => {
        applyConfigToState({
            configVersion: 2,
            quickMessages: [{ text: 'hello' }],
            quickMessagesCategories: ['自定义'],
            providers: []
        });
        expect(state.quickMessages).toHaveLength(1);
        expect(state.quickMessagesCategories).toEqual(['自定义']);
    });

    it('Gemini System Parts', () => {
        applyConfigToState({
            configVersion: 2,
            geminiSystemPartsEnabled: true,
            geminiSystemParts: [{ text: 'part1' }],
            providers: []
        });
        expect(state.geminiSystemPartsEnabled).toBe(true);
        expect(state.geminiSystemParts).toHaveLength(1);
    });
});

// ========== generateExportFilename ==========

describe('generateExportFilename', () => {
    it('包含类型名', () => {
        expect(generateExportFilename('config')).toContain('config');
    });

    it('包含 webchat 前缀', () => {
        expect(generateExportFilename('sessions')).toMatch(/^webchat-/);
    });

    it('包含日期', () => {
        expect(generateExportFilename('config')).toMatch(/\d{4}-\d{2}-\d{2}/);
    });

    it('以 .json 结尾', () => {
        expect(generateExportFilename('config')).toMatch(/\.json$/);
    });
});

// ========== loadConfig ==========

describe('loadConfig 生图参数复查', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.stubGlobal('localStorage', { getItem: vi.fn(() => null), setItem: vi.fn() });
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('纠正过的生图参数写回存储，下次启动不再提示', async () => {
        const storage = await import('../../js/state/storage.js');
        storage.saveConfig.mockClear();
        storage.loadConfig.mockResolvedValueOnce({
            configVersion: 3,
            providers: [],
            modelParams: { 'openai-image': { size: 'custom', customSize: '512x512' } }
        });

        await loadConfig();
        await vi.runAllTimersAsync();

        expect(storage.saveConfig).toHaveBeenCalledWith(
            expect.objectContaining({
                modelParams: expect.objectContaining({
                    'openai-image': expect.objectContaining({ size: null, customSize: '' })
                })
            })
        );
    });

    it('生图参数合法时加载不写回', async () => {
        const storage = await import('../../js/state/storage.js');
        storage.saveConfig.mockClear();
        storage.loadConfig.mockResolvedValueOnce({
            configVersion: 3,
            providers: [],
            modelParams: { 'openai-image': { size: 'custom', customSize: '1536x864' } }
        });

        await loadConfig();
        await vi.runAllTimersAsync();

        expect(storage.saveConfig).not.toHaveBeenCalled();
    });
});
