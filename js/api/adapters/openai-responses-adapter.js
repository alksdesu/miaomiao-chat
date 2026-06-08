/**
 * OpenAI Responses API Adapter — Responses 路径差异化逻辑（input 字段 + reasoning
 * items + /responses 端点）。partsToAPIMessages 按 _turn 还原 reasoning → function_call
 * → output 顺序，buildRequestBody 始终注入 include reasoning.encrypted_content。
 */

import { logger } from '../../utils/logger.js';
import { state } from '../../core/state.js';
import { PartType, MediaKind, Role, ToolMode, ToolState } from '../../messages/schema.js';
import { parseDataURL } from '../../utils/file-helpers.js';
import { extractXMLToolCalls, appendXmlToolResultsForMessage } from '../../tools/xml-formatter.js';
import { isVideoUrl } from '../../utils/media.js';
import { injectToolsToOpenAI, getXMLInjectionStats } from '../../tools/tool-injection.js';
import { OpenAIStreamParser, parseOpenAIStream } from '../../stream/parser-openai.js';

import {
    isTextFile,
    hasNonEmptyContent,
    buildResponsesReasoningItems,
    getReasoningItemTurn,
    stripInternalReasoningFields,
    getPartTurn,
    getSortedToolCallTurns,
    pushResponsesFunctionCallPair,
    buildOpenAIAuthHeaders,
    collectOpenAIBuiltinTools
} from './openai-shared.js';
import { getMappedId, ensureIdMap } from '../format-converter.js';

// ========== partsToAPIMessages ==========

/**
 * 新格式 → OpenAI Responses API items 数组
 *
 * Responses API 对 reasoning 模型校验严格：每轮 function_call 必须带回原始 reasoning item。
 * continuation 后 _turn 标记还原 turn 边界，按序输出 reasoning → function_call → function_call_output。
 */
