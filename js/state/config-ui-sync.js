/**
 * 配置 UI 同步
 * 将 state 值同步到 UI 元素
 */

import { state, elements } from '../core/state.js';
import { eventBus } from '../core/events.js';
import { logger } from '../utils/logger.js';

/**
 * 同步模型参数到UI输入框
 */
function syncModelParamsToUI() {
    // OpenAI 参数
    const openaiParams = {
        'openai-temperature': 'temperature',
        'openai-max-tokens': 'max_tokens',
        'openai-top-p': 'top_p',
        'openai-frequency-penalty': 'frequency_penalty',
        'openai-presence-penalty': 'presence_penalty'
    };

    // Gemini 参数
    const geminiParams = {
        'gemini-temperature': 'temperature',
        'gemini-max-output-tokens': 'maxOutputTokens',
        'gemini-top-p': 'topP',
        'gemini-top-k': 'topK'
    };

    // Claude 参数
    const claudeParams = {
        'claude-temperature': 'temperature',
        'claude-max-tokens': 'max_tokens',
        'claude-top-p': 'top_p',
        'claude-top-k': 'top_k'
    };

    syncParamsToInputs('openai', openaiParams);
    syncParamsToInputs('gemini', geminiParams);
    syncParamsToInputs('claude', claudeParams);
}

function syncParamsToInputs(format, paramsMap) {
    Object.entries(paramsMap).forEach(([inputId, paramKey]) => {
        const input = document.getElementById(inputId);
        if (input) {
            const value = state.modelParams[format][paramKey];
            input.value = value !== null && value !== undefined ? value : '';
        }
    });
}

/**
 * 将 state 同步到 UI 元素
 */
