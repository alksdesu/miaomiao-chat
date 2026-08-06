/**
 * 配置辅助功能模块
 * 处理格式端点输入、思维链配置、配置管理等
 */

import { state } from '../core/state.js';
import { elements } from '../core/elements.js';
import {
    saveCurrentConfig,
    syncUIWithState,
    saveSavedConfigs,
    applyConfigToState,
    buildConfigObject
} from '../state/config.js';
import { populateModelSelect } from './models.js';
import { getToolStats, setToolEnabled } from '../tools/manager.js';
import { eventBus } from '../core/events.js';
import { EVENTS } from '../core/events-registry.js';
import { syncQuickToggles } from './quick-toggles.js';
import { showNotification } from './notifications.js';
import { showInputDialog, showConfirmDialog } from '../utils/dialogs.js';
import { logger } from '../utils/logger.js';
import { validateOpenAIImageSize } from '../api/image-params.js';
import { getCurrentSessionMessagesSnapshot } from '../state/session-message-repository.js';

/**
 * 初始化格式端点输入监听
 */
export function initEndpointInputListeners() {
    const formats = ['openai', 'openai-image', 'gemini', 'claude'];

    formats.forEach((format) => {
        const endpointInput = document.getElementById(`${format}-endpoint`);
        const apikeyInput = document.getElementById(`${format}-apikey`);
        const customModelInput = document.getElementById(`${format}-custom-model`);

        if (endpointInput) {
            endpointInput.addEventListener('input', (e) => {
                state.endpoints[format] = e.target.value;
                saveCurrentConfig();
            });
        }

        if (apikeyInput) {
            apikeyInput.addEventListener('input', (e) => {
                state.apiKeys[format] = e.target.value;
                saveCurrentConfig();
            });
        }

        if (customModelInput) {
            customModelInput.addEventListener('input', (e) => {
                const customModel = e.target.value.trim();
                state.customModels[format] = customModel;

                // 新逻辑：直接刷新模型列表（从提供商聚合）
                if (format === state.apiFormat) {
                    try {
                        populateModelSelect();
                    } catch (err) {
                        logger.warn('Failed to refresh model list:', err);
                    }
                }

                saveCurrentConfig();
            });
        }
    });

    // 初始化模型参数监听
    initModelParamsListeners();
    initOpenAIImageParamsListeners();
}

