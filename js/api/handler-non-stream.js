/**
 * 非流式响应处理
 *
 * 从 handler.js 整段迁出 ~280 行，承担：
 *   - 多回复并发（replyCount > 1）的并行请求 + 错误聚合
 *   - 工具调用早期返回（reply.hasToolCalls 时落库 + handleToolCallStream）
 *   - 单回复 / 多回复的渲染分发 + saveAssistantMessage 落库
 *   - Claude pause_turn 触发 continuation
 */

import { state } from '../core/state.js';
import { executeRequest } from './request-pipeline.js';
import { appendStreamStats } from '../stream/stats.js';
import { saveAssistantMessageAsync } from '../messages/sync.js';
import {
    buildPartsFromStreamingState,
    buildMetaFromStreamingState,
    buildCanonicalReplies
} from '../messages/parts-builder.js';
import { setCurrentMessageIndex } from '../messages/dom-sync.js';
import { renderHumanizedError } from '../utils/errors.js';
import { renderFinalTextWithThinking, renderFinalContentWithThinking } from '../stream/helpers.js';
import { renderReplyWithSelector } from '../messages/renderer.js';
import { handleToolCallStream, startPauseTurnContinuation } from '../tools/orchestrator.js';
import { safeSetHTML } from '../utils/helpers.js';
import { logger } from '../utils/logger.js';
import { requestTaskRegistry } from '../core/request-task-registry.js';

function isForegroundContext(ctx) {
    return (
        ctx.sessionId === state.currentSessionId &&
        (!ctx.task || (requestTaskRegistry.owns(ctx.task) && !ctx.task.isDetached))
    );
}

function getContextTarget(ctx) {
    const element = ctx.task?.assistantMessageEl || ctx.assistantMessageEl;
    if (!element) return null;
    return element.classList?.contains('message-content')
        ? element
        : element.querySelector?.('.message-content') || null;
}

function resolveResponseMeta(meta, ctx, responseModel = null) {
    return {
        ...meta,
        model: responseModel || ctx.requestProfile?.modelDisplayName || meta?.model,
        provider: ctx.requestProfile?.providerName || meta?.provider
    };
}

/**
 * 把响应或 throw 出的 error 归一为 `{message, type, code?, fullError?}` 结构
 */
function normalizeRequestError(err) {
    return {
        message: err?.message || String(err),
        type: err?.type || err?.name || 'network_error',
        code: err?.code,
        fullError: err
    };
}

/**
 * 把失败回复包成统一的 reply 对象（与正常 reply 形状对齐）
 */
function buildErrorReply(err) {
    return {
        content: '',
        isError: true,
        errorType: err.type || err.code || 'request_error',
        errorMessage: err.message || 'Unknown error'
    };
}

/**
 * 处理工具调用早期返回：落库 + 触发 orchestrator
 * @returns {boolean} 是否触发了工具调用（true 表示调用方应直接 return）
 */
async function tryHandleToolCalls(reply, ctx, responseModel) {
    if (!(reply?.hasToolCalls && reply?.toolCalls)) return false;
    const { adapter, sessionId, assistantMessageEl, task } = ctx;

    logger.info('[NonStream] 检测到工具调用:', reply.toolCalls);

    const messageIndex = await saveAssistantMessageAsync(
        buildPartsFromStreamingState({
            textContent: reply.content || '(调用工具)',
            thinkingContent: reply.thinkingContent,
            thinkingBlocks: reply.thinkingBlocks,
            thinkingSignatures: reply.thinkingSignatures,
            thinkingItems: reply.thinkingItems,
            contentParts: reply.contentParts,
            toolCalls: reply.toolCalls,
            signatureFormat: adapter.signatureFormat || null
        }),
        resolveResponseMeta(
            buildMetaFromStreamingState({
                encryptedContent: reply.encryptedContent,
                reasoningItemId: reply.reasoningItemId,
                reasoningItems: reply.reasoningItems,
                streamStats: ctx.requestStats?.getPartialData?.() || null,
                // 代理可能改写 model（如 OpenRouter 'auto' → 真实路由模型），
                // 优先用响应侧 model 让用户看到实际执行路径 + 统计计费准确
                responseModel: responseModel || null
            }),
            ctx,
            responseModel
        ),
        {
            sessionId,
            forceBackground: task?.isDetached === true,
            isContinuation: task?.isSavingContinuation === true,
            toolCalls: reply.toolCalls
        }
    );
    if (isForegroundContext(ctx)) setCurrentMessageIndex(messageIndex);

    handleToolCallStream(reply.toolCalls, {
        assistantMessageEl,
        sourceSessionId: sessionId,
        task
    });

    return true;
}