function partsToAPIMessages(msgs, opts = {}) {
    const out = [];
    const injectReasoning = opts.injectReasoning !== false; // 默认开启

    for (const msg of msgs) {
        if (msg.error || msg.isError) continue;

        const role = msg.role;

        const contentItems = [];
        const toolCalls = [];
        let hasToolCalls = false;

        // 旧数据未补齐 idMap 时 getMappedId 每次返回新临时 id：同一 part 在 toolCalls 数组
        // (L96) 和 pushResponsesFunctionCallPair (L155 → openai-shared.js call_id 兜底分支)
        // 会拿到不同 id，function_call 与 function_call_output 配对错位触发 Responses API 400。
        // 入口主动 ensureIdMap 持久化三槽，保证后续 getMappedId 都命中同一槽
        for (const p of msg.parts || []) {
            if (p.type === PartType.TOOL_CALL) ensureIdMap(p);
        }

        for (const p of msg.parts || []) {
            switch (p.type) {
                case PartType.TEXT:
                    contentItems.push({ type: 'text', text: p.text });
                    break;
                case PartType.MEDIA:
                    if (p.media === MediaKind.IMAGE) {
                        contentItems.push({ type: 'image_url', image_url: { url: p.url } });
                    } else if (p.media === MediaKind.VIDEO) {
                        contentItems.push({
                            type: 'video_url',
                            video_url: { url: p.url, mime_type: p.mime }
                        });
                    } else if (p.media === MediaKind.AUDIO) {
                        const audioParsed = parseDataURL(p.url);
                        if (audioParsed) {
                            const fmt = (audioParsed.mimeType || '').split('/').pop() || 'wav';
                            contentItems.push({
                                type: 'input_audio',
                                input_audio: { data: audioParsed.base64, format: fmt }
                            });
                        }
                    }
                    break;
                case PartType.FILE: {
                    if (isTextFile(p)) {
                        contentItems.push({
                            type: 'text',
                            text: `<document name="${p.name}">\n${p.url}\n</document>`
                        });
                    } else {
                        contentItems.push({
                            type: 'file',
                            file: { filename: p.name, file_data: p.url }
                        });
                    }
                    break;
                }
                case PartType.TOOL_CALL:
                    if (p.mode === ToolMode.XML) break;
                    if (p.state === ToolState.SKIPPED) break; // 多回复 BufferedSink 拦截不下发
                    hasToolCalls = true;
                    // 此 toolCalls 仅供 hasToolCalls 路径分支判定，id 不进 out（实际写入由 pushResponsesFunctionCallPair）
                    // 仍走 getMappedId 保持代码一致性，方便后续扩展直接读 toolCalls 数组
                    toolCalls.push({
                        id: getMappedId(p, 'openai'),
                        type: 'function',
                        function: {
                            name: p.name,
                            arguments:
                                typeof p.args === 'string' ? p.args : JSON.stringify(p.args || {})
                        }
                    });
                    break;
            }
        }

        let content;
        if (contentItems.length === 0) {
            content = '';
        } else if (contentItems.length === 1 && contentItems[0].type === 'text') {
            content = contentItems[0].text;
        } else {
            content = contentItems;
        }

        // Responses API：在 assistant 输出项前注入 reasoning item。
        // 必须带 summary 字段，否则接口会报 input[n].summary 缺失。
        const reasoningItems =
            injectReasoning && role === 'assistant' ? buildResponsesReasoningItems(msg) : [];

        if (!hasToolCalls) {
            out.push(...reasoningItems.map(stripInternalReasoningFields));
            out.push({ role, content });
            if (msg.role === Role.ASSISTANT) {
                appendXmlToolResultsForMessage(out, msg);
            }
            continue;
        }

        // Responses API 对 reasoning 模型的工具调用校验很严格：
        // 每一轮 function_call 必须带回同一轮原始 reasoning item。
        // continuation 合并到一条 UI 消息后，这里按 _turn 还原顺序：
        // reasoning -> function_call -> function_call_output。
        //
        // 合并 reasoning turn ∪ tool_call turn：避免"该轮只有 reasoning 无 tool_call"时
        // reasoning item 被丢弃（违反 reasoning 链对齐）。
        const toolTurns = new Set(getSortedToolCallTurns(msg.parts));
        const reasoningTurns = new Set(reasoningItems.map(getReasoningItemTurn));
        const allTurns = [...new Set([...toolTurns, ...reasoningTurns])].sort((a, b) => a - b);
        const emittedReasoningKeys = new Set();

        for (const turn of allTurns) {
            for (const item of reasoningItems) {
                const key = item.id || item.encrypted_content;
                if (getReasoningItemTurn(item) !== turn || emittedReasoningKeys.has(key)) continue;
                if (key) emittedReasoningKeys.add(key);
                out.push(stripInternalReasoningFields(item));
            }

            for (const p of msg.parts) {
                if (p.type !== PartType.TOOL_CALL || getPartTurn(p) !== turn) continue;
                if (p.mode === ToolMode.XML) continue;
                if (p.state === ToolState.SKIPPED) continue;
                pushResponsesFunctionCallPair(out, p);
            }
        }

        if (hasNonEmptyContent(content)) {
            out.push({ role, content });
        }

        // XML 模式 tool_call 配对追加紧跟在本条 assistant 之后（per-turn 内嵌）
        if (msg.role === Role.ASSISTANT) {
            appendXmlToolResultsForMessage(out, msg);
        }
    }

    return out;
}

// ========== parseResponse ==========

