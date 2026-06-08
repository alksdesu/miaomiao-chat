/**
 * 请求执行管线
 *
 * 统一编排三家提供商的横切关注点：消息过滤 → partsToAPIMessages → SystemContext →
 * Prefill → Tools → ModelParams → adapter.buildRequestBody → Endpoint/Headers/Query → fetch。
 *
 * 三家差异本质化下沉到 adapter（buildRequestBody / resolveEndpoint / buildHeaders 等），
 * pipeline 只负责顺序与共享数据装配。
 */

import { logger } from '../utils/logger.js';
import { state } from '../core/state.js';
import { processVariables } from '../utils/variables.js';
import { filterMessagesByCapabilities } from '../utils/message-filter.js';
import { getCurrentModelCapabilities } from './current.js';
import { getPrefillMessages, getOpeningMessages } from '../utils/prefill.js';
import {
    buildModelParams,
    buildThinkingConfig,
    buildVerbosityConfig,
    getCustomHeadersObject
} from './params.js';
import { buildDevToolsContext } from '../devtools/context-builder.js';
import { getToolsForAPI } from '../tools/manager.js';

/**
 * 构造 SystemContext：systemPrompt + monitor 上下文 + Gemini 多段 system parts
 * @returns {Promise<import('./adapters/format-adapter-types.js').SystemContext>}
 */
async function buildSystemContext() {
    const ctx = {
        systemPrompt: null,
        monitorContext: null,
        geminiSystemParts: null
    };

    if (state.systemPrompt) {
        ctx.systemPrompt = processVariables(state.systemPrompt);
    }

    if (state.monitorEnabled) {
        const devtoolsCtx = buildDevToolsContext();
        if (devtoolsCtx) {
            ctx.monitorContext = devtoolsCtx;
        }
    }

    // Gemini 多段 system parts（仅当开关启用且配置有内容时）
    if (
        state.geminiSystemPartsEnabled &&
        Array.isArray(state.geminiSystemParts) &&
        state.geminiSystemParts.length > 0
    ) {
        const parts = state.geminiSystemParts
            .filter((p) => p.text && p.text.trim())
            .map((p) => ({ text: processVariables(p.text) }));
        if (parts.length > 0) {
            ctx.geminiSystemParts = parts;
        }
    }

    return ctx;
}

/**
 * 构造 PrefillContext：opening + trailing
 * @param {string} apiFormat - adapter.apiFormat（决定 prefill 消息的目标 schema）
 * @returns {import('./adapters/format-adapter-types.js').PrefillContext|null}
 */
function collectPrefill(apiFormat) {
    if (!state.prefillEnabled) return null;
    return {
        opening: getOpeningMessages(apiFormat),
        trailing: getPrefillMessages(apiFormat)
    };
}

/**
 * 收集工具列表：adapter.collectBuiltinTools + getToolsForAPI + adapter.formatSystemTools
 */
async function collectTools(adapter) {
    const tools = [...adapter.collectBuiltinTools(state)];
    try {
        const systemTools = getToolsForAPI(adapter.apiFormat);
        tools.push(...adapter.formatSystemTools(systemTools));
    } catch (error) {
        logger.warn(`[${adapter.name}] 工具系统未加载:`, error);
    }
    return tools;
}

/**
 * 过滤错误消息 + capabilities 过滤（按 adapter.filterPosition 决定时机）
 *
 * - 'before'（Claude / Gemini）：在 partsToAPIMessages 之前过滤 state.messages（新格式 parts）
 * - 'after'（OpenAI）：在 partsToAPIMessages 之后过滤适配后的 OpenAI 格式数组
 *
 * filterMessagesByCapabilities 同时支持新格式 parts 和旧格式 content，
 * 两种过滤时机都安全；保留差异是为了 1:1 等价于原 send 函数行为。
 */
function filterAndConvertMessages(adapter) {
    const filtered = state.messages.filter((m) => !m.isError && !m.error);
    const capabilities = getCurrentModelCapabilities();

    if (adapter.filterPosition === 'before') {
        const beforeFiltered = capabilities
            ? filterMessagesByCapabilities(filtered, capabilities)
            : filtered;
        return adapter.partsToAPIMessages(beforeFiltered, {
            injectReasoning: adapter.apiFormat === 'openai-responses'
        });
    }

    // 'after' 路径（OpenAI Chat / Responses）：先转换再过滤
    let messages = adapter.partsToAPIMessages(filtered, {
        injectReasoning: adapter.apiFormat === 'openai-responses'
    });
    if (capabilities) {
        messages = filterMessagesByCapabilities(messages, capabilities);
        logger.debug(`[${adapter.name}] 消息已根据模型能力过滤:`, {
            capabilities,
            originalCount: filtered.length,
            filteredCount: messages.length
        });
    }
    return messages;
}

/**
 * 主入口：用 adapter 执行一次 API 请求
 *
 * @param {import('./adapters/format-adapter-types.js').FormatAdapter} adapter
 * @param {Object} ctx
 * @param {string} ctx.endpoint
 * @param {string} ctx.apiKey
 * @param {string} ctx.model
 * @param {AbortSignal|null} [ctx.signal]
 * @returns {Promise<Response>}
 */
export async function executeRequest(adapter, { endpoint, apiKey, model, signal = null }) {
    const messages = filterAndConvertMessages(adapter);
    const systemCtx = await buildSystemContext();
    const prefill = collectPrefill(adapter.apiFormat);
    const tools = await collectTools(adapter);

    const requestBody = await adapter.buildRequestBody({
        messages,
        model,
        modelParams: buildModelParams(adapter.apiFormat),
        thinkingCfg: buildThinkingConfig(adapter.apiFormat, model),
        verbosityCfg: buildVerbosityConfig(),
        systemCtx,
        prefill,
        tools,
        isXmlMode: state.xmlToolCallingEnabled,
        state,
        endpoint // Gemini Vertex vs AI Studio safetySettings 需要看 endpoint
    });

    const finalEndpoint = adapter.resolveEndpoint(endpoint, model, state.streamEnabled);
    const headers = {
        'Content-Type': 'application/json',
        ...adapter.buildHeaders(apiKey, { state, tools }),
        ...getCustomHeadersObject()
    };
    const queryString = adapter.buildQueryString(apiKey, { state });
    const fullUrl = queryString ? `${finalEndpoint}?${queryString}` : finalEndpoint;

    logger.debug(`[${adapter.name}] 发送请求:`, JSON.stringify(requestBody, null, 2));

    const options = {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody)
    };
    if (signal) options.signal = signal;

    return await fetch(fullUrl, options);
}
