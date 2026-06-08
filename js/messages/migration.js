/**
 * 旧格式 → 新格式 迁移器
 *
 * 将旧的三数组消息（OpenAI/Gemini/Claude 并行存储）
 * 转换为统一的 parts[] 消息格式。
 *
 * 迁移时以 OpenAI 格式（state.messages）为主数据源，
 * 从 Gemini/Claude 同索引消息中补充签名等格式特有数据。
 *
 * 关键行为：role:"tool" 消息合并到前一条 assistant 的 tool_call.result 中，
 * 迁移后消息总数 = 原消息数 - tool 消息数。
 */

import {
    PartType,
    MediaKind,
    ToolState,
    Role,
    createMessage,
    createMeta,
    textPart,
    thinkingPart,
    mediaPart,
    toolCallPart,
    filePart
} from './schema.js';
import { logger } from '../utils/logger.js';
import { generateIdSet } from '../api/format-converter.js';
import { TOOL_RESULT_NOT_SAVED_MESSAGE } from '../utils/constants.js';

/**
 * 迁移一个会话的消息数组
 * @param {Array} openaiMsgs - state.messages（主数据源）
 * @param {Array} geminiMsgs - 已弃用，保留参数兼容
 * @param {Array} claudeMsgs - 已弃用，保留参数兼容
 * @returns {{ messages: Array, toolMsgCount: number, errors: Array }}
 */
export function migrateSession(openaiMsgs, geminiMsgs = [], claudeMsgs = []) {
    const result = { messages: [], toolMsgCount: 0, errors: [] };

    if (!Array.isArray(openaiMsgs) || openaiMsgs.length === 0) {
        return result;
    }

    // 第一遍：转换所有消息，收集 tool 消息待合并
    const converted = [];
    const toolMessages = new Map(); // tool_call_id → {content, index}

    for (let i = 0; i < openaiMsgs.length; i++) {
        const msg = openaiMsgs[i];
        const gemini = geminiMsgs[i] || null;
        const claude = claudeMsgs[i] || null;

        try {
            if (msg.role === 'tool') {
                // tool 结果消息，暂存待合并
                result.toolMsgCount++;
                const toolCallId = msg.tool_call_id;
                if (toolCallId) {
                    toolMessages.set(toolCallId, {
                        content: msg.content,
                        name: msg._toolName || msg.name || '',
                        index: i
                    });
                }
                continue;
            }

            const newMsg = migrateOneMessage(msg, gemini, claude);
            converted.push(newMsg);
        } catch (err) {
            result.errors.push({ index: i, error: err.message });
            // 降级：创建一个包含原始内容的基础消息
            converted.push(createFallbackMessage(msg, i));
        }
    }

    // 第二遍：将 tool 结果合并到 assistant 消息的 tool_call parts 中
    for (const newMsg of converted) {
        if (newMsg.role !== Role.ASSISTANT) continue;

        for (const part of newMsg.parts) {
            if (part.type !== PartType.TOOL_CALL) continue;

            const toolResult = toolMessages.get(part.id);
            if (toolResult) {
                part.state = ToolState.DONE;
                part.result = parseToolResult(toolResult.content);
                if (!part.name && toolResult.name) {
                    part.name = toolResult.name;
                }
                toolMessages.delete(part.id);
            } else {
                // 没有匹配的 tool 结果：旧消息孤儿 pending 视为中断，翻 ERROR + is_error
                // 让下轮 adapter.partsToAPIMessages 看到 is_error 透传，避免 API 把 stale
                // pending 当成新一轮工具调用触发 'tool_use without tool_result' 400
                if (part.state === ToolState.PENDING) {
                    part.state = ToolState.ERROR;
                    part.result = {
                        error: TOOL_RESULT_NOT_SAVED_MESSAGE,
                        is_error: true,
                        content: ''
                    };
                }
            }
        }
    }

    // 警告未合并的孤立 tool 消息
    if (toolMessages.size > 0) {
        logger.warn(
            `[migration] ${toolMessages.size} 个 tool 结果消息未能合并（无对应 tool_call）:`,
            [...toolMessages.keys()]
        );
    }

    result.messages = converted;
    return result;
}

