/**
 * OpenAI Chat / Responses 两个 adapter 共享的辅助函数
 *
 * 内容来源：原 js/messages/api-adapters.js 顶部辅助函数 + js/tools/tool-result-builder.js 的
 * OpenAI 相关 helper。本模块仅供 openai-chat-adapter / openai-responses-adapter 内部使用。
 */

import { parseDataURL } from '../../utils/file-helpers.js';
import { getMappedId } from '../format-converter.js';
import { PartType } from '../../messages/schema.js';
import { TOOL_INTERRUPTED_MESSAGE } from '../../utils/constants.js';

// ========== 通用判定与字符串化 ==========

/**
 * 判断 FILE part 是否为纯文本内容（非 base64 数据）
 * 优先读 encoding 字段，旧数据兜底用 parseDataURL 试探
 */
export function isTextFile(p) {
    if (p.encoding === 'text') return true;
    if (p.encoding === 'base64') return false;
    return !parseDataURL(p.url);
}

// 工具结果可能含 DOM Node / 自循环对象（MCP 服务端不规范输出），
// 裸 JSON.stringify 抛 'Converting circular structure to JSON' 会让整轮 partsToAPIMessages
// 中断 → continuation 失败。replacer 在第二次遇到同对象时返回占位字符串
function safeStringify(value) {
    try {
        return JSON.stringify(value);
    } catch (_e) {
        const seen = new WeakSet();
        try {
            return JSON.stringify(value, (_k, v) => {
                if (v && typeof v === 'object') {
                    if (seen.has(v)) return '[Circular]';
                    seen.add(v);
                }
                return v;
            });
        } catch {
            return '[unserializable tool result]';
        }
    }
}

export function stringifyToolResult(result, fallback = TOOL_INTERRUPTED_MESSAGE) {
    if (result == null) return fallback;
    if (typeof result === 'string') return result;
    // executeToolCalls 失败 schema {error, is_error: true, ...} — 含 "Do NOT retry" 指令优先透传
    if (result.is_error === true && typeof result.error === 'string') return result.error;
    if (typeof result.content === 'string') return result.content;
    // 历史兼容：仅含 error 字符串（无 is_error 标记）也透传
    if (typeof result.error === 'string') return result.error;
    if (result.content !== undefined) return safeStringify(result.content);
    if (result.error !== undefined) return safeStringify({ error: result.error });
    return safeStringify(result);
}

export function hasNonEmptyContent(content) {
    if (typeof content === 'string') return content.trim().length > 0;
    if (Array.isArray(content)) return content.length > 0;
    return content != null;
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

// ========== Part 排序辅助 ==========

export function getPartTurn(part) {
    return part?._turn ?? 0;
}

export function getSortedToolCallTurns(parts) {
    return Array.from(
        new Set((parts || []).filter((p) => p.type === PartType.TOOL_CALL).map(getPartTurn))
    ).sort((a, b) => a - b);
}

export function pushResponsesFunctionCallPair(out, p) {
    // 优先 part.call_id（同轮 OpenAI 原生 call_id），其次 part.idMap.openai（跨格式映射或 lazy 补齐）
    const callId = p.call_id || getMappedId(p, 'openai');
    const functionCallItemId = buildResponsesFunctionCallItemId(getResponsesItemId(p), callId);
    out.push({
        type: 'function_call',
        id: functionCallItemId,
        call_id: callId,
        name: p.name,
        arguments: typeof p.args === 'string' ? p.args : JSON.stringify(p.args || {})
    });
    out.push({
        type: 'function_call_output',
        call_id: callId,
        output: stringifyToolResult(p.result)
    });
}

// ========== OpenAI 两家共享：headers + builtin tools ==========

/**
 * OpenAI Chat / Responses 共用认证 header
 */
export function buildOpenAIAuthHeaders(apiKey) {
    return {
        Authorization: `Bearer ${apiKey}`
    };
}

/**
 * OpenAI 内置工具列表（code_interpreter + web_search function 声明）
 * Chat 与 Responses 两 adapter 共用，差异仅在 tools 字段位置/parallel_tool_calls 设置
 * @param {Object} state - 全局 state 引用
 */
export function collectOpenAIBuiltinTools(state) {
    const tools = [];
    if (state.codeExecutionEnabled) {
        tools.push({ type: 'code_interpreter' });
    }
    if (state.webSearchEnabled) {
        tools.push({
            type: 'function',
            function: {
                name: 'web_search',
                description: 'Search the web for current information',
                parameters: {
                    type: 'object',
                    properties: {
                        query: { type: 'string', description: 'Search query' }
                    },
                    required: ['query']
                }
            }
        });
    }
    return tools;
}
