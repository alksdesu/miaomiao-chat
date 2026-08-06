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
import { getCurrentModelCapabilities, getCurrentProvider, getModelDisplayName } from './current.js';
import { getPrefillMessages, getOpeningMessages } from '../utils/prefill.js';
import {
    buildModelParams,
    buildThinkingConfig,
    buildVerbosityConfig,
    getCustomHeadersObject
} from './params.js';
import { buildDevToolsContext } from '../devtools/context-builder.js';
import { getToolsForAPI } from '../tools/manager.js';
import { materializeSessionMessages } from '../state/session-message-repository.js';
import { resolveMessagesMediaForApi } from '../state/media-blob-store.js';
import { waitForProviderHistoryCleanup } from '../providers/provider-sync.js';
import { loadSessionMessages } from '../state/storage.js';

function cloneValue(value) {
    if (value === undefined) return undefined;
    try {
        return structuredClone(value);
    } catch {
        return value;
    }
}

export function captureRequestProfile(adapter, model) {
    let provider = null;
    let capabilities = null;
    let modelDisplayName = model || '';
    try {
        provider = getCurrentProvider();
        capabilities = getCurrentModelCapabilities();
        modelDisplayName = getModelDisplayName(model || '', provider);
    } catch (error) {
        logger.warn('[RequestProfile] 提供商快照读取失败，使用请求参数兜底:', error);
    }
    const stateSnapshot = {
        streamEnabled: !!state.streamEnabled,
        codeExecutionEnabled: !!state.codeExecutionEnabled,
        webSearchEnabled: !!state.webSearchEnabled,
        computerUseEnabled: !!state.computerUseEnabled,
        computerUsePermissions: cloneValue(state.computerUsePermissions),
        xmlToolCallingEnabled: !!state.xmlToolCallingEnabled,
        geminiApiKeyInHeader: !!state.geminiApiKeyInHeader,
        fastImageCompression: !!state.fastImageCompression,
        streamIdleTimeout: state.streamIdleTimeout,
        requestTimeout: state.requestTimeout
    };
    const systemCtx = buildSystemContext();
    const prefill =
        adapter.requestFeatures?.prefill === false ? null : collectPrefill(adapter.apiFormat);
    const tools =
        adapter.requestFeatures?.tools === false ? [] : collectTools(adapter, stateSnapshot);

    return {
        state: stateSnapshot,
        streamEnabled: stateSnapshot.streamEnabled,
        replyCount: Number.isInteger(state.replyCount) ? state.replyCount : 1,
        capabilities: cloneValue(capabilities),
        modelParams: cloneValue(buildModelParams(adapter.apiFormat)),
        thinkingCfg:
            adapter.requestFeatures?.thinking === false
                ? null
                : cloneValue(buildThinkingConfig(adapter.apiFormat, model)),
        verbosityCfg:
            adapter.requestFeatures?.verbosity === false
                ? null
                : cloneValue(buildVerbosityConfig()),
        customHeaders: cloneValue(getCustomHeadersObject()),
        systemCtx: cloneValue(systemCtx),
        prefill: cloneValue(prefill),
        tools: cloneValue(tools),
        isXmlMode: stateSnapshot.xmlToolCallingEnabled,
        providerId: provider?.id || null,
        providerName: provider?.name || 'Unknown',
        providerApiFormat: provider?.apiFormat || adapter.apiFormat,
        modelDisplayName,
        providerHistoryCleanup: waitForProviderHistoryCleanup()
    };
}

/**
 * 构造 SystemContext：systemPrompt + monitor 上下文 + Gemini 多段 system parts
 * @returns {Promise<import('./adapters/format-adapter-types.js').SystemContext>}
 */
function buildSystemContext() {
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
function collectTools(adapter, stateRef = state) {
    const tools = [...adapter.collectBuiltinTools(stateRef)];
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
async function filterAndConvertMessages(adapter, requestProfile, sessionId, sourceSnapshot) {
    await requestProfile.providerHistoryCleanup;
    let sourceMessages = sourceSnapshot;
    if (!Array.isArray(sourceMessages)) {
        const stored = await loadSessionMessages(sessionId);
        sourceMessages = stored?.messages || [];
    } else {
        sourceMessages = await materializeSessionMessages(sessionId, sourceMessages);
    }
    sourceMessages = await resolveMessagesMediaForApi(sourceMessages);
    const filtered = sourceMessages.filter((message) => !message.error);
    const capabilities = requestProfile.capabilities;

    if (adapter.filterPosition === 'before') {
        const beforeFiltered = capabilities
            ? filterMessagesByCapabilities(filtered, capabilities)
            : filtered;
        return adapter.partsToAPIMessages(beforeFiltered, {
            injectReasoning: adapter.apiFormat === 'openai-responses',
            isXmlMode: requestProfile.isXmlMode
        });
    }

    // 'after' 路径（OpenAI Chat / Responses）：先转换再过滤
    let messages = adapter.partsToAPIMessages(filtered, {
        injectReasoning: adapter.apiFormat === 'openai-responses',
        isXmlMode: requestProfile.isXmlMode
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
export async function executeRequest(
    adapter,
    {
        endpoint,
        apiKey,
        model,
        signal = null,
        sessionId = state.currentSessionId,
        sourceMessages = null,
        requestProfile = captureRequestProfile(adapter, model)
    }
) {
    const features = adapter.requestFeatures || {};
    const effectiveSourceMessages = Array.isArray(sourceMessages)
        ? sourceMessages
        : !sessionId || sessionId === state.currentSessionId
          ? state.messageStore?.toArray?.() || [...(state.messages || [])]
          : null;
    const messages = await filterAndConvertMessages(
        adapter,
        requestProfile,
        sessionId,
        effectiveSourceMessages
    );
    const systemCtx = features.system === false ? {} : requestProfile.systemCtx;
    const prefill = features.prefill === false ? null : requestProfile.prefill;
    const tools = features.tools === false ? [] : requestProfile.tools;

    const requestBody = await adapter.buildRequestBody({
        messages,
        model,
        modelParams: requestProfile.modelParams,
        thinkingCfg: features.thinking === false ? null : requestProfile.thinkingCfg,
        verbosityCfg: features.verbosity === false ? null : requestProfile.verbosityCfg,
        systemCtx,
        prefill,
        tools,
        isXmlMode: requestProfile.isXmlMode,
        state: requestProfile.state,
        endpoint // Gemini Vertex vs AI Studio safetySettings 需要看 endpoint
    });

    const finalEndpoint = adapter.resolveEndpoint(
        endpoint,
        model,
        requestProfile.streamEnabled,
        requestBody,
        { state: requestProfile.state, requestProfile }
    );
    const headers = {
        'Content-Type': 'application/json',
        ...adapter.buildHeaders(apiKey, { state: requestProfile.state, tools, requestProfile }),
        ...requestProfile.customHeaders
    };
    const queryString = adapter.buildQueryString(apiKey, {
        state: requestProfile.state,
        requestProfile
    });
    const fullUrl = queryString ? `${finalEndpoint}?${queryString}` : finalEndpoint;

    const logBody = adapter.sanitizeRequestForLogging
        ? adapter.sanitizeRequestForLogging(requestBody)
        : requestBody;
    logger.debug(`[${adapter.name}] 发送请求:`, JSON.stringify(logBody, null, 2));

    const options = {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody)
    };
    if (signal) options.signal = signal;

    return await fetch(fullUrl, options);
}
