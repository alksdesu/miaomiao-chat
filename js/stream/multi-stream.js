/**
 * 流式多回复处理模块 — 并行发起 N 个请求，复用 adapter.streamParser + BufferedSink 解析。
 *
 * 每个并发流注入独立 BufferedSink（第一个 reply showRealtime=true 走全局 UI 进度，
 * 其余完全后台不触发 DOM mutation）。所有 reply 收集后由本模块统一 saveAssistantMessage
 * + renderReplyWithSelector 渲染回复选择器。多回复模式不支持工具调用（BufferedSink
 * triggerToolCalls 仅记 warn）。
 */

import { logger } from '../utils/logger.js';
import { state } from '../core/state.js';
import { appendStreamStats } from './stats.js';
import { saveAssistantMessageAsync } from '../messages/sync.js';
import {
    buildPartsFromStreamingState,
    buildMetaFromStreamingState,
    buildCanonicalReplies,
    pickInitialReplyIndex
} from '../messages/parts-builder.js';
import { REPLY_TOOL_SKIPPED_MESSAGE } from '../utils/constants.js';
import { setCurrentMessageIndex } from '../messages/dom-sync.js';
import { renderReplyWithSelector } from '../messages/renderer.js';
import { renderHumanizedError, readErrorBody, buildRequestTimeoutError } from '../utils/errors.js';
import { linkAbortSignal } from '../utils/abort.js';
import { getSendFunction } from '../api/factory.js';
import { executeRequest } from '../api/request-pipeline.js';
import { BufferedSink } from './sink.js';
import { requestTaskRegistry } from '../core/request-task-registry.js';
import { requestStateMachine, RequestState } from '../core/request-state-machine.js';
import { safeSetHTML } from '../utils/helpers.js';

function isForegroundContext(ctx) {
    return (
        ctx.sessionId === state.currentSessionId &&
        (!ctx.task || (requestTaskRegistry.owns(ctx.task) && !ctx.task.isDetached))
    );
}

function getContextElements(ctx) {
    const messageElement = ctx.task?.messageElement || ctx.assistantMessageEl || null;
    const target = messageElement?.classList?.contains('message-content')
        ? messageElement
        : messageElement?.querySelector?.('.message-content') || null;
    return { messageElement, target };
}

function resolveResponseMeta(meta, ctx) {
    return {
        ...meta,
        model: ctx.requestProfile?.modelDisplayName || meta?.model,
        provider: ctx.requestProfile?.providerName || meta?.provider
    };
}

// parseReplyStream 抛出的错误消息形如 `${errorCode}: ${errorMessage}`
function splitStreamFailure(reason) {
    const rawMessage = reason?.message || String(reason);
    const [type, ...messageParts] = rawMessage.split(':');
    return {
        type: type || 'stream_error',
        message: messageParts.join(':').trim() || rawMessage
    };
}

/**
 * 并发请求各自计连接超时：响应头到达即清除，超时只中止这一路；用户取消经共享信号同时中止全部
 */
function sendWithConnectTimeout(sendFn, ctx) {
    // 响应头到达后只停计时，流式读取仍要随共享信号中止
    const linked = linkAbortSignal(ctx.abortController.signal, { timeoutMs: ctx.timeoutMs });
    return new Promise((resolve) =>
        resolve(sendFn(ctx.endpoint, ctx.apiKey, ctx.model, linked.signal))
    ).finally(linked.stopTimer);
}

/**
 * 没拿到响应的请求保留原因：Error / DOMException 展开后会丢掉 message
 */
function describeRequestFailure(reason, ctx) {
    if (reason?.name === 'TimeoutError') return { error: buildRequestTimeoutError(ctx.timeoutMs) };
    return {
        error: {
            type: reason?.name || 'network_error',
            message: reason?.message || String(reason)
        }
    };
}

/**
 * 用户点了停止（不是超时触发的中止）：交给 handler 走取消路径，不把取消落成错误回复
 */
function throwIfUserAborted(signal) {
    if (!signal?.aborted || signal.reason?.name === 'TimeoutError') return;
    const abortErr = new Error('Multi-stream aborted by user');
    abortErr.name = 'AbortError';
    throw abortErr;
}

/**
 * 全部回复失败：错误消息已落库，任务按出错结束，状态机经 ERROR 回到空闲
 */
function markRepliesFailed(ctx, error) {
    if (!ctx.task) return;
    requestTaskRegistry.setPhase(ctx.task, RequestState.ERROR);
    requestStateMachine.transitionFor(ctx.task, RequestState.ERROR, { error });
}

/**
 * 处理多个流式响应（并行）
 * @param {import('../api/handler-context.js').HandlerContext} ctx - sendToAPI 的不可变快照
 */
