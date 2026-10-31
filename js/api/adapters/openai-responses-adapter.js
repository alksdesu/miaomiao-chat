/**
 * OpenAI Responses API Adapter — Responses 路径差异化逻辑（input 字段 + reasoning
 * items + /responses 端点）。partsToAPIMessages 按 _turn 还原 reasoning → function_call
 * → output 顺序，buildRequestBody 始终注入 include reasoning.encrypted_content。
 */

import { logger } from '../../utils/logger.js';
import { PartType, MediaKind, Role, ToolMode } from '../../messages/schema.js';
import { parseDataURL } from '../../utils/file-helpers.js';
import { applyXMLToolCalls, appendXmlToolResultsForMessage } from '../../tools/xml-formatter.js';
import { isVideoUrl } from '../../utils/media.js';
import { OpenAIStreamParser, parseOpenAIStream } from '../../stream/parser-openai.js';
import { normalizeResponsesStop } from '../../messages/stop-reason.js';

import {
    isTextFile,
    buildResponsesReasoningItems,
    getReasoningItemTurn,
    stripInternalReasoningFields,
    pushResponsesFunctionCallPair,
    buildOpenAIAuthHeaders,
    assembleOpenAIConversation,
    applyOpenAITools,
    resolveOpenAIEffort,
    canSendOpenAINoneEffort,
    buildOpenAISampling,
    resolveOpenAIVerbosity
} from './openai-shared.js';
import { pushXmlBuiltinToolsNotice } from '../request-notices.js';
import { ensureIdMap } from '../format-converter.js';
import {
    getPartTurn,
    isNativeToolCall,
    isServerToolCall,
    describeServerToolCall
} from './history-replay.js';

// ========== partsToAPIMessages ==========

/**
 * user / system 消息内容：input_text / input_image / input_file；视频与音频没有对应类型，按中转约定透传
 * 空文本不输出，内容为空时回落为空字符串
 */
function buildInputContent(parts) {
    const content = [];
    for (const p of parts || []) {
        switch (p.type) {
            case PartType.TEXT:
                if (p.text) content.push({ type: 'input_text', text: p.text });
                break;
            case PartType.MEDIA:
                if (p.media === MediaKind.IMAGE) {
                    content.push({ type: 'input_image', image_url: p.url });
                } else if (p.media === MediaKind.VIDEO) {
                    content.push({
                        type: 'video_url',
                        video_url: { url: p.url, mime_type: p.mime }
                    });
                } else if (p.media === MediaKind.AUDIO) {
                    const audioParsed = parseDataURL(p.url);
                    if (audioParsed) {
                        const fmt = (audioParsed.mimeType || '').split('/').pop() || 'wav';
                        content.push({
                            type: 'input_audio',
                            input_audio: { data: audioParsed.base64, format: fmt }
                        });
                    }
                }
                break;
            case PartType.FILE:
                if (isTextFile(p)) {
                    content.push({
                        type: 'input_text',
                        text: `<document name="${p.name}">\n${p.url}\n</document>`
                    });
                } else {
                    content.push({ type: 'input_file', filename: p.name, file_data: p.url });
                }
                break;
        }
    }
    if (content.length === 0) return '';
    if (content.length === 1 && content[0].type === 'input_text') return content[0].text;
    return content;
}

/**
 * assistant 消息只能回放文本；生成的图片没有可回放的输入形式。
 * 服务端工具（Claude 的 web_search 等）的调用与结果以文本保留
 */
function joinAssistantText(parts) {
    return parts
        .map((p) => {
            if (p.type === PartType.TEXT) return p.text;
            return isServerToolCall(p) ? describeServerToolCall(p) : '';
        })
        .filter(Boolean)
        .join('\n\n');
}

function buildResponsesUserMessage(text, images) {
    if (images.length === 0) return { role: 'user', content: text };
    return {
        role: 'user',
        content: [
            { type: 'input_text', text },
            ...images.map((image) => ({ type: 'input_image', image_url: image.url }))
        ]
    };
}

/**
 * 新格式 → OpenAI Responses API items 数组
 *
 * assistant 消息按 _turn 还原每轮的输出顺序：reasoning → 本轮文本 → function_call → function_call_output。
 * 带工具调用那一轮的文本是前言（commentary），没有工具调用的那一轮是最终回答（final_answer）
 *
 * @param {Array} msgs
 * @param {{ injectReasoning?: boolean, profile?: Object }} [opts]
 */
