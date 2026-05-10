/**
 * 消息同步模块（统一格式版）
 *
 * saveAssistantMessage 接收流式解析器传来的旧参数
 * （textContent / thinkingContent / toolCalls / contentParts 等），
 * 内部转换为新的 parts[] 统一格式后写入 state.messages。
 */

import { state } from '../core/state.js';
import { eventBus } from '../core/events.js';
import {
    pushMessage,
    updateMessageAt,
    setIsSavingContinuation,
    setSessionDirty
} from '../core/state-mutations.js';
import { getCurrentProvider, getModelDisplayName } from '../providers/manager.js';
import {
    createMessage,
    createMeta,
    Role,
    PartType,
    MediaKind,
    ToolState,
    textPart,
    thinkingPart,
    mediaPart,
    toolCallPart,
    filterParts,
    isNewFormat
} from './schema.js';
import { isVideoMimeType } from '../utils/media.js';
import { logger } from '../utils/logger.js';

// ========== 辅助函数 ==========

/**
 * 简单的字符串 hash（用于媒体去重）
 * 对长字符串只取前后片段 + 长度作为指纹
 */
function simpleHash(str) {
    if (!str) return '0';
    const len = str.length;
    // 长 URL（data URL）只取前后各 64 字符 + 长度
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
 * 从旧格式 contentParts 构建新格式 parts 数组（双写桥接必须保留）
 * contentParts 是流式解析器输出的中间格式（type: 'text'|'image_url'|'video_url'|'thinking'）
 */
function convertOldContentParts(contentParts) {
    const parts = [];
    if (!Array.isArray(contentParts)) return parts;

    for (const p of contentParts) {
        if (p.type === 'thinking' && p.text) {
            parts.push(thinkingPart(p.text, p.signature || null));
        } else if (p.type === 'text' && p.text && p.text !== '(调用工具)') {
            parts.push(textPart(p.text));
        } else if (p.type === 'image_url' && p.complete && p.url) {
            const mime = p.mimeType || p.mime_type || '';
            if (isVideoMimeType(mime)) {
                parts.push(mediaPart(MediaKind.VIDEO, p.url, mime));
            } else {
                parts.push(mediaPart(MediaKind.IMAGE, p.url, mime));
            }
        } else if (p.type === 'video_url' && p.complete && p.url) {
            parts.push(mediaPart(MediaKind.VIDEO, p.url, p.mimeType || p.mime_type || ''));
        } else if (p.type === 'audio_url' && p.complete && p.url) {
            parts.push(mediaPart(MediaKind.AUDIO, p.url, p.mimeType || p.mime_type || ''));
        } else if (p.type === 'server_tool_use') {
            // 服务端工具调用（web_search, code_execution 等）
            const tc = toolCallPart(p.id, p.name, p.input || {});
            tc.server = true;
            tc.state = ToolState.DONE;
            if (p.result) {
                tc.result = { type: p.result.type, content: p.result.content };
            }
            parts.push(tc);
        }
    }
    return parts;
}

/**
 * 对媒体 parts 去重（基于 url hash）
 */
function deduplicateMediaParts(parts) {
    const seen = new Set();
    return parts.filter((p) => {
        if (p.type === PartType.MEDIA) {
            const key = simpleHash(p.url);
            if (seen.has(key)) return false;
            seen.add(key);
        }
        return true;
    });
}

/**
 * 从旧参数构建完整的 parts 数组
 */
function buildPartsFromOldParams(opts) {
    const {
        textContent,
        thinkingContent, // 双写桥接
        thinkingSignature,
        thoughtSignature,
        contentParts, // 双写桥接
        toolCalls,
        thinkingBlocks,
        thinkingSignatures
    } = opts;

    let parts = [];

    // 检查 contentParts 中是否已包含 thinking
    const contentPartsHasThinking =
        Array.isArray(contentParts) && contentParts.some((p) => p.type === 'thinking' && p.text);

    // 1. 思维链（仅当 contentParts 中没有 thinking 时从独立参数添加）
    if (!contentPartsHasThinking) {
        if (thinkingBlocks && thinkingBlocks.length > 0) {
            // 多 thinking 块：每个块有独立的 signature
            for (let i = 0; i < thinkingBlocks.length; i++) {
                if (thinkingBlocks[i]) {
                    const sig = thinkingSignatures?.[i] || null;
                    parts.push(thinkingPart(thinkingBlocks[i], sig));
                }
            }
        } else if (thinkingContent) {
            const sig = thinkingSignature || thoughtSignature || null;
            parts.push(thinkingPart(thinkingContent, sig));
        }
    }

    // 2. 从 contentParts 构建（优先），否则从 textContent 构建
    if (contentParts && contentParts.length > 0) {
        parts = parts.concat(convertOldContentParts(contentParts));
    } else if (textContent && textContent !== '(调用工具)') {
        parts.push(textPart(textContent));
    }

    // 3. 工具调用
    if (toolCalls && toolCalls.length > 0) {
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
            const tcPart = toolCallPart(tc.id || `tc_${Date.now()}`, name, args);
            // 如果工具有结果，附加到 part
            if (tc.status === 'completed' && tc.result != null) {
                tcPart.state = ToolState.DONE;
                tcPart.result = {
                    content: typeof tc.result === 'string' ? tc.result : JSON.stringify(tc.result)
                };
            } else if (tc.status === 'failed') {
                tcPart.state = ToolState.ERROR;
                tcPart.result = { error: tc.error || 'unknown error' };
            }
            parts.push(tcPart);
        }
    }

    // 4. 去重媒体
    parts = deduplicateMediaParts(parts);

    // 5. 如果完全为空（只有工具调用占位），至少添加空文本
    if (parts.length === 0 && textContent) {
        parts.push(textPart(textContent));
    }

    return parts;
}