/**
 * 多回复并发：发起 N-1 个额外请求并收集结果
 *
 * AbortError 不落库为错误回复 —— 用户主动取消时把"已取消"持久化成 N-1 条错回复会污染会话；
 * 与 multi-stream.js 的 allAborted 守卫语义对齐。
 * 用 ctx 快照的 endpoint/apiKey/model/adapter 走 executeRequest，避免请求往返期间用户切
 * provider 后额外请求打到新端点或用错 adapter。
 */
async function fetchAdditionalReplies(ctx, replyCount) {
    const { adapter, endpoint, apiKey, model } = ctx;
    const signal = ctx.abortController?.signal || null;

    const promises = [];
    for (let i = 1; i < replyCount; i++) {
        promises.push(
            executeRequest(adapter, {
                endpoint,
                apiKey,
                model,
                signal,
                sessionId: ctx.sessionId,
                sourceMessages: ctx.sourceMessages,
                requestProfile: ctx.requestProfile
            })
                .then((res) => res.json())
                .catch((err) => {
                    if (err?.name !== 'AbortError') {
                        logger.error(`Request ${i + 1} failed:`, err);
                    }
                    return { error: normalizeRequestError(err) };
                })
        );
    }

    const results = await Promise.allSettled(promises);
    const replies = [];
    const errors = [];
    let abortedCount = 0;

    results.forEach((result, idx) => {
        const requestIndex = idx + 2;
        if (result.status === 'fulfilled' && result.value) {
            if (result.value.error) {
                // AbortError 静默跳过：用户取消语义，不落库为错回复
                if (result.value.error.type === 'AbortError') {
                    abortedCount++;
                    return;
                }
                errors.push({ index: requestIndex, error: result.value.error });
                replies.push(buildErrorReply(result.value.error));
            } else {
                const reply = adapter.parseResponse(result.value, {
                    isXmlMode: ctx.requestProfile?.isXmlMode
                });
                if (reply) replies.push(reply);
            }
        } else if (result.status === 'rejected') {
            if (result.reason?.name === 'AbortError') {
                abortedCount++;
                return;
            }
            const err = normalizeRequestError(result.reason);
            errors.push({ index: requestIndex, error: err });
            replies.push(buildErrorReply(err));
        }
    });

    return { replies, errors, abortedCount };
}

/**
 * 单回复渲染：错误回复走 humanized error；contentParts 含媒体走 renderFinalContentWithThinking
 */
function renderSingleReply(reply0, ctx) {
    if (!isForegroundContext(ctx)) return;
    const target = getContextTarget(ctx);
    if (reply0.isError) {
        const errorObj = {
            error: {
                type: reply0.errorType,
                message: reply0.errorMessage
            }
        };
        const errorHtml = renderHumanizedError(errorObj, null, true);
        if (target) {
            safeSetHTML(target, errorHtml);
        }
        return;
    }

    if (reply0.contentParts && reply0.contentParts.length > 0) {
        renderFinalContentWithThinking(
            reply0.contentParts,
            reply0.thinkingContent,
            reply0.groundingMetadata,
            target,
            ctx.task || target
        );
    } else {
        renderFinalTextWithThinking(
            reply0.content || '',
            reply0.thinkingContent,
            reply0.groundingMetadata,
            target,
            ctx.task || target
        );
    }
}

/**
 * 把多请求错误聚合成单个 throw payload
 */
function aggregateErrorsAndThrow(requestErrors) {
    if (requestErrors.length === 0) {
        throw new Error('No valid replies received');
    }

    const firstError = requestErrors[0].error;
    const errorObj = {
        error: {
            type: firstError.type || 'request_failed',
            message: firstError.message || 'All requests failed'
        }
    };

    if (requestErrors.length > 1) {
        errorObj.error.allErrors = requestErrors.map((e) => ({
            request: e.index,
            message: e.error.message || String(e.error),
            type: e.error.type,
            code: e.error.code,
            fullError: e.error.fullError || e.error
        }));
    }

    throw errorObj;
}

/**
 * 处理非流式响应（支持多回复）
 *
 * @param {Response} response - Fetch Response
 * @param {import('./handler-context.js').HandlerContext} ctx - sendToAPI 的不可变快照
 *   （adapter/endpoint/apiKey/model/sessionId/assistantMessageEl/abortController 均取自此，
 *   N-1 个并发请求共用 ctx.abortController.signal，用户点取消时一并停止不再吃 token）
 */