/**
 * 迁移单条消息（非 tool 消息）
 */
function migrateOneMessage(msg, gemini, claude) {
    const role = normalizeRole(msg.role);
    const parts = [];
    const rawMeta = {};

    // 1. 思维链（迁移必须保留：读取旧字段以转换为新格式）
    const thinkingText = msg.thinkingContent || '';
    if (thinkingText) {
        // 签名来源：Claude 用 thinkingSignature，Gemini 用 thoughtSignature
        const sig =
            msg.thinkingSignature ||
            msg.thoughtSignature ||
            claude?.thinkingSignature ||
            gemini?.thoughtSignature ||
            null;
        parts.push(thinkingPart(thinkingText, sig));
    }

    // 2. 文本内容 + 多模态（迁移必须保留：读取旧 contentParts 以转换为新格式）
    if (msg.contentParts && msg.contentParts.length > 0) {
        convertOldContentParts(msg.contentParts, parts);
    } else {
        // 没有 contentParts，从 content 字段提取
        extractContentParts(msg.content, parts);
    }

    // 3. 工具调用（旧数据可能用 tool_calls 或 toolCalls）
    const rawToolCalls = msg.tool_calls || msg.toolCalls;
    if (rawToolCalls && rawToolCalls.length > 0) {
        // 老对话 thoughtSignature 只挂在 message 顶层/meta，迁移时下沉到第一个 tool_call
        // 让 Gemini 重发链路（gemini-adapter.partsToAPIMessages）能从 part 取签名
        const legacyThoughtSig = msg.thoughtSignature || gemini?.thoughtSignature || null;
        let sigSunk = false;
        for (const tc of rawToolCalls) {
            const fn = tc.function || tc;
            const name = fn.name || tc.name || '';
            let args = fn.arguments || tc.arguments || {};
            if (typeof args === 'string') {
                try {
                    args = JSON.parse(args);
                } catch {
                    /* keep string */
                }
            }
            // 旧数据可能已有 idMap（导出再导入），优先复用避免重新生成破坏跨格式配对
            // 调用方早已弃用 gemini/claude 并行数组（始终传空），不能用真值判定推断原格式 —
            // 否则 toolu_xxx 会被强写入 openai 槽导致跨格式重发 400。
            // 不显式传 originalFormat，由 generateIdSet 内部按 id 前缀 (call_/toolu_/gemini_) 自然归位；
            // 无前缀（如裸 Gemini fc.id）走三槽 generate 兜底（Gemini API 不接受外部 id 也能工作）
            const idMap = tc.idMap || generateIdSet(tc.id || '');
            const opts = { idMap };
            // tc 自身已带 thoughtSignature 优先，否则把消息级签名挂到第一个 tc
            if (tc.thoughtSignature) {
                opts.thoughtSignature = tc.thoughtSignature;
            } else if (legacyThoughtSig && !sigSunk) {
                opts.thoughtSignature = legacyThoughtSig;
                sigSunk = true;
            }
            const part = toolCallPart(tc.id || '', name, args, opts);
            // 保留已有的状态和结果
            if (tc.status)
                part.state =
                    tc.status === 'completed'
                        ? ToolState.DONE
                        : tc.status === 'failed'
                          ? ToolState.ERROR
                          : tc.status;
            if (tc.result) part.result = tc.result;
            parts.push(part);
        }
    }

    // 4. 构建 meta
    const meta = createMeta({
        model: msg.modelName || '',
        provider: msg.providerName || ''
    });

    // stats
    if (msg.streamStats) {
        meta.stats = msg.streamStats;
    }

    // 格式特有数据
    if (msg.encryptedContent) rawMeta.openai = { encryptedContent: msg.encryptedContent };
    if (msg.thoughtSignature || gemini?.thoughtSignature) {
        rawMeta.gemini = { thoughtSignature: msg.thoughtSignature || gemini?.thoughtSignature };
    }
    if (msg.thinkingSignature || claude?.thinkingSignature) {
        rawMeta.claude = { thinkingSignature: msg.thinkingSignature || claude?.thinkingSignature };
    }
    if (msg.groundingMetadata) {
        rawMeta.gemini = { ...rawMeta.gemini, groundingMetadata: msg.groundingMetadata };
    }
    if (Object.keys(rawMeta).length > 0) {
        meta.raw = rawMeta;
    }

    // 5. 构建 replies（迁移必须保留：读取旧 allReplies 以转换为新格式）
    let replies = null;
    if (msg.allReplies && msg.allReplies.length > 1) {
        replies = {
            all: msg.allReplies.map((r) => migrateReply(r)), // 迁移必须保留
            selected: msg.selectedReplyIndex || 0
        };
    }

    // 6. 错误消息
    let error = null;
    if (msg.isError) {
        error = {
            type: msg.errorData?.error?.type || 'unknown',
            message: msg.errorData?.error?.message || msg.content || '',
            status: msg.httpStatus || 0
        };
    }

    const migratedMsg = createMessage(role, parts, {
        id: msg.id,
        ts: msg.timestamp || Date.now(),
        meta,
        replies,
        error
    });

    // errorHtml 保持顶层属性（restore.js 从顶层读取）
    if (msg.errorHtml) {
        migratedMsg.errorHtml = msg.errorHtml;
    }

    return migratedMsg;
}

