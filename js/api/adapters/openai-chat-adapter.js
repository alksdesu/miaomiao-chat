/**
 * OpenAI Chat Completions Adapter — Chat Completions 路径差异化逻辑（messages 字段 +
 * /chat/completions 端点）。partsToAPIMessages 直接产出 messages[]，XML 模式经
 * appendXmlToolResults 配对追加。
 */

import { logger } from '../../utils/logger.js';
import { state } from '../../core/state.js';
import { PartType, MediaKind, Role, ToolMode, ToolState } from '../../messages/schema.js';
import { parseDataURL } from '../../utils/file-helpers.js';
import { parseMarkdownImages } from '../../utils/markdown-image-parser.js';
import { extractXMLToolCalls, appendXmlToolResultsForMessage } from '../../tools/xml-formatter.js';
import { parseThinkTags } from '../../stream/think-tag-parser.js';
import { isVideoUrl } from '../../utils/media.js';
import { injectToolsToOpenAI, getXMLInjectionStats } from '../../tools/tool-injection.js';
import { OpenAIStreamParser, parseOpenAIStream } from '../../stream/parser-openai.js';

import {
    isTextFile,
    stringifyToolResult,
    buildOpenAIAuthHeaders,
    collectOpenAIBuiltinTools
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
        if (msg.error || msg.isError) continue;

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

function parseResponse(data) {
    if (!data.choices || !data.choices[0]) return null;

    const message = data.choices[0].message;
    const finishReason = data.choices[0].finish_reason;
    // 入口一次性快照 XML toggle，整段解析期间复用同一值
    const xmlMode = state.xmlToolCallingEnabled;

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
        } else if (typeof message.refusal === 'string' && message.refusal) {
            // OpenAI safety refusal：content 为 null + refusal 文本，之前丢字段导致空消息
            content = `[模型拒绝回应] ${message.refusal}`;
        } else {
            return null;
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
        contentParts: contentParts.length > 0 ? contentParts : null
    };
}

// ========== 工具构造 ==========

function collectBuiltinTools(stateRef) {
    return collectOpenAIBuiltinTools(stateRef);
}

function formatSystemTools(systemTools) {
    // OpenAI 系统工具直接 spread 到 tools 数组，无需包装
    return systemTools;
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
        state: stateRef
    } = ctx;

    // 1. 组装 messages 数组（注入 system + opening + history + trailing）
    const finalMessages = [...messages];

    // System prompt + Monitor 上下文注入到 system msg.content
    // 原 openai.js 行为：找已有 system msg append，否则 unshift 一条
    const systemPieces = [];
    if (systemCtx.systemPrompt) systemPieces.push(systemCtx.systemPrompt);

    if (systemPieces.length > 0) {
        finalMessages.unshift({ role: 'system', content: systemPieces.join('') });
    }

    if (systemCtx.monitorContext) {
        const sysMsg = finalMessages.find((m) => m.role === 'system');
        if (sysMsg) {
            sysMsg.content += systemCtx.monitorContext;
        } else {
            finalMessages.unshift({ role: 'system', content: systemCtx.monitorContext });
        }
    }

    // 开场对话插入到 System Prompt 之后、对话历史之前
    if (prefill && prefill.opening.length > 0) {
        const systemIndex = finalMessages.findIndex((m) => m.role === 'system');
        const insertIndex = systemIndex >= 0 ? systemIndex + 1 : 0;
        finalMessages.splice(insertIndex, 0, ...prefill.opening);
    }

    // 预填充消息追加到末尾（用户最新消息之后）
    if (prefill && prefill.trailing.length > 0) {
        finalMessages.push(...prefill.trailing);
    }

    // 2. 构建请求体
    const requestBody = {
        model: model,
        stream: stateRef.streamEnabled,
        messages: finalMessages
    };

    // 3. 模型参数
    Object.assign(requestBody, modelParams);
    if (thinkingCfg) Object.assign(requestBody, thinkingCfg);
    if (verbosityCfg) Object.assign(requestBody, verbosityCfg);

    // 4. 工具：XML 模式注入 system，原生模式塞 tools 字段
    if (tools.length > 0) {
        if (isXmlMode) {
            injectToolsToOpenAI(finalMessages, tools);
            const stats = getXMLInjectionStats(tools);
            logger.debug('[openai-chat] XML 模式注入统计:', stats);
            if (stats.estimatedTokens > 2000) {
                logger.warn(
                    '[openai-chat] XML 描述过长，预计消耗',
                    stats.estimatedTokens,
                    'tokens'
                );
            }
        } else {
            requestBody.tools = tools;
            requestBody.tool_choice = 'auto';
            requestBody.parallel_tool_calls = true;
            logger.debug('[openai-chat] 原生 tools 模式，工具数量:', tools.length);
        }
    }

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
    filterPosition: 'after', // 历史行为：转换后过滤（与 Claude/Gemini 不同）
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
