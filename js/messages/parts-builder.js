/**
 * 流式中间状态 → schema parts[] / meta 的转换器
 *
 * 流式解析器 / 非流式 adapter.parseResponse / multi-stream 都用流式中间格式累积
 * （contentParts: {type:'text|image_url|thinking', text|url, complete}），
 * 这个模块把这些中间状态统一转换成 schema.js 定义的 parts[] / meta。
 *
 * 注意：contentParts 中的 image_url 带 complete 标记是流式增量状态，
 * 转换时只输出 complete=true 的项；未完成的图片占位丢弃。
 */

import { getCurrentProvider, getModelDisplayName } from '../api/current.js';
import { state } from '../core/state.js';
import {
    PartType,
    MediaKind,
    ToolState,
    createMeta,
    textPart,
    thinkingPart,
    mediaPart,
    toolCallPart,
    isSchemaFormatParts
} from './schema.js';
import { isVideoMimeType } from '../utils/media.js';
import { generateId } from '../utils/helpers.js';
import { generateIdSet } from '../api/format-converter.js';

// ========== 内部辅助 ==========

/**
 * 简单字符串 hash（用于媒体去重）
 * 长字符串取前后 64 字符 + 长度作为指纹
 */
function simpleHash(str) {
    if (!str) return '0';
    const len = str.length;
    const sample = len > 256 ? str.slice(0, 64) + str.slice(-64) + len : str;
    let hash = 0;
    for (let i = 0; i < sample.length; i++) {
        const char = sample.charCodeAt(i);
        hash = (hash << 5) - hash + char;
        hash = hash & hash;
    }
    return hash.toString(36);
}

/**
 * 把 toolCalls 中间状态数组（含 status/error/result/idMap/mode）转为 schema tool_call parts
 *
 * 抽出为模块级 helper 同时供 buildPartsFromStreamingState 和 buildPartsFromReply 复用 —
 * 多回复 reply1+ 的 skippedToolCalls 之前走 buildPartsFromReply 路径整组丢弃，
 * 用户切到 reply1+ 的会话历史看不到模型尝试调用了哪些工具
 */
function convertToolCallsToParts(toolCalls) {
    const parts = [];
    if (!Array.isArray(toolCalls) || toolCalls.length === 0) return parts;
    for (const tc of toolCalls) {
        const func = tc.function || tc;
        const name = func.name || 'unknown';
        let args = func.arguments || {};
        if (typeof args === 'string') {
            try {
                args = JSON.parse(args);
            } catch {
                /* keep string */
            }
        }
        const opts = {};
        if (tc.call_id) opts.call_id = tc.call_id;
        if (tc.responseItemId || tc.itemId || tc.fcId) {
            opts.responseItemId = tc.responseItemId || tc.itemId || tc.fcId;
        }
        // Gemini functionCall 必须携带 thoughtSignature 才能续发，签名跟 part 持久化
        if (tc.thoughtSignature) opts.thoughtSignature = tc.thoughtSignature;
        // mode 由 parser 在工具调用累积时显式标注；缺失走 toolCallPart 缺省 NATIVE
        if (tc.mode) opts.mode = tc.mode;
        if (tc.status === 'completed' && tc.result != null) {
            opts.state = ToolState.DONE;
            opts.result = {
                content: typeof tc.result === 'string' ? tc.result : JSON.stringify(tc.result)
            };
        } else if (tc.status === 'failed') {
            opts.state = ToolState.ERROR;
            opts.result = { error: tc.error || 'unknown error' };
        } else if (tc.status === 'skipped') {
            // 多回复模式 BufferedSink 拦截：落库展示但不下发 API
            opts.state = ToolState.SKIPPED;
            opts.result = { content: tc.error || '多回复模式未执行此工具', skipped: true };
        }
        const partId = tc.id || generateId('tc');
        // 跨格式 id 套件持久化到 part.idMap，adapter.partsToAPIMessages 直接 select 不再查表
        opts.idMap = tc.idMap || generateIdSet(partId);
        parts.push(toolCallPart(partId, name, args, opts));
    }
    return parts;
}

/**
 * 媒体 parts 按 url 去重
 */
function deduplicateMediaParts(parts) {
    const seen = new Set();
    return parts.filter((p) => {
        if (p.type === PartType.MEDIA) {
            const key = `${p.media || ''}:${p.mediaId || simpleHash(p.url)}`;
            if (seen.has(key)) return false;
            seen.add(key);
        }
        return true;
    });
}