export async function handleNonStreamResponse(response, ctx) {
    const { assistantMessageEl, sessionId, adapter } = ctx;
    const replyCount = adapter.supportsMultipleReplies === false ? 1 : ctx.replyCount || 1;
    const requestErrors = [];

    // 多回复模式显示进度提示
    const initialTarget = getContextTarget(ctx);
    if (replyCount > 1 && isForegroundContext(ctx) && initialTarget) {
        safeSetHTML(
            initialTarget,
            `<div class="multi-reply-progress">正在生成 ${replyCount} 个回复中...</div>`
        );
    }

    try {
        const data = await response.json();
        logger.debug(
            'API Response 1:',
            adapter.sanitizeResponseForLogging ? adapter.sanitizeResponseForLogging(data) : data
        );

        const allReplies = [];

        // 处理第一个响应
        if (data.error) {
            requestErrors.push({ index: 1, error: data.error });
            allReplies.push(buildErrorReply(data.error));
        } else {
            const reply = adapter.parseResponse(data, {
                isXmlMode: ctx.requestProfile?.isXmlMode
            });
            if (reply) {
                if (await tryHandleToolCalls(reply, ctx, data.model)) {
                    return; // 工具调用早期返回，由 orchestrator 接管
                }
                allReplies.push(reply);
            }
        }

        // 多回复并发
        if (replyCount > 1) {
            const { replies, errors, abortedCount } = await fetchAdditionalReplies(ctx, replyCount);
            allReplies.push(...replies);
            requestErrors.push(...errors);

            // 全部并发请求都被用户取消 + 第一个请求也没产出 reply → 整条 throw AbortError，
            // 让 handler.handleSendError 走"已取消"路径而非把"已取消"持久化为错回复污染会话
            // （与 multi-stream.js allAborted 守卫语义对齐）
            if (allReplies.length === 0 && requestErrors.length === 0 && abortedCount > 0) {
                const abortErr = new Error('Multi-reply non-stream aborted by user');
                abortErr.name = 'AbortError';
                throw abortErr;
            }
        }

        if (allReplies.length === 0) {
            aggregateErrorsAndThrow(requestErrors);
        }

        const canonicalReplies = buildCanonicalReplies(allReplies);
        if (isForegroundContext(ctx)) {
            state.currentReplies = canonicalReplies;
            state.selectedReplyIndex = 0;
            ctx.requestStats?.finalize?.();
        }

        const reply0 = allReplies[0];
        const messageIndex = await saveAssistantMessageAsync(
            buildPartsFromStreamingState({
                textContent: reply0.content || '',
                thinkingContent: reply0.thinkingContent,
                thinkingBlocks: reply0.thinkingBlocks,
                thinkingSignatures: reply0.thinkingSignatures,
                thinkingItems: reply0.thinkingItems,
                contentParts: reply0.contentParts,
                signatureFormat: adapter.signatureFormat || null
            }),
            resolveResponseMeta(
                buildMetaFromStreamingState({
                    thoughtSignature: reply0.thoughtSignature,
                    encryptedContent: reply0.encryptedContent,
                    reasoningItemId: reply0.reasoningItemId,
                    reasoningItems: reply0.reasoningItems,
                    // 透传 Gemini webSearch groundingMetadata 到 meta.raw.gemini，
                    // 否则刷新会话时 restore.js 拿不到引用，搜索来源卡片消失
                    groundingMetadata: reply0.groundingMetadata,
                    usage: reply0.usage,
                    streamStats: ctx.requestStats?.getData?.() || null,
                    responseModel: data.model || null
                }),
                ctx,
                data.model
            ),
            {
                sessionId,
                forceBackground: ctx.task?.isDetached === true,
                isContinuation: ctx.task?.isSavingContinuation === true,
                allReplies: canonicalReplies,
                selectedReplyIndex: 0
            }
        );
        const foreground = isForegroundContext(ctx);
        const currentAssistantMessageEl = ctx.task?.messageElement || assistantMessageEl;
        if (foreground) setCurrentMessageIndex(messageIndex);

        if (foreground && canonicalReplies.length > 1) {
            renderReplyWithSelector(canonicalReplies, 0, currentAssistantMessageEl);
        } else if (foreground) {
            renderSingleReply(reply0, ctx);
        }

        if (foreground) {
            ctx.requestStats?.syncToGlobal?.();
            appendStreamStats();
        }

        // Claude pause_turn：服务端工具执行后需要 continuation
        if (reply0.pauseTurn) {
            logger.debug('[Handler] 非流式 pause_turn，发起 continuation');
            startPauseTurnContinuation(assistantMessageEl, sessionId, ctx.task);
        }
    } catch (error) {
        logger.error('Non-stream response parsing error:', error);
        throw error;
    }
}