/**
 * 构建 meta 对象
 */
function buildMeta(opts) {
    const {
        streamStats,
        encryptedContent,
        reasoningItemId,
        thoughtSignature,
        thinkingSignature,
        groundingMetadata
    } = opts;

    const provider = getCurrentProvider();
    const modelId = state.selectedModel || '';
    const modelName = getModelDisplayName(modelId, provider);
    const providerName = provider?.name || 'Unknown';

    const raw = {};
    if (encryptedContent) {
        raw.openai = { encryptedContent };
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
        stats: streamStats || null,
        raw
    });
}

/**
 * 构建 replies 对象（双写桥接必须保留：接收旧格式 allReplies 参数）
 */
function buildReplies(parts, meta, allReplies, selectedReplyIndex, ts) {
    if (allReplies && allReplies.length > 0) {
        // 将旧格式 allReplies 转换为新格式
        const newAll = allReplies.map((r) => ({
            parts: r.parts || convertReplyToNewParts(r),
            meta: r.meta || extractReplyMeta(r),
            ts: r.timestamp || ts,
            isOriginal: r.isOriginal,
            isError: r.isError,
            errorType: r.errorType,
            errorMessage: r.errorMessage
        }));
        return { all: newAll, selected: selectedReplyIndex || 0 };
    }

    // 单回复不创建 replies（避免复制 parts 浪费内存）
    return null;
}

/**
 * 旧格式回复 → 新格式 parts（用于 replies.all 转换）
 */
function convertReplyToNewParts(reply) {
    const parts = [];
    if (reply.thinkingContent) {
        // 双写桥接
        parts.push(
            thinkingPart(
                reply.thinkingContent,
                reply.thinkingSignature || reply.thoughtSignature || null
            )
        );
    }
    if (reply.contentParts && reply.contentParts.length > 0) {
        // 双写桥接
        parts.push(...convertOldContentParts(reply.contentParts)); // 双写桥接
    } else if (reply.content) {
        parts.push(textPart(typeof reply.content === 'string' ? reply.content : ''));
    }
    return parts;
}

/**
 * 从旧格式回复中提取 meta
 */
function extractReplyMeta(reply) {
    const raw = {};
    if (reply.encryptedContent) raw.openai = { encryptedContent: reply.encryptedContent };
    if (reply.thoughtSignature) raw.gemini = { thoughtSignature: reply.thoughtSignature };
    if (reply.thinkingSignature) raw.claude = { thinkingSignature: reply.thinkingSignature };
    return createMeta({ raw });
}

// ========== 主要导出函数 ==========

/**
 * 统一的助手消息保存函数
 * 接收流式解析器的旧参数，转换为新格式后保存
 */
