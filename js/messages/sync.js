/**
 * 消息同步模块（统一格式版）
 *
 * saveAssistantMessage 接收流式解析器传来的旧参数
 * （textContent / thinkingContent / toolCalls / contentParts 等），
 * 内部转换为新的 parts[] 统一格式后写入 state.messages。
 */

import { state } from '../core/state.js';
import { eventBus } from '../core/events.js';
import { pushMessage, updateMessageAt } from '../core/state-mutations.js';
import { createMessage, createMeta, Role, PartType, ToolState, filterParts } from './schema.js';
import { buildCanonicalReplies } from './parts-builder.js';
import { applyToolResultsToMessages } from './tool-results.js';
import { isSessionDeleted, debouncedSaveSession } from '../state/sessions.js';
import { loadSessionMessages, saveSessionAtomic, SessionConflictError } from '../state/storage.js';
import { broadcastEvent } from '../state/tab-sync.js';
import { logger } from '../utils/logger.js';
import { withSessionWriteLock } from '../state/session-write-queue.js';

// ========== 辅助函数 ==========

/**
 * 字符串 hash + 媒体 parts 去重
 * mergeContinuation 在合并新旧 parts 时需要按 url 去重
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
 * 多回复对象数组 → schema 形态的 replies
 * reply 可能是新格式（含 parts）或旧格式（thinkingContent / contentParts / content）
 */
function buildReplies(allReplies, selectedReplyIndex, ts) {
    if (allReplies && allReplies.length > 0) {
        const newAll = buildCanonicalReplies(allReplies, ts);
        return { all: newAll, selected: selectedReplyIndex || 0 };
    }

    // 单回复不创建 replies（避免复制 parts 浪费内存）
    return null;
}

function upsertCurrentMessage(savedMessage) {
    const store = state.messageStore;
    if (store?.findIndexById && store?.replaceAt && store?.push) {
        const currentIndex = store.findIndexById(savedMessage.id);
        const index =
            currentIndex >= 0
                ? (store.replaceAt(currentIndex, savedMessage), currentIndex)
                : store.push(savedMessage);
        return { index, updated: currentIndex >= 0 };
    }

    const currentIndex = (state.messages || []).findIndex(
        (message) => message?.id === savedMessage.id
    );
    if (currentIndex >= 0) {
        updateMessageAt(currentIndex, savedMessage);
        return { index: currentIndex, updated: true };
    }
    return { index: pushMessage(savedMessage), updated: false };
}

// ========== 主要导出函数 ==========

/**
 * 核心保存逻辑（共享给新旧两个公开签名）
 * 输入 parts + meta 已是 schema 形态
 */
function _saveCore(parts, meta, opts) {
    const {
        sessionId = null,
        isContinuation = false,
        toolCalls = null, // 仅用于 mergeContinuation 内部 _turn 标记
        isError = false,
        errorData = null,
        errorHtml = null,
        allReplies = null,
        selectedReplyIndex = 0,
        ts = Date.now()
    } = opts;

    // 会话切换检查 — 走 background 路径并透传 continuation/error opts，避免新切到的
    // 会话被原会话的消息污染，同时让 background 路径能正确合并 continuation 或落错误
    if (opts.forceBackground || (sessionId && sessionId !== state.currentSessionId)) {
        logger.warn(
            `[sync] 会话已切换（${sessionId} → ${state.currentSessionId}），将消息保存到原会话`
        );
        const savePromise = saveToBackgroundSession(
            sessionId,
            parts,
            meta,
            allReplies,
            selectedReplyIndex,
            ts,
            {
                isContinuation,
                isError,
                errorData,
                errorHtml
            }
        );
        return savePromise;
    }

    // Continuation 模式
    if (isContinuation) {
        const mergeIndex = findMergeTarget();
        if (mergeIndex >= 0) {
            return mergeContinuation(mergeIndex, parts, meta, toolCalls);
        }
    }

    // 构建 replies
    const replies = buildReplies(allReplies, selectedReplyIndex, ts);

    // 创建新消息
    const msg = createMessage(Role.ASSISTANT, parts, { ts, meta, replies });

    // 如果是中途错误，标记错误状态
    if (isError && errorData) {
        msg.error = {
            type: errorData.code || errorData.error?.type || 'unknown',
            message: errorData.message || errorData.error?.message || 'Unknown error',
            ...(errorHtml ? { html: errorHtml } : {})
        };
    }

    // 推入状态
    const messageIndex = pushMessage(msg);

    // 模型标签 DOM 注入：在 push 时就锁定目标消息索引，避免 setTimeout 触发时
    // 期间又有新 assistant 消息渲染（multi-stream / tool-call continuation）导致 badge 错挂
    if (meta.model || meta.provider) {
        const targetIndex = messageIndex;
        setTimeout(() => addModelBadge(meta.model, meta.provider, targetIndex), 0);
    }

    eventBus.emit('messages:changed', { action: 'assistant_added', index: messageIndex });

    return messageIndex;
}

