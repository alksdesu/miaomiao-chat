/**
 * OpenAI Chat / Responses 两个 adapter 共享的辅助函数
 *
 * 内容来源：原 js/messages/api-adapters.js 顶部辅助函数 + js/tools/tool-result-builder.js 的
 * OpenAI 相关 helper。本模块仅供 openai-chat-adapter / openai-responses-adapter 内部使用。
 */

import { logger } from '../../utils/logger.js';
import { parseDataURL } from '../../utils/file-helpers.js';
import { getMappedId } from '../format-converter.js';
import { injectToolsToOpenAI, getXMLInjectionStats } from '../../tools/tool-injection.js';
import { clampToSupportedLevel } from '../reasoning.js';
import { stringifyToolResult, splitToolResultContent } from '../../messages/tool-results.js';

export { stringifyToolResult };

// ========== 通用判定 ==========

/**
 * 判断 FILE part 是否为纯文本内容（非 base64 数据）
 * 优先读 encoding 字段，旧数据兜底用 parseDataURL 试探
 */
export function isTextFile(p) {
    if (p.encoding === 'text') return true;
    if (p.encoding === 'base64') return false;
    return !parseDataURL(p.url);
}

// ========== Responses API reasoning items 处理 ==========

/**
 * Responses API 的 reasoning item 要求 summary 字段存在。
 * 当前程序只保存 encrypted_content，因此没有摘要时回传空数组。
 */
function normalizeReasoningSummary(summary) {
    if (Array.isArray(summary)) return summary;
    if (typeof summary === 'string' && summary.trim()) {
        return [{ type: 'summary_text', text: summary }];
    }
    return [];
}

function normalizeResponsesReasoningItem(item) {
    if (!item || typeof item !== 'object') return null;
    const reasoningItem = {
        type: 'reasoning',
        summary: normalizeReasoningSummary(item.summary)
    };
    if (item.id) reasoningItem.id = item.id;
    if (item.encrypted_content || item.encryptedContent) {
        reasoningItem.encrypted_content = item.encrypted_content || item.encryptedContent;
    }
    if (item.status) reasoningItem.status = item.status;
    if (item._turn !== undefined) reasoningItem._turn = item._turn;
    return reasoningItem.id || reasoningItem.encrypted_content ? reasoningItem : null;
}

export function buildResponsesReasoningItems(msg) {
    const openaiRaw = msg.meta?.raw?.openai;
    if (!openaiRaw) return [];

    if (Array.isArray(openaiRaw.reasoningItems) && openaiRaw.reasoningItems.length > 0) {
        return openaiRaw.reasoningItems.map(normalizeResponsesReasoningItem).filter(Boolean);
    }

    const encryptedContent = openaiRaw?.encryptedContent;
    const reasoningItemId = openaiRaw?.reasoningItemId;
    if (!encryptedContent && !reasoningItemId) return [];

    const reasoningItem = {
        type: 'reasoning',
        summary: normalizeReasoningSummary(openaiRaw.reasoningSummary)
    };

    if (reasoningItemId) reasoningItem.id = reasoningItemId;
    if (encryptedContent) reasoningItem.encrypted_content = encryptedContent;
    return [reasoningItem];
}

export function getReasoningItemTurn(item) {
    return item?._turn ?? 0;
}

export function stripInternalReasoningFields(item) {
    const publicItem = { ...item };
    delete publicItem._turn;
    return publicItem;
}

// ========== Responses API function_call ID 派生 ==========

export function buildResponsesFunctionCallItemId(itemId, callId) {
    if (typeof itemId === 'string' && itemId.startsWith('fc')) return itemId;

    const base = String(callId || itemId || `generated_${Date.now()}`)
        .replace(/^call_?/, '')
        .replace(/[^A-Za-z0-9_-]/g, '_');
    return `fc_${base || Date.now()}`;
}

/**
 * 取 tool_call part 或临时 toolCall 对象上保存的 Responses API item id。
 * 兼容 part.responseItemId / part.itemId / part.fcId 三种字段名。
 */
export function getResponsesItemId(obj) {
    return obj.responseItemId || obj.itemId || obj.fcId || null;
}

/**
 * @param {Array} out
 * @param {Object} p tool_call part
 * @param {{ includeItemId?: boolean }} [options] 同轮推理项无法回放时不带 item id，
 *     否则服务端会按 id 找到原推理项并以缺少推理项拒绝请求
 */