export function saveAssistantMessage(options) {
    const {
        textContent = '',
        thinkingContent = null, // 双写桥接
        thinkingSignature = null,
        thoughtSignature = null,
        groundingMetadata = null,
        streamStats = null,
        allReplies = null, // 双写桥接
        selectedReplyIndex = 0,
        contentParts = [], // 双写桥接
        sessionId = null,
        isContinuation = false,
        toolCalls = null,
        encryptedContent = null,
        reasoningItemId = null,
        isError = false,
        errorData = null,
        errorHtml = null,
        thinkingBlocks = null,
        thinkingSignatures = null
    } = options;

    const ts = Date.now();

    // 构建新格式 parts
    const parts = buildPartsFromOldParams({
        textContent,
        thinkingContent,
        thinkingSignature,
        thoughtSignature,
        contentParts,
        toolCalls,
        thinkingBlocks,
        thinkingSignatures
    });

    // 构建 meta
    const meta = buildMeta({
        streamStats,
        encryptedContent,
        reasoningItemId,
        thoughtSignature,
        thinkingSignature,
        groundingMetadata
    });

    // 会话切换检查
    if (sessionId && sessionId !== state.currentSessionId) {
        logger.warn(
            `[sync] 会话已切换（${sessionId} → ${state.currentSessionId}），将消息保存到原会话`
        );
        saveToBackgroundSession(sessionId, parts, meta, allReplies, selectedReplyIndex, ts);
        return;
    }

    // Continuation 模式
    const shouldMerge = isContinuation || state.isSavingContinuation;
    if (state.isSavingContinuation) setIsSavingContinuation(false);

    if (shouldMerge) {
        const mergeIndex = findMergeTarget();
        if (mergeIndex >= 0) {
            return mergeContinuation(mergeIndex, parts, meta, toolCalls);
        }
    }

    // 构建 replies
    const replies = buildReplies(parts, meta, allReplies, selectedReplyIndex, ts);

    // 创建新消息
    const msg = createMessage(Role.ASSISTANT, parts, { ts, meta, replies });

    // 如果是中途错误，标记错误状态
    if (isError && errorData) {
        msg.error = {
            type: errorData.code || errorData.error?.type || 'unknown',
            message: errorData.message || errorData.error?.message || 'Unknown error'
        };
        if (errorHtml) msg.errorHtml = errorHtml;
    }

    // 推入状态
    pushMessage(msg);
    const messageIndex = state.messages.length - 1;

    // 模型标签 DOM 注入
    if (meta.model || meta.provider) {
        setTimeout(() => addModelBadge(meta.model, meta.provider), 0);
    }

    eventBus.emit('messages:changed', { action: 'assistant_added', index: messageIndex });

    return messageIndex;
}

// ========== Continuation 合并逻辑 ==========

/**
 * 查找 continuation 合并目标
 */
function findMergeTarget() {
    // 优先从 DOM dataset 取
    const domMessageEl = state.currentAssistantMessage?.closest?.('.message');
    const domIndexStr = domMessageEl?.dataset?.messageIndex;
    if (domIndexStr !== undefined) {
        const idx = parseInt(domIndexStr, 10);
        if (
            !Number.isNaN(idx) &&
            idx >= 0 &&
            idx < state.messages.length &&
            state.messages[idx]?.role === 'assistant'
        ) {
            return idx;
        }
    }

    // Fallback: 从后向前找最后一条"真实"assistant 消息
    for (let i = state.messages.length - 1; i >= 0; i--) {
        const msg = state.messages[i];
        if (!msg || msg.role !== 'assistant') continue;

        // 新格式消息：检查是否有实质内容
        if (isNewFormat(msg)) {
            const hasContent = msg.parts?.some(
                (p) =>
                    p.type === PartType.TEXT ||
                    p.type === PartType.THINKING ||
                    p.type === PartType.MEDIA
            );
            if (!hasContent) continue; // 跳过纯 tool_call 占位
            return i;
        }

        // 旧格式兼容（旧格式兜底，未迁移数据需要；迁移后不应触发）
        logger.warn('[Sync] findMergeTarget 命中旧格式消息:', i);
        const hasTextContent =
            typeof msg.content === 'string'
                ? msg.content.trim().length > 0
                : Array.isArray(msg.content)
                  ? msg.content.some((p) => p?.type === 'text' && (p.text || '').trim().length > 0)
                  : false;
        const hasContentParts = Array.isArray(msg.contentParts) && msg.contentParts.length > 0; // 旧格式兜底
        const hasThinking = !!msg.thinkingContent; // 旧格式兜底
        const isToolCallsOnly =
            ((Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) ||
                (Array.isArray(msg.toolCalls) && msg.toolCalls.length > 0)) &&
            !hasTextContent &&
            !hasContentParts &&
            !hasThinking;
        if (isToolCallsOnly) continue;
        return i;
    }

    return -1;
}

/**
 * 合并 continuation 到现有消息
 */
