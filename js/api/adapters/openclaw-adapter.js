/**
 * OpenClaw Adapter — WebSocket 协议特例。sendOpenClawRequest 在 openclaw.js 自走
 * WS 路径不经 partsToAPIMessages / buildRequestBody，本 adapter 暴露 streamParser、
 * parseResponse（借用 OpenAI Chat）与 buildGenerationParams，其余字段保留空实现满足 FormatAdapter 契约。
 */

import { handleOpenClawStream } from '../../stream/parser-openclaw.js';
import { openaiChatAdapter } from './openai-chat-adapter.js';
import { buildOpenAISamplingParams } from './openai-shared.js';

// handleOpenClawStream 只需 sessionId；reader 不存在（OpenClaw 走 WebSocket）。
// signal 透传到 handleOpenClawStream 让用户点停止时主动清理 eventBus listener + 取消 WS run
function streamParser(_reader, sessionId, sink = null, signal = null) {
    return handleOpenClawStream(sessionId, sink, signal);
}

/**
 * OpenClaw 网关返回 OpenAI 兼容格式，复用 OpenAI Chat parseResponse。
 * 协议只转发最后一条用户文本，不存在 XML 工具路径，XML 开关一律不参与解析
 */
function parseResponse(data) {
    return openaiChatAdapter.parseResponse(data, { isXmlMode: false });
}

/**
 * openclaw.js 把 modelParams / thinkingCfg 合并进 chat.send 参数，由网关转交底层模型
 * @param {import('../params.js').GenerationSettings} settings
 * @returns {import('./format-adapter-types.js').GenerationParams}
 */
function buildGenerationParams(settings) {
    const { reasoning } = settings;
    return {
        modelParams: buildOpenAISamplingParams(settings.userParams, { penalties: false }),
        thinkingCfg: reasoning.enabled
            ? { thinking: { budget_tokens: reasoning.budget || 8192 } }
            : null,
        verbosityCfg: null
    };
}

// 以下方法 OpenClaw 协议不使用（WebSocket 路径走 openclaw.js sendOpenClawRequest）
// 保留空实现以满足 FormatAdapter 接口契约
function partsToAPIMessages(_msgs, _opts) {
    return [];
}
function collectBuiltinTools(_state) {
    return [];
}
function formatSystemTools(systemTools) {
    return systemTools;
}
function buildRequestBody(_ctx) {
    return {};
}
function resolveEndpoint(baseEndpoint, _model, _isStreaming) {
    return baseEndpoint;
}
function buildHeaders(_apiKey, _ctx) {
    return {};
}
function buildQueryString(_apiKey, _ctx) {
    return '';
}

export const openclawAdapter = Object.freeze({
    name: 'OpenClaw',
    apiFormat: 'openclaw',
    filterPosition: 'after',
    // OpenClaw 中转 Claude 协议响应，签名按 Claude 处理
    signatureFormat: 'claude',
    // OpenClaw 走 WebSocket 单连接 + agent.event 全局 eventBus 派发，
    // 并行 N 个流会共享同一组事件监听器导致互相覆盖；handler 入口拦截退化为单流
    supportsMultiStream: false,

    parserClass: null, // OpenClaw 不走 BaseStreamParser 路径
    streamParser,

    partsToAPIMessages,
    parseResponse,

    collectBuiltinTools,
    formatSystemTools,
    buildGenerationParams,
    buildRequestBody,
    resolveEndpoint,
    buildHeaders,
    buildQueryString
});
