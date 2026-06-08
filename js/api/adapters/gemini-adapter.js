/**
 * Gemini API Adapter — Google AI Studio + Vertex AI 差异化逻辑（contents 字段 +
 * functionCall + thoughtSignature）。buildRequestBody 异步以支持图片压缩；
 * resolveEndpoint / buildHeaders / buildQueryString 区分原生 Gemini provider 与统一代理。
 */

import { logger } from '../../utils/logger.js';
import { state, elements } from '../../core/state.js';
import { PartType, Role, ToolMode, ToolState } from '../../messages/schema.js';
import { parseDataURL } from '../../utils/file-helpers.js';
import { extractXMLToolCalls, appendXmlToolResultsForMessage } from '../../tools/xml-formatter.js';
import { parseThinkTags } from '../../stream/think-tag-parser.js';
import { isVideoMimeType, isAudioMimeType } from '../../utils/media.js';
import { getMappedId, generateIdSet, ensureIdMap } from '../format-converter.js';
import { compressImage } from '../../utils/images.js';
import { getCurrentProvider } from '../current.js';
import { injectToolsToGemini, getXMLInjectionStats } from '../../tools/tool-injection.js';
import { GeminiStreamParser, parseGeminiStream } from '../../stream/parser-gemini.js';
import { isTextFile, stringifyToolResult } from './openai-shared.js';
import { TOOL_INTERRUPTED_MESSAGE } from '../../utils/constants.js';

// ========== 辅助 ==========

/**
 * 构建 Gemini functionResponse 的 response 对象
 *
 * 失败结果 {error, is_error, ...} 或任意非 .content 结构（自定义 MCP / bash 输出）若仅
 * 取 .content 会丢成空串。统一通过 stringifyToolResult 序列化保证模型看到错误/原始信息。
 */
function buildGeminiToolResponse(result) {
    if (!result) return { result: '' };

    // 有媒体时使用 parts 格式
    if (result.media && result.media.length > 0) {
        const parts = [];
        const textBody = stringifyToolResult(result, '');
        if (textBody) {
            parts.push({ text: textBody });
        }
        for (const m of result.media) {
            const parsed = parseDataURL(m.url);
            if (parsed) {
                parts.push({ inlineData: { mimeType: parsed.mimeType, data: parsed.base64 } });
            }
        }
        return { parts };
    }

    // 纯文本：JSON 字符串原样解析为对象，否则字符串透传
    const content = stringifyToolResult(result, '');
    try {
        return { result: JSON.parse(content) };
    } catch {
        return { result: content };
    }
}

// ========== partsToAPIMessages ==========

/**
 * 新格式 → Gemini API contents 数组
 *
 * system 消息被过滤（Gemini 用 systemInstruction 参数）。
 * thinking parts 转为 parts[{text, thought:true}]。
 * tool_call 和结果在同一层级处理（model functionCall + user functionResponse）。
 */