function mergeContinuation(index, newParts, newMeta, _toolCalls) {
    const prev = state.messages[index];
    logger.debug(`[saveAssistantMessage] Continuation 模式：更新消息 #${index}`);

    // 合并 parts
    const prevThinkingParts = filterParts(prev.parts, PartType.THINKING);
    const newThinkingParts = newParts.filter((p) => p.type === PartType.THINKING);

    const prevTextParts = filterParts(prev.parts, PartType.TEXT).filter(
        (p) => p.text !== '(调用工具)'
    );
    const newTextParts = newParts.filter(
        (p) => p.type === PartType.TEXT && p.text !== '(调用工具)'
    );

    const prevMediaParts = filterParts(prev.parts, PartType.MEDIA);
    const newMediaParts = newParts.filter((p) => p.type === PartType.MEDIA);

    const prevToolParts = filterParts(prev.parts, PartType.TOOL_CALL);
    const newToolParts = newParts.filter((p) => p.type === PartType.TOOL_CALL);

    const mergedParts = [
        ...prevThinkingParts,
        ...newThinkingParts,
        ...prevTextParts,
        ...newTextParts,
        ...deduplicateMediaParts([...prevMediaParts, ...newMediaParts]),
        ...prevToolParts,
        ...newToolParts
    ];

    // 构建合并后的 meta
    const mergedMeta = prev.meta ? { ...prev.meta } : createMeta();
    if (newMeta.raw) {
        mergedMeta.raw = { ...mergedMeta.raw, ...newMeta.raw };
    }

    // 合并 streamStats
    if (newMeta.stats) {
        const prevStats = prev.meta?.stats;
        if (prevStats?.isPartial) {
            const prevTokens = parseInt(prevStats.tokens, 10) || 0;
            const currentTokens = parseInt(newMeta.stats.tokens, 10) || 0;
            if (currentTokens < prevTokens) {
                const totalTokens = prevTokens + currentTokens;
                const ttft =
                    prevStats.ttft && prevStats.ttft !== '-' ? prevStats.ttft : newMeta.stats.ttft;
                const totalTimeNum = parseFloat(newMeta.stats.totalTime);
                const ttftNum = parseFloat(ttft);
                const genTime =
                    Number.isFinite(totalTimeNum) && Number.isFinite(ttftNum)
                        ? totalTimeNum - ttftNum
                        : NaN;
                mergedMeta.stats = {
                    ...newMeta.stats,
                    ttft,
                    tokens: totalTokens,
                    tps:
                        Number.isFinite(genTime) && genTime > 0
                            ? (totalTokens / genTime).toFixed(1)
                            : newMeta.stats.tps
                };
            } else {
                mergedMeta.stats = {
                    ...newMeta.stats,
                    ttft:
                        newMeta.stats.ttft && newMeta.stats.ttft !== '-'
                            ? newMeta.stats.ttft
                            : prevStats.ttft
                };
            }
        } else {
            mergedMeta.stats = newMeta.stats;
        }
        if (mergedMeta.stats?.isPartial) delete mergedMeta.stats.isPartial;
    }

    // 一次性通过 updateMessageAt 更新
    const updates = {
        parts: mergedParts,
        meta: mergedMeta
    };

    updateMessageAt(index, updates);

    eventBus.emit('messages:changed', { action: 'assistant_updated', index });
    return index;
}

// ========== 后台会话保存 ==========

function saveToBackgroundSession(sessionId, parts, meta, allReplies, selectedReplyIndex, ts) {
    const targetSession = state.sessions.find((s) => s.id === sessionId);

    const msg = createMessage(Role.ASSISTANT, parts, {
        ts,
        meta,
        replies: buildReplies(parts, meta, allReplies, selectedReplyIndex, ts)
    });

    import('../state/storage.js').then(
        async ({ loadSessionMessages, saveSessionMessages, saveSessionToDB }) => {
            try {
                const existing = (await loadSessionMessages(sessionId)) || { messages: [] };
                existing.messages.push(msg);
                await saveSessionMessages(sessionId, existing);

                if (targetSession) {
                    targetSession.messageCount = existing.messages.length;
                    targetSession.updatedAt = Date.now();
                    await saveSessionToDB(targetSession);
                }

                const sessionName = targetSession?.name || '会话';
                logger.debug(`[sync] 消息已保存到后台会话: ${sessionName}`);
                eventBus.emit('ui:notification', {
                    message: `消息已保存到会话"${sessionName}"`,
                    type: 'info'
                });
            } catch (e) {
                logger.error('[sync] 保存后台会话消息失败:', e);
                eventBus.emit('ui:notification', {
                    message: '消息保存失败，请检查存储空间',
                    type: 'error'
                });
            }
        }
    );
}

// ========== 模型标签 ==========