/**
 * 迁移单个 reply（迁移必须保留：allReplies 中的元素转为新格式）
 */
function migrateReply(reply) {
    const parts = [];

    // 思维链（迁移必须保留：读取旧字段）
    if (reply.thinkingContent) {
        const sig = reply.thinkingSignature || reply.thoughtSignature || null;
        parts.push(thinkingPart(reply.thinkingContent, sig)); // 迁移必须保留
    }

    // 内容（迁移必须保留：读取旧 contentParts）
    if (reply.contentParts && reply.contentParts.length > 0) {
        convertOldContentParts(reply.contentParts, parts);
    } else if (reply.content) {
        extractContentParts(reply.content, parts);
    } else if (reply.parts) {
        // Gemini 格式的 reply
        for (const p of reply.parts) {
            if (p.thought) continue;
            if (p.text) parts.push(textPart(p.text));
        }
    }

    // 错误回复
    if (reply.isError) {
        return {
            parts,
            meta: createMeta(),
            ts: reply.timestamp || 0,
            error: {
                type: reply.errorType || 'unknown',
                message: reply.errorMessage || ''
            }
        };
    }

    // meta
    const raw = {};
    if (reply.encryptedContent) raw.openai = { encryptedContent: reply.encryptedContent };
    if (reply.thoughtSignature) raw.gemini = { thoughtSignature: reply.thoughtSignature };
    if (reply.thinkingSignature) raw.claude = { thinkingSignature: reply.thinkingSignature };

    return {
        parts,
        meta: createMeta({ raw: Object.keys(raw).length > 0 ? raw : {} }),
        ts: reply.timestamp || 0
    };
}

/**
 * 将旧 contentParts 数组转换为新 parts（迁移必须保留）
 */
function convertOldContentParts(contentParts, parts) {
    for (const cp of contentParts) {
        // 迁移必须保留
        if (cp.type === 'thinking') continue;
        if (cp.type === 'text') {
            if (cp.text && cp.text !== '(调用工具)') {
                parts.push(textPart(cp.text));
            }
        } else if (cp.type === 'image_url') {
            parts.push(mediaPart(MediaKind.IMAGE, cp.url || '', cp.mimeType || ''));
        } else if (cp.type === 'video_url') {
            parts.push(mediaPart(MediaKind.VIDEO, cp.url || '', cp.mimeType || ''));
        } else if (cp.type === 'audio_url') {
            parts.push(mediaPart(MediaKind.AUDIO, cp.url || '', cp.mimeType || ''));
        }
    }
}