export function pushResponsesFunctionCallPair(out, p, { includeItemId = true } = {}) {
    // 优先 part.call_id（同轮 OpenAI 原生 call_id），其次 part.idMap.openai（跨格式映射或 lazy 补齐）
    const callId = p.call_id || getMappedId(p, 'openai');
    const functionCall = {
        type: 'function_call',
        call_id: callId,
        name: p.name,
        arguments: typeof p.args === 'string' ? p.args : JSON.stringify(p.args || {})
    };
    if (includeItemId) {
        functionCall.id = buildResponsesFunctionCallItemId(getResponsesItemId(p), callId);
    }
    out.push(functionCall);
    out.push({
        type: 'function_call_output',
        call_id: callId,
        output: buildResponsesFunctionOutput(p.result)
    });
}

/**
 * 带图片的结果用内容数组回传（截图等），纯文本结果仍是字符串
 */
function buildResponsesFunctionOutput(result) {
    const { text, images } = splitToolResultContent(result);
    if (images.length === 0) return text;
    return [
        ...(text ? [{ type: 'input_text', text }] : []),
        ...images.map((image) => ({ type: 'input_image', image_url: image.url }))
    ];
}

// ========== 会话装配 ==========

/**
 * system prompt 与 monitor 上下文合并进首条 system 消息，开场对话紧随其后，末尾预填充追加在最新消息之后
 * @param {Array} messages partsToAPIMessages 输出
 * @param {import('./format-adapter-types.js').SystemContext} systemCtx
 * @param {import('./format-adapter-types.js').PrefillContext|null} prefill
 * @returns {Array}
 */
export function assembleOpenAIConversation(messages, systemCtx, prefill) {
    const conversation = [...messages];

    if (systemCtx.systemPrompt) {
        conversation.unshift({ role: 'system', content: systemCtx.systemPrompt });
    }
    if (systemCtx.monitorContext) {
        const systemMessage = conversation.find((m) => m.role === 'system');
        if (systemMessage) {
            systemMessage.content += systemCtx.monitorContext;
        } else {
            conversation.unshift({ role: 'system', content: systemCtx.monitorContext });
        }
    }

    if (prefill && prefill.opening.length > 0) {
        const systemIndex = conversation.findIndex((m) => m.role === 'system');
        conversation.splice(systemIndex >= 0 ? systemIndex + 1 : 0, 0, ...prefill.opening);
    }
    if (prefill && prefill.trailing.length > 0) {
        conversation.push(...prefill.trailing);
    }

    return conversation;
}

/**
 * XML 模式把工具描述注入 system 消息，原生模式写入 tools 字段
 * @param {Object} requestBody
 * @param {Array} conversation assembleOpenAIConversation 输出，XML 注入会就地修改
 * @param {Array} tools
 * @param {{ isXmlMode: boolean, logTag: string, nativeFields?: Object }} options
 *     nativeFields 为原生模式额外附加的请求字段（Chat 的 parallel_tool_calls）
 */
export function applyOpenAITools(
    requestBody,
    conversation,
    tools,
    { isXmlMode, logTag, nativeFields = {} }
) {
    if (tools.length === 0) return;

    if (isXmlMode) {
        injectToolsToOpenAI(conversation, tools);
        const stats = getXMLInjectionStats(tools);
        logger.debug(`[${logTag}] XML 模式注入统计:`, stats);
        if (stats.estimatedTokens > 2000) {
            logger.warn(`[${logTag}] XML 描述过长，预计消耗`, stats.estimatedTokens, 'tokens');
        }
        return;
    }

    requestBody.tools = tools;
    requestBody.tool_choice = 'auto';
    Object.assign(requestBody, nativeFields);
    logger.debug(`[${logTag}] 原生 tools 模式，工具数量:`, tools.length);
}

// ========== 生成参数 ==========