function initOpenAIImageParamsListeners() {
    const params = state.modelParams['openai-image'];
    if (!params) return;
    const fields = {
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
    const numericFields = new Set(['output_compression', 'n', 'partial_images']);
    const numericRanges = {
        output_compression: [0, 100],
        n: [1, 10],
        partial_images: [0, 3]
    };

    const updateDependencies = () => {
        const customSizeGroup = document.getElementById('openai-image-custom-size-group');
        if (customSizeGroup) customSizeGroup.hidden = params.size !== 'custom';
        const compressionGroup = document.getElementById('openai-image-compression-group');
        if (compressionGroup) {
            compressionGroup.hidden =
                params.output_format !== 'jpeg' && params.output_format !== 'webp';
        }
    };

    Object.entries(fields).forEach(([id, key]) => {
        const input = document.getElementById(id);
        if (!input) return;
        input.addEventListener('change', (event) => {
            const rawValue = event.target.value.trim();
            const value = numericFields.has(key)
                ? rawValue === ''
                    ? null
                    : Number(rawValue)
                : rawValue || null;

            if (numericFields.has(key) && value !== null) {
                const [min, max] = numericRanges[key];
                if (!Number.isInteger(value) || value < min || value > max) {
                    showNotification(`请输入 ${min} 到 ${max} 的整数`, 'warning');
                    event.target.value = params[key] ?? '';
                    return;
                }
            }

            if (key === 'customSize' && value) {
                const error = validateOpenAIImageSize(value);
                if (error) {
                    showNotification(error, 'warning');
                    event.target.value = params.customSize || '';
                    return;
                }
            }

            params[key] = key === 'customSize' && value === null ? '' : value;
            updateDependencies();
            saveCurrentConfig();
        });
    });

    updateDependencies();
}

/**
 * 通用参数映射表（填一次，同步到所有格式）
 */
const UNIVERSAL_PARAMS = {
    temperature: {
        openai: 'temperature',
        gemini: 'temperature',
        claude: 'temperature'
    },
    max_tokens: {
        openai: 'max_tokens',
        gemini: 'maxOutputTokens',
        claude: 'max_tokens'
    },
    top_p: {
        openai: 'top_p',
        gemini: 'topP',
        claude: 'top_p'
    }
};

/**
 * 初始化模型参数监听
 */
function initModelParamsListeners() {
    const openaiParams = {
        'openai-temperature': 'temperature',
        'openai-max-tokens': 'max_tokens',
        'openai-top-p': 'top_p',
        'openai-frequency-penalty': 'frequency_penalty',
        'openai-presence-penalty': 'presence_penalty'
    };

    const geminiParams = {
        'gemini-temperature': 'temperature',
        'gemini-max-output-tokens': 'maxOutputTokens',
        'gemini-top-p': 'topP',
        'gemini-top-k': 'topK'
    };

    const claudeParams = {
        'claude-temperature': 'temperature',
        'claude-max-tokens': 'max_tokens',
        'claude-top-p': 'top_p',
        'claude-top-k': 'top_k'
    };

    // 初始化时同步通用参数值（确保所有格式一致）
    const wasSynced = syncUniversalParams();

    // 如果发生了同步（说明之前数据不一致），保存一次
    if (wasSynced) {
        saveCurrentConfig();
    }

    setupParamListeners('openai', openaiParams);
    setupParamListeners('gemini', geminiParams);
    setupParamListeners('claude', claudeParams);
}

/**
 * 同步通用参数值（取第一个非空值）
 * @returns {boolean} 是否发生了同步
 */
function syncUniversalParams() {
    let synced = false;

    Object.entries(UNIVERSAL_PARAMS).forEach(([paramName, mapping]) => {
        // 查找第一个非空值
        const value =
            state.modelParams.openai[mapping.openai] ??
            state.modelParams.gemini[mapping.gemini] ??
            state.modelParams.claude[mapping.claude];

        if (value !== null && value !== undefined) {
            // 检查是否需要同步
            const needsSync =
                state.modelParams.openai[mapping.openai] !== value ||
                state.modelParams.gemini[mapping.gemini] !== value ||
                state.modelParams.claude[mapping.claude] !== value;

            if (needsSync) {
                // 同步到所有格式
                state.modelParams.openai[mapping.openai] = value;
                state.modelParams.gemini[mapping.gemini] = value;
                state.modelParams.claude[mapping.claude] = value;
                synced = true;
                logger.debug(`[Config] 初始化时同步通用参数 ${paramName}: ${value}`);
            }
        }
    });

    return synced;
}

function setupParamListeners(format, paramsMap) {
    Object.entries(paramsMap).forEach(([inputId, paramKey]) => {
        const input = document.getElementById(inputId);
        if (input) {
            // 初始化值
            const currentValue = state.modelParams[format][paramKey];
            if (currentValue !== null && currentValue !== undefined) {
                input.value = currentValue;
            }

            input.addEventListener('input', (e) => {
                const value = e.target.value.trim();
                const numValue = value === '' ? null : parseFloat(value);

                if (value !== '' && isNaN(numValue)) {
                    return; // 非法数值，忽略
                }

                // 检查是否为通用参数（需要同步到所有格式）
                const universalParam = Object.keys(UNIVERSAL_PARAMS).find(
                    (key) => UNIVERSAL_PARAMS[key][format] === paramKey
                );

                if (universalParam) {
                    // 🔄 通用参数：同步更新所有格式
                    const mapping = UNIVERSAL_PARAMS[universalParam];
                    state.modelParams.openai[mapping.openai] = numValue;
                    state.modelParams.gemini[mapping.gemini] = numValue;
                    state.modelParams.claude[mapping.claude] = numValue;

                    logger.debug(
                        `[Config] 通用参数 ${universalParam} 已同步到所有格式: ${numValue}`
                    );
                } else {
                    // 📌 特殊参数：仅更新当前格式
                    state.modelParams[format][paramKey] = numValue;
                    logger.debug(`[Config] ${format} 特殊参数 ${paramKey} 已更新: ${numValue}`);
                }

                saveCurrentConfig();
            });
        }
    });
}

/**
 * 初始化思维链配置控件
 */
export function initThinkingControls() {
    const thinkingEnabled = document.getElementById('thinking-enabled');
    const thinkingStrengthGroup = document.getElementById('thinking-strength-group');
    const thinkingHint = document.getElementById('thinking-hint');
    const strengthBtns = document.querySelectorAll('.strength-btn');
    const budgetGroup = document.getElementById('thinking-budget-group');
    const budgetInput = document.getElementById('thinking-budget');

    function updateBudgetInputVisibility() {
        if (budgetGroup) {
            const showBudget = state.thinkingEnabled && state.thinkingStrength === 'custom';
            budgetGroup.style.display = showBudget ? 'flex' : 'none';
        }
    }

    if (thinkingEnabled) {
        thinkingEnabled.checked = state.thinkingEnabled;
        if (thinkingStrengthGroup) {
            thinkingStrengthGroup.style.display = state.thinkingEnabled ? 'flex' : 'none';
        }
        if (thinkingHint) {
            thinkingHint.style.display = state.thinkingEnabled ? 'block' : 'none';
        }
        updateBudgetInputVisibility();

        thinkingEnabled.addEventListener('change', (e) => {
            state.thinkingEnabled = !!e.target.checked;
            if (thinkingStrengthGroup) {
                thinkingStrengthGroup.style.display = e.target.checked ? 'flex' : 'none';
            }
            if (thinkingHint) {
                thinkingHint.style.display = e.target.checked ? 'block' : 'none';
            }
            updateBudgetInputVisibility();
            updateClaudeAdaptiveVisibility();
            syncQuickToggles();
            saveCurrentConfig();
        });
    }

    if (budgetInput) {
        budgetInput.value = state.thinkingBudget;
        budgetInput.addEventListener('change', (e) => {
            const value = parseInt(e.target.value, 10);
            if (value >= 1024 && value <= 131072) {
                state.thinkingBudget = value;
                saveCurrentConfig();
            } else {
                e.target.value = state.thinkingBudget;
                showNotification('Token 预算范围: 1024 - 131072', 'warning');
            }
        });
    }

    strengthBtns.forEach((btn) => {
        // 跳过 Claude effort 按钮（由下方单独处理）
        if (btn.classList.contains('claude-effort-btn')) return;

        if (btn.dataset.strength === state.thinkingStrength) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }

        btn.addEventListener('click', () => {
            state.thinkingStrength = btn.dataset.strength;
            strengthBtns.forEach((b) => {
                if (!b.classList.contains('claude-effort-btn')) {
                    b.classList.remove('active');
                }
            });
            btn.classList.add('active');
            updateBudgetInputVisibility();
            saveCurrentConfig();
        });
    });

    // Claude 4.6 Adaptive Thinking 控件
    const claudeAdaptiveCheckbox = document.getElementById('claude-adaptive-thinking');
    const claudeAdaptiveRow = document.getElementById('claude-adaptive-row');
    const claudeEffortGroup = document.getElementById('claude-effort-group');
    const claudeAdaptiveHint = document.getElementById('claude-adaptive-hint');
    const claudeEffortBtns = document.querySelectorAll('.claude-effort-btn');

    function updateClaudeAdaptiveVisibility() {
        // 思维链关闭时隐藏整个 adaptive 区域
        if (claudeAdaptiveRow) {
            claudeAdaptiveRow.style.display = state.thinkingEnabled ? 'flex' : 'none';
        }
        // effort 按钮和提示只在 adaptive 也开启时显示
        const showEffort = state.thinkingEnabled && state.claudeAdaptiveThinking;
        if (claudeEffortGroup) claudeEffortGroup.style.display = showEffort ? 'flex' : 'none';
        if (claudeAdaptiveHint) claudeAdaptiveHint.style.display = showEffort ? 'block' : 'none';
    }

    if (claudeAdaptiveCheckbox) {
        claudeAdaptiveCheckbox.checked = state.claudeAdaptiveThinking;
        updateClaudeAdaptiveVisibility();

        claudeAdaptiveCheckbox.addEventListener('change', (e) => {
            state.claudeAdaptiveThinking = !!e.target.checked;
            updateClaudeAdaptiveVisibility();
            saveCurrentConfig();
        });
    }

    claudeEffortBtns.forEach((btn) => {
        if (btn.dataset.effort === state.claudeEffortLevel) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }

        btn.addEventListener('click', () => {
            state.claudeEffortLevel = btn.dataset.effort;
            claudeEffortBtns.forEach((b) => b.classList.remove('active'));
            btn.classList.add('active');
            saveCurrentConfig();
        });
    });

    // 返回思考摘要开关
    const claudeShowThinkingCheckbox = document.getElementById('claude-show-thinking');
    if (claudeShowThinkingCheckbox) {
        claudeShowThinkingCheckbox.checked = state.claudeShowThinking;
        claudeShowThinkingCheckbox.addEventListener('change', (e) => {
            state.claudeShowThinking = !!e.target.checked;
            saveCurrentConfig();
        });
    }
}

