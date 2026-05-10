/**
 * Claude API 请求处理器
 * 支持 Anthropic Claude Messages API
 */

import { logger } from '../utils/logger.js';
import { state } from '../core/state.js';
import { buildModelParams, buildThinkingConfig, getCustomHeadersObject } from './params.js';
import { getPrefillMessages, getOpeningMessages } from '../utils/prefill.js';
import { processVariables } from '../utils/variables.js';
import { filterMessagesByCapabilities } from '../utils/message-filter.js';
import { getCurrentModelCapabilities } from '../providers/manager.js';
import { toClaudeMessages } from '../messages/api-adapters.js';
import { isElectron } from '../utils/platform.js';

/**
 * 发送 Claude 格式的请求
 * @param {string} endpoint - API 端点
 * @param {string} apiKey - API 密钥
 * @param {string} model - 模型名称
 * @param {AbortSignal} signal - 取消信号
 * @returns {Promise<Response>} Fetch Response
 */
export async function sendClaudeRequest(endpoint, apiKey, model, signal = null) {
    // 转换消息格式为 Claude Messages API（新格式 → Claude API 格式）
    const filtered = state.messages.filter((m) => !m.isError && !m.error);

    // 根据模型能力过滤消息
    const capabilities = getCurrentModelCapabilities();
    let messagesToConvert = filtered;
    if (capabilities) {
        messagesToConvert = filterMessagesByCapabilities(filtered, capabilities);
        logger.debug('📋 [Claude] 消息已根据模型能力过滤:', {
            capabilities,
            filteredCount: messagesToConvert.length
        });
    }

    // 使用 api-adapters 将新格式转为 Claude API 格式
    let claudeMessages = toClaudeMessages(messagesToConvert);

    // 开场对话插入到对话历史之前（Claude 的 system 是独立参数，所以这里直接插入到最前面）
    if (state.prefillEnabled) {
        const opening = getOpeningMessages();
        if (opening.length > 0) {
            claudeMessages = [...opening, ...claudeMessages];
        }
    }

    // 预填充消息追加到末尾（用户最新消息之后）
    if (state.prefillEnabled) {
        const prefill = getPrefillMessages();
        claudeMessages = [...claudeMessages, ...prefill];
    }

    // 构建请求体
    const requestBody = {
        model: model,
        messages: claudeMessages,
        stream: state.streamEnabled,
        ...buildModelParams('claude') // 包含 max_tokens（默认 8192）及其他参数
    };

    // Claude 的 system 是顶层参数（独立于预填充开关）
    if (state.systemPrompt) {
        requestBody.system = processVariables(state.systemPrompt);
    }

    // AI DevTools Monitor 上下文注入
    if (state.monitorEnabled) {
        const { buildDevToolsContext } = await import('../devtools/context-builder.js');
        const devtoolsCtx = buildDevToolsContext();
        if (devtoolsCtx) {
            requestBody.system = (requestBody.system || '') + devtoolsCtx;
        }
    }

    // 添加思维链配置 (Claude Extended Thinking)
    const claudeThinkingConfig = buildThinkingConfig('claude');
    if (claudeThinkingConfig) Object.assign(requestBody, claudeThinkingConfig);

    // ⭐ 添加工具调用支持 (Tool Use)
    const tools = [];

    // 1. Code Execution 工具（需要同时添加工具定义 + beta header）
    if (state.codeExecutionEnabled) {
        tools.push({
            type: 'code_execution_20250825',
            name: 'code_execution'
        });
        logger.debug('[Claude] 📊 Code Execution 工具已启用');
    }

    // 2. Computer Use 原生工具（仅 Electron 环境且非 XML 模式）
    // ⭐ XML 模式下使用统一的自定义 computer 工具（来自 builtin/computer-use.js）
    if (state.computerUseEnabled && isElectron() && !state.xmlToolCallingEnabled) {
        // 根据模型选择 computer 工具版本（只有 computer 工具版本会变）
        // Opus 4.5 使用 20251124，其他模型使用 20250124
        const isOpus45 = model && model.toLowerCase().includes('opus-4-5');
        const computerVersion = isOpus45 ? '20251124' : '20250124';

        // 2.1 屏幕控制工具（版本根据模型变化）
        // 动态获取屏幕分辨率
        let displayWidth = 1920;
        let displayHeight = 1080;
        if (typeof window !== 'undefined' && window.screen) {
            displayWidth = window.screen.width;
            displayHeight = window.screen.height;
        }

        tools.push({
            type: `computer_${computerVersion}`,
            name: 'computer',
            display_width_px: displayWidth,
            display_height_px: displayHeight,
            display_number: 1
        });

        // 2.2 Bash 命令工具（固定版本 20250124）
        if (state.computerUsePermissions?.bash !== false) {
            tools.push({
                type: 'bash_20250124',
                name: 'bash'
            });
        }

        // 2.3 文本编辑器工具（固定版本 20250728）
        if (state.computerUsePermissions?.textEditor !== false) {
            tools.push({
                type: 'text_editor_20250728',
                name: 'str_replace_based_edit_tool'
            });
        }

        logger.debug(
            `[Claude] 💻 Computer Use 原生工具已添加（computer: ${computerVersion}, bash: 20250124, text_editor: 20250728）`
        );
    } else if (state.computerUseEnabled && isElectron() && state.xmlToolCallingEnabled) {
        logger.debug(
            `[Claude] 💻 XML 模式：将使用自定义 Computer Use 工具（来自 builtin/computer-use.js）`
        );
    }

    // 3. Web Search 工具（保持不变）
    if (state.webSearchEnabled) {
        tools.push({
            type: 'web_search_20250305',
            name: 'web_search',
            max_uses: 5
        });
    }

    // 4. 系统工具
    // getToolsForAPI 已经根据 xmlToolCallingEnabled 正确处理了 computer 工具
    // - 原生模式：自动过滤掉 computer 工具（使用 Claude 原生版本）
    // - XML 模式：自动保留 computer 工具（使用自定义版本）
    try {
        const { getToolsForAPI } = await import('../tools/manager.js');
        const systemTools = getToolsForAPI('claude');
        tools.push(...systemTools);

        if (state.xmlToolCallingEnabled) {
            logger.debug('[Claude] 📦 XML 模式：包含所有系统工具（含自定义 computer 工具）');
        }
    } catch (error) {
        logger.warn('[Claude] 工具系统未加载:', error);
    }

    if (tools.length > 0) {
        if (state.xmlToolCallingEnabled) {
            // XML 模式：只注入 XML 到 system 参数，不使用原生 tools 字段
            const { injectToolsToClaude, getXMLInjectionStats } =
                await import('../tools/tool-injection.js');
            injectToolsToClaude(requestBody, tools);

            // 性能监控
            const stats = getXMLInjectionStats(tools);
            logger.debug('[Claude] 📊 XML 模式启用，注入统计:', stats);
        } else {
            // 原生模式：使用标准 tools 字段
            requestBody.tools = tools;
            logger.debug('[Claude] 📊 原生 tools 模式，工具数量:', tools.length);
        }
    }

    logger.debug('Sending Claude request:', JSON.stringify(requestBody, null, 2));

    const options = {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'anthropic-dangerous-direct-browser-access': 'true',
            ...getCustomHeadersObject() // 合并自定义请求头
        },
        body: JSON.stringify(requestBody)
    };
    if (signal) options.signal = signal;

    // 智能合并 beta headers
    const betaFeaturesToAdd = [];

    // Code Execution beta
    if (state.codeExecutionEnabled) {
        betaFeaturesToAdd.push('code-execution-2025-08-25');
        betaFeaturesToAdd.push('advanced-tool-use-2025-11-20');
        // Code Execution 需要 Files API 支持（用于 container_upload）
        betaFeaturesToAdd.push('files-api-2025-04-14');
    }

    // Computer Use beta（仅 Electron 环境）
    if (state.computerUseEnabled && isElectron()) {
        // 根据模型选择 beta header
        const isOpus45 = model && model.toLowerCase().includes('opus-4-5');
        const betaHeader = isOpus45 ? 'computer-use-2025-11-24' : 'computer-use-2025-01-24';
        betaFeaturesToAdd.push(betaHeader);
    }

    // 合并 beta headers
    if (betaFeaturesToAdd.length > 0) {
        const existingBeta = options.headers['anthropic-beta'];
        let betaFeatures = [];

        if (existingBeta) {
            betaFeatures = existingBeta.split(',').map((s) => s.trim());
        }

        // 添加新的 beta 功能（去重）
        for (const feature of betaFeaturesToAdd) {
            if (!betaFeatures.includes(feature)) {
                betaFeatures.push(feature);
            }
        }

        options.headers['anthropic-beta'] = betaFeatures.join(',');
        logger.debug('[Claude] 📊 Beta headers:', betaFeatures.join(', '));
    }

    return await fetch(endpoint, options);
}