/**
 * 主签名：直接接收 schema 形态的 parts[] 与 meta
 * 所有生产消息入口的目标接口
 */
export function saveAssistantMessage(parts, meta, opts = {}) {
    return _saveCore(parts, meta, opts);
}

export async function saveAssistantMessageAsync(parts, meta, opts = {}) {
    return await _saveCore(parts, meta, opts);
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

        const hasContent = msg.parts?.some(
            (p) =>
                p.type === PartType.TEXT ||
                p.type === PartType.THINKING ||
                p.type === PartType.MEDIA
        );
        if (!hasContent) continue;
        return i;
    }

    return -1;
}

function normalizeOpenAIReasoningItemsForMerge(items, fallbackTurn) {
    if (!Array.isArray(items)) return [];
    return items
        .filter((item) => item && typeof item === 'object')
        .map((item) => ({
            ...item,
            _turn: item._turn ?? fallbackTurn
        }));
}

function mergeOpenAIRaw(prevOpenAI = {}, newOpenAI = {}, nextTurn = 1) {
    const merged = { ...prevOpenAI, ...newOpenAI };
    const reasoningItems = [
        ...normalizeOpenAIReasoningItemsForMerge(prevOpenAI.reasoningItems, 0),
        ...normalizeOpenAIReasoningItemsForMerge(newOpenAI.reasoningItems, nextTurn)
    ];

    if (reasoningItems.length > 0) {
        const seen = new Set();
        merged.reasoningItems = reasoningItems.filter((item) => {
            const key = item.id || item.encrypted_content || item.encryptedContent;
            if (!key) return false;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }

    return merged;
}

/**
 * 纯函数：合并 prev 消息与 newParts/newMeta，返回 { mergedParts, mergedMeta }
 *
 * 给新轮 parts 打上 `_turn` 标记（递增数字），让 claude-adapter 在转 Claude API 时
 * 能按轮拆回独立的 assistant 消息——Claude 要求 latest assistant message 的 thinking
 * blocks 必须与原响应一致，多轮 thinking 合并到一条消息会触发严格校验失败。
 *
 * 同时供 mergeContinuation（state.messages 路径）和 saveToBackgroundSession
 * （已切换会话的 IDB 路径）复用，避免两条路径合并逻辑漂移
 */
export function mergeContinuationParts(prev, newParts, newMeta) {
    // 旧 schema 消息可能没有 parts 数组；filterParts 也假设 parts 是数组，统一兜底
    if (!Array.isArray(prev.parts)) {
        prev.parts = [];
    }

    // 计算下一轮编号（旧消息无 _turn 视为 0，多次 continuation 时递增）
    const prevMaxTurn = prev.parts.reduce((max, p) => Math.max(max, p._turn || 0), 0);
    const nextTurn = prevMaxTurn + 1;
    const tagTurn = (p) => ({ ...p, _turn: nextTurn });

    const prevThinkingParts = filterParts(prev.parts, PartType.THINKING);
    const newThinkingParts = newParts.filter((p) => p.type === PartType.THINKING).map(tagTurn);

    const prevTextParts = filterParts(prev.parts, PartType.TEXT).filter(
        (p) => p.text !== '(调用工具)'
    );
    const newTextParts = newParts
        .filter((p) => p.type === PartType.TEXT && p.text !== '(调用工具)')
        .map(tagTurn);

    const prevMediaParts = filterParts(prev.parts, PartType.MEDIA);
    const newMediaParts = newParts.filter((p) => p.type === PartType.MEDIA).map(tagTurn);

    // 新轮 tool_call 优先：同一逻辑工具调用在跨格式 continuation 中 part.id 会不同
    // （Claude 轮 toolu_xxx → OpenAI 轮 call_yyy），但 part.idMap 三槽共享同一逻辑 id 集合。
    // 仅按 part.id 去重会让两轮各保留一份导致后续 partsToAPIMessages 输出两条 tool_use，
    // LLM 上下文重复 + tool_result 配对错位。收集 part.id ∪ idMap.{openai,claude,gemini}
    // 作为去重 Set，prev 任一槽位命中即视为同一调用淘汰
    const collectAllIds = (p) => {
        const ids = [p.id];
        if (p.idMap) {
            for (const fmt of ['openai', 'claude', 'gemini']) {
                const id = p.idMap[fmt];
                if (id) ids.push(id);
            }
        }
        return ids;
    };
    const newToolParts = newParts.filter((p) => p.type === PartType.TOOL_CALL).map(tagTurn);
    const newToolIds = new Set();
    for (const p of newToolParts) {
        for (const id of collectAllIds(p)) newToolIds.add(id);
    }
    const prevToolParts = filterParts(prev.parts, PartType.TOOL_CALL).filter(
        (p) => !collectAllIds(p).some((id) => newToolIds.has(id))
    );

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
    const prevRaw = mergedMeta.raw || {};
    if (newMeta.raw) {
        mergedMeta.raw = { ...prevRaw, ...newMeta.raw };
        if (prevRaw.openai || newMeta.raw.openai) {
            mergedMeta.raw.openai = mergeOpenAIRaw(prevRaw.openai, newMeta.raw.openai, nextTurn);
        }
    }

    // 合并 streamStats
    if (newMeta.stats) {
        const prevStats = prev.meta?.stats;
        if (prevStats?.isPartial) {
            const prevTokens = parseInt(prevStats.tokens, 10) || 0;
            const currentTokens = parseInt(newMeta.stats.tokens, 10) || 0;
            // <= 让两轮 token 数恰好相等的情形也走累加分支（短回复 / 截断尾流常见）
            if (currentTokens <= prevTokens) {
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

    return { mergedParts, mergedMeta };
}

/**
 * 合并 continuation 到 state.messages 中现有消息（state.messages 路径）
 */
function mergeContinuation(index, newParts, newMeta, _toolCalls) {
    const prev = state.messages[index];
    logger.debug(`[saveAssistantMessage] Continuation 模式：更新消息 #${index}`);

    const { mergedParts, mergedMeta } = mergeContinuationParts(prev, newParts, newMeta);

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

/**
 * 把消息保存到后台会话（非当前激活会话）
 *
 * 此函数 async 化让调用方能 await 完成或 catch 异常；前置 isSessionDeleted
 * 检查阻断「会话刚被删 / 异步保存到来」的竞态写回；continuation 模式下复用
 * mergeContinuationParts 合并到最后一条 assistant，与主路径 mergeContinuation 对称
 *
 * @param {string} sessionId
 * @param {Array} parts
 * @param {Object} meta
 * @param {Array|null} allReplies
 * @param {number} selectedReplyIndex
 * @param {number} ts
 * @param {Object} [opts] - { isContinuation, isError, errorData, errorHtml }
 */
async function saveToBackgroundSession(
    sessionId,
    parts,
    meta,
    allReplies,
    selectedReplyIndex,
    ts,
    opts = {}
) {
    return await withSessionWriteLock(sessionId, () =>
        saveToBackgroundSessionUnlocked(
            sessionId,
            parts,
            meta,
            allReplies,
            selectedReplyIndex,
            ts,
            opts
        )
    );
}

async function saveToBackgroundSessionUnlocked(
    sessionId,
    parts,
    meta,
    allReplies,
    selectedReplyIndex,
    ts,
    opts = {}
) {
    const { isContinuation = false, isError = false, errorData = null, errorHtml = null } = opts;

    // 已删除会话的异步保存请求一律丢弃，防止 IDB 中重建死会话
    if (isSessionDeleted(sessionId)) {
        logger.warn(`[sync] 跳过已删除会话的后台保存: ${sessionId}`);
        return false;
    }

    const targetSession = state.sessions.find((s) => s.id === sessionId);
    if (!targetSession) {
        logger.warn(`[sync] 后台保存目标会话不存在: ${sessionId}`);
        return false;
    }

    try {
        const existing = (await loadSessionMessages(sessionId)) || { messages: [] };

        // 本轮写入/合并的那条消息，冲突重试时按其 id 在 fresh 中定位
        let savedMessage = null;
        let mergedIntoExisting = false;
        if (isContinuation && !isError) {
            // 倒序找最后一条「真实」assistant 消息合并新轮 parts，复用主路径同款 _turn 标记
            for (let i = existing.messages.length - 1; i >= 0; i--) {
                const m = existing.messages[i];
                if (!m || m.role !== 'assistant') continue;
                if (!Array.isArray(m.parts)) continue;
                const hasContent = m.parts.some(
                    (p) =>
                        p.type === PartType.TEXT ||
                        p.type === PartType.THINKING ||
                        p.type === PartType.MEDIA
                );
                if (!hasContent) continue;

                const { mergedParts, mergedMeta } = mergeContinuationParts(m, parts, meta);
                existing.messages[i] = { ...m, parts: mergedParts, meta: mergedMeta };
                savedMessage = existing.messages[i];
                mergedIntoExisting = true;
                logger.debug(`[sync] background continuation 合并到消息 #${i} (${sessionId})`);
                break;
            }
        }

        if (!mergedIntoExisting) {
            const msg = createMessage(Role.ASSISTANT, parts, {
                ts,
                meta,
                replies: buildReplies(allReplies, selectedReplyIndex, ts)
            });

            if (isError && errorData) {
                msg.error = {
                    type: errorData.code || errorData.error?.type || 'unknown',
                    message: errorData.message || errorData.error?.message || 'Unknown error',
                    ...(errorHtml ? { html: errorHtml } : {})
                };
            }

            existing.messages.push(msg);
            savedMessage = msg;
        }

        // 走 saveSessionAtomic 乐观锁，与 writeToolResultsToBackgroundSession 路径对齐
        // 跨 tab/同 tab 并发后台保存场景下避免静默覆盖另一 tab 已写入的消息
        const newUpdatedAt = Date.now();
        const newMeta = {
            ...targetSession,
            updatedAt: newUpdatedAt,
            messageCount: existing.messages.length
        };
        const baseline = state._lastKnownSessionUpdatedAt?.get(sessionId) ?? null;
        try {
            await saveSessionAtomic(
                newMeta,
                { messages: existing.messages, searchIndex: null },
                { expectedUpdatedAt: baseline }
            );
        } catch (saveErr) {
            if (saveErr instanceof SessionConflictError) {
                // 另一 tab 抢先写入：reload-merge-retry 一次（不无限重试，避免循环冲突）
                logger.warn(
                    `[sync] 后台保存冲突 ${sessionId}: baseline=${baseline}, actual=${saveErr.actualUpdatedAt}，reload 重试`
                );
                const fresh = (await loadSessionMessages(sessionId)) || { messages: [] };
                // continuation 合并场景 fresh 里已存在同 id 消息：按 id 替换，盲目 push 会造成重复
                const freshIdx = savedMessage?.id
                    ? fresh.messages.findIndex((m) => m?.id === savedMessage.id)
                    : -1;
                if (freshIdx >= 0) {
                    fresh.messages[freshIdx] = savedMessage;
                } else {
                    fresh.messages.push(savedMessage);
                }
                const retryMeta = {
                    ...targetSession,
                    updatedAt: Date.now(),
                    messageCount: fresh.messages.length
                };
                await saveSessionAtomic(
                    retryMeta,
                    { messages: fresh.messages, searchIndex: null },
                    { expectedUpdatedAt: saveErr.actualUpdatedAt }
                );
                existing.messages = fresh.messages;
                newMeta.updatedAt = retryMeta.updatedAt;
                newMeta.messageCount = retryMeta.messageCount;
            } else {
                throw saveErr;
            }
        }

        targetSession.messageCount = newMeta.messageCount;
        targetSession.updatedAt = newMeta.updatedAt;
        state._lastKnownSessionUpdatedAt?.set(sessionId, newMeta.updatedAt);

        // 广播给其他 tab 同步元数据
        broadcastEvent('session-updated', {
            sessionId,
            updatedAt: newMeta.updatedAt,
            messageCount: newMeta.messageCount
        });

        const sessionName = targetSession.name || '会话';
        logger.debug(`[sync] 消息已保存到后台会话: ${sessionName}`);
        eventBus.emit('ui:notification', {
            message: `消息已保存到会话"${sessionName}"`,
            type: 'info'
        });
        if (state.currentSessionId === sessionId && savedMessage) {
            const { index, updated } = upsertCurrentMessage(savedMessage);
            eventBus.emit('messages:changed', {
                action: updated ? 'assistant_updated' : 'assistant_added',
                index
            });
            return index;
        }
        return savedMessage?.id || true;
    } catch (e) {
        logger.error('[sync] 保存后台会话消息失败:', e);
        eventBus.emit('ui:notification', {
            message: '消息保存失败，请检查存储空间',
            type: 'error'
        });
        throw e;
    }
}

/**
 * 显式暴露 background save 给 handler.js 等跨会话场景使用
 * （error 消息 / continuation 消息走背景路径时直接调用，避开 _saveCore 主路径）
 */
export function saveAssistantMessageToBackground(sessionId, parts, meta, opts = {}) {
    const ts = opts.ts || Date.now();
    return saveToBackgroundSession(
        sessionId,
        parts,
        meta,
        opts.allReplies || null,
        opts.selectedReplyIndex || 0,
        ts,
        opts
    );
}

/**
 * 把工具执行结果写回已切换走的源会话（跨会话工具完成场景）。
 *
 * 用户在工具执行期间切走会话：工具不打断、继续跑完，
 * 但 state.messages 已被新会话替换、不能 writeToolResultsBackToState。改走 IDB：
 * 加载 sourceSessionId 的消息 → 遍历所有含 tool_call 的 assistant 全量配对
 * （适配多轮 continuation 在后台跑完的场景）→ 按 part.id 匹配写 result + state
 * → 持久化。让用户切回原会话能看到完成状态而非永久 pending。
 *
 * @param {string} sessionId - 源会话 ID
 * @param {Array<{id:string,name:string,result:*,isError:boolean}>} toolResults
 * @returns {Promise<number>} 匹配并写入的 part 数量
 */
export async function writeToolResultsToBackgroundSession(sessionId, toolResults) {
    return await withSessionWriteLock(sessionId, () =>
        writeToolResultsToBackgroundSessionUnlocked(sessionId, toolResults)
    );
}

async function writeToolResultsToBackgroundSessionUnlocked(sessionId, toolResults) {
    if (!sessionId || !Array.isArray(toolResults) || toolResults.length === 0) return 0;

    if (isSessionDeleted(sessionId)) {
        logger.warn(`[sync] 跳过已删除会话的 tool result 写入: ${sessionId}`);
        return 0;
    }

    const targetSession = state.sessions.find((s) => s.id === sessionId);
    if (!targetSession) {
        logger.warn(`[sync] 跨会话 tool result 写入：源会话不存在: ${sessionId}`);
        return 0;
    }

    try {
        const existing = (await loadSessionMessages(sessionId)) || { messages: [] };

        const applied = applyToolResultsToMessages(existing.messages, toolResults);
        const matched = applied.matched;
        existing.messages = applied.messages;

        if (matched === 0) {
            logger.warn(
                `[sync] 跨会话 tool result 写入：未匹配任何 part (${sessionId}, results=${toolResults.length})`
            );
            return 0;
        }

        // 走 saveSessionAtomic 乐观锁：用本 tab baseline（同 tab 切走后可能已观察过 broadcast），
        // 没有 baseline 时从 targetSession.updatedAt fallback（state.sessions 里的元数据），
        // 不再 null bypass 让 silent 覆盖另一 tab 的写入
        const baseline =
            state._lastKnownSessionUpdatedAt?.get(sessionId) ?? targetSession.updatedAt ?? null;
        const newUpdatedAt = Date.now();
        const newMeta = {
            ...targetSession,
            updatedAt: newUpdatedAt,
            messageCount: existing.messages.length
        };
        try {
            await saveSessionAtomic(
                newMeta,
                { messages: existing.messages, searchIndex: null },
                { expectedUpdatedAt: baseline }
            );
        } catch (saveErr) {
            if (saveErr instanceof SessionConflictError) {
                // 另一 tab 抢先写入：放弃本次写入，让用户切回时通过 reload 拉取最新内容
                logger.warn(
                    `[sync] 跨会话 tool result 写入冲突 ${sessionId}: baseline=${baseline}, actual=${saveErr.actualUpdatedAt}`
                );
                return 0;
            }
            throw saveErr;
        }

        // 同步更新 state.sessions 与本 tab baseline，避免后续切回再次假冲突
        targetSession.updatedAt = newUpdatedAt;
        targetSession.messageCount = existing.messages.length;
        state._lastKnownSessionUpdatedAt?.set(sessionId, newUpdatedAt);

        if (sessionId === state.currentSessionId) {
            const current = applyToolResultsToMessages(state.messages, toolResults);
            for (const index of current.changedIndexes) {
                updateMessageAt(index, { parts: current.messages[index].parts });
            }
            if (current.matched > 0) {
                eventBus.emit('messages:changed', {
                    action: 'tool_results_updated',
                    sessionId
                });
            }
        }

        // 广播给其他 tab 让它们同步元数据并触发 storage:remote-updated
        broadcastEvent('session-updated', {
            sessionId,
            updatedAt: newUpdatedAt,
            messageCount: existing.messages.length
        });

        const sessionName = targetSession.name || '会话';
        logger.debug(
            `[sync] 跨会话 tool result 写入: ${sessionName} matched=${matched}/${toolResults.length}`
        );
        // 仅当真正写入跨会话（非当前会话）时才通知，避免当前会话场景下噪音
        if (sessionId !== state.currentSessionId) {
            eventBus.emit('ui:notification', {
                message: `${matched} 个工具结果已写回会话"${sessionName}"`,
                type: 'info',
                duration: 5000
            });
        }
        return matched;
    } catch (e) {
        logger.error('[sync] 跨会话 tool result 写入失败:', e);
        return 0;
    }
}

// ========== 模型标签 ==========

function addModelBadge(modelName, providerName, messageIndex) {
    // 按消息索引精确定位（multi-stream / continuation 期间 .message.assistant 数量会变）
    const targetEl =
        typeof messageIndex === 'number'
            ? document.querySelector(`.message.assistant[data-message-index="${messageIndex}"]`)
            : null;
    const lastMsg =
        targetEl ||
        (() => {
            const list = document.querySelectorAll('.message.assistant');
            return list[list.length - 1];
        })();
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
        status: httpStatus,
        ...(errorHtml ? { html: errorHtml } : {})
    };

    const messageIndex = pushMessage(msg);

    eventBus.emit('messages:changed', { action: 'error_added', index: messageIndex });

    return messageIndex;
}

// ========== 旧 API 兼容导出 ==========

/**
 * 复制消息元数据（旧 API，保留用于 sessionToMarkdown）
 */
export function copyMessageMetadata(source, target) {
    if (source.id) target.id = source.id;
    if (source.meta) target.meta = source.meta;
    if (source.replies) target.replies = source.replies;
    if (source.error) target.error = source.error;
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
        if (!msg.parts) continue;
        const tcPart = msg.parts.find((p) => p.type === PartType.TOOL_CALL && p.id === toolId);
        if (!tcPart) continue;

        const newState = status === 'completed' ? ToolState.DONE : ToolState.ERROR;
        const newResult =
            status === 'completed'
                ? { content: typeof result === 'string' ? result : JSON.stringify(result) }
                : {
                      error:
                          typeof result === 'string' ? result : result?.message || 'unknown error'
                  };

        const newParts = msg.parts.map((p) =>
            p.type === PartType.TOOL_CALL && p.id === toolId
                ? { ...p, state: newState, result: newResult }
                : p
        );
        updateMessageAt(i, { parts: newParts });
        eventBus.emit('messages:changed', { action: 'tool_call_updated', index: i });
        logger.debug('[Sync] 工具调用结果已保存到消息 #' + i + ' (parts)');
        triggerSave();
        return;
    }
}

function triggerSave() {
    try {
        debouncedSaveSession();
    } catch (err) {
        logger.error('[Sync] 触发会话保存失败:', err);
    }
}