/**
 * 处理配置选择
 */
function handleConfigSelect() {
    const index = elements.configSelect.value;
    if (index === '') return;

    const config = state.savedConfigs[parseInt(index)];
    if (!config) return;

    state.currentConfigName = config.name;
    applyConfigToState(config);

    saveCurrentConfig();
    syncUIWithState();

    eventBus.emit('models:fetch-requested', { forceRefresh: false });

    showNotification(`已切换到配置: ${config.name}`, 'info');
}

/**
 * 处理保存配置
 */
async function handleSaveConfig() {
    const name = await showInputDialog(
        '请输入配置名称:',
        state.currentConfigName || '新配置',
        '保存配置'
    );
    if (!name) return;

    // 复用统一的配置构建函数，避免字段遗漏
    const config = buildConfigObject();
    config.name = name;

    const existingIndex = state.savedConfigs.findIndex((c) => c.name === name);
    if (existingIndex >= 0) {
        state.savedConfigs[existingIndex] = config;
    } else {
        state.savedConfigs.push(config);
    }

    state.currentConfigName = name;
    saveCurrentConfig();
    await saveSavedConfigs(); // 保存配置列表到持久化存储
    updateConfigSelect();
    showNotification(`配置已保存: ${name}`, 'info');
}

/**
 * 处理删除配置
 */