function parseResponse(data) {
    // 响应结构: { output: [...], output_text: "..." }
    if (data.error) return null;
    const xmlMode = state.xmlToolCallingEnabled;

    // 1. 优先检测工具调用（function_call 类型）
    if (data.output && Array.isArray(data.output)) {
        const toolCalls = [];
        const reasoningItems = [];
        let encryptedContent = null;
        let reasoningItemId = null;

        for (const item of data.output) {
            if (item.type === 'reasoning') {
                reasoningItems.push({
                    type: 'reasoning',
                    id: item.id || null,
                    summary: Array.isArray(item.summary) ? item.summary : [],
                    encrypted_content: item.encrypted_content || null,
                    status: item.status || null
                });
                encryptedContent = item.encrypted_content || encryptedContent;
                reasoningItemId = item.id || reasoningItemId;
            } else if (item.type === 'function_call') {
                let parsedArgs;
                if (typeof item.arguments === 'string') {
                    try {
                        parsedArgs = JSON.parse(item.arguments);
                    } catch (_e) {
                        logger.warn('[openai-responses] 工具参数解析失败:', _e);
                        parsedArgs = {};
                    }
                } else {
                    parsedArgs = item.arguments || {};
                }
                const callId = item.call_id || `call_${Date.now()}_${toolCalls.length}`;
                toolCalls.push({
                    id: callId,
                    call_id: callId,
                    responseItemId: item.id || null,
                    name: item.name,
                    arguments: parsedArgs,
                    // Responses API function_call 永远是原生协议
                    mode: ToolMode.NATIVE
                });
            }
        }

        if (toolCalls.length > 0) {
            let textContent = '';
            for (const item of data.output) {
                if (item.type === 'message') {
                    textContent += item.text || '';
                    if (Array.isArray(item.content)) {
                        for (const part of item.content) {
                            if (
                                (part.type === 'output_text' || part.type === 'text') &&
                                part.text
                            ) {
                                textContent += part.text;
                            }
                        }
                    }
                }
            }

            logger.debug('[openai-responses] 检测到工具调用:', toolCalls.length);
            return {
                toolCalls: toolCalls,
                content: textContent || '',
                hasToolCalls: true,
                encryptedContent,
                reasoningItemId,
                reasoningItems
            };
        }
    }

    // 2. 检测 XML 工具调用
    if (xmlMode && data.output_text) {
        const xmlToolCalls = extractXMLToolCalls(data.output_text);
        if (xmlToolCalls.length > 0) {
            logger.debug('[openai-responses] 检测到 XML 工具调用:', xmlToolCalls.length);
            return {
                toolCalls: xmlToolCalls.map((tc) => ({ ...tc, mode: ToolMode.XML })),
                content: data.output_text,
                hasToolCalls: true
            };
        }
    }

    let textContent = '';
    let thinkingContent = '';
    let encryptedContent = null;
    let reasoningItemId = null;
    const reasoningItems = [];
    const contentParts = [];

    // 1. 优先从 output[] 数组解析
    if (data.output && Array.isArray(data.output)) {
        for (const item of data.output) {
            if (item.type === 'reasoning') {
                reasoningItems.push({
                    type: 'reasoning',
                    id: item.id || null,
                    summary: Array.isArray(item.summary) ? item.summary : [],
                    encrypted_content: item.encrypted_content || null,
                    status: item.status || null
                });

                if (item.content) {
                    thinkingContent += item.content;
                    contentParts.push({ type: 'thinking', text: item.content });
                }
                if (item.encrypted_content) {
                    encryptedContent = item.encrypted_content;
                    reasoningItemId = item.id || null;
                    logger.debug('[openai-responses] 提取到 encrypted_content 签名');
                }
            } else if (item.type === 'message') {
                const messageText = item.text || '';
                if (messageText) {
                    textContent += messageText;
                    contentParts.push({ type: 'text', text: messageText });
                } else if (Array.isArray(item.content)) {
                    for (const part of item.content) {
                        if (part.type === 'output_text' && part.text) {
                            textContent += part.text;
                            contentParts.push({ type: 'text', text: part.text });
                        } else if (part.type === 'text' && part.text) {
                            textContent += part.text;
                            contentParts.push({ type: 'text', text: part.text });
                        } else if (part.type === 'image_url' && part.image_url?.url) {
                            const mediaUrl = part.image_url.url;
                            const mediaType = isVideoUrl(
                                mediaUrl,
                                part.image_url?.mime_type || part.image_url?.mimeType
                            )
                                ? 'video_url'
                                : 'image_url';
                            contentParts.push({
                                type: mediaType,
                                url: mediaUrl,
                                complete: true,
                                mimeType:
                                    part.image_url?.mime_type || part.image_url?.mimeType || ''
                            });
                        } else if (part.type === 'video_url') {
                            const mediaUrl = part.video_url?.url || part.url;
                            if (mediaUrl) {
                                contentParts.push({
                                    type: 'video_url',
                                    url: mediaUrl,
                                    complete: true,
                                    mimeType:
                                        part.mime_type ||
                                        part.mimeType ||
                                        part.video_url?.mime_type ||
                                        part.video_url?.mimeType ||
                                        ''
                                });
                            }
                        }
                    }
                }
            }
        }
    }

    // 2. 兜底：使用 output_text 快捷字段
    if (!textContent && data.output_text) {
        textContent = data.output_text;
        contentParts.push({ type: 'text', text: textContent });
    }

    // 3. 如果没有任何内容，返回 null
    if (!textContent && !thinkingContent && contentParts.length === 0) {
        return null;
    }

    return {
        content: textContent,
        thinkingContent: thinkingContent || null,
        contentParts: contentParts.length > 0 ? contentParts : null,
        encryptedContent: encryptedContent,
        reasoningItemId: reasoningItemId,
        reasoningItems: reasoningItems
    };
}

