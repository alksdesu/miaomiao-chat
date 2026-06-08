/**
 * OpenClaw Adapter — WebSocket 协议特例。sendOpenClawRequest 在 openclaw.js 自走
 * WS 路径不经 partsToAPIMessages / buildRequestBody，本 adapter 仅暴露 streamParser
 * 与 parseResponse（借用 OpenAI Chat），其余字段保留空实现满足 FormatAdapter 契约。
 */

import { handleOpenClawStream } from '../../stream/parser-openclaw.js';
import { openaiChatAdapter } from './openai-chat-adapter.js';
import { ToolMode } from '../../messages/schema.js';

// handleOpenClawStream 只需 sessionId；reader 不存在（OpenClaw 走 WebSocket）。
// signal 透传到 handleOpenClawStream 让用户点停止时主动清理 eventBus listener + 取消 WS run
function streamParser(_reader, sessionId, sink = null, signal = null) {
    return handleOpenClawStream(sessionId, sink, signal);
}

/**
 * OpenClaw 网关返回 OpenAI 兼容格式，复用 OpenAI Chat parseResponse。
 * 但 OpenAI Chat 内部读 state.xmlToolCallingEnabled 全局快照决策 toolCall mode：
 * 若用户在其他 provider 启用过 XML 模式后切回 OpenClaw 未关闭 toggle，会返回
 * mode=XML 的 toolCalls 污染下游 — OpenClaw 协议不存在 XML 路径，强制覆盖 NATIVE。
 */
function parseResponse(data) {
    const reply = openaiChatAdapter.parseResponse(data);
    if (reply && Array.isArray(reply.toolCalls)) {
        for (const tc of reply.toolCalls) {
            tc.mode = ToolMode.NATIVE;
        }
    }
    return reply;
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
    buildRequestBody,
    resolveEndpoint,
    buildHeaders,
    buildQueryString
});