/**
 * 流式中间格式 contentParts → schema parts
 *   contentParts 元素 shape：{ type: 'text'|'thinking'|'image_url'|'video_url'|'audio_url'|'server_tool_use',
 *                              text?, url?, complete?, mimeType?, mime_type?, signature?,
 *                              id?, name?, input?, result? }
 */
function streamingContentPartsToSchema(contentParts, signatureFormat = null) {
    const parts = [];
    if (!Array.isArray(contentParts)) return parts;

    for (const p of contentParts) {
        if (p.type === 'thinking' && p.text) {
            parts.push(
                thinkingPart(p.text, p.signature || null, {
                    signatureFormat: p.signature ? signatureFormat : null
                })
            );
        } else if (p.type === 'text' && p.text && p.text !== '(调用工具)') {
            parts.push(textPart(p.text));
        } else if (p.type === 'image_url' && p.complete && p.url) {
            const mime = p.mimeType || p.mime_type || '';
            const kind = isVideoMimeType(mime) ? MediaKind.VIDEO : MediaKind.IMAGE;
            parts.push(mediaPart(kind, p.url, mime));
        } else if (p.type === 'video_url' && p.complete && p.url) {
            parts.push(mediaPart(MediaKind.VIDEO, p.url, p.mimeType || p.mime_type || ''));
        } else if (p.type === 'audio_url' && p.complete && p.url) {
            parts.push(mediaPart(MediaKind.AUDIO, p.url, p.mimeType || p.mime_type || ''));
        } else if (p.type === 'server_tool_use') {
            // 服务端工具调用（web_search, code_execution 等）已完成
            const result = p.result ? { type: p.result.type, content: p.result.content } : null;
            const partId = p.id || generateId('tc');
            parts.push(
                toolCallPart(partId, p.name, p.input || {}, {
                    server: true,
                    state: ToolState.DONE,
                    result,
                    idMap: p.idMap || generateIdSet(partId)
                })
            );
        }
    }
    return parts;
}

// ========== 公开 API ==========

/**
 * 从流式中间状态构建 schema parts[]
 *
 * @param {Object} state - 流式累积状态
 * @param {string} [state.textContent] - 文本累积
 * @param {string} [state.thinkingContent] - 思维链累积（无独立 thinkingItems 时用）
 * @param {string} [state.thinkingSignature] - Claude 单签名（最简路径用）
 * @param {string} [state.thoughtSignature] - Gemini 签名（最简路径用）
 * @param {Array} [state.contentParts] - 流式中间 contentParts 数组
 * @param {Array} [state.toolCalls] - 客户端工具调用数组
 * @param {Array} [state.thinkingBlocks] - Claude thinking 文本数组（与 thinkingSignatures 同 index）
 * @param {Array} [state.thinkingSignatures] - Claude thinking 签名数组
 * @param {Array} [state.thinkingItems] - Claude thinking 顺序数组（含 redacted_thinking，优先于 thinkingBlocks）
 * @returns {Array} schema parts[]
 */
export function buildPartsFromStreamingState(streamingState = {}) {
    const {
        textContent,
        thinkingContent,
        thinkingSignature,
        thoughtSignature,
        contentParts,
        toolCalls,
        thinkingBlocks,
        thinkingSignatures,
        thinkingItems,
        // 各家流解析器在创建 streamingState 时显式标记 signature 来源 ('claude'|'gemini'|'openai')
        // 为空时落 part 不写 signatureFormat，adapter 走旧数据宽容模式
        signatureFormat = null
    } = streamingState;

    let parts = [];

    // contentParts 中是否已含 thinking？避免独立 thinking 参数重复输出
    const contentPartsHasThinking =
        Array.isArray(contentParts) && contentParts.some((p) => p.type === 'thinking' && p.text);

    // 1. 思维链（优先 thinkingItems 顺序数组，含 redacted；其次 thinkingBlocks；最次 thinkingContent）
    if (!contentPartsHasThinking) {
        if (thinkingItems && thinkingItems.length > 0) {
            for (const item of thinkingItems) {
                if (item.type === 'redacted_thinking' && item.data) {
                    parts.push(thinkingPart('', null, { redacted: true, data: item.data }));
                } else if (item.text) {
                    parts.push(
                        thinkingPart(item.text, item.signature || null, {
                            signatureFormat: item.signature ? signatureFormat : null
                        })
                    );
                }
            }
        } else if (thinkingBlocks && thinkingBlocks.length > 0) {
            for (let i = 0; i < thinkingBlocks.length; i++) {
                if (thinkingBlocks[i]) {
                    const sig = thinkingSignatures?.[i] || null;
                    parts.push(
                        thinkingPart(thinkingBlocks[i], sig, {
                            signatureFormat: sig ? signatureFormat : null
                        })
                    );
                }
            }
        } else if (thinkingContent) {
            const sig = thinkingSignature || thoughtSignature || null;
            parts.push(
                thinkingPart(thinkingContent, sig, {
                    signatureFormat: sig ? signatureFormat : null
                })
            );
        }
    }

    // 2. 内容部分：contentParts 优先，否则裸 textContent
    if (contentParts && contentParts.length > 0) {
        parts = parts.concat(streamingContentPartsToSchema(contentParts, signatureFormat));
    } else if (textContent && textContent !== '(调用工具)') {
        parts.push(textPart(textContent));
    }

    // 3. 客户端工具调用
    if (toolCalls && toolCalls.length > 0) {
        parts.push(...convertToolCallsToParts(toolCalls));
    }

    // 4. 媒体去重
    parts = deduplicateMediaParts(parts);

    // 5. 兜底：完全为空但有 textContent 时至少补一条 TEXT
    if (parts.length === 0 && textContent) {
        parts.push(textPart(textContent));
    }

    return parts;
}