// ========== 工具构造 ==========

function collectBuiltinTools(stateRef) {
    return collectOpenAIBuiltinTools(stateRef);
}

function formatSystemTools(systemTools) {
    return systemTools;
}

// ========== buildRequestBody ==========

function buildRequestBody(ctx) {
    const {
        messages,
        model,
        modelParams,
        thinkingCfg,
        verbosityCfg,
        systemCtx,
        prefill,
        tools,
        isXmlMode,
        state: stateRef
    } = ctx;

    const finalMessages = [...messages];

    // System prompt + Monitor 注入：与 Chat 行为一致
    // 注意：Responses API 的 input 数组里 system 仍以 role:'system' + content 表达
    if (systemCtx.systemPrompt) {
        finalMessages.unshift({ role: 'system', content: systemCtx.systemPrompt });
    }
    if (systemCtx.monitorContext) {
        const sysMsg = finalMessages.find((m) => m.role === 'system');
        if (sysMsg) {
            sysMsg.content += systemCtx.monitorContext;
        } else {
            finalMessages.unshift({ role: 'system', content: systemCtx.monitorContext });
        }
    }

    if (prefill && prefill.opening.length > 0) {
        const systemIndex = finalMessages.findIndex((m) => m.role === 'system');
        const insertIndex = systemIndex >= 0 ? systemIndex + 1 : 0;
        finalMessages.splice(insertIndex, 0, ...prefill.opening);
    }
    if (prefill && prefill.trailing.length > 0) {
        finalMessages.push(...prefill.trailing);
    }

    // Responses API 使用 input 字段而非 messages
    const requestBody = {
        model: model,
        stream: stateRef.streamEnabled,
        input: finalMessages,
        // 请求返回加密的推理内容（用于多轮对话保持思维链上下文）
        include: ['reasoning.encrypted_content']
    };

    Object.assign(requestBody, modelParams);
    if (thinkingCfg) Object.assign(requestBody, thinkingCfg);
    if (verbosityCfg) Object.assign(requestBody, verbosityCfg);

    if (tools.length > 0) {
        if (isXmlMode) {
            injectToolsToOpenAI(finalMessages, tools);
            const stats = getXMLInjectionStats(tools);
            logger.debug('[openai-responses] XML 模式注入统计:', stats);
            if (stats.estimatedTokens > 2000) {
                logger.warn(
                    '[openai-responses] XML 描述过长，预计消耗',
                    stats.estimatedTokens,
                    'tokens'
                );
            }
        } else {
            requestBody.tools = tools;
            requestBody.tool_choice = 'auto';
            // parallel_tool_calls 仅 Chat Completions 支持，Responses API 不发送
            logger.debug('[openai-responses] 原生 tools 模式，工具数量:', tools.length);
        }
    }

    return requestBody;
}

// ========== Endpoint / Headers / Query ==========

/**
 * Responses API 端点路径：若 endpoint 未含 /responses，则从 /chat/completions 替换
 * 与原 sendOpenAIRequest line 33-37 行为等价
 */
function resolveEndpoint(baseEndpoint, _model, _isStreaming) {
    if (!baseEndpoint.includes('/responses')) {
        return baseEndpoint.replace('/chat/completions', '/responses');
    }
    return baseEndpoint;
}

function buildHeaders(apiKey, _ctx) {
    return buildOpenAIAuthHeaders(apiKey);
}

function buildQueryString(_apiKey, _ctx) {
    return '';
}

// ========== Adapter 对象 + 注册 ==========

// parseOpenAIStream 内部签名 (reader, format, sessionId, sink, signal) — 统一为 (reader, sessionId, sink, signal) 入口
function streamParser(reader, sessionId, sink = null, signal = null) {
    return parseOpenAIStream(reader, 'openai-responses', sessionId, sink, signal);
}

export const openaiResponsesAdapter = Object.freeze({
    name: 'OpenAI Responses',
    apiFormat: 'openai-responses',
    filterPosition: 'after',
    signatureFormat: 'openai',

    parserClass: OpenAIStreamParser,
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
