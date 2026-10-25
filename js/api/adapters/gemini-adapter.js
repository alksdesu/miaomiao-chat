/**
 * Gemini API Adapter — Google AI Studio + Vertex AI 差异化逻辑（contents 字段 +
 * functionCall + thoughtSignature）。buildRequestBody 异步以支持图片压缩；
 * resolveEndpoint / buildHeaders / buildQueryString 区分原生 Gemini provider 与统一代理。
 */

import { logger } from '../../utils/logger.js';
import { PartType, Role, ToolMode, ToolState } from '../../messages/schema.js';
import { parseDataURL } from '../../utils/file-helpers.js';
import { processVariables } from '../../utils/variables.js';
import { extractXMLToolCalls, appendXmlToolResultsForMessage } from '../../tools/xml-formatter.js';
import { parseThinkTags } from '../../stream/think-tag-parser.js';
import { isVideoMimeType, isAudioMimeType } from '../../utils/media.js';
import { getMappedId, generateIdSet, ensureIdMap } from '../format-converter.js';
import { compressImage } from '../../utils/images.js';
import { injectToolsToGemini, getXMLInjectionStats } from '../../tools/tool-injection.js';
import {
    GeminiStreamParser,
    parseGeminiStream,
    resolveFunctionCallSignature
} from '../../stream/parser-gemini.js';
import { isTextFile, stringifyToolResult } from './openai-shared.js';
import { TOOL_INTERRUPTED_MESSAGE } from '../../utils/constants.js';
import {
    resolveThinkingBudget,
    nearestBudgetStrength,
    clampToSupportedLevel
} from '../reasoning.js';
import { normalizeGeminiStop } from '../../messages/stop-reason.js';
import { pushXmlBuiltinToolsNotice } from '../request-notices.js';

const GEMINI_THINKING_BUDGETS = Object.freeze({ low: 4096, medium: 8192, high: 16384 });
// 思考档位由低到高
const GEMINI_THINKING_LEVELS = Object.freeze(['minimal', 'low', 'medium', 'high']);
const GEMINI_IMAGE_SIZES = Object.freeze(['1K', '2K', '4K']);
const GEMINI_SAMPLING_KEYS = Object.freeze(['temperature', 'topP', 'topK']);
// 长输出型号单次输出上限低于该值时，长回复容易在上限处截断
const LONG_DECODE_MIN_OUTPUT_TOKENS = 32768;
// 未识别的型号按名称判断是否为出图模型
const IMAGE_MODEL_PATTERN = /image|nano-banana/;

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
        if (msg.error) continue;
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

        // 不含函数调用的回复把签名放回最后一个 part，与服务端返回签名的位置一致
        if (lastThinkingSignature && !signatureUsedForToolCallGroup && toolCallParts.length === 0) {
            const lastIndex = parts.length - 1;
            parts[lastIndex] = { ...parts[lastIndex], thoughtSignature: lastThinkingSignature };
        }

        out.push({ role, parts });

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