/**
 * 从流式中间状态构建 meta 对象
 *
 * @param {Object} extras
 * @param {Object} [extras.streamStats] - StreamStats.getData() 返回值
 * @param {string} [extras.encryptedContent] - OpenAI Responses 签名（最简路径）
 * @param {string} [extras.reasoningItemId] - OpenAI Responses item id
 * @param {Array}  [extras.reasoningItems] - OpenAI Responses reasoning 数组（优先）
 * @param {string} [extras.thoughtSignature] - Gemini 签名（消息级冗余写入 meta.raw.gemini）
 * @param {string} [extras.thinkingSignature] - Claude 签名（消息级冗余写入 meta.raw.claude）
 * @param {Object} [extras.groundingMetadata] - Gemini 搜索引用
 * @returns {Object} createMeta 返回的 meta 对象
 */
export function buildMetaFromStreamingState(extras = {}) {
    const {
        streamStats,
        encryptedContent,
        reasoningItemId,
        reasoningItems,
        thoughtSignature,
        thinkingSignature,
        groundingMetadata,
        usage,
        // 响应侧实际模型名（代理可能改写 model，如 OpenRouter 'auto' → 真实路由模型）
        responseModel
    } = extras;

    const provider = getCurrentProvider();
    const modelId = state.selectedModel || '';
    // 响应侧 model 优先：用户能看到代理实际路由到哪个模型 + 统计计费准确
    const modelName = responseModel || getModelDisplayName(modelId, provider);
    const providerName = provider?.name || 'Unknown';

    const raw = {};
    if (Array.isArray(reasoningItems) && reasoningItems.length > 0) {
        raw.openai = {
            reasoningItems: reasoningItems.map((item) => ({
                id: item.id || null,
                summary: Array.isArray(item.summary) ? item.summary : [],
                encrypted_content: item.encrypted_content || item.encryptedContent || null,
                _turn: item._turn,
                status: item.status || null
            }))
        };
    } else if (encryptedContent || reasoningItemId) {
        raw.openai = {};
        if (encryptedContent) raw.openai.encryptedContent = encryptedContent;
        if (reasoningItemId) raw.openai.reasoningItemId = reasoningItemId;
    }
    if (thoughtSignature) raw.gemini = { thoughtSignature };
    if (thinkingSignature) raw.claude = { thinkingSignature };
    if (groundingMetadata) {
        raw.gemini = raw.gemini || {};
        raw.gemini.groundingMetadata = groundingMetadata;
    }

    return createMeta({
        model: modelName,
        provider: providerName,
        usage: usage || null,
        stats: streamStats || null,
        raw
    });
}

/**
 * 多回复（multi-stream）reply 对象 → schema parts[]
 * reply 可能是新格式（已有 parts）或旧格式（thinkingContent / contentParts / content 等）
 *
 * @param {Object} reply
 * @returns {Array} schema parts[]
 */
