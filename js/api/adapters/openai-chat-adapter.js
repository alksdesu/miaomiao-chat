/**
 * OpenAI Chat Completions Adapter — Chat Completions 路径差异化逻辑（messages 字段 +
 * /chat/completions 端点）。partsToAPIMessages 直接产出 messages[]，XML 模式经
 * appendXmlToolResults 配对追加。
 */

import { logger } from '../../utils/logger.js';
import { PartType, MediaKind, Role, ToolMode } from '../../messages/schema.js';
import { parseDataURL } from '../../utils/file-helpers.js';
import { parseMarkdownImages } from '../../utils/markdown-image-parser.js';
import { applyXMLToolCalls, appendXmlToolResultsForMessage } from '../../tools/xml-formatter.js';
import { parseThinkTags } from '../../stream/think-tag-parser.js';
import { isVideoUrl } from '../../utils/media.js';
import { OpenAIStreamParser, parseOpenAIStream } from '../../stream/parser-openai.js';
import { normalizeOpenAIChatStop } from '../../messages/stop-reason.js';

import {
    isTextFile,
    buildOpenAIAuthHeaders,
    assembleOpenAIConversation,
    applyOpenAITools,
    resolveOpenAIEffort,
    canSendOpenAINoneEffort,
    buildOpenAISampling,
    resolveOpenAIVerbosity
} from './openai-shared.js';
import { getMappedId, ensureIdMap } from '../format-converter.js';
import {
    splitPartsByTurn,
    isNativeToolCall,
    isServerToolCall,
    describeServerToolCall
} from './history-replay.js';
import { splitToolResultContent } from '../../messages/tool-results.js';

// ========== partsToAPIMessages ==========

/**
 * 文本、媒体与文件 part → Chat Completions 的 content 项；空文本不输出
 * assistant 消息只能回放文本与图片，视频与音频换成说明文字
 * @returns {Object|null}
 */
function toChatContentItem(p, role) {
    switch (p.type) {
        case PartType.TEXT:
            return p.text ? { type: 'text', text: p.text } : null;
        case PartType.MEDIA:
            if (p.media === MediaKind.IMAGE) {
                return { type: 'image_url', image_url: { url: p.url } };
            }
            if (role === Role.ASSISTANT) {
                return {
                    type: 'text',
                    text: `[${p.media === MediaKind.VIDEO ? '视频' : '音频'}附件已省略]`
                };
            }
            if (p.media === MediaKind.VIDEO) {
                return { type: 'video_url', video_url: { url: p.url, mime_type: p.mime } };
            }
            if (p.media === MediaKind.AUDIO) {
                // OpenAI input_audio 需要纯 base64 和简短格式名
                const audioParsed = parseDataURL(p.url);
                if (!audioParsed) return null;
                const fmt = (audioParsed.mimeType || '').split('/').pop() || 'wav';
                return {
                    type: 'input_audio',
                    input_audio: { data: audioParsed.base64, format: fmt }
                };
            }
            return null;
        case PartType.FILE:
            if (isTextFile(p)) {
                return { type: 'text', text: `<document name="${p.name}">\n${p.url}\n</document>` };
            }
            return { type: 'file', file: { filename: p.name, file_data: p.url } };
        default:
            return null;
    }
}

function toChatContent(contentItems) {
    if (contentItems.length === 0) return '';
    if (contentItems.length === 1 && contentItems[0].type === 'text') return contentItems[0].text;
    return contentItems;
}

function buildChatUserMessage(text, images) {
    if (images.length === 0) return { role: 'user', content: text };
    return {
        role: 'user',
        content: [
            { type: 'text', text },
            ...images.map((image) => ({ type: 'image_url', image_url: { url: image.url } }))
        ]
    };
}

/**
 * 一轮 assistant 输出：assistant（文本 + tool_calls）→ 每个调用一条 tool 消息；
 * tool 消息只能是文本，结果里的图片放进紧随其后的一条 user 消息
 */