function partsToAPIMessages(msgs, opts = {}) {
    const out = [];
    // 不支持推理的型号收到加密推理项会拒绝整条请求（同一渠道从推理型号换到 gpt-4.1 / 4o 时）
    const injectReasoning =
        opts.injectReasoning !== false && opts.profile?.reasoning?.supported !== false;
    const withPhase = opts.profile?.assistantPhase === true;

    const pushAssistantText = (text, phase) => {
        if (!text.trim()) return;
        out.push({ role: 'assistant', content: text, ...(withPhase ? { phase } : {}) });
    };

    for (const msg of msgs) {
        if (msg.error) continue;

        if (msg.role !== Role.ASSISTANT) {
            out.push({ role: msg.role, content: buildInputContent(msg.parts) });
            continue;
        }

        const parts = msg.parts || [];
        // 旧数据未补齐 idMap 时 getMappedId 每次返回新临时 id，function_call 与 function_call_output
        // 会配对错位触发 400；入口主动 ensureIdMap 持久化三槽
        for (const p of parts) {
            if (p.type === PartType.TOOL_CALL) ensureIdMap(p);
        }

        // 请求不保存服务端状态，推理项只能靠加密内容回放；只有 id 的推理项无法解析，直接跳过
        const reasoningItems = injectReasoning
            ? buildResponsesReasoningItems(msg).filter((item) => item.encrypted_content)
            : [];
        const toolCallTurns = new Set(parts.filter(isNativeToolCall).map(getPartTurn));
        const turns = [
            ...new Set([...parts.map(getPartTurn), ...reasoningItems.map(getReasoningItemTurn)])
        ].sort((a, b) => a - b);

        for (const turn of turns) {
            const turnParts = parts.filter((p) => getPartTurn(p) === turn);
            const turnReasoning = reasoningItems.filter(
                (item) => getReasoningItemTurn(item) === turn
            );
            out.push(...turnReasoning.map(stripInternalReasoningFields));
            pushAssistantText(
                joinAssistantText(turnParts),
                toolCallTurns.has(turn) ? 'commentary' : 'final_answer'
            );
            for (const p of turnParts) {
                if (!isNativeToolCall(p)) continue;
                pushResponsesFunctionCallPair(out, p, {
                    includeItemId: turnReasoning.length > 0
                });
            }
            // XML 模式 tool_call 配对追加紧跟在本轮输出之后
            appendXmlToolResultsForMessage(out, { parts: turnParts }, buildResponsesUserMessage);
        }
    }

    return out;
}

// ========== parseResponse ==========