function partsToAPIMessages(msgs, _opts = {}) {
    const out = [];

    for (const msg of msgs) {
        if (msg.error || msg.isError) continue;
        if (msg.role === Role.SYSTEM) continue;

        // 旧数据 idMap 缺槽补齐：避免下方 getMappedId 走 generateFormatId 兜底
        // 拿到与服务端原 fc.id 失联的临时 id，造成 functionCall ↔ functionResponse 配对错位
        for (const p of msg.parts || []) {
            if (p.type === PartType.TOOL_CALL) ensureIdMap(p);
        }

        const role = msg.role === Role.ASSISTANT ? 'model' : msg.role;
        const parts = [];
        const toolCallParts = [];
        // Gemini 严格校验：parallel call 只第一个 functionCall 带 signature，
        // sequential（同 message 内 thinking → fc → thinking → fc 交替）每组首个独立 signature。
        // 每次新 thinking 进来重置 group flag，使下一组 functionCall 重新可挂一次 signature。
        let lastThinkingSignature = null;
        let signatureUsedForToolCallGroup = false;

        for (const p of msg.parts || []) {
            switch (p.type) {
                case PartType.THINKING:
                    // 用户编辑过的 thinking 跳过（失去原 signature，发回 Gemini 也无效）
                    if (p._edited) break;
                    parts.push({ text: p.text, thought: true });
                    if (p.signature) {
                        // signatureFormat 守门：Claude/OpenAI signature 与 Gemini thoughtSignature
                        // 协议不兼容，跨格式继承会触发 Gemini INVALID_ARGUMENT 400。
                        // 老消息无 signatureFormat 走宽容模式
                        if (p.signatureFormat && p.signatureFormat !== 'gemini') break;
                        lastThinkingSignature = p.signature;
                        signatureUsedForToolCallGroup = false;
                    }
                    break;
                case PartType.TEXT:
                    parts.push({ text: p.text });
                    break;
                case PartType.MEDIA:
                case PartType.FILE: {
                    if (p.type === PartType.FILE && isTextFile(p)) {
                        parts.push({
                            text: `<document name="${p.name}">\n${p.url}\n</document>`
                        });
                    } else {
                        const parsed = parseDataURL(p.url);
                        if (parsed) {
                            parts.push({
                                inlineData: { mimeType: parsed.mimeType, data: parsed.base64 }
                            });
                        } else {
                            logger.warn(
                                '[gemini] 媒体非 base64 格式，已跳过:',
                                p.name || p.url?.substring(0, 60)
                            );
                        }
                    }
                    break;
                }
                case PartType.TOOL_CALL: {
                    // XML 模式产生的工具调用以 <tool_use> 字符串形式存活于 TEXT part，
                    // 不输出 native functionCall；对应结果由 appendXmlToolResults 追加
                    if (p.mode === ToolMode.XML) break;
                    // 多回复 BufferedSink 拦截的工具调用不下发 functionCall，下方 toolCallParts
                    // 也不收集 → 不输出 functionResponse 配对
                    if (p.state === ToolState.SKIPPED) break;
                    let args = p.args || {};
                    if (typeof args === 'string') {
                        try {
                            args = JSON.parse(args);
                        } catch {
                            args = {};
                        }
                    }
                    const callPart = {
                        functionCall: { name: p.name, args }
                    };
                    // 优先 part 自带 signature（fc 自带签名场景），fallback 到上一个 thinking 签名
                    const sigForCall = p.thoughtSignature || lastThinkingSignature;
                    // part 自带签名时强制开新 group，否则同 message 内多 fc 共享一个 sig 触发 position N 缺签报错
                    if (p.thoughtSignature) {
                        callPart.thoughtSignature = p.thoughtSignature;
                        // 此 fc 自带签名后，已挂的 lastThinkingSignature 不再借用给后续 fc
                        signatureUsedForToolCallGroup = true;
                    } else if (sigForCall && !signatureUsedForToolCallGroup) {
                        // 每组第一个 functionCall 挂 signature，同组后续不重复（Gemini API 规范）
                        callPart.thoughtSignature = sigForCall;
                        signatureUsedForToolCallGroup = true;
                    }
                    parts.push(callPart);
                    toolCallParts.push(p);
                    break;
                }
            }
        }

        // 源消息有 part 但全部被跳过（XML 模式 tool_call / _edited thinking）
        const sourcePartCount = (msg.parts || []).length;
        if (parts.length === 0 && toolCallParts.length === 0 && sourcePartCount > 0) {
            continue;
        }

        if (parts.length === 0) {
            parts.push({ text: '' });
        }

        const outMsg = { role, parts };
        // 无 functionCall 响应：signature 落在 message 末尾（项目历史路径，保留兼容）
        if (lastThinkingSignature && !signatureUsedForToolCallGroup && toolCallParts.length === 0) {
            outMsg.thoughtSignature = lastThinkingSignature;
        }

        out.push(outMsg);

        // 拆出 tool 结果为 user 消息
        if (toolCallParts.length > 0) {
            const responseParts = [];
            for (const p of toolCallParts) {
                const geminiId = getMappedId(p, 'gemini');
                const response = p.result
                    ? buildGeminiToolResponse(p.result)
                    : { content: TOOL_INTERRUPTED_MESSAGE };
                const frPart = { functionResponse: { name: p.name, response } };
                // 仅当原始 id 是 Gemini API 真给的 fc.id 时回传；parser 兜底生成的 gemini_tc_*
                // 或跨格式 generateIdSet 生成的 gemini_* 都跳过（Gemini 不接受外部臆造 id）
                if (geminiId === p.id && !geminiId.startsWith('gemini_tc_')) {
                    frPart.functionResponse.id = geminiId;
                }
                responseParts.push(frPart);
            }
            if (responseParts.length > 0) {
                out.push({ role: 'user', parts: responseParts });
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
    if (data.error) return null;
    if (!data.candidates || data.candidates.length === 0) return null;
    const xmlMode = state.xmlToolCallingEnabled;

    const candidate = data.candidates[0];
    if (!candidate.content || !candidate.content.parts) return null;

    // 1. 优先检测原生工具调用 — 不早 return，下方统一抽取 thinking/thoughtSignature/contentParts
    // 让 saveAssistantMessage 落库的 part 含完整 thinking + signature，下轮 resendWithToolResults
    // 重发时 Gemini 校验 thoughtSignature 才不会拒绝 'thoughtSignature required'
    const toolCalls = [];
    for (let i = 0; i < candidate.content.parts.length; i++) {
        const part = candidate.content.parts[i];
        if (part.functionCall) {
            const fcId = part.functionCall.id || `gemini_tc_${Date.now()}_${i}`;
            toolCalls.push({
                id: fcId,
                name: part.functionCall.name,
                arguments: part.functionCall.args,
                mode: ToolMode.NATIVE,
                // Gemini fc.id 不带前缀，显式标记 originalFormat='gemini' 让 idMap.gemini 槽直接归位
                // 跨格式重发时 openai/claude 槽走 generate 兜底
                idMap: generateIdSet(fcId, 'gemini')
            });
        }
    }

    // 2. XML 兜底：仅在原生 functionCall 不存在时检测（XML/native 互斥）
    if (xmlMode && toolCalls.length === 0) {
        let allText = '';
        for (const part of candidate.content.parts) {
            if (part.text) {
                allText += part.text;
            }
        }

        if (allText) {
            const xmlToolCalls = extractXMLToolCalls(allText);
            if (xmlToolCalls.length > 0) {
                logger.debug('[gemini] 检测到 XML 工具调用:', xmlToolCalls.length);
                return {
                    toolCalls: xmlToolCalls.map((tc) => ({ ...tc, mode: ToolMode.XML })),
                    content: allText,
                    hasToolCalls: true
                };
            }
        }
    }

    // 提取 thoughtSignature（如果有）
    let thoughtSignature = null;
    let thinkingContent = '';
    let textContent = '';

    // 从 parts 中提取内容和 thoughtSignature
    for (const part of candidate.content.parts) {
        if (part.thoughtSignature) {
            thoughtSignature = part.thoughtSignature;
        }
        if (part.thought) {
            // Gemini 2.5/3 的思维链可能在 part.thought 为 true 时
            thinkingContent += part.text || '';
        } else if (part.text) {
            const { displayText: thinkParsedText, thinkingContent: thinkContent } = parseThinkTags(
                part.text
            );
            if (thinkContent) {
                thinkingContent += thinkContent;
            }
            textContent += thinkParsedText;
        }
    }

    // 检查顶层的 reasoning 字段（某些 SDK/代理返回格式）
    if (data.reasoning && !thinkingContent) {
        thinkingContent = data.reasoning;
    }

    // 检查 metadata 中的 reasoning 字段
    if (data.metadata?.gemini?.reasoning && !thinkingContent) {
        thinkingContent = data.metadata.gemini.reasoning;
    }

    // 检查 usageMetadata 中的思维链 token 统计
    const reasoningTokens =
        data.usageMetadata?.thoughts_token_count ||
        data.usage?.completion_tokens_details?.reasoning_tokens;

    const contentParts = [];

    // 先添加思维链（如果有）
    if (thinkingContent) {
        contentParts.push({ type: 'thinking', text: thinkingContent });
    }

    for (const part of candidate.content.parts) {
        if (part.text && !part.thought) {
            const { displayText: thinkParsedText } = parseThinkTags(part.text);
            if (thinkParsedText) {
                contentParts.push({ type: 'text', text: thinkParsedText });
            }
        } else if (part.inlineData || part.inline_data) {
            const inlineData = part.inlineData || part.inline_data;
            const mimeType = inlineData.mimeType || inlineData.mime_type;
            const dataUrl = `data:${mimeType};base64,${inlineData.data}`;
            const mediaType = isVideoMimeType(mimeType)
                ? 'video_url'
                : isAudioMimeType(mimeType)
                  ? 'audio_url'
                  : 'image_url';
            contentParts.push({ type: mediaType, url: dataUrl, complete: true, mimeType });
        }
    }

    // 原生 functionCall 路径：保留全部 thinking/contentParts/thoughtSignature 上下文，
    // handler.js 据 hasToolCalls 走 handleToolCallStream 分支并按 reply.toolCalls 执行工具
    const hasNativeToolCalls = toolCalls.length > 0;

    return {
        parts: candidate.content.parts,
        content: textContent,
        thinkingContent: thinkingContent || null,
        thoughtSignature: thoughtSignature,
        groundingMetadata: candidate.groundingMetadata,
        reasoningTokens: reasoningTokens || null,
        contentParts: contentParts.length > 0 ? contentParts : null,
        toolCalls: hasNativeToolCalls ? toolCalls : undefined,
        hasToolCalls: hasNativeToolCalls
    };
}

// ========== 工具构造 ==========

function collectBuiltinTools(stateRef) {
    const tools = [];
    if (stateRef.codeExecutionEnabled) {
        tools.push({ codeExecution: {} });
    }
    if (stateRef.webSearchEnabled) {
        tools.push({ googleSearch: {} });
        tools.push({ urlContext: {} });
    }
    return tools;
}

/**
 * Gemini 要求系统工具包装在 functionDeclarations 数组中
 */
function formatSystemTools(systemTools) {
    if (!systemTools || systemTools.length === 0) return [];
    return [{ functionDeclarations: systemTools }];
}

// ========== buildRequestBody 辅助 ==========

/**
 * 处理 contents 用于发送请求：压缩历史图片
 */
async function processContentsForRequest(contents) {
    const processed = [];

    for (let i = 0; i < contents.length; i++) {
        const content = contents[i];
        const isLastMessage = i === contents.length - 1;

        // 最后一条消息（当前用户输入）保持完整
        if (isLastMessage) {
            processed.push(content);
            continue;
        }

        // 处理 parts
        const processedParts = [];
        for (const part of content.parts || []) {
            if (part.inlineData || part.inline_data) {
                const inlineData = part.inlineData || part.inline_data;
                const mimeType = inlineData.mimeType || inlineData.mime_type;
                const data = inlineData.data;

                const compressed = await compressImage(data, mimeType, { apiFormat: 'gemini' });

                processedParts.push({
                    inlineData: {
                        mimeType: compressed.mimeType,
                        data: compressed.data
                    },
                    ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {})
                });
            } else {
                processedParts.push(part);
            }
        }

        processed.push({
            role: content.role,
            parts: processedParts,
            ...(content.thoughtSignature ? { thoughtSignature: content.thoughtSignature } : {})
        });
    }

    return processed;
}

/**
 * 构建带 thoughtSignature 的 Gemini contents
 * 每条消息保留自己的签名，不做全局传播
 */
function buildGeminiContentsWithSignatures(contents) {
    return contents.map((content) => {
        const msgSignature = content.thoughtSignature || null;
        const partSignature =
            content.parts?.find((p) => p.thoughtSignature)?.thoughtSignature || null;
        const signature = msgSignature || partSignature;

        if (signature) {
            return {
                role: content.role,
                parts: content.parts.map((part) => ({
                    ...part,
                    thoughtSignature: signature
                }))
            };
        }

        return {
            role: content.role,
            parts: content.parts
        };
    });
}

// ========== buildRequestBody ==========

/**
 * Gemini buildRequestBody 是异步的（含图片压缩）。Pipeline 必须 await。
 */
async function buildRequestBody(ctx) {
    const { messages, modelParams, thinkingCfg, systemCtx, prefill, tools, isXmlMode } = ctx;

    // ⚠️ 安全检查：如果所有消息都被过滤掉，抛出错误
    if (messages.length === 0) {
        throw new Error('所有消息都被过滤，无法发送请求。请至少输入一条有效消息。');
    }

    // 1. 构建 generationConfig
    const generationConfig = { ...modelParams };

    // 图片配置
    const imageSize = elements.imageSizeSelect?.value;
    if (imageSize) {
        generationConfig.responseModalities = ['TEXT', 'IMAGE'];
        generationConfig.imageConfig = { imageSize };
    }

    // 思维链配置（Gemini 嵌入到 generationConfig.thinkingConfig）
    if (thinkingCfg?.thinkingConfig) {
        generationConfig.thinkingConfig = thinkingCfg.thinkingConfig;
    }

    // 2. safetySettings：Vertex AI 10 类 OFF / AI Studio 5 类 BLOCK_NONE
    const baseEndpoint = ctx.endpoint || '';
    const isVertex = baseEndpoint.includes('aiplatform.googleapis.com');
    const safetySettings = isVertex
        ? [
              { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'OFF' },
              { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'OFF' },
              { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'OFF' },
              { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'OFF' },
              { category: 'HARM_CATEGORY_CIVIC_INTEGRITY', threshold: 'OFF' },
              { category: 'HARM_CATEGORY_IMAGE_HATE', threshold: 'OFF' },
              { category: 'HARM_CATEGORY_IMAGE_DANGEROUS_CONTENT', threshold: 'OFF' },
              { category: 'HARM_CATEGORY_IMAGE_HARASSMENT', threshold: 'OFF' },
              { category: 'HARM_CATEGORY_IMAGE_SEXUALLY_EXPLICIT', threshold: 'OFF' },
              { category: 'HARM_CATEGORY_JAILBREAK', threshold: 'OFF' }
          ]
        : [
              { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
              { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
              { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
              { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
              { category: 'HARM_CATEGORY_CIVIC_INTEGRITY', threshold: 'BLOCK_NONE' }
          ];

    // 3. 压缩历史图片
    const processedContents = await processContentsForRequest(messages);

    // 4. 开场对话插入到对话历史之前（Gemini 的 systemInstruction 是独立参数）
    let finalContents = processedContents;
    if (prefill && prefill.opening.length > 0) {
        finalContents = [...prefill.opening, ...processedContents];
    }
    // 预填充消息追加到末尾（用户最新消息之后）
    if (prefill && prefill.trailing.length > 0) {
        finalContents = [...finalContents, ...prefill.trailing];
    }

    // 5. 构建带 thoughtSignature 的 contents
    const contentsWithSignatures = buildGeminiContentsWithSignatures(finalContents);

    const requestBody = {
        contents: contentsWithSignatures,
        generationConfig: generationConfig,
        safetySettings: safetySettings
    };

    // 6. System Instruction（含 monitor 上下文 + geminiSystemParts 多段）
    const systemParts = [];
    if (systemCtx.geminiSystemParts && systemCtx.geminiSystemParts.length > 0) {
        // 多段 system parts（geminiSystemPartsEnabled）
        systemParts.push(...systemCtx.geminiSystemParts);
    } else if (systemCtx.systemPrompt) {
        systemParts.push({ text: systemCtx.systemPrompt });
    }
    if (systemCtx.monitorContext) {
        systemParts.push({ text: systemCtx.monitorContext });
    }

    if (systemParts.length > 0) {
        requestBody.systemInstruction = { parts: systemParts };
    }

    // 7. 工具
    if (tools.length > 0) {
        if (isXmlMode) {
            injectToolsToGemini(requestBody, tools);
            const stats = getXMLInjectionStats(tools);
            logger.debug('[gemini] XML 模式注入统计:', stats);
        } else {
            requestBody.tools = tools;
            logger.debug('[gemini] 原生 tools 模式，工具数量:', tools.length);
        }
    }

    return requestBody;
}

// ========== Endpoint / Headers / Query ==========

/**
 * Gemini 端点拼接：
 * - 原生 Gemini provider：清理 OpenAI/Claude 路径残留 → 拼 /v1beta/models/{model}:{action}
 * - 统一代理（OpenAI/Claude/Responses provider 切到 gemini 格式）：保持原 endpoint
 */
function resolveEndpoint(baseEndpoint, model, isStreaming) {
    const action = isStreaming ? 'streamGenerateContent' : 'generateContent';
    const provider = getCurrentProvider();
    const isNativeGeminiProvider = provider && provider.apiFormat === 'gemini';

    if (isNativeGeminiProvider) {
        let cleanedEndpoint = baseEndpoint.replace(/\/$/, '');
        cleanedEndpoint = cleanedEndpoint
            .replace(/\/v1\/chat\/completions$/, '')
            .replace(/\/chat\/completions$/, '')
            .replace(/\/v1\/messages$/, '')
            .replace(/\/messages$/, '')
            .replace(/\/v1\/responses$/, '')
            .replace(/\/responses$/, '');
        return `${cleanedEndpoint}/v1beta/models/${model}:${action}`;
    }
    return baseEndpoint.replace(/\/$/, '');
}

/**
 * Gemini headers：根据 state.geminiApiKeyInHeader 决定 API key 走 header 还是 query
 */
function buildHeaders(apiKey, _ctx) {
    if (state.geminiApiKeyInHeader) {
        return { 'x-goog-api-key': apiKey };
    }
    return {};
}

/**
 * Gemini query string：
 * - header 模式：流式加 alt=sse
 * - query 模式：key=...&alt=sse（流式）或 key=...（非流式）
 */
function buildQueryString(apiKey, _ctx) {
    if (state.geminiApiKeyInHeader) {
        return state.streamEnabled ? 'alt=sse' : '';
    }
    return state.streamEnabled ? `key=${apiKey}&alt=sse` : `key=${apiKey}`;
}

// ========== Adapter 对象 + 注册 ==========

// 统一 (reader, sessionId, sink, signal) 入口签名，parseGeminiStream 内部完成构造 + 解析
function streamParser(reader, sessionId, sink = null, signal = null) {
    return parseGeminiStream(reader, sessionId, sink, signal);
}

export const geminiAdapter = Object.freeze({
    name: 'Gemini',
    apiFormat: 'gemini',
    filterPosition: 'before',
    signatureFormat: 'gemini',

    parserClass: GeminiStreamParser,
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