export async function handleMultiStreamResponses(ctx) {
    const { abortController, sessionId, adapter, requestFormat } = ctx;
    const replyCount = ctx.replyCount || 1;
    const foreground = isForegroundContext(ctx);
    const { target } = getContextElements(ctx);

    // 显示进度 —— 用独立 DOM 节点（class:multi-reply-progress-bar）不覆盖整个 message-content，
    // 后续 BufferedSink showRealtime 的 updateStreamingMessage 可与进度条共存，避免 loading
    // 文案在首流首 token 前换 3 次的视觉抖动
    const progressEl = document.createElement('div');
    progressEl.className = 'multi-reply-progress multi-reply-progress-bar';
    progressEl.textContent = `正在并行生成 ${replyCount} 个回复...`;
    if (foreground && target) {
        target.replaceChildren(progressEl);
    }

    // 用 ctx 快照 adapter 走 executeRequest：请求往返期间用户切 provider 也不会让并发流
    // 用错 adapter 或打到新端点。openclaw supportsMultiStream:false 不进本路径（handler 已
    // 拦截降级单流），保留 getSendFunction 分支仅作防御
    const boundSendFn =
        requestFormat === 'openclaw'
            ? getSendFunction(requestFormat)
            : (ep, key, mdl, sig) =>
                  executeRequest(adapter, {
                      endpoint: ep,
                      apiKey: key,
                      model: mdl,
                      signal: sig,
                      sessionId,
                      sourceMessages: ctx.sourceMessages,
                      requestProfile: ctx.requestProfile
                  });

    const promises = [];
    for (let i = 0; i < replyCount; i++) {
        promises.push(sendWithConnectTimeout(boundSendFn, ctx));
    }

    // 等待所有请求返回响应对象
    const responseResults = await Promise.allSettled(promises);

    // 筛选成功的响应，同时收集错误信息
    const validResponses = [];
    const errorDetails = [];
    for (let i = 0; i < responseResults.length; i++) {
        const result = responseResults[i];
        if (result.status === 'fulfilled' && result.value.ok) {
            validResponses.push({ index: i, response: result.value });
        } else if (result.status === 'rejected') {
            errorDetails.push({
                index: i + 1,
                type: 'network',
                error: describeRequestFailure(result.reason, ctx)
            });
            logger.error(`Response ${i + 1} failed:`, result.reason);
        } else {
            const response = result.value;
            errorDetails.push({
                index: i + 1,
                type: 'api',
                status: response.status,
                error: await readErrorBody(response)
            });
            logger.error(`Response ${i + 1} not ok:`, response.status);
        }
    }

    if (validResponses.length === 0) {
        throwIfUserAborted(abortController.signal);
        const firstError = errorDetails[0];
        // 浅拷贝 firstError.error 后再挂 allErrors：直接复用引用会污染 errorDetails[0].error
        // 原对象，下游若再次读取 errorDetails 会拿到带 allErrors 的污染版本
        const errorObj = firstError?.error ? { ...firstError.error } : { message: '未知错误' };
        const statusCode = firstError?.status || 0;

        if (errorDetails.length > 1) {
            errorObj.allErrors = errorDetails.map((e) => ({
                request: e.index,
                status: e.status || (e.type === 'network' ? 'Network Error' : 'Unknown'),
                message: e.error?.error?.message || e.error?.message || String(e.error),
                type: e.error?.error?.type || e.error?.type,
                code: e.error?.error?.code || e.error?.code,
                fullError: e.error
            }));
        }

        const errorHtml = renderHumanizedError(errorObj, statusCode);
        const currentTarget = getContextElements(ctx).target;
        if (isForegroundContext(ctx) && currentTarget) safeSetHTML(currentTarget, errorHtml);
        await saveAssistantMessageAsync(
            [],
            resolveResponseMeta(buildMetaFromStreamingState({}), ctx),
            {
                sessionId,
                forceBackground: ctx.task?.isDetached === true,
                isError: true,
                errorData: errorObj,
                errorHtml
            }
        );
        markRepliesFailed(ctx, errorObj);
        return;
    }

    // 连接阶段结束：与单流一致进入 STREAMING，发送锁随之解除，长时间的流式接收不会被强制中止
    if (ctx.task) {
        requestTaskRegistry.setPhase(ctx.task, RequestState.STREAMING);
        requestStateMachine.transitionFor(ctx.task, RequestState.STREAMING, {
            assistantMessageEl: ctx.assistantMessageEl
        });
    }

    // 更新进度文本（仅替换文本，DOM 节点保留），首流首 token 到来后会被 updateStreamingMessage
    // 覆盖渲染流式内容；progress bar 在所有流完成后由 renderReplyWithSelector 清理
    const existingProgress = isForegroundContext(ctx)
        ? getContextElements(ctx).target?.querySelector('.multi-reply-progress')
        : null;
    if (existingProgress) {
        existingProgress.textContent = `正在接收 ${validResponses.length} 个回复的流式数据...`;
    }

    // 并行解析所有流，第一个流 showRealtime 走全局 UI 进度，其余后台
    // abortController.signal 透传到每个 parser，用户点"停止"时同时取消所有并发流
    const streamPromises = validResponses.map((item, idx) =>
        parseReplyStream(
            adapter,
            item.response,
            idx === 0,
            abortController?.signal || null,
            ctx.task,
            target
        )
    );
    const streamResults = await Promise.allSettled(streamPromises);

    // 全部失败且全是 AbortError → 用户主动取消，整条 throw 让 handler.handleSendError
    // 走"已取消"路径而非持久化为 N 条错误回复污染会话
    const allRejected = streamResults.every((r) => r.status === 'rejected');
    const allAborted = allRejected && streamResults.every((r) => r.reason?.name === 'AbortError');
    if (allAborted) {
        const abortErr = new Error('Multi-stream aborted by user');
        abortErr.name = 'AbortError';
        throw abortErr;
    }

    // 收集所有回复（成功或失败）
    const allReplies = []; // 运行时变量，非旧格式字段
    const streamErrors = [];
    for (let i = 0; i < streamResults.length; i++) {
        const result = streamResults[i];
        if (result.status === 'fulfilled' && result.value) {
            const reply = result.value;
            allReplies.push(reply);
            if (reply.isError) {
                streamErrors.push({
                    index: i + 1,
                    type: reply.errorType,
                    message: reply.errorMessage
                });
            }
        } else if (result.status === 'rejected') {
            // 单个流被 abort（其他流仍在跑）：不落库为错误，跳过即可
            if (result.reason?.name === 'AbortError') {
                logger.debug(`Stream ${i + 1} aborted, 跳过持久化`);
                continue;
            }
            const { type, message } = splitStreamFailure(result.reason);
            allReplies.push({ content: '', isError: true, errorType: type, errorMessage: message });
            streamErrors.push({
                index: i + 1,
                type,
                message,
                code: result.reason?.code,
                fullError: result.reason
            });
            logger.error(`Stream ${i + 1} failed:`, result.reason);
        }
    }

    const selectedIndex = pickInitialReplyIndex(allReplies);
    if (selectedIndex >= 0) {
        const canonicalReplies = buildCanonicalReplies(allReplies);
        if (isForegroundContext(ctx)) {
            state.currentReplies = canonicalReplies;
            state.selectedReplyIndex = selectedIndex;
        }

        const selectedReply = allReplies[selectedIndex];

        // 同步选中回复的统计到全局（供 DOM 渲染）
        if (isForegroundContext(ctx) && selectedReply.stats) selectedReply.stats.syncToGlobal();

        // 多回复模式下被 BufferedSink 拦截的工具调用：标 'skipped' 状态。
        // adapter.partsToAPIMessages 看到 ToolState.SKIPPED 整条 tool_call 跳过不下发
        // （既不输出 tool_use 也不需要配对 tool_result，避免 'failed' 路径需要伪造 tool_result）；
        // UI 用 tool-display 'skipped' 灰色分支提示用户「未执行（多回复模式不支持工具）」
        const skippedToolCalls = selectedReply.toolCalls
            ? selectedReply.toolCalls.map((tc) => ({
                  ...tc,
                  status: 'skipped',
                  error: REPLY_TOOL_SKIPPED_MESSAGE
              }))
            : undefined;

        const messageIndex = await saveAssistantMessageAsync(
            buildPartsFromStreamingState({
                textContent: selectedReply.content || '',
                thinkingContent: selectedReply.thinkingContent,
                thoughtSignature: selectedReply.thoughtSignature || selectedReply.thinkingSignature,
                thinkingBlocks: selectedReply.thinkingBlocks,
                thinkingSignatures: selectedReply.thinkingSignatures,
                thinkingItems: selectedReply.thinkingItems,
                // 透传 contentParts 让图片/视频/音频媒体不被丢失（contentParts 含
                // 图像生成与多模态结果，仅靠 textContent 走 TEXT part 兜底会丢媒体）
                contentParts: selectedReply.contentParts,
                toolCalls: skippedToolCalls,
                signatureFormat: selectedReply.signatureFormat
            }),
            resolveResponseMeta(
                buildMetaFromStreamingState({
                    thoughtSignature:
                        selectedReply.thoughtSignature || selectedReply.thinkingSignature,
                    encryptedContent: selectedReply.encryptedContent,
                    reasoningItemId: selectedReply.reasoningItemId,
                    reasoningItems: selectedReply.reasoningItems,
                    groundingMetadata: selectedReply.groundingMetadata,
                    stop: selectedReply.stop,
                    streamStats: selectedReply.stats ? selectedReply.stats.getData() : null
                }),
                ctx
            ),
            {
                sessionId,
                forceBackground: ctx.task?.isDetached === true,
                isContinuation: ctx.task?.isSavingContinuation === true,
                allReplies: canonicalReplies,
                selectedReplyIndex: selectedIndex,
                // 选中的是中途失败的回复时与切换到失败回复一致：标记错误，部分内容不进入后续上下文
                ...(selectedReply.isError
                    ? {
                          isError: true,
                          errorData: {
                              code: selectedReply.errorType,
                              message: selectedReply.errorMessage
                          }
                      }
                    : {})
            }
        );

        const foregroundAtCommit = isForegroundContext(ctx);
        const currentMessageElement = getContextElements(ctx).messageElement;
        if (foregroundAtCommit) setCurrentMessageIndex(messageIndex);

        // 渲染回复选择器
        if (foregroundAtCommit) {
            renderReplyWithSelector(canonicalReplies, selectedIndex, currentMessageElement);
        }

        // 添加统计信息
        if (foregroundAtCommit) appendStreamStats();

        // 优先选中成功的回复，选中的仍是失败回复说明全部失败
        if (selectedReply.isError) {
            markRepliesFailed(ctx, {
                code: selectedReply.errorType,
                message: selectedReply.errorMessage
            });
        }
    } else {
        // 所有流都失败且没有任何内容，显示详细错误信息
        let errorObj;
        if (streamErrors.length > 0) {
            const [firstError] = streamErrors;
            errorObj = { error: { type: firstError.type, message: firstError.message } };

            if (streamErrors.length > 1) {
                errorObj.error.allErrors = streamErrors.map((e) => ({
                    stream: e.index,
                    message: e.message,
                    type: e.type,
                    code: e.code,
                    fullError: e.fullError
                }));
            }
        } else {
            errorObj = { error: { type: 'empty_response', message: '没有收到有效回复' } };
        }

        const errorHtml = renderHumanizedError(errorObj, 0);
        const currentTarget = getContextElements(ctx).target;
        if (isForegroundContext(ctx) && currentTarget) safeSetHTML(currentTarget, errorHtml);
        await saveAssistantMessageAsync(
            [],
            resolveResponseMeta(buildMetaFromStreamingState({}), ctx),
            {
                sessionId,
                forceBackground: ctx.task?.isDetached === true,
                isError: true,
                errorData: errorObj,
                errorHtml
            }
        );
        markRepliesFailed(ctx, errorObj);
    }
}

