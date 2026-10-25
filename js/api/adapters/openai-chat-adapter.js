/**
 * OpenAI Chat Completions Adapter — Chat Completions 路径差异化逻辑（messages 字段 +
 * /chat/completions 端点）。partsToAPIMessages 直接产出 messages[]，XML 模式经
 * appendXmlToolResults 配对追加。
 */

import { logger } from '../../utils/logger.js';
import { PartType, MediaKind, Role, ToolMode, ToolState } from '../../messages/schema.js';
import { parseDataURL } from '../../utils/file-helpers.js';
import { parseMarkdownImages } from '../../utils/markdown-image-parser.js';
import { extractXMLToolCalls, appendXmlToolResultsForMessage } from '../../tools/xml-formatter.js';
import { parseThinkTags } from '../../stream/think-tag-parser.js';
import { isVideoUrl } from '../../utils/media.js';
import { OpenAIStreamParser, parseOpenAIStream } from '../../stream/parser-openai.js';
import { normalizeOpenAIChatStop } from '../../messages/stop-reason.js';

import {
    isTextFile,
    stringifyToolResult,
    buildOpenAIAuthHeaders,
    assembleOpenAIConversation,
    applyOpenAITools,
    resolveOpenAIEffort,
    canSendOpenAINoneEffort,
    buildOpenAISampling,
    resolveOpenAIVerbosity
} from './openai-shared.js';
import { getMappedId, ensureIdMap } from '../format-converter.js';

// ========== partsToAPIMessages ==========

/**
 * 新格式 → OpenAI Chat Completions 消息数组
 *
 * thinking parts 被忽略（reasoning 由 API 参数控制）。
 * tool_call 拆分为 assistant.tool_calls + 独立 role:"tool" 消息。
 * 旧格式消息（无 parts[]）直接透传。
 */
function partsToAPIMessages(msgs, _opts = {}) {
    const out = [];

    for (const msg of msgs) {
        if (msg.error) continue;

        const role = msg.role;
        const contentItems = [];
        const toolCalls = [];
        let hasToolCalls = false;
        const sourcePartCount = (msg.parts || []).length;

        // 旧数据未补齐 idMap 时 getMappedId 每次返回新临时 id，会导致同一 part 在
        // tool_use 分支(L95)和 tool_result 分支(L134)拿到不同 id，OpenAI API 配对 400。
        // 入口主动 ensureIdMap 持久化三槽 + 局部 Map 兜底，保证同 part 两次取值一致
        for (const p of msg.parts || []) {
            if (p.type === PartType.TOOL_CALL) ensureIdMap(p);
        }
        const toolCallIdMap = new Map();

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
                        // OpenAI input_audio 需要纯 base64 和简短格式名
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
                    // XML 模式产生的工具调用以 <tool_use> 字符串形式存活于 TEXT part，
                    // 不输出 native block；对应工具结果由末尾追加的 XML 字符串临时消息承载
                    if (p.mode === ToolMode.XML) break;
                    // 多回复模式 BufferedSink 拦截的 tool_call —— 既不输出 tool_use 也不输出
                    // tool_result（schema.ToolState.SKIPPED 注释说明），避免孤儿 tool_use 触发 400
                    if (p.state === ToolState.SKIPPED) break;
                    hasToolCalls = true;
                    {
                        const openaiId = getMappedId(p, 'openai');
                        toolCallIdMap.set(p, openaiId);
                        toolCalls.push({
                            id: openaiId,
                            type: 'function',
                            function: {
                                name: p.name,
                                arguments:
                                    typeof p.args === 'string'
                                        ? p.args
                                        : JSON.stringify(p.args || {})
                            }
                        });
                    }
                    break;
                // THINKING: 忽略
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

        const outMsg = { role, content };
        if (hasToolCalls) outMsg.tool_calls = toolCalls;

        // ASSISTANT 全 part 被跳过（XML mode tool_call / SKIPPED / thinking 忽略）→ 整条不 push，
        // 避免 OpenAI API 收到空 assistant 触发 400（对齐 Gemini adapter:160）。
        // USER 消息保留空 content 占位（音频 parseDataURL 失败等场景需要保留空消息）
        const assistantAllSkipped =
            role === Role.ASSISTANT &&
            sourcePartCount > 0 &&
            contentItems.length === 0 &&
            toolCalls.length === 0;
        if (assistantAllSkipped) continue;

        out.push(outMsg);

        // 拆出 tool 结果为独立消息（native 模式）
        if (toolCalls.length > 0) {
            for (const p of msg.parts) {
                if (p.type !== PartType.TOOL_CALL) continue;
                if (p.mode === ToolMode.XML) continue;
                // SKIPPED 的 tool_call 上方未输出 tool_use，此处也必须跳过 tool_result 配对
                if (p.state === ToolState.SKIPPED) continue;
                const resultContent = stringifyToolResult(p.result);
                // 用 toolCallIdMap 复用上方 push tool_use 时的 id，保证同 part 配对一致；
                // ensureIdMap 已 pass 过理论上 fallback 不会触发，留作极端防御（手动构造 part 等）
                out.push({
                    role: 'tool',
                    tool_call_id: toolCallIdMap.get(p) || getMappedId(p, 'openai'),
                    content: resultContent,
                    _toolName: p.name
                });
            }
        }

        // XML 模式 tool_call 配对追加紧跟在本条 assistant 之后（per-turn 内嵌）
        if (msg.role === Role.ASSISTANT) {
            appendXmlToolResultsForMessage(out, msg);
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
            hasToolCalls: true
        };
    }

    // 兜底：检测 XML <tool_use>
    if (xmlMode && message.content && typeof message.content === 'string') {
        const xmlToolCalls = extractXMLToolCalls(message.content);

        if (xmlToolCalls.length > 0) {
            logger.debug('[openai-chat] 检测到 XML 工具调用:', xmlToolCalls.length);
            return {
                toolCalls: xmlToolCalls.map((tc) => ({ ...tc, mode: ToolMode.XML })),
                content: message.content,
                hasToolCalls: true
            };
        }
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

    return {
        content: Array.isArray(content)
            ? textContent
            : extractedThinkingContent
              ? textContent
              : content,
        thinkingContent: finalThinkingContent,
        contentParts: contentParts.length > 0 ? contentParts : null,
        stop
    };
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