export function buildPartsFromReply(reply) {
    if (Array.isArray(reply.parts) && reply.parts.length > 0) return reply.parts;

    const parts = [];
    const signatureFormat = reply.signatureFormat || null;

    // contentParts 中是否已含 thinking？与 buildPartsFromStreamingState 对齐，避免 thinking 重复输出
    // （OpenAI Responses parser 同时把 thinking 写入 thinkingContent 和 contentParts 数组）
    const contentPartsHasThinking =
        Array.isArray(reply.contentParts) &&
        reply.contentParts.some((p) => p.type === 'thinking' && p.text);

    // thinking：contentParts 含 thinking 时由 streamingContentPartsToSchema 渲染；
    // 否则优先 thinkingItems，再次 thinkingContent
    if (!contentPartsHasThinking) {
        if (Array.isArray(reply.thinkingItems) && reply.thinkingItems.length > 0) {
            for (const item of reply.thinkingItems) {
                if (item.type === 'redacted_thinking' && item.data) {
                    parts.push(thinkingPart('', null, { redacted: true, data: item.data }));
                } else if (item.text) {
                    parts.push(
                        thinkingPart(item.text, item.signature || null, {
                            signatureFormat: item.signature ? signatureFormat : null
                        })
                    );
                }
            }
        } else if (reply.thinkingContent) {
            const sig = reply.thinkingSignature || reply.thoughtSignature || null;
            parts.push(
                thinkingPart(reply.thinkingContent, sig, {
                    signatureFormat: sig ? signatureFormat : null
                })
            );
        }
    }
    // 内容：contentParts 优先，否则 reply.content 字符串
    if (reply.contentParts && reply.contentParts.length > 0) {
        parts.push(...streamingContentPartsToSchema(reply.contentParts, signatureFormat));
    } else if (reply.content) {
        parts.push(textPart(typeof reply.content === 'string' ? reply.content : ''));
    }

    // 工具调用（multi-stream reply1+ 的 BufferedSink.skippedToolCalls 由
    // base-parser.collectReply 透传到 reply.toolCalls，必须落 parts 才有会话历史）
    if (reply.toolCalls && reply.toolCalls.length > 0) {
        parts.push(...convertToolCallsToParts(reply.toolCalls));
    }

    return parts;
}

/**
 * 多回复 reply 对象 → meta（提取 reply 上的 signature 类字段到 meta.raw）
 */
export function buildMetaFromReply(reply) {
    if (reply.meta) return reply.meta;

    const raw = {};
    // 优先 reasoningItems 数组（multi-turn reasoning），缺失才退化单 encryptedContent
    // 对齐 buildMetaFromStreamingState 的写入路径，避免备选回复切换后 Responses API 缺 reasoning items 报 400
    if (Array.isArray(reply.reasoningItems) && reply.reasoningItems.length > 0) {
        raw.openai = {
            reasoningItems: reply.reasoningItems.map((item) => ({
                id: item.id || null,
                summary: Array.isArray(item.summary) ? item.summary : [],
                encrypted_content: item.encrypted_content || item.encryptedContent || null,
                _turn: item._turn,
                status: item.status || null
            }))
        };
    } else if (reply.encryptedContent || reply.reasoningItemId) {
        raw.openai = {};
        if (reply.encryptedContent) raw.openai.encryptedContent = reply.encryptedContent;
        if (reply.reasoningItemId) raw.openai.reasoningItemId = reply.reasoningItemId;
    }
    if (reply.thoughtSignature) raw.gemini = { thoughtSignature: reply.thoughtSignature };
    if (reply.thinkingSignature) raw.claude = { thinkingSignature: reply.thinkingSignature };
    return createMeta({ usage: reply.usage || null, stats: reply.stats?.getData?.() || null, raw });
}

export function buildCanonicalReply(reply, ts = Date.now()) {
    const source = reply && typeof reply === 'object' ? reply : {};
    return {
        parts: isSchemaFormatParts(source.parts) ? source.parts : buildPartsFromReply(source),
        meta: source.meta || buildMetaFromReply(source),
        ts: source.ts || source.timestamp || ts,
        isOriginal: source.isOriginal,
        error:
            source.error ||
            (source.isError
                ? {
                      type: source.errorType || 'unknown',
                      message: source.errorMessage || 'Unknown error',
                      ...(source.errorHtml ? { html: source.errorHtml } : {})
                  }
                : null)
    };
}

export function buildCanonicalReplies(replies, ts = Date.now()) {
    return Array.isArray(replies) ? replies.map((reply) => buildCanonicalReply(reply, ts)) : [];
}