export function syncUIWithState() {
    // 流式开关
    const streamEnabled = document.getElementById('stream-enabled');
    if (streamEnabled) {
        streamEnabled.checked = state.streamEnabled;
    }

    // PDF 处理模式
    const pdfModeSelect = document.getElementById('pdf-mode-select');
    if (pdfModeSelect) {
        pdfModeSelect.value = state.pdfMode || 'standard';
    }

    // 思维链开关
    const thinkingEnabled = document.getElementById('thinking-enabled');
    const thinkingStrengthGroup = document.getElementById('thinking-strength-group');
    const thinkingHint = document.getElementById('thinking-hint');
    const budgetGroup = document.getElementById('thinking-budget-group');
    const budgetInput = document.getElementById('thinking-budget');
    if (thinkingEnabled) {
        thinkingEnabled.checked = state.thinkingEnabled;
        if (thinkingStrengthGroup) {
            thinkingStrengthGroup.style.display = state.thinkingEnabled ? 'flex' : 'none';
        }
        if (thinkingHint) {
            thinkingHint.style.display = state.thinkingEnabled ? 'block' : 'none';
        }
        // 更新自定义 budget 输入框显示状态和值
        if (budgetGroup) {
            const showBudget = state.thinkingEnabled && state.thinkingStrength === 'custom';
            budgetGroup.style.display = showBudget ? 'flex' : 'none';
        }
        if (budgetInput) {
            budgetInput.value = state.thinkingBudget;
        }
    }

    // 思维链强度按钮（排除 Claude effort 按钮）
    const strengthBtns = document.querySelectorAll('.strength-btn:not(.claude-effort-btn)');
    strengthBtns.forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.strength === state.thinkingStrength);
    });

    // Claude Adaptive Thinking
    const claudeAdaptiveCheckbox = document.getElementById('claude-adaptive-thinking');
    if (claudeAdaptiveCheckbox) claudeAdaptiveCheckbox.checked = state.claudeAdaptiveThinking;
    const claudeAdaptiveRow = document.getElementById('claude-adaptive-row');
    if (claudeAdaptiveRow)
        claudeAdaptiveRow.style.display = state.thinkingEnabled ? 'flex' : 'none';
    const claudeEffortBtns = document.querySelectorAll('.claude-effort-btn');
    claudeEffortBtns.forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.effort === state.claudeEffortLevel);
    });
    const claudeShowThinkingCheckbox = document.getElementById('claude-show-thinking');
    if (claudeShowThinkingCheckbox) claudeShowThinkingCheckbox.checked = state.claudeShowThinking;

    // Thinking None Mode
    const thinkingNoneCheckbox = document.getElementById('thinking-none-mode');
    if (thinkingNoneCheckbox) thinkingNoneCheckbox.checked = state.thinkingNoneMode;

    // 输出详细度
    const verbosityCheckbox = document.getElementById('verbosity-enabled');
    if (verbosityCheckbox) verbosityCheckbox.checked = state.verbosityEnabled;
    const verbositySelect = document.getElementById('output-verbosity');
    if (verbositySelect) verbositySelect.value = state.outputVerbosity;

    // Gemini System Parts
    const geminiPartsCheckbox = document.getElementById('gemini-system-parts-enabled');
    if (geminiPartsCheckbox) geminiPartsCheckbox.checked = state.geminiSystemPartsEnabled;

    // 网络搜索开关
    const webSearchEnabled = document.getElementById('web-search-enabled');
    if (webSearchEnabled) {
        webSearchEnabled.checked = state.webSearchEnabled;
    }

    // XML 工具调用兜底
    const xmlToolCalling = document.getElementById('xml-tool-calling-enabled');
    if (xmlToolCalling) {
        xmlToolCalling.checked = state.xmlToolCallingEnabled;
    }

    // 三格式端点输入框和自定义模型
    ['openai', 'gemini', 'claude'].forEach((format) => {
        const endpointInput = document.getElementById(`${format}-endpoint`);
        const apikeyInput = document.getElementById(`${format}-apikey`);
        const customModelInput = document.getElementById(`${format}-custom-model`);

        // 使用 !== undefined 确保空字符串也能正确设置
        if (endpointInput && state.endpoints[format] !== undefined) {
            endpointInput.value = state.endpoints[format];
        }
        if (apikeyInput && state.apiKeys[format] !== undefined) {
            apikeyInput.value = state.apiKeys[format];
        }
        if (customModelInput && state.customModels[format] !== undefined) {
            customModelInput.value = state.customModels[format];
        }
    });

    // 同步模型参数到 UI
    syncModelParamsToUI();

    // 自定义请求头 - 通过事件通知 UI 渲染
    eventBus.emit('config:sync-custom-headers');

    // 预填充相关 UI - 通过事件通知渲染
    eventBus.emit('config:sync-prefill-ui');

    // 快捷开关 - 通过事件通知同步
    eventBus.emit('config:sync-quick-toggles');

    // 图片尺寸选择
    if (elements.imageSizeSelect && state.imageSize) {
        elements.imageSizeSelect.value = state.imageSize;
    }

    // Gemini API key 传递方式
    if (elements.geminiApiKeyInHeaderToggle) {
        elements.geminiApiKeyInHeaderToggle.checked = state.geminiApiKeyInHeader || false;
    }

    // 多回复数量
    if (elements.replyCountSelect && state.replyCount) {
        elements.replyCountSelect.value = state.replyCount;
    }

    // API 格式标签高亮
    document.querySelectorAll('.format-btn').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.format === state.apiFormat);
    });

    // 图片压缩模式
    const fastImageCompression = document.getElementById('fast-image-compression');
    if (fastImageCompression) fastImageCompression.checked = state.fastImageCompression || false;

    // Code Execution
    const codeExecutionEnabled = document.getElementById('code-execution-enabled');
    if (codeExecutionEnabled) codeExecutionEnabled.checked = state.codeExecutionEnabled || false;

    // Computer Use
    const computerUseEnabled = document.getElementById('computer-use-enabled');
    if (computerUseEnabled) computerUseEnabled.checked = state.computerUseEnabled || false;

    logger.debug('UI synced with state');
}
