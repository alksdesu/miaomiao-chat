/**
 * config-helpers.js 测试
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../js/core/state.js', () => ({
    state: {
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
            gemini: { temperature: null, maxOutputTokens: null, topP: null, topK: null },
            claude: { temperature: null, max_tokens: null, top_p: null, top_k: null }
        },
        apiFormat: 'openai',
        thinkingEnabled: false,
        thinkingBudget: 8192,
        thinkingStrength: 'medium',
        claudeAdaptiveThinking: false,
        claudeEffortLevel: 'medium',
        claudeShowThinking: false,
        streamEnabled: true,
        webSearchEnabled: false,
        xmlToolCallingEnabled: false,
        replyCount: 1,
        thinkingNoneMode: false,
        verbosityEnabled: false,
        outputVerbosity: 'medium',
        imageSize: '2K',
        geminiApiKeyInHeader: false,
        savedConfigs: [],
        currentConfigName: '',
        messages: []
    }
}));

vi.mock('../../js/core/elements.js', () => ({
    elements: {
        configSelect: null,
        saveConfig: null,
        deleteConfig: null,
        imageSizeSelect: null,
        geminiApiKeyInHeaderToggle: null,
        replyCountSelect: null,
        thinkingNoneMode: null,
        verbosityEnabled: null,
        outputVerbosity: null
    }
}));

vi.mock('../../js/core/events.js', () => ({
    eventBus: { emit: vi.fn(), on: vi.fn(), off: vi.fn() }
}));

vi.mock('../../js/state/config.js', () => ({
    saveCurrentConfig: vi.fn(),
    syncUIWithState: vi.fn(),
    saveSavedConfigs: vi.fn(() => Promise.resolve()),
    applyConfigToState: vi.fn(),
    buildConfigObject: vi.fn(() => ({ name: '' }))
}));

vi.mock('../../js/ui/quick-toggles.js', () => ({
    syncQuickToggles: vi.fn()
}));

vi.mock('../../js/ui/notifications.js', () => ({
    showNotification: vi.fn()
}));

vi.mock('../../js/utils/dialogs.js', () => ({
    showInputDialog: vi.fn(() => Promise.resolve(null)),
    showConfirmDialog: vi.fn(() => Promise.resolve(false))
}));

vi.mock('../../js/utils/icons.js', () => ({
    getIcon: vi.fn(() => '<svg></svg>')
}));

vi.mock('../../js/utils/logger.js', () => ({
    logger: { warn: vi.fn(), debug: vi.fn(), error: vi.fn(), info: vi.fn() }
}));

import { state } from '../../js/core/state.js';
import { elements } from '../../js/core/elements.js';
import {
    initEndpointInputListeners,
    initThinkingControls,
    initConfigManagement,
    initOtherConfigInputs
} from '../../js/ui/config-helpers.js';

describe('config-helpers', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
        vi.clearAllMocks();
        state.endpoints = { openai: '', gemini: '', claude: '' };
        state.apiKeys = { openai: '', gemini: '', claude: '' };
        state.customModels = { openai: '', gemini: '', claude: '' };
        state.modelParams = {
            openai: {
                temperature: null,
                max_tokens: null,
                top_p: null,
                frequency_penalty: null,
                presence_penalty: null
            },
            gemini: { temperature: null, maxOutputTokens: null, topP: null, topK: null },
            claude: { temperature: null, max_tokens: null, top_p: null, top_k: null }
        };
        state.thinkingEnabled = false;
        state.thinkingBudget = 8192;
        state.thinkingStrength = 'medium';
        state.claudeAdaptiveThinking = false;
        state.claudeEffortLevel = 'medium';
        state.streamEnabled = true;
        state.webSearchEnabled = false;
        state.xmlToolCallingEnabled = false;
        state.replyCount = 1;
        state.thinkingNoneMode = false;
        state.verbosityEnabled = false;
        state.outputVerbosity = 'medium';
        state.imageSize = '2K';
        state.geminiApiKeyInHeader = false;
        state.savedConfigs = [];
        state.currentConfigName = '';
        state.messages = [];
    });

    afterEach(() => {
        document.body.innerHTML = '';
    });

    // ========== initEndpointInputListeners ==========
    describe('initEndpointInputListeners', () => {
        it('不抛错', () => {
            expect(() => initEndpointInputListeners()).not.toThrow();
        });

        it('endpoint 输入更新 state', () => {
            document.body.innerHTML = `
                <input id="openai-endpoint" />
                <input id="openai-apikey" />
                <input id="openai-custom-model" />
                <input id="openai-temperature" />
                <input id="openai-max-tokens" />
                <input id="openai-top-p" />
                <input id="openai-frequency-penalty" />
                <input id="openai-presence-penalty" />
                <input id="gemini-temperature" />
                <input id="gemini-max-output-tokens" />
                <input id="gemini-top-p" />
                <input id="gemini-top-k" />
                <input id="claude-temperature" />
                <input id="claude-max-tokens" />
                <input id="claude-top-p" />
                <input id="claude-top-k" />
            `;
            initEndpointInputListeners();
            const ep = document.getElementById('openai-endpoint');
            ep.value = 'https://api.example.com';
            ep.dispatchEvent(new Event('input'));
            expect(state.endpoints.openai).toBe('https://api.example.com');
        });

        it('apikey 输入更新 state', () => {
            document.body.innerHTML = '<input id="openai-apikey" />';
            initEndpointInputListeners();
            const ak = document.getElementById('openai-apikey');
            ak.value = 'sk-test';
            ak.dispatchEvent(new Event('input'));
            expect(state.apiKeys.openai).toBe('sk-test');
        });

        it('custom-model 输入更新 state', () => {
            document.body.innerHTML = '<input id="gemini-custom-model" />';
            initEndpointInputListeners();
            const cm = document.getElementById('gemini-custom-model');
            cm.value = 'my-model';
            cm.dispatchEvent(new Event('input'));
            expect(state.customModels.gemini).toBe('my-model');
        });

        it('通用参数同步到所有格式', () => {
            document.body.innerHTML = `
                <input id="openai-temperature" />
                <input id="gemini-temperature" />
                <input id="claude-temperature" />
            `;
            initEndpointInputListeners();
            const tempInput = document.getElementById('openai-temperature');
            tempInput.value = '0.7';
            tempInput.dispatchEvent(new Event('input'));
            expect(state.modelParams.openai.temperature).toBe(0.7);
            expect(state.modelParams.gemini.temperature).toBe(0.7);
            expect(state.modelParams.claude.temperature).toBe(0.7);
        });

        it('特殊参数仅更新当前格式', () => {
            document.body.innerHTML = '<input id="openai-frequency-penalty" />';
            initEndpointInputListeners();
            const fp = document.getElementById('openai-frequency-penalty');
            fp.value = '0.5';
            fp.dispatchEvent(new Event('input'));
            expect(state.modelParams.openai.frequency_penalty).toBe(0.5);
        });

        it('空值设为 null', () => {
            document.body.innerHTML = '<input id="openai-temperature" />';
            state.modelParams.openai.temperature = 0.5;
            initEndpointInputListeners();
            const tempInput = document.getElementById('openai-temperature');
            tempInput.value = '';
            tempInput.dispatchEvent(new Event('input'));
            expect(state.modelParams.openai.temperature).toBeNull();
        });

        it('非法数值被忽略', () => {
            document.body.innerHTML = '<input id="openai-temperature" />';
            state.modelParams.openai.temperature = 0.5;
            initEndpointInputListeners();
            const tempInput = document.getElementById('openai-temperature');
            tempInput.value = 'abc';
            tempInput.dispatchEvent(new Event('input'));
            expect(state.modelParams.openai.temperature).toBe(0.5);
        });
    });

    // ========== initThinkingControls ==========
    describe('initThinkingControls', () => {
        it('不抛错', () => {
            expect(() => initThinkingControls()).not.toThrow();
        });

        it('checkbox 初始化', () => {
            state.thinkingEnabled = true;
            document.body.innerHTML = `
                <input type="checkbox" id="thinking-enabled" />
                <div id="thinking-strength-group"></div>
                <div id="thinking-hint"></div>
            `;
            initThinkingControls();
            expect(document.getElementById('thinking-enabled').checked).toBe(true);
            expect(document.getElementById('thinking-strength-group').style.display).toBe('flex');
        });

        it('change 事件切换思维链', () => {
            document.body.innerHTML = `
                <input type="checkbox" id="thinking-enabled" />
                <div id="thinking-strength-group"></div>
                <div id="thinking-hint"></div>
            `;
            initThinkingControls();
            const cb = document.getElementById('thinking-enabled');
            cb.checked = true;
            cb.dispatchEvent(new Event('change'));
            expect(state.thinkingEnabled).toBe(true);
        });

        it('budget 输入有效范围', () => {
            state.thinkingEnabled = true;
            state.thinkingStrength = 'custom';
            document.body.innerHTML = `
                <input type="checkbox" id="thinking-enabled" checked />
                <div id="thinking-budget-group"></div>
                <input type="number" id="thinking-budget" value="8192" />
            `;
            initThinkingControls();
            const budgetInput = document.getElementById('thinking-budget');
            budgetInput.value = '2048';
            budgetInput.dispatchEvent(new Event('change'));
            expect(state.thinkingBudget).toBe(2048);
        });

        it('budget 无效值恢复原值', () => {
            state.thinkingBudget = 8192;
            document.body.innerHTML = '<input type="number" id="thinking-budget" value="8192" />';
            initThinkingControls();
            const budgetInput = document.getElementById('thinking-budget');
            budgetInput.value = '500';
            budgetInput.dispatchEvent(new Event('change'));
            expect(budgetInput.value).toBe('8192');
        });

        it('strength 按钮点击', () => {
            document.body.innerHTML = `
                <button class="strength-btn" data-strength="low"></button>
                <button class="strength-btn" data-strength="medium"></button>
                <button class="strength-btn" data-strength="high"></button>
            `;
            initThinkingControls();
            document.querySelector('[data-strength="high"]').click();
            expect(state.thinkingStrength).toBe('high');
        });

        it('claude effort 按钮点击', () => {
            state.claudeAdaptiveThinking = true;
            document.body.innerHTML = `
                <input type="checkbox" id="claude-adaptive-thinking" />
                <div id="claude-adaptive-row"></div>
                <div id="claude-effort-group"></div>
                <div id="claude-adaptive-hint"></div>
                <button class="strength-btn claude-effort-btn" data-effort="low"></button>
                <button class="strength-btn claude-effort-btn" data-effort="high"></button>
            `;
            initThinkingControls();
            document.querySelector('[data-effort="high"]').click();
            expect(state.claudeEffortLevel).toBe('high');
        });

        it('claude adaptive checkbox change', () => {
            document.body.innerHTML = `
                <input type="checkbox" id="claude-adaptive-thinking" />
                <div id="claude-adaptive-row"></div>
                <div id="claude-effort-group"></div>
            `;
            initThinkingControls();
            const cb = document.getElementById('claude-adaptive-thinking');
            cb.checked = true;
            cb.dispatchEvent(new Event('change'));
            expect(state.claudeAdaptiveThinking).toBe(true);
        });
    });

    // ========== initConfigManagement ==========
    describe('initConfigManagement', () => {
        it('不抛错', () => {
            expect(() => initConfigManagement()).not.toThrow();
        });

        it('configSelect 绑定 change', () => {
            const select = document.createElement('select');
            elements.configSelect = select;
            const spy = vi.spyOn(select, 'addEventListener');
            initConfigManagement();
            expect(spy).toHaveBeenCalledWith('change', expect.any(Function));
            spy.mockRestore();
        });

        it('saveConfig 绑定 click', () => {
            const btn = document.createElement('button');
            elements.saveConfig = btn;
            const spy = vi.spyOn(btn, 'addEventListener');
            initConfigManagement();
            expect(spy).toHaveBeenCalledWith('click', expect.any(Function));
            spy.mockRestore();
        });

        it('deleteConfig 绑定 click', () => {
            const btn = document.createElement('button');
            elements.deleteConfig = btn;
            const spy = vi.spyOn(btn, 'addEventListener');
            initConfigManagement();
            expect(spy).toHaveBeenCalledWith('click', expect.any(Function));
            spy.mockRestore();
        });

        it('elements 全 null 不抛错', () => {
            elements.configSelect = null;
            elements.saveConfig = null;
            elements.deleteConfig = null;
            expect(() => initConfigManagement()).not.toThrow();
        });
    });

    // ========== initOtherConfigInputs ==========
    describe('initOtherConfigInputs', () => {
        it('不抛错', () => {
            expect(() => initOtherConfigInputs()).not.toThrow();
        });

        it('stream-enabled change 更新', () => {
            document.body.innerHTML = '<input type="checkbox" id="stream-enabled" />';
            initOtherConfigInputs();
            const cb = document.getElementById('stream-enabled');
            cb.checked = true;
            cb.dispatchEvent(new Event('change'));
            expect(state.streamEnabled).toBe(true);
        });

        it('web-search-enabled change 更新', () => {
            document.body.innerHTML = '<input type="checkbox" id="web-search-enabled" />';
            initOtherConfigInputs();
            const cb = document.getElementById('web-search-enabled');
            cb.checked = true;
            cb.dispatchEvent(new Event('change'));
            expect(state.webSearchEnabled).toBe(true);
        });

        it('xml-tool-calling change 更新', () => {
            document.body.innerHTML = '<input type="checkbox" id="xml-tool-calling-enabled" />';
            initOtherConfigInputs();
            const cb = document.getElementById('xml-tool-calling-enabled');
            cb.checked = true;
            cb.dispatchEvent(new Event('change'));
            expect(state.xmlToolCallingEnabled).toBe(true);
        });

        it('imageSizeSelect change 更新', () => {
            const select = document.createElement('select');
            select.innerHTML =
                '<option value="">default</option><option value="medium">medium</option>';
            elements.imageSizeSelect = select;
            initOtherConfigInputs();
            select.value = 'medium';
            select.dispatchEvent(new Event('change'));
            expect(state.imageSize).toBe('medium');
        });

        it('geminiApiKeyInHeaderToggle change', () => {
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            elements.geminiApiKeyInHeaderToggle = cb;
            initOtherConfigInputs();
            cb.checked = true;
            cb.dispatchEvent(new Event('change'));
            expect(state.geminiApiKeyInHeader).toBe(true);
        });

        it('thinkingNoneMode checkbox', () => {
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            elements.thinkingNoneMode = cb;
            initOtherConfigInputs();
            cb.checked = true;
            cb.dispatchEvent(new Event('change'));
            expect(state.thinkingNoneMode).toBe(true);
        });

        it('verbosity 控件初始化和交互', () => {
            const vEnabled = document.createElement('input');
            vEnabled.type = 'checkbox';
            elements.verbosityEnabled = vEnabled;
            const vSelect = document.createElement('select');
            vSelect.innerHTML =
                '<option value="low">low</option><option value="medium">medium</option><option value="high">high</option>';
            elements.outputVerbosity = vSelect;
            const vGroup = document.createElement('div');
            vGroup.id = 'verbosity-select-group';
            document.body.appendChild(vGroup);

            initOtherConfigInputs();
            vEnabled.checked = true;
            vEnabled.dispatchEvent(new Event('change'));
            expect(state.verbosityEnabled).toBe(true);
            expect(vGroup.style.display).toBe('block');

            vSelect.value = 'high';
            vSelect.dispatchEvent(new Event('change'));
            expect(state.outputVerbosity).toBe('high');
        });

        it('replyCount change', () => {
            const select = document.createElement('select');
            select.innerHTML = '<option value="1">1</option>';
            select.value = '1';
            elements.replyCountSelect = select;
            initOtherConfigInputs();
            select.value = '1';
            select.dispatchEvent(new Event('change'));
            expect(state.replyCount).toBe(1);
        });

        it('tool:enabled:changed 事件注册', async () => {
            initOtherConfigInputs();
            const { eventBus } = await import('../../js/core/events.js');
            expect(eventBus.on).toHaveBeenCalledWith('tool:enabled:changed', expect.any(Function));
        });
    });
});