function parseResponse(data, options = {}) {
    // 响应结构: { output: [...], output_text: "..." }
    if (data.error) return null;
    const xmlMode = options.isXmlMode === true;
    // incomplete 时函数调用参数可能被截断，按普通回复处理并提示结束原因
    const incomplete = data.status === 'incomplete';

    // 1. 优先检测工具调用（function_call 类型）
    if (!incomplete && data.output && Array.isArray(data.output)) {
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

    let textContent = '';
    let thinkingContent = '';
    let encryptedContent = null;
    let reasoningItemId = null;
    let refused = false;
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
                        } else if (part.type === 'refusal' && part.refusal) {
                            // 拒答文本按正文展示，结束原因另行提示
                            refused = true;
                            textContent += part.refusal;
                            contentParts.push({ type: 'text', text: part.refusal });
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

    const stop = normalizeResponsesStop(data, { refused });

    // 3. 没有任何内容（如推理耗尽 max_output_tokens）时只带回结束原因，由 handler 按空回复处理
    if (!textContent && !thinkingContent && contentParts.length === 0) {
        return { content: '', stop };
    }

    const reply = {
        content: textContent,
        thinkingContent: thinkingContent || null,
        contentParts: contentParts.length > 0 ? contentParts : null,
        encryptedContent: encryptedContent,
        reasoningItemId: reasoningItemId,
        reasoningItems: reasoningItems,
        stop
    };

    // 检测 XML 工具调用，推理项照常落库供续作回放
    if (xmlMode) {
        const xmlReply = applyXMLToolCalls(reply, textContent);
        if (xmlReply) {
            logger.debug('[openai-responses] 检测到 XML 工具调用:', xmlReply.toolCalls.length);
            return xmlReply;
        }
    }
    return reply;
}

// ========== 工具构造 ==========

// 服务端工具由 OpenAI 执行；XML 模式下工具写进提示词，服务端工具无法这样调用
function collectBuiltinTools(stateRef, { notices } = {}) {
    if (stateRef.xmlToolCallingEnabled) {
        pushXmlBuiltinToolsNotice(stateRef, notices);
        return [];
    }
    const tools = [];
    if (stateRef.codeExecutionEnabled) {
        tools.push({ type: 'code_interpreter', container: { type: 'auto' } });
    }
    if (stateRef.webSearchEnabled) {
        tools.push({ type: 'web_search' });
    }
    return tools;
}

function formatSystemTools(systemTools) {
    return systemTools;
}

// ========== 生成参数 ==========

/**
 * 开启推理时按型号收敛档位并请求摘要；关闭时按用户选择显式发送 none（型号不支持 none 时省略）
 * @returns {Object|null}
 */
function buildReasoningConfig(reasoning, profile, notices) {
    if (!profile.reasoning.supported) {
        if (reasoning.enabled) {
            notices.push({
                key: 'openai.reasoning-unsupported',
                message: '当前模型不支持推理强度参数，已忽略'
            });
        }
        return null;
    }
    if (reasoning.enabled) {
        return {
            reasoning: {
                effort: resolveOpenAIEffort(reasoning.strength, profile.reasoning.efforts, notices),
                summary: 'auto'
            }
        };
    }
    if (reasoning.sendNoneWhenDisabled && canSendOpenAINoneEffort(profile, notices)) {
        return { reasoning: { effort: 'none' } };
    }
    return null;
}

/**
 * @param {import('../params.js').GenerationSettings} settings
 * @param {{ profile: Object }} ctx
 * @returns {import('./format-adapter-types.js').GenerationParams}
 */
function buildGenerationParams(settings, { profile }) {
    const { userParams, reasoning } = settings;
    const notices = [];
    const thinkingCfg = buildReasoningConfig(reasoning, profile, notices);

    const penalties = ['frequency_penalty', 'presence_penalty'].filter(
        (key) => userParams[key] !== null && userParams[key] !== undefined
    );
    if (penalties.length > 0) {
        notices.push({
            key: 'openai-responses.penalties',
            message: `Responses API 不支持 ${penalties.join(' / ')}，已忽略`
        });
    }

    const modelParams = buildOpenAISampling(userParams, {
        rule: profile.sampling,
        effectiveEffort: thinkingCfg?.reasoning?.effort ?? profile.reasoning.defaultEffort,
        penalties: false,
        notices
    });
    if (userParams.max_tokens !== null) modelParams.max_output_tokens = userParams.max_tokens;

    const verbosity = resolveOpenAIVerbosity(settings.verbosity, profile, notices);
    return {
        modelParams,
        thinkingCfg,
        verbosityCfg: verbosity ? { text: { verbosity } } : null,
        notices
    };
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
        profile,
        state: stateRef
    } = ctx;

    // Responses API 的 input 数组里 system 仍以 role:'system' + content 表达
    const conversation = assembleOpenAIConversation(messages, systemCtx, prefill);
    const requestBody = {
        model: model,
        stream: stateRef.streamEnabled,
        input: conversation,
        // 每轮都回放完整历史，不需要服务端保存对话
        store: false
    };
    // 不保存时推理项只能靠加密内容在多轮对话里回放；不支持推理的型号收到这个参数直接 400
    if (profile?.reasoning?.supported !== false) {
        requestBody.include = ['reasoning.encrypted_content'];
    }

    Object.assign(requestBody, modelParams);
    if (thinkingCfg) Object.assign(requestBody, thinkingCfg);
    if (verbosityCfg) Object.assign(requestBody, verbosityCfg);

    applyOpenAITools(requestBody, conversation, tools, {
        isXmlMode,
        logTag: 'openai-responses'
    });

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
    signatureFormat: 'openai',

    parserClass: OpenAIStreamParser,
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
