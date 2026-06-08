/**
 * config-ui-sync.js 测试
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../js/core/state.js', () => ({
    state: {
        streamEnabled: true,
        pdfMode: 'standard',
        thinkingEnabled: false,
        thinkingStrength: 'medium',
        thinkingBudget: 8192,
        claudeAdaptiveThinking: false,
        claudeEffortLevel: 'medium',
        thinkingNoneMode: false,
        verbosityEnabled: false,
        outputVerbosity: 'medium',
        geminiSystemPartsEnabled: false,
        webSearchEnabled: false,
        xmlToolCallingEnabled: false,
        endpoints: { openai: 'https://api.openai.com', gemini: '', claude: '' },
        apiKeys: { openai: 'sk-test', gemini: '', claude: '' },
        customModels: { openai: 'gpt-4', gemini: '', claude: '' },
        modelParams: {
            openai: {
                temperature: 0.7,
                max_tokens: 4096,
                top_p: 1,
                frequency_penalty: 0,
                presence_penalty: 0
            },
            gemini: { temperature: 0.7, maxOutputTokens: 4096, topP: 1, topK: null },
            claude: { temperature: 0.7, max_tokens: 4096, top_p: 1, top_k: null }
        },
        prefillEnabled: false,
        systemPrompt: 'You are helpful.',
        charName: 'AI',
        userName: 'User',
        imageSize: 'small',
        geminiApiKeyInHeader: false,
        replyCount: 1,
        apiFormat: 'openai',
        fastImageCompression: false,
        codeExecutionEnabled: false,
        computerUseEnabled: false
    },
    elements: {
        imageSizeSelect: null,
        geminiApiKeyInHeaderToggle: null,
        replyCountSelect: null
    }
}));

vi.mock('../../js/core/events.js', () => ({
    eventBus: { emit: vi.fn(), on: vi.fn(), off: vi.fn() }
}));

vi.mock('../../js/utils/logger.js', () => ({
    logger: { warn: vi.fn(), debug: vi.fn(), error: vi.fn(), info: vi.fn() }
}));

import { state, elements } from '../../js/core/state.js';
import { eventBus } from '../../js/core/events.js';
import { syncUIWithState } from '../../js/state/config-ui-sync.js';

describe('config-ui-sync', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
        vi.clearAllMocks();
    });

    afterEach(() => {
        document.body.innerHTML = '';
    });

    describe('syncUIWithState', () => {
        it('不抛错', () => {
            expect(() => syncUIWithState()).not.toThrow();
        });

        it('同步 stream-enabled', () => {
            document.body.innerHTML = '<input type="checkbox" id="stream-enabled" />';
            state.streamEnabled = true;
            syncUIWithState();
            expect(document.getElementById('stream-enabled').checked).toBe(true);
        });

        it('同步 pdf-mode-select', () => {
            document.body.innerHTML =
                '<select id="pdf-mode-select"><option value="standard">std</option><option value="fast">fast</option></select>';
            state.pdfMode = 'fast';
            syncUIWithState();
            expect(document.getElementById('pdf-mode-select').value).toBe('fast');
        });

        it('同步 thinking-enabled', () => {
            document.body.innerHTML = `
                <input type="checkbox" id="thinking-enabled" />
                <div id="thinking-strength-group"></div>
                <div id="thinking-hint"></div>
                <div id="thinking-budget-group"></div>
                <input id="thinking-budget" />
            `;
            state.thinkingEnabled = true;
            state.thinkingStrength = 'custom';
            state.thinkingBudget = 16384;
            syncUIWithState();
            expect(document.getElementById('thinking-enabled').checked).toBe(true);
            expect(document.getElementById('thinking-strength-group').style.display).toBe('flex');
            expect(document.getElementById('thinking-hint').style.display).toBe('block');
            expect(document.getElementById('thinking-budget-group').style.display).toBe('flex');
            expect(document.getElementById('thinking-budget').value).toBe('16384');
        });

        it('thinking 关闭时隐藏 strength/hint/budget', () => {
            document.body.innerHTML = `
                <input type="checkbox" id="thinking-enabled" />
                <div id="thinking-strength-group"></div>
                <div id="thinking-hint"></div>
                <div id="thinking-budget-group"></div>
            `;
            state.thinkingEnabled = false;
            syncUIWithState();
            expect(document.getElementById('thinking-strength-group').style.display).toBe('none');
            expect(document.getElementById('thinking-hint').style.display).toBe('none');
            expect(document.getElementById('thinking-budget-group').style.display).toBe('none');
        });

        it('同步 strength 按钮 active', () => {
            document.body.innerHTML = `
                <button class="strength-btn" data-strength="low"></button>
                <button class="strength-btn" data-strength="medium"></button>
                <button class="strength-btn" data-strength="high"></button>
            `;
            state.thinkingStrength = 'high';
            syncUIWithState();
            const btns = document.querySelectorAll('.strength-btn');
            expect(btns[0].classList.contains('active')).toBe(false);
            expect(btns[1].classList.contains('active')).toBe(false);
            expect(btns[2].classList.contains('active')).toBe(true);
        });

        it('同步 claude adaptive thinking', () => {
            document.body.innerHTML = `
                <input type="checkbox" id="claude-adaptive-thinking" />
                <div id="claude-adaptive-row"></div>
                <button class="claude-effort-btn" data-effort="low"></button>
                <button class="claude-effort-btn" data-effort="high"></button>
            `;
            state.claudeAdaptiveThinking = true;
            state.thinkingEnabled = true;
            state.claudeEffortLevel = 'high';
            syncUIWithState();
            expect(document.getElementById('claude-adaptive-thinking').checked).toBe(true);
            expect(document.getElementById('claude-adaptive-row').style.display).toBe('flex');
            const effortBtns = document.querySelectorAll('.claude-effort-btn');
            expect(effortBtns[0].classList.contains('active')).toBe(false);
            expect(effortBtns[1].classList.contains('active')).toBe(true);
        });

        it('同步 thinking-none-mode', () => {
            document.body.innerHTML = '<input type="checkbox" id="thinking-none-mode" />';
            state.thinkingNoneMode = true;
            syncUIWithState();
            expect(document.getElementById('thinking-none-mode').checked).toBe(true);
        });

        it('同步 verbosity', () => {
            document.body.innerHTML = `
                <input type="checkbox" id="verbosity-enabled" />
                <select id="output-verbosity"><option value="low">low</option><option value="high">high</option></select>
            `;
            state.verbosityEnabled = true;
            state.outputVerbosity = 'high';
            syncUIWithState();
            expect(document.getElementById('verbosity-enabled').checked).toBe(true);
            expect(document.getElementById('output-verbosity').value).toBe('high');
        });

        it('同步 web-search-enabled', () => {
            document.body.innerHTML = '<input type="checkbox" id="web-search-enabled" />';
            state.webSearchEnabled = true;
            syncUIWithState();
            expect(document.getElementById('web-search-enabled').checked).toBe(true);
        });

        it('同步 xml-tool-calling-enabled', () => {
            document.body.innerHTML = '<input type="checkbox" id="xml-tool-calling-enabled" />';
            state.xmlToolCallingEnabled = true;
            syncUIWithState();
            expect(document.getElementById('xml-tool-calling-enabled').checked).toBe(true);
        });

        it('同步三格式端点', () => {
            document.body.innerHTML = `
                <input id="openai-endpoint" />
                <input id="openai-apikey" />
                <input id="openai-custom-model" />
            `;
            state.endpoints.openai = 'https://api.test.com';
            state.apiKeys.openai = 'sk-abc';
            state.customModels.openai = 'gpt-4o';
            syncUIWithState();
            expect(document.getElementById('openai-endpoint').value).toBe('https://api.test.com');
            expect(document.getElementById('openai-apikey').value).toBe('sk-abc');
            expect(document.getElementById('openai-custom-model').value).toBe('gpt-4o');
        });

        it('同步模型参数到 input', () => {
            document.body.innerHTML = `
                <input id="openai-temperature" />
                <input id="openai-max-tokens" />
                <input id="gemini-temperature" />
                <input id="claude-temperature" />
            `;
            state.modelParams.openai.temperature = 0.9;
            state.modelParams.openai.max_tokens = 2048;
            syncUIWithState();
            expect(document.getElementById('openai-temperature').value).toBe('0.9');
            expect(document.getElementById('openai-max-tokens').value).toBe('2048');
        });

        // prefill UI 同步已下沉到 prefill-modal.js，syncUIWithState 仅 emit 'config:sync-prefill-ui'
        // 由订阅方负责实际 DOM 更新（见下方 "发送同步事件" 用例）

        it('发送同步事件', () => {
            syncUIWithState();
            expect(eventBus.emit).toHaveBeenCalledWith('config:sync-custom-headers');
            expect(eventBus.emit).toHaveBeenCalledWith('config:sync-prefill-ui');
            expect(eventBus.emit).toHaveBeenCalledWith('config:sync-quick-toggles');
        });

        it('同步 format-btn active', () => {
            document.body.innerHTML = `
                <button class="format-btn" data-format="openai"></button>
                <button class="format-btn" data-format="gemini"></button>
                <button class="format-btn" data-format="claude"></button>
            `;
            state.apiFormat = 'gemini';
            syncUIWithState();
            const btns = document.querySelectorAll('.format-btn');
            expect(btns[0].classList.contains('active')).toBe(false);
            expect(btns[1].classList.contains('active')).toBe(true);
            expect(btns[2].classList.contains('active')).toBe(false);
        });

        it('同步 imageSizeSelect', () => {
            const select = document.createElement('select');
            select.innerHTML =
                '<option value="small">small</option><option value="large">large</option>';
            elements.imageSizeSelect = select;
            state.imageSize = 'large';
            syncUIWithState();
            expect(select.value).toBe('large');
        });

        it('同步 geminiApiKeyInHeaderToggle', () => {
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            elements.geminiApiKeyInHeaderToggle = cb;
            state.geminiApiKeyInHeader = true;
            syncUIWithState();
            expect(cb.checked).toBe(true);
        });

        it('同步 replyCountSelect', () => {
            const select = document.createElement('select');
            select.innerHTML = '<option value="1">1</option><option value="3">3</option>';
            elements.replyCountSelect = select;
            state.replyCount = 3;
            syncUIWithState();
            expect(select.value).toBe('3');
        });

        it('同步 fast-image-compression', () => {
            document.body.innerHTML = '<input type="checkbox" id="fast-image-compression" />';
            state.fastImageCompression = true;
            syncUIWithState();
            expect(document.getElementById('fast-image-compression').checked).toBe(true);
        });

        it('同步 code-execution-enabled', () => {
            document.body.innerHTML = '<input type="checkbox" id="code-execution-enabled" />';
            state.codeExecutionEnabled = true;
            syncUIWithState();
            expect(document.getElementById('code-execution-enabled').checked).toBe(true);
        });

        it('同步 computer-use-enabled', () => {
            document.body.innerHTML = '<input type="checkbox" id="computer-use-enabled" />';
            state.computerUseEnabled = true;
            syncUIWithState();
            expect(document.getElementById('computer-use-enabled').checked).toBe(true);
        });

        it('gemini-system-parts-enabled', () => {
            document.body.innerHTML = '<input type="checkbox" id="gemini-system-parts-enabled" />';
            state.geminiSystemPartsEnabled = true;
            syncUIWithState();
            expect(document.getElementById('gemini-system-parts-enabled').checked).toBe(true);
        });
    });
});