function pushAssistantTurn(out, turnParts) {
    const contentItems = [];
    const toolCalls = [];
    const callParts = [];
    // 同一 part 两次取 id 必须一致，否则 tool_calls 与 tool 消息配对 400
    const toolCallIdMap = new Map();

    for (const p of turnParts) {
        if (p.type === PartType.THINKING) continue;
        if (p.type !== PartType.TOOL_CALL) {
            const item = toChatContentItem(p, Role.ASSISTANT);
            if (item) contentItems.push(item);
            continue;
        }
        if (isServerToolCall(p)) {
            contentItems.push({ type: 'text', text: describeServerToolCall(p) });
            continue;
        }
        // XML 模式的调用经 appendXmlToolResultsForMessage 回放；多回复拦截的调用不回放
        if (!isNativeToolCall(p)) continue;
        const openaiId = getMappedId(p, 'openai');
        toolCallIdMap.set(p, openaiId);
        toolCalls.push({
            id: openaiId,
            type: 'function',
            function: {
                name: p.name,
                arguments: typeof p.args === 'string' ? p.args : JSON.stringify(p.args || {})
            }
        });
        callParts.push(p);
    }

    // 全部被跳过的 assistant 不输出，空 assistant 会被拒绝
    if (contentItems.length === 0 && toolCalls.length === 0) return;
    const assistantMessage = { role: 'assistant', content: toChatContent(contentItems) };
    if (toolCalls.length > 0) assistantMessage.tool_calls = toolCalls;
    out.push(assistantMessage);

    const imageItems = [];
    for (const p of callParts) {
        const { text, images } = splitToolResultContent(p.result);
        out.push({ role: 'tool', tool_call_id: toolCallIdMap.get(p), content: text });
        if (images.length > 0) {
            imageItems.push(
                { type: 'text', text: `[${p.name} 返回的图片]` },
                ...images.map((image) => ({ type: 'image_url', image_url: { url: image.url } }))
            );
        }
    }
    if (imageItems.length > 0) out.push({ role: 'user', content: imageItems });
}

/**
 * 新格式 → OpenAI Chat Completions 消息数组
 *
 * thinking parts 被忽略（reasoning 由 API 参数控制）。
 * 工具循环续作合并成的 assistant 消息按 _turn 拆回每一步：assistant.tool_calls → tool 结果，
 * 否则最终回答会排到调用之前、多步调用被当成同一步的并行调用
 */
function partsToAPIMessages(msgs, _opts = {}) {
    const out = [];

    for (const msg of msgs) {
        if (msg.error) continue;

        // 旧数据未补齐 idMap 时 getMappedId 每次返回新临时 id，tool_calls 与 tool 消息会配对错位
        for (const p of msg.parts || []) {
            if (p.type === PartType.TOOL_CALL) ensureIdMap(p);
        }

        if (msg.role !== Role.ASSISTANT) {
            // user 消息保留空 content 占位（音频 parseDataURL 失败等场景）
            const items = (msg.parts || [])
                .map((p) => toChatContentItem(p, msg.role))
                .filter(Boolean);
            out.push({ role: msg.role, content: toChatContent(items) });
            continue;
        }

        for (const { parts: turnParts } of splitPartsByTurn(msg.parts)) {
            pushAssistantTurn(out, turnParts);
            // XML 模式 tool_call 配对追加紧跟在本轮输出之后
            appendXmlToolResultsForMessage(out, { parts: turnParts }, buildChatUserMessage);
        }
    }

    return out;
}

// ========== parseResponse ==========

