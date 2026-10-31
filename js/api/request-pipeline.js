/**
 * 请求执行管线
 *
 * 统一编排三家提供商的横切关注点：消息过滤 → partsToAPIMessages → SystemContext →
 * Prefill → Tools → 生成参数 → adapter.buildRequestBody → Endpoint/Headers/Query → fetch。
 *
 * 三家差异本质化下沉到 adapter（buildGenerationParams / buildRequestBody / resolveEndpoint 等），
 * pipeline 只负责顺序与共享数据装配。
 */

import { logger } from '../utils/logger.js';
import { state } from '../core/state.js';
import { processVariables, templateNamesOf } from '../utils/variables.js';
import { filterMessagesByCapabilities } from '../utils/message-filter.js';
import { getCurrentModelCapabilities, getCurrentProvider, getModelDisplayName } from './current.js';
import { getPrefillMessages, getOpeningMessages } from '../utils/prefill.js';
import { captureGenerationSettings, getCustomHeadersObject } from './params.js';
import { resolveModelProfile } from './model-profiles.js';
import { emitRequestNotices } from './request-notices.js';
import { buildDevToolsContext } from '../devtools/context-builder.js';
import { getToolsForAPI } from '../tools/manager.js';
import { fetchScreenGeometry } from '../tools/computer-actions.js';
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

/**
 * 模型编辑里指定的"按哪个官方型号处理"，供代理改名的模型匹配能力表
 */
function findProfileAlias(provider, model) {
    const entry = provider?.models?.find(
        (item) => item && typeof item === 'object' && item.id === model
    );
    const alias = typeof entry?.profileAlias === 'string' ? entry.profileAlias.trim() : '';
    return alias || null;
}

// 部分型号要求客户端超时不低于指定值，用户设置更长时以用户为准
function applyMinTimeout(value, minTimeoutMs) {
    if (!minTimeoutMs) return value;
    return Number.isFinite(value) && value > minTimeoutMs ? value : minTimeoutMs;
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
    const profile = resolveModelProfile(adapter.apiFormat, model, {
        alias: findProfileAlias(provider, model)
    });
    const stateSnapshot = {
        streamEnabled: !!state.streamEnabled,
        codeExecutionEnabled: !!state.codeExecutionEnabled,
        webSearchEnabled: !!state.webSearchEnabled,
        computerUseEnabled: !!state.computerUseEnabled,
        computerUsePermissions: cloneValue(state.computerUsePermissions),
        xmlToolCallingEnabled: !!state.xmlToolCallingEnabled,
        fastImageCompression: !!state.fastImageCompression,
        streamIdleTimeout: applyMinTimeout(state.streamIdleTimeout, profile.minTimeoutMs),
        requestTimeout: applyMinTimeout(state.requestTimeout, profile.minTimeoutMs)
    };
    const systemCtx = buildSystemContext();
    const prefill =
        adapter.requestFeatures?.prefill === false ? null : collectPrefill(adapter.apiFormat);
    const toolNotices = [];
    const tools =
        adapter.requestFeatures?.tools === false
            ? []
            : collectTools(adapter, stateSnapshot, profile, toolNotices);
    const generation = adapter.buildGenerationParams(captureGenerationSettings(adapter.apiFormat), {
        model: model || '',
        profile,
        nativeTools: tools.length > 0 && !stateSnapshot.xmlToolCallingEnabled
    });

    return {
        state: stateSnapshot,
        streamEnabled: stateSnapshot.streamEnabled,
        replyCount: Number.isInteger(state.replyCount) ? state.replyCount : 1,
        capabilities: cloneValue(capabilities),
        profile,
        formatSettings: cloneValue(adapter.captureFormatSettings?.(state) ?? null),
        modelParams: cloneValue(generation.modelParams),
        thinkingCfg: cloneValue(generation.thinkingCfg),
        verbosityCfg: cloneValue(generation.verbosityCfg),
        notices: cloneValue([...toolNotices, ...(generation.notices || [])]),
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
 * 构造 SystemContext：systemPrompt + monitor 上下文
 * @returns {import('./adapters/format-adapter-types.js').SystemContext}
 */
function buildSystemContext() {
    const ctx = {
        systemPrompt: null,
        monitorContext: null
    };

    if (state.systemPrompt) {
        ctx.systemPrompt = processVariables(state.systemPrompt, templateNamesOf(state));
    }

    if (state.monitorEnabled) {
        const devtoolsCtx = buildDevToolsContext();
        if (devtoolsCtx) {
            ctx.monitorContext = devtoolsCtx;
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
function collectTools(adapter, stateRef, profile, notices) {
    const tools = [...adapter.collectBuiltinTools(stateRef, { profile, notices })];
    try {
        const systemTools = getToolsForAPI(adapter.apiFormat);
        tools.push(...adapter.formatSystemTools(systemTools));
    } catch (error) {
        logger.warn(`[${adapter.name}] 工具系统未加载:`, error);
    }
    return tools;
}

/**
 * 需要声明显示器尺寸的 computer 工具按回传截图的尺寸声明；同一任务的续作沿用首次取到的尺寸，
 * 工具定义前后一致
 * @returns {Promise<Object|null>} fetchScreenGeometry 的结果，取不到时为 null
 */
async function resolveComputerDisplay(requestProfile, tools) {
    const computerUse = requestProfile.profile?.computerUse;
    if (!computerUse?.declaresDisplay || !tools.some((tool) => tool?.type === computerUse.type)) {
        return null;
    }
    if (requestProfile.computerDisplay === undefined) {
        try {
            requestProfile.computerDisplay = await fetchScreenGeometry();
        } catch (error) {
            logger.warn(
                '[RequestPipeline] 获取截图尺寸失败，computer 工具按窗口所在屏幕声明:',
                error
            );
            requestProfile.computerDisplay = null;
        }
    }
    return requestProfile.computerDisplay;
}

/**
 * 过滤错误消息 + 按模型能力处理历史图片，再交给 adapter 转成 API 消息
 *
 * 能力过滤只认新格式 parts，必须发生在 partsToAPIMessages 之前
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
    const withoutErrors = sourceMessages.filter((message) => !message.error);
    const capabilities = requestProfile.capabilities;
    const filtered = capabilities
        ? filterMessagesByCapabilities(withoutErrors, capabilities)
        : withoutErrors;
    // XML 模式下工具写进提示词，请求里没有原生工具；历史调用按此决定能否原样回放
    const declaredTools =
        adapter.requestFeatures?.tools === false || requestProfile.isXmlMode
            ? []
            : requestProfile.tools;

    return adapter.partsToAPIMessages(filtered, {
        injectReasoning: adapter.apiFormat === 'openai-responses',
        isXmlMode: requestProfile.isXmlMode,
        profile: requestProfile.profile,
        declaredTools
    });
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
    const notices = [...(requestProfile.notices || [])];
    const computerDisplay = await resolveComputerDisplay(requestProfile, tools);

    const requestBody = await adapter.buildRequestBody({
        messages,
        model,
        modelParams: requestProfile.modelParams,
        thinkingCfg: requestProfile.thinkingCfg,
        verbosityCfg: requestProfile.verbosityCfg,
        systemCtx,
        prefill,
        tools,
        isXmlMode: requestProfile.isXmlMode,
        profile: requestProfile.profile,
        capabilities: requestProfile.capabilities,
        formatSettings: requestProfile.formatSettings,
        state: requestProfile.state,
        endpoint, // Gemini Vertex vs AI Studio safetySettings 需要看 endpoint
        computerDisplay,
        notices
    });
    emitRequestNotices(sessionId, notices);

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