function addModelBadge(modelName, providerName) {
    const assistantMessages = document.querySelectorAll('.message.assistant');
    const lastMsg = assistantMessages[assistantMessages.length - 1];
    if (!lastMsg) return;

    const wrapper = lastMsg.querySelector('.message-content-wrapper');
    if (!wrapper || wrapper.querySelector('.message-model-badge')) return;

    const badge = document.createElement('div');
    badge.className = 'message-model-badge';
    badge.textContent = [modelName, providerName].filter(Boolean).join(' | ');
    badge.title = `模型: ${modelName || '未知'}\n提供商: ${providerName || '未知'}`;
    wrapper.insertBefore(badge, wrapper.firstChild);
}

// ========== 错误消息 ==========

/**
 * 保存错误消息
 */
export function saveErrorMessage(errorData, httpStatus = null, renderHumanizedError) {
    const errorHtml = renderHumanizedError(errorData, httpStatus);
    const ts = Date.now();

    const msg = createMessage(Role.ASSISTANT, [], { ts });
    msg.error = {
        type: errorData?.error?.type || 'unknown',
        message: errorData?.error?.message || 'Unknown error',
        status: httpStatus
    };
    msg.errorHtml = errorHtml;

    pushMessage(msg);
    const messageIndex = state.messages.length - 1;

    eventBus.emit('messages:changed', { action: 'error_added', index: messageIndex });

    return messageIndex;
}

// ========== 旧 API 兼容导出 ==========

/**
 * 复制消息元数据（旧 API，保留用于 sessionToMarkdown）
 */
export function copyMessageMetadata(source, target) {
    // 新格式字段
    if (source.meta) target.meta = source.meta;
    if (source.replies) target.replies = source.replies;
    if (source.error) target.error = source.error;
    // 保留的标识字段
    const preserveKeys = ['id', 'errorHtml', 'isError'];
    preserveKeys.forEach((key) => {
        if (source[key] !== undefined) target[key] = source[key];
    });
    return target;
}

/**
 * 提取文本内容
 */
export function extractTextContent(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content
            .filter((p) => p.type === 'text')
            .map((p) => p.text)
            .join('');
    }
    return '';
}

/**
 * 提取图片 URL
 */
export function extractImages(content) {
    if (!Array.isArray(content)) return null;
    const images = content
        .filter((p) => p.type === 'image_url')
        .map((p) => p.image_url?.url)
        .filter(Boolean);
    return images.length > 0 ? images : null;
}

/**
 * 更新工具调用结果
 */
export function updateToolCallResult(toolId, status, result) {
    logger.debug('[Sync] 更新工具调用结果:', toolId, status);

    for (let i = state.messages.length - 1; i >= 0; i--) {
        const msg = state.messages[i];

        // 新格式：查找 parts 中的 tool_call
        if (msg.parts) {
            const tcPart = msg.parts.find((p) => p.type === PartType.TOOL_CALL && p.id === toolId);
            if (tcPart) {
                tcPart.state = status === 'completed' ? ToolState.DONE : ToolState.ERROR;
                tcPart.result =
                    status === 'completed'
                        ? { content: typeof result === 'string' ? result : JSON.stringify(result) }
                        : {
                              error:
                                  typeof result === 'string'
                                      ? result
                                      : result?.message || 'unknown error'
                          };
                setSessionDirty(true);
                logger.debug('[Sync] 工具调用结果已保存到消息 #' + i + ' (parts)');
                triggerSave();
                return;
            }
        }

        // 旧格式兼容（旧格式兜底，未迁移数据需要；迁移后不应触发）
        if (msg.toolCalls && Array.isArray(msg.toolCalls)) {
            logger.warn('[Sync] updateToolCallResult 命中旧格式 toolCalls[]，消息未迁移:', i);
            const tcIdx = msg.toolCalls.findIndex((tc) => tc.id === toolId);
            if (tcIdx !== -1) {
                msg.toolCalls[tcIdx] = {
                    ...msg.toolCalls[tcIdx],
                    status,
                    result: status === 'completed' ? result : null,
                    error: status === 'failed' ? result : null,
                    completedAt: Date.now()
                };
                setSessionDirty(true);
                logger.debug('[Sync] 工具调用结果已保存到消息 #' + i + ' (toolCalls)');
                triggerSave();
                return;
            }
        }
    }
}

function triggerSave() {
    import('../state/sessions.js')
        .then(({ debouncedSaveSession }) => {
            debouncedSaveSession();
        })
        .catch((err) => logger.error('[Sync] 加载会话保存模块失败:', err));
}