/**
 * 从 OpenAI content 字段提取 parts
 */
function extractContentParts(content, parts) {
    if (!content) return;

    if (typeof content === 'string') {
        if (content && content !== '(调用工具)') {
            parts.push(textPart(content));
        }
        return;
    }

    if (Array.isArray(content)) {
        for (const item of content) {
            if (item.type === 'text') {
                if (item.text && item.text !== '(调用工具)') {
                    parts.push(textPart(item.text));
                }
            } else if (item.type === 'image_url' && item.image_url?.url) {
                parts.push(mediaPart(MediaKind.IMAGE, item.image_url.url, ''));
            } else if (item.type === 'video_url') {
                const url = item.video_url?.url || item.url || '';
                parts.push(mediaPart(MediaKind.VIDEO, url, item.mime_type || ''));
            } else if (item.type === 'image' && item.source?.data) {
                // Claude 图片格式
                const mime = item.source.media_type || 'image/jpeg';
                parts.push(
                    mediaPart(MediaKind.IMAGE, `data:${mime};base64,${item.source.data}`, mime)
                );
            } else if (item.type === 'file' && item.file?.file_data) {
                parts.push(
                    filePart(item.file.filename || 'file', 'application/pdf', item.file.file_data)
                );
            } else if (item.type === 'document' && item.source?.data) {
                const mime = item.source.media_type || 'application/pdf';
                parts.push(filePart('document', mime, `data:${mime};base64,${item.source.data}`));
            }
        }
    }
}

/**
 * 解析 tool 结果内容
 */
function parseToolResult(content) {
    const result = { content: '', media: [], error: null };

    if (!content) return result;

    if (typeof content === 'string') {
        // 尝试解析为 JSON（可能包含图片等多模态数据）
        try {
            const parsed = JSON.parse(content);
            if (typeof parsed === 'object' && parsed !== null) {
                result.content = parsed.text || parsed.content || JSON.stringify(parsed);
                // 提取图片
                const images = parsed.image ? [parsed.image] : parsed.images ? parsed.images : [];
                for (const img of images) {
                    if (typeof img === 'string' && img.startsWith('data:')) {
                        result.media.push({ type: MediaKind.IMAGE, url: img });
                    }
                }
                return result;
            }
        } catch {
            /* 不是 JSON，当作纯文本 */
        }
        result.content = content;
    }

    return result;
}

/**
 * 创建降级消息（迁移失败时的回退）
 */
function createFallbackMessage(msg, index) {
    const role = normalizeRole(msg.role);
    const parts = [];
    const textContent =
        typeof msg.content === 'string'
            ? msg.content
            : Array.isArray(msg.content)
              ? msg.content
                    .filter((p) => p.type === 'text')
                    .map((p) => p.text)
                    .join('')
              : '';
    if (textContent) parts.push(textPart(textContent));

    logger.warn(`[migration] 消息 ${index} 迁移失败，使用降级格式`);

    return createMessage(role, parts, {
        id: msg.id,
        ts: msg.timestamp || Date.now()
    });
}

function normalizeRole(role) {
    if (role === 'model') return Role.ASSISTANT;
    if (role === 'assistant' || role === 'user' || role === 'system') return role;
    return Role.USER; // 安全回退
}

/**
 * 校验迁移结果的数量一致性
 */
export function validateMigration(originalCount, migratedCount, toolMsgCount) {
    const expected = originalCount - toolMsgCount;
    if (migratedCount !== expected) {
        return {
            valid: false,
            error: `消息数量不匹配: 原始 ${originalCount} - tool ${toolMsgCount} = 期望 ${expected}, 实际 ${migratedCount}`
        };
    }
    return { valid: true };
}
