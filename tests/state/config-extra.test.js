/**
 * 补充测试：config 升级、export 工具函数、params 边界用例
 * 目标：覆盖 config.js 的 upgradeProviderModels / upgradeConfig 和 params.js 边界
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ========== config.js 测试 ==========

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

import { state } from '../../js/core/state.js';
import { getDefaultCapabilities, buildConfigObject } from '../../js/state/config.js';

describe('getDefaultCapabilities 边界', () => {
    it('空字符串返回默认', () => {
        expect(getDefaultCapabilities('')).toEqual({ imageInput: false, imageOutput: false });
    });

    it('null 返回默认', () => {
        expect(getDefaultCapabilities(null)).toEqual({ imageInput: false, imageOutput: false });
    });

    it('数字返回默认', () => {
        expect(getDefaultCapabilities(123)).toEqual({ imageInput: false, imageOutput: false });
    });

    it('openai 返回正确', () => {
        const result = getDefaultCapabilities('openai');
        expect(result.imageInput).toBe(true);
        expect(result.imageOutput).toBe(false);
    });
});

describe('buildConfigObject 边界', () => {
    beforeEach(() => {
        state.customHeaders = [];
        state.providers = [];
        state.prefillMessages = [];
    });

    it('包含 quickMessages 深拷贝', () => {
        state.quickMessages = [{ text: 'hello' }];
        const config = buildConfigObject();
        state.quickMessages[0].text = 'changed';
        expect(config.quickMessages[0].text).toBe('hello');
    });

    it('包含 quickMessagesCategories', () => {
        state.quickMessagesCategories = ['cat1', 'cat2'];
        const config = buildConfigObject();
        expect(config.quickMessagesCategories).toEqual(['cat1', 'cat2']);
    });

    it('customHeaders 拷贝', () => {
        state.customHeaders = [{ key: 'X-Test', value: 'val' }];
        const config = buildConfigObject();
        expect(config.customHeaders).toHaveLength(1);
        expect(config.customHeaders[0].key).toBe('X-Test');
    });

    it('geminiSystemParts 深拷贝', () => {
        state.geminiSystemParts = [{ text: 'part1' }];
        const config = buildConfigObject();
        state.geminiSystemParts[0].text = 'changed';
        expect(config.geminiSystemParts[0].text).toBe('part1');
    });

    it('包含 computerUsePermissions', () => {
        state.computerUsePermissions = { bash: true, editor: false };
        const config = buildConfigObject();
        expect(config.computerUsePermissions.bash).toBe(true);
    });

    it('包含 bashConfig', () => {
        state.bashConfig = { timeout: 30000 };
        const config = buildConfigObject();
        expect(config.bashConfig.timeout).toBe(30000);
    });

    it('savedPrefillPresets 深拷贝', () => {
        state.savedPrefillPresets = [{ name: 'preset1', messages: [] }];
        const config = buildConfigObject();
        state.savedPrefillPresets[0].name = 'changed';
        expect(config.savedPrefillPresets[0].name).toBe('preset1');
    });

    it('包含 claudeAdaptiveThinking', () => {
        state.claudeAdaptiveThinking = true;
        const config = buildConfigObject();
        expect(config.claudeAdaptiveThinking).toBe(true);
    });

    it('包含 verbosityEnabled', () => {
        state.verbosityEnabled = true;
        const config = buildConfigObject();
        expect(config.verbosityEnabled).toBe(true);
    });

    it('包含 outputVerbosity', () => {
        state.outputVerbosity = 'low';
        const config = buildConfigObject();
        expect(config.outputVerbosity).toBe('low');
    });

    it('包含 xmlToolCallingEnabled', () => {
        state.xmlToolCallingEnabled = true;
        const config = buildConfigObject();
        expect(config.xmlToolCallingEnabled).toBe(true);
    });

    it('包含 pdfMode', () => {
        state.pdfMode = 'ocr';
        const config = buildConfigObject();
        expect(config.pdfMode).toBe('ocr');
    });

    it('包含 replyCount', () => {
        state.replyCount = 3;
        const config = buildConfigObject();
        expect(config.replyCount).toBe(3);
    });

    it('包含 imageSize', () => {
        state.imageSize = '4K';
        const config = buildConfigObject();
        expect(config.imageSize).toBe('4K');
    });

    it('包含 fastImageCompression', () => {
        state.fastImageCompression = true;
        const config = buildConfigObject();
        expect(config.fastImageCompression).toBe(true);
    });

    it('包含 codeExecutionEnabled', () => {
        state.codeExecutionEnabled = true;
        const config = buildConfigObject();
        expect(config.codeExecutionEnabled).toBe(true);
    });

    it('包含 computerUseEnabled', () => {
        state.computerUseEnabled = true;
        const config = buildConfigObject();
        expect(config.computerUseEnabled).toBe(true);
    });

    it('包含 charName', () => {
        state.charName = 'TestBot';
        const config = buildConfigObject();
        expect(config.charName).toBe('TestBot');
    });

    it('包含 userName', () => {
        state.userName = 'TestUser';
        const config = buildConfigObject();
        expect(config.userName).toBe('TestUser');
    });

    it('包含 currentProviderId', () => {
        state.currentProviderId = 'provider-1';
        const config = buildConfigObject();
        expect(config.currentProviderId).toBe('provider-1');
    });

    it('包含 geminiSystemPartsEnabled', () => {
        state.geminiSystemPartsEnabled = true;
        const config = buildConfigObject();
        expect(config.geminiSystemPartsEnabled).toBe(true);
    });

    it('包含 prefillEnabled', () => {
        state.prefillEnabled = false;
        const config = buildConfigObject();
        expect(config.prefillEnabled).toBe(false);
    });

    it('包含 systemPrompt', () => {
        state.systemPrompt = 'You are a helper.';
        const config = buildConfigObject();
        expect(config.systemPrompt).toBe('You are a helper.');
    });

    it('包含 thinkingBudget', () => {
        state.thinkingBudget = 16384;
        const config = buildConfigObject();
        expect(config.thinkingBudget).toBe(16384);
    });

    it('包含 thinkingNoneMode', () => {
        state.thinkingNoneMode = true;
        const config = buildConfigObject();
        expect(config.thinkingNoneMode).toBe(true);
    });

    it('包含 claudeEffortLevel', () => {
        state.claudeEffortLevel = 'medium';
        const config = buildConfigObject();
        expect(config.claudeEffortLevel).toBe('medium');
    });

    it('包含 geminiApiKeyInHeader', () => {
        state.geminiApiKeyInHeader = true;
        const config = buildConfigObject();
        expect(config.geminiApiKeyInHeader).toBe(true);
    });

    it('包含 currentPrefillPresetName', () => {
        state.currentPrefillPresetName = 'my-preset';
        const config = buildConfigObject();
        expect(config.currentPrefillPresetName).toBe('my-preset');
    });

    it('包含 currentSystemPrefillPresetName', () => {
        state.currentSystemPrefillPresetName = 'sys-preset';
        const config = buildConfigObject();
        expect(config.currentSystemPrefillPresetName).toBe('sys-preset');
    });

    it('包含 currentGeminiPartsPresetName', () => {
        state.currentGeminiPartsPresetName = 'gemini-preset';
        const config = buildConfigObject();
        expect(config.currentGeminiPartsPresetName).toBe('gemini-preset');
    });
});