async function handleDeleteConfig() {
    const index = elements.configSelect.value;
    if (index === '') {
        showNotification('请先选择要删除的配置', 'warning');
        return;
    }

    const config = state.savedConfigs[parseInt(index)];
    if (!config) return;

    const confirmed = await showConfirmDialog(`确定删除配置 "${config.name}" 吗？`, '确认删除');
    if (!confirmed) return;

    state.savedConfigs.splice(parseInt(index), 1);
    if (state.currentConfigName === config.name) {
        state.currentConfigName = '';
    }

    saveCurrentConfig();
    await saveSavedConfigs(); // 保存配置列表到持久化存储
    updateConfigSelect();
    showNotification(`已删除配置: ${config.name}`, 'info');
}

/**
 * 更新配置下拉框
 */
function updateConfigSelect() {
    if (!elements.configSelect) return;

    // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
    elements.configSelect.innerHTML = '<option value="">选择配置...</option>';
    state.savedConfigs.forEach((config, index) => {
        const option = document.createElement('option');
        option.value = index;
        option.textContent = config.name;
        if (config.name === state.currentConfigName) {
            option.selected = true;
        }
        elements.configSelect.appendChild(option);
    });
}

/**
 * 初始化配置管理
 */
export function initConfigManagement() {
    // 绑定配置选择
    elements.configSelect?.addEventListener('change', handleConfigSelect);
    elements.saveConfig?.addEventListener('click', handleSaveConfig);
    elements.deleteConfig?.addEventListener('click', handleDeleteConfig);

    // 初始化下拉框
    updateConfigSelect();

    logger.debug('Config management initialized');
}

/**
 * 初始化其他配置项
 */