function parseResponse(data, options = {}) {
    if (data.error) return null;
    const candidate = data.candidates?.[0];
    const stop = normalizeGeminiStop({
        finishReason: candidate?.finishReason,
        finishMessage: candidate?.finishMessage,
        blockReason: data.promptFeedback?.blockReason,
        blockReasonMessage: data.promptFeedback?.blockReasonMessage
    });
    // prompt 被拦截时没有候选，候选被安全拦截时没有 content，只带回结束原因，由 handler 按空回复处理
    if (!candidate?.content?.parts) return { content: '', stop };
    const xmlMode = options.isXmlMode === true;

    // 1. 优先检测原生工具调用 — 不早 return，下方统一抽取 thinking/thoughtSignature/contentParts
    // 让 saveAssistantMessage 落库的 part 含完整 thinking + signature，下轮 resendWithToolResults
    // 重发时 Gemini 校验 thoughtSignature 才不会拒绝 'thoughtSignature required'
    const toolCalls = [];
    let latestSignature = null;
    for (let i = 0; i < candidate.content.parts.length; i++) {
        const part = candidate.content.parts[i];
        if (part.thoughtSignature) latestSignature = part.thoughtSignature;
        if (part.functionCall) {
            const fcId = part.functionCall.id || `gemini_tc_${Date.now()}_${i}`;
            toolCalls.push({
                id: fcId,
                name: part.functionCall.name,
                arguments: part.functionCall.args,
                thoughtSignature: resolveFunctionCallSignature(
                    part,
                    latestSignature,
                    toolCalls.length
                ),
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
        hasToolCalls: hasNativeToolCalls,
        stop
    };
}

// ========== 工具构造 ==========

// 服务端工具由 Google 执行；XML 模式下工具写进提示词，服务端工具无法这样调用
function collectBuiltinTools(stateRef, { notices } = {}) {
    if (stateRef.xmlToolCallingEnabled) {
        pushXmlBuiltinToolsNotice(stateRef, notices);
        return [];
    }
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

// ========== 生成参数与格式设置 ==========

/**
 * 设置面板强度 → 思考档位；custom 按最接近的预算档位换算，xhigh / max 归到 high
 * @param {import('../reasoning.js').ReasoningIntent} reasoning
 * @returns {string}
 */
function levelFromIntent(reasoning) {
    if (reasoning.strength === 'custom') {
        return nearestBudgetStrength(reasoning.budget, GEMINI_THINKING_BUDGETS);
    }
    if (reasoning.strength === 'xhigh' || reasoning.strength === 'max') return 'high';
    return GEMINI_THINKING_LEVELS.includes(reasoning.strength) ? reasoning.strength : 'high';
}

// 未识别的型号按名称推断：3 代及以后与 Nano Banana 用思考档位，更早的型号用思考预算
function inferThinkingMode(model) {
    const id = String(model || '').toLowerCase();
    if (id.includes('nano-banana')) return 'level';
    const match = /gemini-?(\d+)/.exec(id);
    return match && Number(match[1]) >= 3 ? 'level' : 'budget';
}

function levelThinking(level, includeThoughts) {
    const thinkingConfig = { thinkingLevel: level.toUpperCase() };
    if (includeThoughts) thinkingConfig.includeThoughts = true;
    return { thinkingConfig };
}

function budgetThinking(budget, includeThoughts) {
    const thinkingConfig = { thinkingBudget: budget };
    if (includeThoughts) thinkingConfig.includeThoughts = true;
    return { thinkingConfig };
}

/**
 * 已识别的型号按能力表收敛档位与预算；关闭思维链时改发最低档位或关闭预算，
 * 否则省略 thinkingConfig 等于按型号默认档位思考
 * @param {import('../reasoning.js').ReasoningIntent} reasoning
 * @param {Object} rules profile.thinking
 * @param {string} model
 * @param {import('../request-notices.js').RequestNotice[]} notices
 * @returns {Object|null}
 */
function buildThinkingConfig(reasoning, rules, model, notices) {
    const known = rules.mode !== 'auto';
    const mode = known ? rules.mode : inferThinkingMode(model);

    if (!reasoning.enabled) {
        if (!known) return null;
        if (mode === 'level') return levelThinking(rules.levels[0], false);
        return budgetThinking(rules.offBudget ?? rules.budgetRange[0], false);
    }

    if (mode === 'level') {
        const requested = levelFromIntent(reasoning);
        const level = clampToSupportedLevel(requested, GEMINI_THINKING_LEVELS, rules.levels);
        if (level !== requested) {
            notices.push({
                key: 'gemini.thinking-level',
                message: `当前模型不支持思考档位 ${requested}，已改用 ${level}`
            });
        }
        return levelThinking(level, true);
    }

    const requested = resolveThinkingBudget(reasoning, GEMINI_THINKING_BUDGETS);
    if (!rules.budgetRange) return budgetThinking(requested, true);
    const [min, max] = rules.budgetRange;
    const budget = Math.min(Math.max(requested, min), max);
    if (budget !== requested) {
        notices.push({
            key: 'gemini.thinking-budget',
            message: `当前模型的思考预算范围为 ${min} - ${max}，已调整为 ${budget}`
        });
    }
    return budgetThinking(budget, true);
}

/**
 * 采样参数与输出上限只发送用户显式设置的值；已弃用采样参数的型号丢弃并提示
 * @param {import('../params.js').GenerationSettings} settings
 * @param {{ model: string, profile: Object }} ctx
 * @returns {import('./format-adapter-types.js').GenerationParams}
 */
function buildGenerationParams(settings, { model, profile }) {
    const { userParams } = settings;
    const notices = [];
    const modelParams = {};

    const requested = GEMINI_SAMPLING_KEYS.filter(
        (key) => userParams[key] !== null && userParams[key] !== undefined
    );
    if (profile.sampling === 'ignored' && requested.length > 0) {
        notices.push({
            key: 'gemini.sampling',
            message: `当前模型已弃用 ${requested.join(' / ')}，本次请求未发送`
        });
    } else {
        for (const key of requested) modelParams[key] = userParams[key];
    }

    const maxOutputTokens = userParams.maxOutputTokens;
    if (maxOutputTokens !== null && maxOutputTokens !== undefined) {
        modelParams.maxOutputTokens = maxOutputTokens;
        if (profile.longDecode && maxOutputTokens < LONG_DECODE_MIN_OUTPUT_TOKENS) {
            notices.push({
                key: 'gemini.long-decode',
                message: `当前模型建议把 Max Output Tokens 设为 ${LONG_DECODE_MIN_OUTPUT_TOKENS} 以上，过低时长回复会在上限处截断`
            });
        }
    }

    return {
        modelParams,
        thinkingCfg: buildThinkingConfig(settings.reasoning, profile.thinking, model, notices),
        verbosityCfg: null,
        notices
    };
}

/**
 * @param {Object} stateRef
 * @returns {Array<{text: string}>|null}
 */
function collectSystemParts(stateRef) {
    if (!stateRef.geminiSystemPartsEnabled || !Array.isArray(stateRef.geminiSystemParts)) {
        return null;
    }
    const parts = stateRef.geminiSystemParts
        .filter((p) => p.text && p.text.trim())
        .map((p) => ({ text: processVariables(p.text) }));
    return parts.length > 0 ? parts : null;
}

/**
 * Gemini 专属设置快照：API Key 传递方式、出图尺寸与宽高比、多段 system parts
 * @param {Object} stateRef
 * @returns {{ apiKeyInHeader: boolean, imageSize: string, imageAspectRatio: string, systemParts: Array|null }}
 */
function captureFormatSettings(stateRef) {
    return {
        apiKeyInHeader: !!stateRef.geminiApiKeyInHeader,
        imageSize: stateRef.imageSize || '',
        imageAspectRatio: stateRef.imageAspectRatio || '',
        systemParts: collectSystemParts(stateRef)
    };
}

// ========== buildRequestBody 辅助 ==========

const SAFETY_POLICIES = Object.freeze({
    vertex: Object.freeze({
        threshold: 'OFF',
        categories: Object.freeze([
            'HARM_CATEGORY_HATE_SPEECH',
            'HARM_CATEGORY_DANGEROUS_CONTENT',
            'HARM_CATEGORY_HARASSMENT',
            'HARM_CATEGORY_SEXUALLY_EXPLICIT',
            'HARM_CATEGORY_CIVIC_INTEGRITY',
            'HARM_CATEGORY_IMAGE_HATE',
            'HARM_CATEGORY_IMAGE_DANGEROUS_CONTENT',
            'HARM_CATEGORY_IMAGE_HARASSMENT',
            'HARM_CATEGORY_IMAGE_SEXUALLY_EXPLICIT',
            'HARM_CATEGORY_JAILBREAK'
        ])
    }),
    // AI Studio 只开放这四类；OFF 不再计算安全评分，BLOCK_NONE 仍会多算一遍
    aiStudio: Object.freeze({
        threshold: 'OFF',
        categories: Object.freeze([
            'HARM_CATEGORY_HATE_SPEECH',
            'HARM_CATEGORY_DANGEROUS_CONTENT',
            'HARM_CATEGORY_HARASSMENT',
            'HARM_CATEGORY_SEXUALLY_EXPLICIT'
        ])
    })
});

/**
 * @param {string} [endpoint] 用户配置的原始端点，用于区分 Vertex AI 与 AI Studio
 * @returns {Array<{category: string, threshold: string}>}
 */
function buildSafetySettings(endpoint) {
    const policy = (endpoint || '').includes('aiplatform.googleapis.com')
        ? SAFETY_POLICIES.vertex
        : SAFETY_POLICIES.aiStudio;
    return policy.categories.map((category) => ({ category, threshold: policy.threshold }));
}

/**
 * 出图配置只发给能出图的型号；用户在模型能力里标明不支持图片输出时始终不发
 * @returns {boolean}
 */
function supportsImageOutput(model, profile, capabilities) {
    if (capabilities?.imageOutput === false) return false;
    if (profile.image.output !== null) return profile.image.output;
    return IMAGE_MODEL_PATTERN.test(String(model || '').toLowerCase());
}

function resolveImageSize(size, supported, notices) {
    if (!supported || supported.includes(size)) return size;
    if (supported.length === 0) {
        notices.push({
            key: 'gemini.image-size',
            message: '当前模型不支持指定图片尺寸，已按模型默认尺寸生成'
        });
        return null;
    }
    const fallback = clampToSupportedLevel(size, GEMINI_IMAGE_SIZES, supported);
    notices.push({
        key: 'gemini.image-size',
        message: `当前模型不支持 ${size} 图片尺寸，已改用 ${fallback}`
    });
    return fallback;
}

/**
 * 尺寸与宽高比按型号收敛，都未指定时不发 imageConfig，由模型按默认 1K 生成
 * @returns {Object|null}
 */
function buildImageConfig({ imageSize, imageAspectRatio }, rules, notices) {
    const imageConfig = {};
    if (imageSize) {
        const size = resolveImageSize(imageSize, rules.sizes, notices);
        if (size) imageConfig.imageSize = size;
    }
    if (imageAspectRatio) {
        if (!rules.aspectRatios || rules.aspectRatios.includes(imageAspectRatio)) {
            imageConfig.aspectRatio = imageAspectRatio;
        } else {
            notices.push({
                key: 'gemini.image-aspect',
                message: `当前模型不支持 ${imageAspectRatio} 宽高比，已按模型默认比例生成`
            });
        }
    }
    return Object.keys(imageConfig).length > 0 ? imageConfig : null;
}

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

        processed.push({ role: content.role, parts: processedParts });
    }

    return processed;
}

// ========== buildRequestBody ==========

/**
 * Gemini buildRequestBody 是异步的（含图片压缩）。Pipeline 必须 await。
 */
async function buildRequestBody(ctx) {
    const {
        messages,
        model,
        modelParams,
        thinkingCfg,
        systemCtx,
        prefill,
        tools,
        isXmlMode,
        profile,
        capabilities,
        notices
    } = ctx;
    const {
        imageSize = '',
        imageAspectRatio = '',
        systemParts: configuredSystemParts = null
    } = ctx.formatSettings || {};

    // ⚠️ 安全检查：如果所有消息都被过滤掉，抛出错误
    if (messages.length === 0) {
        throw new Error('所有消息都被过滤，无法发送请求。请至少输入一条有效消息。');
    }

    // 1. 构建 generationConfig
    const generationConfig = { ...modelParams };

    if (supportsImageOutput(model, profile, capabilities)) {
        generationConfig.responseModalities = ['TEXT', 'IMAGE'];
        const imageConfig = buildImageConfig(
            { imageSize, imageAspectRatio },
            profile.image,
            notices
        );
        if (imageConfig) generationConfig.imageConfig = imageConfig;
    }

    // 思维链配置（Gemini 嵌入到 generationConfig.thinkingConfig）
    if (thinkingCfg?.thinkingConfig) {
        generationConfig.thinkingConfig = thinkingCfg.thinkingConfig;
    }

    // 2. safetySettings：Vertex AI 与 AI Studio 可调类别不同
    const safetySettings = buildSafetySettings(ctx.endpoint);

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

    const requestBody = {
        contents: finalContents,
        generationConfig: generationConfig,
        safetySettings: safetySettings
    };

    // 5. System Instruction：多段 system parts 优先于单段 systemPrompt，monitor 上下文追加在后
    const systemParts = [];
    if (configuredSystemParts && configuredSystemParts.length > 0) {
        systemParts.push(...configuredSystemParts);
    } else if (systemCtx.systemPrompt) {
        systemParts.push({ text: systemCtx.systemPrompt });
    }
    if (systemCtx.monitorContext) {
        systemParts.push({ text: systemCtx.monitorContext });
    }

    if (systemParts.length > 0) {
        requestBody.systemInstruction = { parts: systemParts };
    }

    // 6. 工具
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
function resolveEndpoint(baseEndpoint, model, isStreaming, _requestBody, { requestProfile }) {
    const action = isStreaming ? 'streamGenerateContent' : 'generateContent';
    const isNativeGeminiProvider = requestProfile.providerApiFormat === 'gemini';

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
 * Gemini headers：按 provider 的 API Key 传递方式决定走 header 还是 query
 */
function buildHeaders(apiKey, { requestProfile }) {
    if (requestProfile.formatSettings?.apiKeyInHeader) {
        return { 'x-goog-api-key': apiKey };
    }
    return {};
}

/**
 * Gemini query string：
 * - header 模式：流式加 alt=sse
 * - query 模式：key=...&alt=sse（流式）或 key=...（非流式）
 */
function buildQueryString(apiKey, { requestProfile }) {
    const { streamEnabled } = requestProfile;
    if (requestProfile.formatSettings?.apiKeyInHeader) {
        return streamEnabled ? 'alt=sse' : '';
    }
    return streamEnabled ? `key=${apiKey}&alt=sse` : `key=${apiKey}`;
}

// ========== Adapter 对象 + 注册 ==========

// 统一 (reader, sessionId, sink, signal) 入口签名，parseGeminiStream 内部完成构造 + 解析
function streamParser(reader, sessionId, sink = null, signal = null) {
    return parseGeminiStream(reader, sessionId, sink, signal);
}

export const geminiAdapter = Object.freeze({
    name: 'Gemini',
    apiFormat: 'gemini',
    signatureFormat: 'gemini',

    parserClass: GeminiStreamParser,
    streamParser,

    partsToAPIMessages,
    parseResponse,

    collectBuiltinTools,
    formatSystemTools,
    buildGenerationParams,
    captureFormatSettings,
    buildRequestBody,
    resolveEndpoint,
    buildHeaders,
    buildQueryString
});