function parseResponse(data, options = {}) {
    if (!data.choices || !data.choices[0]) return null;

    const message = data.choices[0].message || {};
    const finishReason = data.choices[0].finish_reason;
    const xmlMode = options.isXmlMode === true;
    const refusal = typeof message.refusal === 'string' ? message.refusal : '';
    const stop = normalizeOpenAIChatStop(finishReason, { refused: !!refusal });

    // 检测原生 tool_calls（仅在非 XML 模式）
    if (message.tool_calls && finishReason === 'tool_calls' && !xmlMode) {
        const toolCalls = message.tool_calls.map((tc) => {
            let parsedArgs;
            if (typeof tc.function.arguments === 'string') {
                try {
                    parsedArgs = JSON.parse(tc.function.arguments);
                } catch (e) {
                    logger.warn('[openai-chat] 工具调用参数解析失败:', e);
                    parsedArgs = {};
                }
            } else {
                parsedArgs = tc.function.arguments;
            }
            return {
                id: tc.id,
                name: tc.function.name,
                arguments: parsedArgs,
                mode: ToolMode.NATIVE
            };
        });

        logger.debug('[openai-chat] 检测到原生工具调用:', toolCalls.length);
        return {
            toolCalls: toolCalls,
            content: message.content || '',
            // 调用工具的那一轮同样显示思维链
            thinkingContent: message.reasoning_content || message.reasoning || null,
            hasToolCalls: true
        };
    }

    // 处理不同的 content 格式
    let content = message.content;
    const contentParts = [];
    let textContent = '';

    // 如果 content 为 null 但有其他字段（如 tool_calls），跳过
    if (content === null || content === undefined) {
        if (message.image) {
            content = [{ type: 'image_url', image_url: { url: message.image } }];
        } else if (refusal) {
            // 安全拒答：content 为 null，拒答文本按正文展示，结束原因另行提示
            content = refusal;
        } else {
            // 推理耗尽 max_completion_tokens 等场景没有正文，只带回结束原因，由 handler 按空回复处理
            return { content: '', stop };
        }
    }

    let extractedThinkingContent = '';

    if (Array.isArray(content)) {
        for (const part of content) {
            if (part.type === 'text') {
                const { displayText: thinkParsedText, thinkingContent: thinkContent } =
                    parseThinkTags(part.text);
                if (thinkContent) {
                    extractedThinkingContent += thinkContent;
                    contentParts.push({ type: 'thinking', text: thinkContent });
                }

                const parsedParts = parseMarkdownImages(thinkParsedText);
                for (const parsed of parsedParts) {
                    if (parsed.type === 'text') {
                        textContent += parsed.text;
                        contentParts.push(parsed);
                    } else if (parsed.type === 'image_url') {
                        contentParts.push(parsed);
                    }
                }
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
                    mimeType: part.image_url?.mime_type || part.image_url?.mimeType || ''
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
    } else if (typeof content === 'string') {
        const { displayText: thinkParsedText, thinkingContent: thinkContent } =
            parseThinkTags(content);
        if (thinkContent) {
            extractedThinkingContent += thinkContent;
            contentParts.push({ type: 'thinking', text: thinkContent });
        }

        const parsedParts = parseMarkdownImages(thinkParsedText);
        for (const part of parsedParts) {
            if (part.type === 'text') {
                textContent += part.text;
                contentParts.push(part);
            } else if (part.type === 'image_url') {
                contentParts.push(part);
            }
        }
    }

    // 处理原生思维链（优先级高于 <think> 标签）
    const nativeReasoning = message.reasoning_content || message.reasoning;
    const finalThinkingContent = nativeReasoning || extractedThinkingContent || null;
    if (nativeReasoning) {
        contentParts.unshift({ type: 'thinking', text: nativeReasoning });
    }

    const reply = {
        content: Array.isArray(content)
            ? textContent
            : extractedThinkingContent
              ? textContent
              : content,
        thinkingContent: finalThinkingContent,
        contentParts: contentParts.length > 0 ? contentParts : null,
        stop
    };

    // 兜底：检测 XML <tool_use>，原生思维链照常落库
    if (xmlMode) {
        const xmlReply = applyXMLToolCalls(reply, reply.content);
        if (xmlReply) {
            logger.debug('[openai-chat] 检测到 XML 工具调用:', xmlReply.toolCalls.length);
            return xmlReply;
        }
    }
    return reply;
}

// ========== 工具构造 ==========

// Chat Completions 没有代码执行与联网搜索工具，这两项只在 Responses 格式提供
function collectBuiltinTools() {
    return [];
}

function formatSystemTools(systemTools) {
    // OpenAI 系统工具直接 spread 到 tools 数组，无需包装
    return systemTools;
}

// ========== 生成参数 ==========

/**
 * 未识别的型号只在开启推理时发送 reasoning_effort；已识别且支持 none 的型号关闭推理时按设置发送 none
 * @returns {string|null}
 */
function resolveChatEffort(reasoning, profile, notices) {
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
        return resolveOpenAIEffort(reasoning.strength, profile.reasoning.efforts, notices);
    }
    if (!reasoning.sendNoneWhenDisabled || !profile.known) return null;
    return canSendOpenAINoneEffort(profile, notices) ? 'none' : null;
}

/**
 * @param {import('../params.js').GenerationSettings} settings
 * @param {{ profile: Object, nativeTools: boolean }} ctx
 * @returns {import('./format-adapter-types.js').GenerationParams}
 */
function buildGenerationParams(settings, { profile, nativeTools }) {
    const { userParams, reasoning } = settings;
    const notices = [];

    let effort = resolveChatEffort(reasoning, profile, notices);
    if (nativeTools && profile.chatTools === 'effort-none' && effort !== 'none') {
        effort = 'none';
        notices.push({
            key: 'openai.chat-tools-effort',
            message:
                '当前模型在 Chat Completions 中只有推理强度为 none 时才能使用工具，已改为 none；需要推理时请改用 Responses 格式'
        });
    }

    const modelParams = buildOpenAISampling(userParams, {
        rule: profile.sampling,
        effectiveEffort: effort ?? profile.reasoning.defaultEffort,
        notices
    });
    // 推理模型不接受 max_tokens；未识别的型号沿用 max_tokens 兼容各类中转
    if (userParams.max_tokens !== null) modelParams[profile.maxTokensParam] = userParams.max_tokens;

    const verbosity = resolveOpenAIVerbosity(settings.verbosity, profile, notices);
    return {
        modelParams,
        thinkingCfg: effort ? { reasoning_effort: effort } : null,
        verbosityCfg: verbosity ? { verbosity } : null,
        notices
    };
}

// ========== buildRequestBody ==========

/**
 * @param {import('./format-adapter-types.js').RequestBodyContext} ctx
 */
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
        notices,
        state: stateRef
    } = ctx;

    const conversation = assembleOpenAIConversation(messages, systemCtx, prefill);
    const requestBody = {
        model: model,
        stream: stateRef.streamEnabled,
        messages: conversation
    };
    // 流式默认不返回 usage；未识别的型号不加，部分中转不认 stream_options
    if (stateRef.streamEnabled && profile?.streamUsage) {
        requestBody.stream_options = { include_usage: true };
    }

    Object.assign(requestBody, modelParams);
    if (thinkingCfg) Object.assign(requestBody, thinkingCfg);
    if (verbosityCfg) Object.assign(requestBody, verbosityCfg);

    if (stateRef.codeExecutionEnabled || stateRef.webSearchEnabled) {
        notices.push({
            key: 'openai.chat-builtin-tools',
            message: 'Chat Completions 不提供代码执行与联网搜索工具，需要时请改用 Responses 格式'
        });
    }

    const nativeToolsBlocked = !isXmlMode && tools.length > 0 && profile?.chatTools === 'never';
    if (nativeToolsBlocked) {
        notices.push({
            key: 'openai.chat-tools',
            message:
                '当前模型在 Chat Completions 中不支持工具调用，本次请求未附带工具；需要工具时请改用 Responses 格式'
        });
    }
    applyOpenAITools(requestBody, conversation, nativeToolsBlocked ? [] : tools, {
        isXmlMode,
        logTag: 'openai-chat',
        nativeFields: { parallel_tool_calls: true }
    });

    return requestBody;
}

// ========== Endpoint / Headers / Query ==========

function resolveEndpoint(baseEndpoint, _model, _isStreaming) {
    // Chat Completions：保持端点不变（OpenAI Responses 才需要替换 path）
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
    return parseOpenAIStream(reader, 'openai', sessionId, sink, signal);
}

export const openaiChatAdapter = Object.freeze({
    name: 'OpenAI Chat',
    apiFormat: 'openai',
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