export function initOtherConfigInputs() {
    const longChatRenderingMode = document.getElementById('long-chat-rendering-mode');
    if (longChatRenderingMode) {
        longChatRenderingMode.value = state.longChatRenderingMode || 'auto';
        longChatRenderingMode.addEventListener('change', (event) => {
            const mode = event.target.value;
            state.longChatRenderingMode = ['auto', 'compatibility', 'virtual'].includes(mode)
                ? mode
                : 'auto';
            saveCurrentConfig();
            eventBus.emit(EVENTS.LONG_CHAT_RENDERING_MODE_CHANGED, {
                mode: state.longChatRenderingMode
            });
        });
    }

    // Gemini 图片大小
    elements.imageSizeSelect?.addEventListener('change', (e) => {
        state.imageSize = e.target.value;
        saveCurrentConfig();
    });

    // Gemini API Key 传递方式
    elements.geminiApiKeyInHeaderToggle?.addEventListener('change', (e) => {
        state.geminiApiKeyInHeader = !!e.target.checked;
        saveCurrentConfig();
    });

    // 流式开关（设置面板）
    const streamEnabled = document.getElementById('stream-enabled');
    if (streamEnabled) {
        streamEnabled.checked = state.streamEnabled;
        streamEnabled.addEventListener('change', (e) => {
            state.streamEnabled = !!e.target.checked;
            syncQuickToggles();
            saveCurrentConfig();
        });
    }

    // 网络搜索开关（设置面板）
    const webSearchEnabled = document.getElementById('web-search-enabled');
    if (webSearchEnabled) {
        webSearchEnabled.checked = state.webSearchEnabled;
        webSearchEnabled.addEventListener('change', (e) => {
            state.webSearchEnabled = !!e.target.checked;
            syncQuickToggles();
            saveCurrentConfig();
        });
    }

    // XML 工具调用兜底
    const xmlToolCalling = document.getElementById('xml-tool-calling-enabled');
    if (xmlToolCalling) {
        xmlToolCalling.checked = state.xmlToolCallingEnabled || false;
        xmlToolCalling.addEventListener('change', async (e) => {
            const enabled = e.target.checked;
            state.xmlToolCallingEnabled = !!enabled;
            saveCurrentConfig();

            if (enabled) {
                logger.debug('[Config] XML 工具调用兜底已启用，将在 system prompt 中注入工具描述');
            }

            // 历史消息已有 tool_call part 时提示切换语义：
            // 历史消息保留各自原模式，toggle 仅决定后续新对话走哪条协议
            let history = state.messages || [];
            try {
                history = await getCurrentSessionMessagesSnapshot();
            } catch (error) {
                logger.warn('[Config] 历史工具调用检查失败:', error);
            }
            const hasHistoricalToolCall = history.some((m) =>
                Array.isArray(m?.parts) ? m.parts.some((p) => p?.type === 'tool_call') : false
            );
            if (hasHistoricalToolCall) {
                const msg = enabled
                    ? '已启用 XML 工具调用模式。历史 native 工具调用消息保留原模式，仅新对话生效'
                    : '已切换回原生工具调用模式。历史 XML 工具调用消息保留原模式，仅新对话生效';
                eventBus.emit('ui:notification', {
                    message: msg,
                    type: 'info',
                    duration: 5000
                });
            }
        });
    }

    // 多回复数量
    elements.replyCountSelect?.addEventListener('change', async (e) => {
        const newCount = parseInt(e.target.value, 10);

        // ⭐ 检测多回复与工具调用互斥
        if (newCount > 1) {
            try {
                const stats = getToolStats();

                if (stats.enabled > 0) {
                    // 有启用的工具，阻止设置多回复
                    // ui:notification 经 textContent 纯文本渲染，禁止拼接 getIcon 等 HTML 字符串
                    eventBus.emit('ui:notification', {
                        message: `多回复模式与工具调用功能互斥\n\n当前有 ${stats.enabled} 个工具已启用，请先禁用所有工具后再开启多回复模式。`,
                        type: 'error',
                        duration: 6000
                    });

                    // 恢复原值
                    e.target.value = state.replyCount;
                    return;
                }
            } catch (error) {
                logger.warn('[ConfigHelpers] 工具系统未加载:', error);
            }
        }

        state.replyCount = newCount;
        saveCurrentConfig();
    });

    // ⭐ 新增：思维链 None 模式
    if (elements.thinkingNoneMode) {
        elements.thinkingNoneMode.checked = state.thinkingNoneMode || false;
        elements.thinkingNoneMode.addEventListener('change', (e) => {
            state.thinkingNoneMode = !!e.target.checked;
            saveCurrentConfig();
        });
    }

    // ⭐ 新增：输出详细度开关和选择器
    const verbosityEnabled = elements.verbosityEnabled;
    const outputVerbosity = elements.outputVerbosity;
    const verbositySelectGroup = document.getElementById('verbosity-select-group');

    if (verbosityEnabled && outputVerbosity && verbositySelectGroup) {
        // 初始化状态
        verbosityEnabled.checked = state.verbosityEnabled || false;
        outputVerbosity.value = state.outputVerbosity || 'medium';
        verbositySelectGroup.style.display = state.verbosityEnabled ? 'block' : 'none';

        // 开关监听
        verbosityEnabled.addEventListener('change', (e) => {
            state.verbosityEnabled = !!e.target.checked;
            verbositySelectGroup.style.display = e.target.checked ? 'block' : 'none';
            saveCurrentConfig();
        });

        // 选择器监听
        outputVerbosity.addEventListener('change', (e) => {
            state.outputVerbosity = e.target.value;
            saveCurrentConfig();
        });
    }

    // ⭐ 监听工具启用/禁用事件，检测与多回复模式的互斥
    eventBus.on('tool:enabled:changed', ({ toolId, enabled }) => {
        if (enabled && state.replyCount > 1) {
            // 尝试启用工具时发现多回复模式已开启
            eventBus.emit('ui:notification', {
                message: `多回复模式与工具调用功能互斥\n\n当前多回复数量为 ${state.replyCount}，请先将其设为 1 后再启用工具。\n\n工具 "${toolId}" 已自动禁用。`,
                type: 'error',
                duration: 6000
            });

            // 自动禁用该工具
            try {
                setToolEnabled(toolId, false);
            } catch (err) {
                logger.error('[ConfigHelpers] 禁用工具失败:', err);
            }
        }
    });

    logger.debug('Other config inputs initialized');
}
