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
    PartType, MediaKind, ToolState, Role,
    createMessage, createMeta,
    textPart, thinkingPart, mediaPart, toolCallPart, filePart,
} from './schema.js';

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
                        index: i,
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
                // 没有匹配的 tool 结果，标记为完成但无结果
                if (part.state === ToolState.PENDING) {
                    part.state = ToolState.DONE;
                    part.result = { content: '(结果未保存)', media: [], error: null };
                }
            }
        }
    }

    // 警告未合并的孤立 tool 消息
    if (toolMessages.size > 0) {
        console.warn(`[migration] ${toolMessages.size} 个 tool 结果消息未能合并（无对应 tool_call）:`,
            [...toolMessages.keys()]);
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

    // 1. 思维链
    const thinkingText = msg.thinkingContent || '';
    if (thinkingText) {
        // 签名来源：Claude 用 thinkingSignature，Gemini 用 thoughtSignature
        const sig = msg.thinkingSignature || msg.thoughtSignature
            || claude?.thinkingSignature || gemini?.thoughtSignature || null;
        parts.push(thinkingPart(thinkingText, sig));
    }

    // 2. 文本内容 + 多模态
    if (msg.contentParts && msg.contentParts.length > 0) {
        convertOldContentParts(msg.contentParts, parts);
    } else {
        // 没有 contentParts，从 content 字段提取
        extractContentParts(msg.content, parts);
    }

    // 3. 工具调用（旧数据可能用 tool_calls 或 toolCalls）
    const rawToolCalls = msg.tool_calls || msg.toolCalls;
    if (rawToolCalls && rawToolCalls.length > 0) {
        for (const tc of rawToolCalls) {
            const fn = tc.function || tc;
            const name = fn.name || tc.name || '';
            let args = fn.arguments || tc.arguments || {};
            if (typeof args === 'string') {
                try { args = JSON.parse(args); } catch { /* keep string */ }
            }
            const part = toolCallPart(tc.id || '', name, args);
            // 保留已有的状态和结果
            if (tc.status) part.state = tc.status === 'completed' ? ToolState.DONE
                : tc.status === 'failed' ? ToolState.ERROR : tc.status;
            if (tc.result) part.result = tc.result;
            parts.push(part);
        }
    }

    // 4. 构建 meta
    const meta = createMeta({
        model: msg.modelName || '',
        provider: msg.providerName || '',
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

    // 5. 构建 replies
    let replies = null;
    if (msg.allReplies && msg.allReplies.length > 1) {
        replies = {
            all: msg.allReplies.map(r => migrateReply(r)),
            selected: msg.selectedReplyIndex || 0,
        };
    }

    // 6. 错误消息
    let error = null;
    if (msg.isError) {
        error = {
            type: msg.errorData?.error?.type || 'unknown',
            message: msg.errorData?.error?.message || msg.content || '',
            status: msg.httpStatus || 0,
        };
    }

    const migratedMsg = createMessage(role, parts, {
        id: msg.id,
        ts: msg.timestamp || Date.now(),
        meta,
        replies,
        error,
    });

    // errorHtml 保持顶层属性（restore.js 从顶层读取）
    if (msg.errorHtml) {
        migratedMsg.errorHtml = msg.errorHtml;
    }

    return migratedMsg;
}

/**
 * 迁移单个 reply（allReplies 中的元素）
 */
function migrateReply(reply) {
    const parts = [];

    // 思维链
    if (reply.thinkingContent) {
        const sig = reply.thinkingSignature || reply.thoughtSignature || null;
        parts.push(thinkingPart(reply.thinkingContent, sig));
    }

    // 内容
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
                message: reply.errorMessage || '',
            },
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
        ts: reply.timestamp || 0,
    };
}

/**
 * 将旧 contentParts 数组转换为新 parts（共享逻辑）
 */
function convertOldContentParts(contentParts, parts) {
    for (const cp of contentParts) {
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
                parts.push(mediaPart(MediaKind.IMAGE, `data:${mime};base64,${item.source.data}`, mime));
            } else if (item.type === 'file' && item.file?.file_data) {
                parts.push(filePart(item.file.filename || 'file', 'application/pdf', item.file.file_data));
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
                const images = parsed.image ? [parsed.image]
                    : parsed.images ? parsed.images : [];
                for (const img of images) {
                    if (typeof img === 'string' && img.startsWith('data:')) {
                        result.media.push({ type: MediaKind.IMAGE, url: img });
                    }
                }
                return result;
            }
        } catch { /* 不是 JSON，当作纯文本 */ }
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
    const textContent = typeof msg.content === 'string' ? msg.content
        : Array.isArray(msg.content) ? msg.content.filter(p => p.type === 'text').map(p => p.text).join('')
        : '';
    if (textContent) parts.push(textPart(textContent));

    console.warn(`[migration] 消息 ${index} 迁移失败，使用降级格式`);

    return createMessage(role, parts, {
        id: msg.id,
        ts: msg.timestamp || Date.now(),
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
            error: `消息数量不匹配: 原始 ${originalCount} - tool ${toolMsgCount} = 期望 ${expected}, 实际 ${migratedCount}`,
        };
    }
    return { valid: true };
}
