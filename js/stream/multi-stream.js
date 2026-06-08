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
import { saveAssistantMessage } from '../messages/sync.js';
import {
    buildPartsFromStreamingState,
    buildMetaFromStreamingState
} from '../messages/parts-builder.js';
import { setCurrentMessageIndex } from '../messages/dom-sync.js';
import { renderReplyWithSelector } from '../messages/renderer.js';
import { renderHumanizedError } from '../utils/errors.js';
import { saveErrorMessage } from '../messages/sync.js';
import { getSendFunction } from '../api/factory.js';
import { getAdapter } from '../api/adapters/index.js';
import { getCurrentProvider } from '../api/current.js';
import { executeRequest } from '../api/request-pipeline.js';
import { BufferedSink } from './sink.js';

/**
 * 处理多个流式响应（并行）
 * @param {string} endpoint - API端点
 * @param {string} apiKey - API密钥
 * @param {string} model - 模型名称
 * @param {AbortController} abortController - 取消控制器
 * @param {HTMLElement} assistantMessageEl - 助手消息元素
 * @param {string} sessionId - 会话ID
 */
export async function handleMultiStreamResponses(
    endpoint,
    apiKey,
    model,
    abortController,
    assistantMessageEl,
    sessionId
) {
    const replyCount = state.replyCount || 1;

    // 显示进度 —— 用独立 DOM 节点（class:multi-reply-progress-bar）不覆盖整个 message-content，
    // 后续 BufferedSink showRealtime 的 updateStreamingMessage 可与进度条共存，避免 loading
    // 文案在首流首 token 前换 3 次的视觉抖动
    const progressEl = document.createElement('div');
    progressEl.className = 'multi-reply-progress multi-reply-progress-bar';
    progressEl.textContent = `正在并行生成 ${replyCount} 个回复...`;
    // eslint-disable-next-line no-restricted-syntax -- 已审计：清空 children，无注入
    state.currentAssistantMessage.innerHTML = '';
    state.currentAssistantMessage.appendChild(progressEl);

    // 并行发送所有请求
    const provider = getCurrentProvider();
    const requestFormat = provider?.apiFormat || 'openai';
    const sendFn = getSendFunction(requestFormat);
    const adapter = getAdapter(requestFormat);

    // sendFn 内部（openai.js）会再次 getCurrentProvider 读 apiFormat — 多回复并发期间
    // 用户切到不同 apiFormat 的 provider 会让第 N 个请求用新 adapter + 旧 endpoint 错配。
    // 用闭包绑定快照 adapter 走 executeRequest 跳过 sendFn 重读 provider 的问题
    // （openclaw 走 WS 不在 executeRequest 流程，回退 sendFn 单流路径已规避）
    const boundSendFn =
        requestFormat === 'openclaw'
            ? sendFn
            : (ep, key, mdl, sig) =>
                  executeRequest(adapter, { endpoint: ep, apiKey: key, model: mdl, signal: sig });

    const promises = [];
    for (let i = 0; i < replyCount; i++) {
        promises.push(boundSendFn(endpoint, apiKey, model, abortController.signal));
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
            errorDetails.push({ index: i + 1, type: 'network', error: result.reason });
            logger.error(`Response ${i + 1} failed:`, result.reason);
        } else {
            const response = result.value;
            try {
                const errorData = await response.clone().json();
                errorDetails.push({
                    index: i + 1,
                    type: 'api',
                    status: response.status,
                    error: errorData
                });
            } catch (_error) {
                errorDetails.push({
                    index: i + 1,
                    type: 'http',
                    status: response.status,
                    error: { message: `HTTP ${response.status}` }
                });
            }
            logger.error(`Response ${i + 1} not ok:`, response.status);
        }
    }

    if (validResponses.length === 0) {
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

        // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
        state.currentAssistantMessage.innerHTML = renderHumanizedError(errorObj, statusCode);
        saveErrorMessage(errorObj, statusCode, renderHumanizedError);
        return;
    }

    // 更新进度文本（仅替换文本，DOM 节点保留），首流首 token 到来后会被 updateStreamingMessage
    // 覆盖渲染流式内容；progress bar 在所有流完成后由 renderReplyWithSelector 清理
    const existingProgress = state.currentAssistantMessage.querySelector('.multi-reply-progress');
    if (existingProgress) {
        existingProgress.textContent = `正在接收 ${validResponses.length} 个回复的流式数据...`;
    }

    // 并行解析所有流，第一个流 showRealtime 走全局 UI 进度，其余后台
    // abortController.signal 透传到每个 parser，用户点"停止"时同时取消所有并发流
    const streamPromises = validResponses.map((item, idx) =>
        parseReplyStream(adapter, item.response, idx === 0, abortController?.signal || null)
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
            allReplies.push(result.value);
        } else if (result.status === 'rejected') {
            // 单个流被 abort（其他流仍在跑）：不落库为错误，跳过即可
            if (result.reason?.name === 'AbortError') {
                logger.debug(`Stream ${i + 1} aborted, 跳过持久化`);
                continue;
            }
            const errorMessage = result.reason?.message || String(result.reason);
            const [errorType, ...messageParts] = errorMessage.split(':');
            const cleanMessage = messageParts.join(':').trim() || errorMessage;

            allReplies.push({
                content: '',
                isError: true,
                errorType: errorType || 'stream_error',
                errorMessage: cleanMessage
            });

            streamErrors.push({ index: i + 1, error: result.reason });
            logger.error(`Stream ${i + 1} failed:`, result.reason);
        }
    }

    if (allReplies.length > 0) {
        state.currentReplies = allReplies;
        state.selectedReplyIndex = 0;

        const reply0 = allReplies[0];

        // 同步第一个回复的统计到全局（供 DOM 渲染）
        if (reply0.stats) reply0.stats.syncToGlobal();

        // 多回复模式下被 BufferedSink 拦截的工具调用：标 'skipped' 状态。
        // adapter.partsToAPIMessages 看到 ToolState.SKIPPED 整条 tool_call 跳过不下发
        // （既不输出 tool_use 也不需要配对 tool_result，避免 'failed' 路径需要伪造 tool_result）；
        // UI 用 tool-display 'skipped' 灰色分支提示用户「未执行（多回复模式不支持工具）」
        const skippedToolCalls = reply0.toolCalls
            ? reply0.toolCalls.map((tc) => ({
                  ...tc,
                  status: 'skipped',
                  error: '多回复模式不支持工具调用，已跳过执行'
              }))
            : undefined;

        const messageIndex = saveAssistantMessage(
            buildPartsFromStreamingState({
                textContent: reply0.content || '',
                thinkingContent: reply0.thinkingContent,
                thoughtSignature: reply0.thoughtSignature || reply0.thinkingSignature,
                thinkingBlocks: reply0.thinkingBlocks,
                thinkingSignatures: reply0.thinkingSignatures,
                thinkingItems: reply0.thinkingItems,
                // 透传 contentParts 让图片/视频/音频媒体不被丢失（reply0.contentParts 含
                // 图像生成与多模态结果，仅靠 textContent 走 TEXT part 兜底会丢媒体）
                contentParts: reply0.contentParts,
                toolCalls: skippedToolCalls,
                signatureFormat: reply0.signatureFormat
            }),
            buildMetaFromStreamingState({
                thoughtSignature: reply0.thoughtSignature || reply0.thinkingSignature,
                encryptedContent: reply0.encryptedContent,
                reasoningItemId: reply0.reasoningItemId,
                reasoningItems: reply0.reasoningItems,
                groundingMetadata: reply0.groundingMetadata,
                streamStats: reply0.stats ? reply0.stats.getData() : null
            }),
            {
                sessionId,
                allReplies,
                selectedReplyIndex: 0
            }
        );

        setCurrentMessageIndex(messageIndex);

        // 渲染回复选择器
        renderReplyWithSelector(allReplies, 0, assistantMessageEl);

        // 添加统计信息
        appendStreamStats();
    } else {
        // 所有流都失败了，显示详细错误信息
        let errorObj;
        if (streamErrors.length > 0) {
            const firstError = streamErrors[0].error;
            const errorMessage = firstError?.message || String(firstError);
            const [errorType, ...messageParts] = errorMessage.split(':');
            const cleanMessage = messageParts.join(':').trim() || errorMessage;

            errorObj = {
                error: {
                    type: errorType || 'stream_error',
                    message: cleanMessage
                }
            };

            if (streamErrors.length > 1) {
                errorObj.error.allErrors = streamErrors.map((e) => {
                    const msg = e.error?.message || String(e.error);
                    const [eType, ...mParts] = msg.split(':');
                    return {
                        stream: e.index,
                        message: mParts.join(':').trim() || msg,
                        type: eType || e.error?.type,
                        code: e.error?.code,
                        fullError: e.error
                    };
                });
            }
        } else {
            errorObj = { error: { type: 'empty_response', message: '没有收到有效回复' } };
        }

        // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
        state.currentAssistantMessage.innerHTML = renderHumanizedError(errorObj, 0);
        saveErrorMessage(errorObj, 0, renderHumanizedError);
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
async function parseReplyStream(adapter, response, showRealtime, signal = null) {
    if (!response.body) {
        throw new Error('响应体为空（代理可能返回了空响应）');
    }
    const reader = response.body.getReader();
    const sink = new BufferedSink({ showRealtime });

    // sessionId=null：BufferedSink.commit 是 no-op，无需会话归属
    const parser = await adapter.streamParser(reader, null, sink, signal);

    if (sink.errorInfo) {
        // 流内 API 错误：抛出让外层 Promise.allSettled 收集
        throw new Error(
            `${sink.errorInfo.errorCode || 'stream_error'}: ${sink.errorInfo.errorMessage}`
        );
    }

    if (sink.skippedToolCalls) {
        // 多回复模式工具调用被忽略；reply 仍含部分文本
        logger.warn(
            '[multi-stream] reply 含被忽略的工具调用（多回复模式不支持）:',
            sink.skippedToolCalls.length
        );
    }

    // 从 parser 实例提取 reply（子类 collectReply 提供格式特有字段）
    if (!parser || typeof parser.collectReply !== 'function') {
        throw new Error('adapter.streamParser 未返回 parser 实例（缺 collectReply 方法）');
    }
    return parser.collectReply();
}