/**
 * 单个流的解析：复用 adapter.streamParser + BufferedSink 隔离副作用，
 * 流完成后从 parser 实例提取 reply（含格式特有字段如 thoughtSignature / thinkingBlocks 等）。
 *
 * @param {import('../api/adapters/format-adapter-types.js').FormatAdapter} adapter
 * @param {Response} response - fetch Response
 * @param {boolean} showRealtime - true 时本流走全局 UI 进度（多流第一个）
 * @param {AbortSignal|null} signal - 透传给 parser.parse，abort 时主动 cancel reader
 * @returns {Promise<Object>} reply 对象（content/thinkingContent/stats/格式特有字段）
 */
async function parseReplyStream(
    adapter,
    response,
    showRealtime,
    signal = null,
    task = null,
    target = null
) {
    if (!response.body) {
        throw new Error('响应体为空（代理可能返回了空响应）');
    }
    const reader = response.body.getReader();
    const sink = new BufferedSink({ showRealtime, task, target });

    // sessionId=null：BufferedSink.commit 是 no-op，无需会话归属
    const parser = await adapter.streamParser(reader, null, sink, signal);

    // 从 parser 实例提取 reply（子类 collectReply 提供格式特有字段）
    if (!parser || typeof parser.collectReply !== 'function') {
        if (sink.errorInfo) {
            throw new Error(
                `${sink.errorInfo.errorCode || 'stream_error'}: ${sink.errorInfo.errorMessage}`
            );
        }
        throw new Error('adapter.streamParser 未返回 parser 实例（缺 collectReply 方法）');
    }

    if (sink.skippedToolCalls) {
        // 多回复模式工具调用被忽略；reply 仍含部分文本
        logger.warn(
            '[multi-stream] reply 含被忽略的工具调用（多回复模式不支持）:',
            sink.skippedToolCalls.length
        );
    }

    const reply = parser.collectReply();
    if (sink.errorInfo) {
        // 流内 API 错误不 throw：已接收文本随 reply 保留，
        // isError 标记走 reply-selector 的失败 tab 展示分支
        reply.isError = true;
        reply.errorType = sink.errorInfo.errorCode || 'stream_error';
        reply.errorMessage = sink.errorInfo.errorMessage;
    }
    return reply;
}