// 推理强度由低到高
const OPENAI_EFFORTS = Object.freeze(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
// 开启推理时可用的档位，不含 none
const OPENAI_REASONING_EFFORTS = Object.freeze(OPENAI_EFFORTS.filter((level) => level !== 'none'));
const OPENAI_SAMPLING_KEYS = Object.freeze([
    'temperature',
    'top_p',
    'frequency_penalty',
    'presence_penalty'
]);

/**
 * 开启推理时的 effort：设置面板强度归一（custom 回落 high），再收敛到型号支持的档位，不会收敛到 none
 * @param {string} strength
 * @param {string[]|null} supported 型号支持的档位；null 表示未识别，原样发送
 * @param {import('../request-notices.js').RequestNotice[]} notices
 * @returns {string}
 */
export function resolveOpenAIEffort(strength, supported, notices) {
    const requested = OPENAI_REASONING_EFFORTS.includes(strength) ? strength : 'high';
    const effort = clampToSupportedLevel(requested, OPENAI_REASONING_EFFORTS, supported);
    if (effort === requested) return requested;
    notices.push({
        key: 'openai.effort',
        message: `当前模型不支持推理强度 ${requested}，已改用 ${effort}`
    });
    return effort;
}

/**
 * 关闭推理时是否发送 none：未识别的型号沿用用户设置，已识别但不支持 none 的型号省略并提示
 * @returns {boolean}
 */
export function canSendOpenAINoneEffort(profile, notices) {
    const supported = profile.reasoning?.efforts;
    if (!profile.known || !supported || supported.includes('none')) return true;
    notices.push({
        key: 'openai.effort-none',
        message: '当前模型不支持关闭推理（none），将按模型默认推理强度回复'
    });
    return false;
}

/**
 * 用户显式设置的采样参数；型号完全不接受、或只在 effort 为 none 时接受时丢弃并提示
 * @param {Object} userParams
 * @param {Object} options
 * @param {'always'|'never'|'effort-none'} options.rule
 * @param {string|null} options.effectiveEffort 实际生效的推理强度（含型号默认值）
 * @param {boolean} [options.penalties] 是否支持 frequency / presence penalty
 * @param {import('../request-notices.js').RequestNotice[]} options.notices
 * @returns {Object}
 */
export function buildOpenAISampling(
    userParams,
    { rule, effectiveEffort, penalties = true, notices }
) {
    const keys = penalties ? OPENAI_SAMPLING_KEYS : OPENAI_SAMPLING_KEYS.slice(0, 2);
    const requested = keys.filter(
        (key) => userParams[key] !== null && userParams[key] !== undefined
    );
    if (requested.length === 0) return {};

    const blocked = rule === 'never' || (rule === 'effort-none' && effectiveEffort !== 'none');
    if (blocked) {
        notices.push({
            key: 'openai.sampling',
            message:
                rule === 'never'
                    ? `当前模型不接受自定义 ${requested.join(' / ')}，已忽略`
                    : `当前模型只在推理强度为 none 时接受 ${requested.join(' / ')}，已忽略`
        });
        return {};
    }
    return Object.fromEntries(requested.map((key) => [key, userParams[key]]));
}

/**
 * OpenClaw 网关沿用 Chat 字段名，不接受 penalty 参数
 * @param {Object} userParams
 * @param {{ penalties?: boolean }} [options]
 * @returns {Object}
 */
export function buildOpenAISamplingParams(userParams, { penalties = true } = {}) {
    const result = {};
    if (userParams.temperature !== null) result.temperature = userParams.temperature;
    if (userParams.max_tokens !== null) result.max_tokens = userParams.max_tokens;
    if (userParams.top_p !== null) result.top_p = userParams.top_p;
    if (penalties) {
        if (userParams.frequency_penalty !== null) {
            result.frequency_penalty = userParams.frequency_penalty;
        }
        if (userParams.presence_penalty !== null) {
            result.presence_penalty = userParams.presence_penalty;
        }
    }
    return result;
}

/**
 * @returns {string|null} 型号不支持输出详细度时返回 null 并提示
 */
export function resolveOpenAIVerbosity(verbosity, profile, notices) {
    if (!verbosity) return null;
    if (profile.verbosity === false) {
        notices.push({
            key: 'openai.verbosity',
            message: '当前模型不支持输出详细度参数，已忽略'
        });
        return null;
    }
    return verbosity;
}

// ========== OpenAI 两家共享：headers ==========

/**
 * OpenAI Chat / Responses 共用认证 header
 */
export function buildOpenAIAuthHeaders(apiKey) {
    return {
        Authorization: `Bearer ${apiKey}`
    };
}
