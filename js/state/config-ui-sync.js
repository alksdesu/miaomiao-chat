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

    const openaiImageParams = {
        'openai-image-size': 'size',
        'openai-image-custom-size': 'customSize',
        'openai-image-quality': 'quality',
        'openai-image-output-format': 'output_format',
        'openai-image-output-compression': 'output_compression',
        'openai-image-background': 'background',
        'openai-image-moderation': 'moderation',
        'openai-image-input-fidelity': 'input_fidelity',
        'openai-image-count': 'n',
        'openai-image-partial-images': 'partial_images'
    };

    syncParamsToInputs('openai', openaiParams);
    syncParamsToInputs('gemini', geminiParams);
    syncParamsToInputs('claude', claudeParams);
    syncParamsToInputs('openai-image', openaiImageParams);
    syncOpenAIImageParamControls();
}

/**
 * 生图参数控件联动：自定义尺寸与压缩率按需显示；选了透明背景时 JPEG 不可选
 */
export function syncOpenAIImageParamControls() {
    const imageParams = state.modelParams?.['openai-image'];
    const sizeGroup = document.getElementById('openai-image-custom-size-group');
    if (sizeGroup) sizeGroup.hidden = imageParams?.size !== 'custom';
    const compressionGroup = document.getElementById('openai-image-compression-group');
    if (compressionGroup) {
        const format = imageParams?.output_format;
        compressionGroup.hidden = format !== 'jpeg' && format !== 'webp';
    }
    const jpegOption = document.querySelector('#openai-image-output-format option[value="jpeg"]');
    if (jpegOption) {
        const transparent = imageParams?.background === 'transparent';
        jpegOption.disabled = transparent;
        jpegOption.title = transparent ? '透明背景仅支持 PNG 或 WebP' : '';
    }
}

function syncParamsToInputs(format, paramsMap) {
    if (!state.modelParams[format]) return;
    Object.entries(paramsMap).forEach(([inputId, paramKey]) => {
        const input = document.getElementById(inputId);
        if (input) {
            const value = state.modelParams[format][paramKey];
            input.value = value !== null && value !== undefined ? value : '';
        }
    });
}

// Responses 与 OpenClaw 的生成参数取自 modelParams.openai（captureGenerationSettings 回退），共用 OpenAI 参数面板
const PARAM_PANEL_FORMAT = { 'openai-responses': 'openai', openclaw: 'openai' };
// 只有 Chat Completions 发送惩罚项，Responses 与 OpenClaw 的 buildGenerationParams 都不带
const PENALTY_PARAM_FORMATS = new Set(['openai']);
const PENALTY_PARAM_INPUT_IDS = ['openai-frequency-penalty', 'openai-presence-penalty'];

/**
 * 按 API 格式切换参数面板与格式相关的设置项（格式切换、模型切换、加载配置共用）
 * @param {string} format - 当前 API 格式
 */
export function syncFormatConfigPanels(format) {
    const panelFormat = PARAM_PANEL_FORMAT[format] || format;
    document.querySelectorAll('.api-config').forEach((panel) => {
        panel.style.display = panel.id === `${panelFormat}-config` ? 'block' : 'none';
    });
    PENALTY_PARAM_INPUT_IDS.forEach((inputId) => {
        const item = document.getElementById(inputId)?.closest('.param-item');
        if (item) item.style.display = PENALTY_PARAM_FORMATS.has(format) ? '' : 'none';
    });
    const replyCountGroup = document.getElementById('reply-count-settings-group');
    if (replyCountGroup) replyCountGroup.hidden = format === 'openai-image';
}

function setElementDisplay(id, visible, display) {
    const element = document.getElementById(id);
    if (element) element.style.display = visible ? display : 'none';
}

/**
 * 思维链强度、Claude effort 与输出详细度控件的显隐只由开关状态决定，
 * 设置面板、快捷开关、切换配置等所有改动这些开关的入口都走这里
 */
export function syncReasoningControlVisibility() {
    const showEffort = state.thinkingEnabled && state.claudeAdaptiveThinking;
    setElementDisplay('thinking-strength-group', state.thinkingEnabled, 'flex');
    setElementDisplay('thinking-hint', state.thinkingEnabled, 'block');
    setElementDisplay(
        'thinking-budget-group',
        state.thinkingEnabled && state.thinkingStrength === 'custom',
        'flex'
    );
    setElementDisplay('claude-adaptive-row', state.thinkingEnabled, 'flex');
    setElementDisplay('claude-effort-group', showEffort, 'flex');
    setElementDisplay('claude-adaptive-hint', showEffort, 'block');
    setElementDisplay('verbosity-select-group', state.verbosityEnabled, 'block');
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
    const budgetInput = document.getElementById('thinking-budget');
    if (thinkingEnabled) {
        thinkingEnabled.checked = state.thinkingEnabled;
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

    // 切换配置会同时改动思维链、adaptive、详细度开关，控件显隐跟着重算
    syncReasoningControlVisibility();

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

    // 格式端点输入框和自定义模型
    ['openai', 'openai-image', 'gemini', 'claude'].forEach((format) => {
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

    // 出图尺寸与宽高比：空值表示按模型默认，也要同步，否则切换配置后下拉框停在旧值
    if (elements.imageSizeSelect) {
        elements.imageSizeSelect.value = state.imageSize || '';
    }
    if (elements.imageAspectSelect) {
        elements.imageAspectSelect.value = state.imageAspectRatio || '';
    }

    // Gemini API key 传递方式
    if (elements.geminiApiKeyInHeaderToggle) {
        elements.geminiApiKeyInHeaderToggle.checked = state.geminiApiKeyInHeader || false;
    }

    // 多回复数量
    if (elements.replyCountSelect && state.replyCount) {
        elements.replyCountSelect.value = state.replyCount;
    }
    syncFormatConfigPanels(state.apiFormat);

    // API 格式标签高亮
    document.querySelectorAll('.format-btn').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.format === state.apiFormat);
    });

    // 图片压缩模式
    const fastImageCompression = document.getElementById('fast-image-compression');
    if (fastImageCompression) fastImageCompression.checked = state.fastImageCompression || false;

    const longChatRenderingMode = document.getElementById('long-chat-rendering-mode');
    if (longChatRenderingMode) {
        longChatRenderingMode.value = state.longChatRenderingMode || 'auto';
    }

    // Code Execution
    const codeExecutionEnabled = document.getElementById('code-execution-enabled');
    if (codeExecutionEnabled) codeExecutionEnabled.checked = state.codeExecutionEnabled || false;

    // Computer Use
    const computerUseEnabled = document.getElementById('computer-use-enabled');
    if (computerUseEnabled) computerUseEnabled.checked = state.computerUseEnabled || false;

    logger.debug('UI synced with state');
}
