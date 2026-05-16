/**
 * API 处理器
 * 响应 API 请求事件，协调请求发送和响应处理
 */

import { state, elements } from '../core/state.js';
import { eventBus } from '../core/events.js';
import { requestStateMachine, RequestState } from '../core/request-state-machine.js';
import { getSendFunction } from './factory.js';
import { getCurrentEndpoint, getCurrentApiKey, getCurrentModel } from './current.js';
import { getCurrentProvider } from '../providers/manager.js';
import { parseOpenAIStream } from '../stream/parser-openai.js';
import { parseClaudeStream } from '../stream/parser-claude.js';
import { parseGeminiStream } from '../stream/parser-gemini.js';
import { handleOpenClawStream } from '../stream/parser-openclaw.js';
import {
    resetStreamStats,
    finalizeStreamStats,
    getCurrentStreamStatsData,
    appendStreamStats
} from '../stream/stats.js';
import { saveErrorMessage, saveAssistantMessage } from '../messages/sync.js';
import { setCurrentMessageIndex } from '../messages/dom-sync.js';
import {
    extendMessagesTemporarily,
    restoreMessages,
    setIsLoading,
    setIsSending,
    setCurrentAssistantMessage,
    setSelectedReplyIndex,
    setIsToolCallPending,
    setCurrentReplies,
    setIsSavingContinuation,
    setToolCallContinuation,
    clearToolCallContinuation,
    clearImageRetry
} from '../core/state-mutations.js';
import { renderHumanizedError } from '../utils/errors.js';
import { renderFinalTextWithThinking, renderFinalContentWithThinking } from '../stream/helpers.js';
import { parseApiResponse } from './response-parser.js';
import { renderReplyWithSelector } from '../messages/renderer.js';
import { handleMultiStreamResponses } from '../stream/multi-stream.js';
import { createAssistantMessagePlaceholder } from '../messages/placeholder.js';
import { attemptImageCompressionRetry, resetAllImageRetryState } from './image-retry.js';
import { logger } from '../utils/logger.js';

// getCurrentEndpoint, getCurrentApiKey, getCurrentModel 已移至 ./current.js（打破循环依赖）
// 从 current.js 重导出，保持向后兼容
export { getCurrentEndpoint, getCurrentApiKey, getCurrentModel } from './current.js';

/**
 * 处理流式响应
 * @param {Response} response - Fetch Response
 * @param {AbortController} abortController - 取消控制器
 * @param {string} sessionId - 请求发起时的会话ID
 */
async function handleStreamResponse(response, abortController, sessionId) {
    // 使用提供商的原始 apiFormat 选择解析器（响应格式由提供商格式决定）
    const provider = getCurrentProvider();
    const responseFormat = provider?.apiFormat || 'openai';

    // OpenClaw 使用 WebSocket，不需要 reader
    if (responseFormat === 'openclaw') {
        await handleOpenClawStream(sessionId);
        return;
    }

    const reader = response.body.getReader();

    try {
        switch (responseFormat) {
            case 'claude':
                await parseClaudeStream(reader, sessionId);
                break;
            case 'gemini':
                await parseGeminiStream(reader, sessionId);
                break;
            case 'openai':
            case 'openai-responses':
            default:
                await parseOpenAIStream(reader, responseFormat, sessionId);
                break;
        }
    } catch (error) {
        // 检查是否是取消错误
        if (error.name === 'AbortError') {
            logger.debug('请求已被用户取消');
            throw error; // 重新抛出，让外层处理
        }
        throw error;
    }
}

/**
 * 处理非流式响应（支持多回复）
 * @param {Response} response - Fetch Response
 * @param {HTMLElement} assistantMessageEl - 助手消息元素
 * @param {string} sessionId - 请求发起时的会话ID
 */
async function handleNonStreamResponse(response, assistantMessageEl, sessionId) {
    const replyCount = state.replyCount || 1;
    const allReplies = []; // 运行时变量，非旧格式字段
    const requestErrors = []; // 收集错误信息

    // 如果是多回复模式，显示进度提示
    if (replyCount > 1) {
        if (state.currentAssistantMessage) {
            // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
            state.currentAssistantMessage.innerHTML = `<div class="multi-reply-progress">正在生成 ${replyCount} 个回复中...</div>`;
        }
    }

    // 获取提供商的原始格式（用于解析响应）
    const provider = getCurrentProvider();
    const responseFormat = provider?.apiFormat || 'openai';

    try {
        // 处理第一个响应
        const data = await response.json();
        logger.debug('API Response 1:', data);

        // 检查第一个响应是否是错误
        if (data.error) {
            const err = data.error;
            requestErrors.push({
                index: 1,
                error: err
            });
            // 为失败的请求创建错误回复对象
            allReplies.push({
                content: '',
                isError: true,
                errorType: err.type || err.code || 'request_error',
                errorMessage: err.message || 'Unknown error'
            });
        } else {
            const reply = parseApiResponse(data, responseFormat);
            if (reply) {
                // ⭐ 检测工具调用
                if (reply.hasToolCalls && reply.toolCalls) {
                    logger.info('[NonStream] 检测到工具调用:', reply.toolCalls);

                    // 保存助手消息（包含工具调用）
                    const messageIndex = saveAssistantMessage({
                        textContent: reply.content || '(调用工具)',
                        toolCalls: reply.toolCalls,
                        encryptedContent: reply.encryptedContent,
                        reasoningItemId: reply.reasoningItemId,
                        reasoningItems: reply.reasoningItems,
                        streamStats: getCurrentStreamStatsData(),
                        sessionId: sessionId
                    });

                    setCurrentMessageIndex(messageIndex);

                    // 执行工具调用
                    const { handleToolCallStream } = await import('../stream/tool-call-handler.js');
                    await handleToolCallStream(reply.toolCalls, {
                        endpoint: getCurrentEndpoint(),
                        apiKey: getCurrentApiKey(),
                        model: getCurrentModel(),
                        sessionId: sessionId
                    });

                    return; // 退出非流式处理
                }

                allReplies.push(reply);
            }
        }

        // 如果需要多个回复，并行发送额外的请求
        if (replyCount > 1) {
            const endpoint = getCurrentEndpoint();
            const apiKey = getCurrentApiKey();
            const model = getCurrentModel();

            // 使用提供商的原始 apiFormat
            const sendFn = getSendFunction(responseFormat);

            const promises = [];
            for (let i = 1; i < replyCount; i++) {
                promises.push(
                    sendFn(endpoint, apiKey, model, state.currentAbortController?.signal)
                        .then((res) => res.json())
                        .catch((err) => {
                            logger.error(`Request ${i + 1} failed:`, err);
                            // 保留完整的错误对象
                            return {
                                error: {
                                    message: err.message || String(err),
                                    type: err.type || err.name || 'network_error',
                                    code: err.code,
                                    fullError: err // 完整错误对象
                                }
                            };
                        })
                );
            }

            const results = await Promise.allSettled(promises);
            for (let i = 0; i < results.length; i++) {
                const result = results[i];
                if (result.status === 'fulfilled' && result.value) {
                    // 检查响应是否包含错误
                    if (result.value.error) {
                        const err = result.value.error;
                        requestErrors.push({
                            index: i + 2,
                            error: err
                        });
                        // 为失败的请求创建错误回复对象
                        allReplies.push({
                            content: '',
                            isError: true,
                            errorType: err.type || err.code || 'request_error',
                            errorMessage: err.message || 'Unknown error'
                        });
                    } else {
                        const reply = parseApiResponse(result.value, responseFormat);
                        if (reply) {
                            allReplies.push(reply);
                        }
                    }
                } else if (result.status === 'rejected') {
                    const errorMsg = result.reason?.message || String(result.reason);
                    // 保留完整的错误对象
                    const fullError = {
                        message: errorMsg,
                        type: result.reason?.type || result.reason?.name || 'network_error',
                        code: result.reason?.code,
                        fullError: result.reason // 完整错误对象
                    };
                    requestErrors.push({
                        index: i + 2,
                        error: fullError
                    });
                    // 为失败的请求创建错误回复对象
                    allReplies.push({
                        content: '',
                        isError: true,
                        errorType: fullError.type,
                        errorMessage: errorMsg
                    });
                }
            }
        }

        // 渲染和保存
        if (allReplies.length > 0) {
            setCurrentReplies(allReplies);
            setSelectedReplyIndex(0);

            // 完成统计（非流式模式只有总时间）
            finalizeStreamStats();

            const reply0 = allReplies[0];

            // 保存消息并获取索引（stream parser 输出的中间字段，由 saveAssistantMessage 转为新格式）
            const messageIndex = saveAssistantMessage({
                textContent: reply0.content || '',
                thinkingContent: reply0.thinkingContent, // 运行时变量，传递给 saveAssistantMessage
                thoughtSignature: reply0.thoughtSignature,
                thinkingBlocks: reply0.thinkingBlocks,
                thinkingSignatures: reply0.thinkingSignatures,
                thinkingItems: reply0.thinkingItems,
                encryptedContent: reply0.encryptedContent,
                reasoningItemId: reply0.reasoningItemId,
                streamStats: getCurrentStreamStatsData(),
                allReplies: allReplies, // 运行时变量，传递给 saveAssistantMessage
                selectedReplyIndex: 0,
                contentParts: reply0.contentParts, // 运行时变量，传递给 saveAssistantMessage
                sessionId: sessionId // 传递会话ID防止串消息
            });

            setCurrentMessageIndex(messageIndex);

            // 渲染回复
            if (allReplies.length > 1) {
                renderReplyWithSelector(allReplies, 0, assistantMessageEl);
            } else {
                // 单回复模式：检查是否是错误回复
                if (reply0.isError) {
                    const errorObj = {
                        error: {
                            type: reply0.errorType,
                            message: reply0.errorMessage
                        }
                    };
                    const errorHtml = renderHumanizedError(errorObj, null, true);
                    if (state.currentAssistantMessage) {
                        // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
                        state.currentAssistantMessage.innerHTML = errorHtml;
                    }
                } else {
                    // stream parser 输出的 contentParts 含媒体时，需要走 renderFinalContentWithThinking
                    if (reply0.contentParts && reply0.contentParts.length > 0) {
                        renderFinalContentWithThinking(
                            reply0.contentParts,
                            reply0.thinkingContent,
                            reply0.groundingMetadata
                        );
                    } else {
                        renderFinalTextWithThinking(
                            reply0.content || '',
                            reply0.thinkingContent,
                            reply0.groundingMetadata
                        );
                    }
                }
            }

            // 添加统计信息
            appendStreamStats();

            // Claude pause_turn：服务端工具执行后需要 continuation
            if (reply0.pauseTurn) {
                logger.debug('[Handler] 非流式 pause_turn，发起 continuation');
                const continuationEl = assistantMessageEl;
                requestStateMachine.transition(RequestState.TOOL_CALLING);
                setIsToolCallPending(true);
                resendWithToolResults(
                    [],
                    {
                        endpoint: getCurrentEndpoint(),
                        apiKey: getCurrentApiKey(),
                        model: getCurrentModel()
                    },
                    continuationEl
                ).catch((error) => {
                    logger.error('[Handler] pause_turn continuation 失败:', error);
                });
            }
        } else {
            // 所有请求都失败了，抛出包含详细错误信息的异常
            if (requestErrors.length > 0) {
                const firstError = requestErrors[0].error;
                const errorObj = {
                    error: {
                        type: firstError.type || 'request_failed',
                        message: firstError.message || 'All requests failed'
                    }
                };

                // 如果有多个错误，添加详情（保留完整错误对象）
                if (requestErrors.length > 1) {
                    errorObj.error.allErrors = requestErrors.map((e) => ({
                        request: e.index,
                        message: e.error.message || String(e.error),
                        type: e.error.type,
                        code: e.error.code,
                        fullError: e.error.fullError || e.error // 完整错误对象
                    }));
                }

                throw errorObj;
            } else {
                throw new Error('No valid replies received');
            }
        }
    } catch (error) {
        logger.error('Non-stream response parsing error:', error);
        throw error;
    }
}

/**
 * 请求错误处理（从 sendToAPI catch 块提取）
 */
async function handleSendError(error, assistantMessageEl, sessionId, timeoutId) {
    clearTimeout(timeoutId);
    logger.error('Error:', error);

    if (error.name === 'AbortError') {
        if (state.currentAssistantMessage) {
            // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
            state.currentAssistantMessage.innerHTML =
                '<div class="error-message">[!] 请求已取消</div>';
        }
        eventBus.emit('ui:notification', { message: '请求已取消', type: 'info' });
        requestStateMachine.cancel();
        return;
    }

    let displayError = error;
    try {
        const retried = await attemptImageCompressionRetry(error, assistantMessageEl);
        if (retried) {
            requestStateMachine.forceReset();
            await sendToAPI();
            return;
        }
    } catch (retryError) {
        logger.error('[Handler] 压缩重试失败:', retryError);
        displayError = retryError;
    }

    resetAllImageRetryState();
    if (state.currentAssistantMessage) {
        // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
        state.currentAssistantMessage.innerHTML = renderHumanizedError(displayError);
        const messageIndex = saveErrorMessage(displayError, null, renderHumanizedError);
        setCurrentMessageIndex(messageIndex);
    }
    if (sessionId === state.currentSessionId) {
        requestStateMachine.transition(RequestState.ERROR, { error: displayError });
    } else {
        requestStateMachine.forceReset();
    }
}

/**
 * 请求完成后的清理工作（从 sendToAPI finally 块提取）
 */
function cleanupAfterSend(sessionId, requestSucceeded) {
    // 后台任务清理
    if (sessionId && state.backgroundTasks.has(sessionId)) {
        const task = state.backgroundTasks.get(sessionId);
        if (task?.cleanupTimer) clearTimeout(task.cleanupTimer);
        state.backgroundTasks.delete(sessionId);
        eventBus.emit('sessions:updated', { sessions: state.sessions });

        if (sessionId !== state.currentSessionId) {
            const session = state.sessions.find((s) => s.id === sessionId);
            const sessionName = session?.name || '会话';
            eventBus.emit('ui:notification', {
                message: requestSucceeded
                    ? `「${sessionName}」的 AI 回复已完成`
                    : `「${sessionName}」的 AI 回复失败`,
                type: requestSucceeded ? 'success' : 'error',
                duration: 5000
            });
        }
    }

    setIsSavingContinuation(false);
    resetAllImageRetryState();

    const isStillSameSession = sessionId === state.currentSessionId;
    if (isStillSameSession && !state.isToolCallPending) {
        setCurrentAssistantMessage(null);
    }
}

/**
 * 发送到 API
 */
async function sendToAPI() {
    const endpoint = getCurrentEndpoint();
    const apiKey = getCurrentApiKey();
    const model = getCurrentModel();

    logger.debug('[sendToAPI] 请求参数:', {
        endpoint: endpoint,
        model: model,
        apiFormat: state.apiFormat,
        currentProviderId: state.currentProviderId,
        selectedModel: state.selectedModel,
        hasApiKey: !!apiKey
    });

    // 创建 AbortController 用于取消请求
    const abortController = new AbortController();

    // 记录当前会话 ID（用于后台生成）
    const sessionId = state.currentSessionId;
    let requestSucceeded = false;

    // 转换到 SENDING 状态
    requestStateMachine.transition(RequestState.SENDING, {
        abortController,
        sessionId
    });

    // 设置请求超时
    const timeoutId = setTimeout(() => {
        abortController.abort();
        logger.warn(`请求超时（${state.requestTimeout}ms），已自动取消`);
    }, state.requestTimeout);

    // 移除欢迎消息（如果存在）
    const welcomeMessage = elements.messagesArea.querySelector('.welcome-message');
    if (welcomeMessage) {
        welcomeMessage.remove();
    }

    // 创建助手消息占位符（或复用现有的工具调用continuation/图片重试）
    let assistantMessageEl;
    let isContinuationMode = false; // 保存 continuation 状态用于后续判断

    if (state.isToolCallContinuation && state.toolCallContinuationElement) {
        // 工具调用后的continuation - 复用保存的消息元素
        isContinuationMode = true;
        assistantMessageEl = state.toolCallContinuationElement;
        setCurrentAssistantMessage(assistantMessageEl.querySelector('.message-content'));
        logger.debug('[Handler] 复用工具调用后的消息元素');

        // 清除已有的 thinking-dots（流式解析阶段残留）
        const existingDots = state.currentAssistantMessage.querySelectorAll('.thinking-dots');
        existingDots.forEach((el) => el.remove());

        // 在现有内容后添加加载提示（不删除工具调用UI）
        const loadingIndicator = document.createElement('div');
        loadingIndicator.className = 'thinking-dots continuation-loading';
        // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
        loadingIndicator.innerHTML = '<span></span><span></span><span></span>';
        state.currentAssistantMessage.appendChild(loadingIndicator);

        // 添加持久标记：标识这是 continuation 模式
        // 这个标记不会被流式渲染移除，用于 finalRender 检测
        state.currentAssistantMessage.dataset.isContinuation = 'true';

        // 设置 state 标志用于 saveAssistantMessage 检测
        setIsSavingContinuation(true);

        // 重置 continuation 标志和元素引用（语义化复合 setter，保证两者同步）
        clearToolCallContinuation();
    } else if (state.isImageCompressionRetry && state.imageRetryMessageElement) {
        // 图片压缩重试 - 复用保存的消息元素（无感重试）
        isContinuationMode = true;
        assistantMessageEl = state.imageRetryMessageElement;
        setCurrentAssistantMessage(assistantMessageEl.querySelector('.message-content'));
        logger.debug('[Handler] 复用图片压缩重试的消息元素（无感重试）');

        // 清除之前的 "图片过大" 提示，只保留加载动画
        // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
        state.currentAssistantMessage.innerHTML =
            '<div class="thinking-dots"><span></span><span></span><span></span></div>';

        // 重置图片重试标志和元素引用（语义化复合 setter，保证两者同步）
        clearImageRetry();
    } else {
        // 创建新的消息元素
        assistantMessageEl = createAssistantMessagePlaceholder();
        elements.messagesArea.appendChild(assistantMessageEl);
        setCurrentAssistantMessage(assistantMessageEl.querySelector('.message-content'));
    }

    // 初始化流统计（continuation 模式下不重置，让统计继续累积）
    if (!isContinuationMode) {
        resetStreamStats();
    } else {
        logger.debug('[Handler] Continuation 模式，保留原有统计数据');
    }

    try {
        // 流式多回复模式
        if (state.streamEnabled && state.replyCount > 1) {
            clearTimeout(timeoutId); // 清除单请求超时
            await handleMultiStreamResponses(
                endpoint,
                apiKey,
                model,
                abortController,
                assistantMessageEl,
                sessionId
            );
            return;
        }

        // 单回复模式（流式或非流式）
        // 使用提供商的原始 apiFormat，而不是切换后的格式
        const provider = getCurrentProvider();
        const requestFormat = provider?.apiFormat || 'openai';
        logger.debug(
            '[sendToAPI] 使用提供商原始格式:',
            requestFormat,
            '(provider:',
            provider?.name,
            ')'
        );

        const sendFn = getSendFunction(requestFormat);

        const response = await sendFn(endpoint, apiKey, model, abortController.signal);

        // 清除超时定时器（请求成功）
        clearTimeout(timeoutId);

        if (!response.ok) {
            // 处理错误响应
            try {
                const errorData = await response.json();

                // 图片大小超限 - 自动压缩重试
                const retried = await attemptImageCompressionRetry(errorData, assistantMessageEl);
                if (retried) {
                    requestStateMachine.forceReset();
                    await sendToAPI();
                    return;
                }

                // 非图片错误或已重试过，正常显示错误
                resetAllImageRetryState();
                // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
                state.currentAssistantMessage.innerHTML = renderHumanizedError(
                    errorData,
                    response.status
                );
                const messageIndex = saveErrorMessage(
                    errorData,
                    response.status,
                    renderHumanizedError
                );
                setCurrentMessageIndex(messageIndex);
            } catch (_e) {
                const errorData = { error: { message: `HTTP ${response.status}` } };
                // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
                state.currentAssistantMessage.innerHTML = renderHumanizedError(
                    errorData,
                    response.status
                );
                const messageIndex = saveErrorMessage(
                    errorData,
                    response.status,
                    renderHumanizedError
                );
                // Bug 2 立即设置 dataset.messageIndex
                setCurrentMessageIndex(messageIndex);
            }
            // HTTP 错误时转换到错误状态，确保 UI 和状态正确重置
            requestStateMachine.transition(RequestState.ERROR, {
                error: { status: response.status }
            });
            return;
        }

        // 处理流式响应或非流式响应
        // OpenClaw 使用 WebSocket，必须走流式路径
        const forceStream = getCurrentProvider()?.apiFormat === 'openclaw';
        if (state.streamEnabled || forceStream) {
            requestStateMachine.transition(RequestState.STREAMING, { assistantMessageEl });
            await handleStreamResponse(response, abortController, sessionId);
        } else {
            requestStateMachine.transition(RequestState.STREAMING, { assistantMessageEl });
            await handleNonStreamResponse(response, assistantMessageEl, sessionId);
        }

        // 请求成功完成（工具调用进行中时跳过，由 continuation 流程管理状态）
        requestSucceeded = true;
        if (!state.isToolCallPending) {
            requestStateMachine.transition(RequestState.COMPLETED);
        }
    } catch (error) {
        await handleSendError(error, assistantMessageEl, sessionId, timeoutId);
    } finally {
        cleanupAfterSend(sessionId, requestSucceeded);
    }
}

/**
 * 取消当前请求
 */
export function cancelCurrentRequest() {
    logger.debug('[Handler] 取消按钮被点击');
    logger.debug('[Handler] 当前状态:', requestStateMachine.getState());

    // 检测是否有异常状态（UI 显示 loading 但状态机显示 IDLE）
    const isCancelButtonVisible =
        elements.cancelRequestButton &&
        elements.cancelRequestButton.style.display !== 'none' &&
        elements.cancelRequestButton.style.display !== '';
    const currentState = requestStateMachine.getState();

    // 如果状态机不是 IDLE 但确实有活动请求，使用正常取消流程
    if (currentState !== RequestState.IDLE) {
        const cancelled = requestStateMachine.cancel();
        if (cancelled) {
            logger.debug('[Handler] 请求已取消');
            return true;
        }
    }

    // 如果状态机显示 IDLE 但 UI 显示 loading，说明状态泄漏，强制重置
    if (currentState === RequestState.IDLE && isCancelButtonVisible) {
        logger.warn('[Handler] ⚠️ 检测到状态泄漏（UI loading但状态机 IDLE），强制重置...');

        // 清理旧版状态标志
        setIsLoading(false);
        setIsSending(false);
        setIsToolCallPending(false);
        setCurrentAssistantMessage(null);
        clearToolCallContinuation();
        clearImageRetry();

        // 使用状态机强制重置
        requestStateMachine.forceReset();

        return true;
    }

    logger.warn('[Handler] ⚠️ 没有检测到需要取消的请求');
    return false;
}

/**
 * 清理 loading 指示元素（thinking-dots / continuation-loading / retry-loading）
 * 优先在指定消息元素内查找；否则在最后一条助手消息中查找
 * @param {HTMLElement|null} messageEl
 */
function removeLoadingIndicators(messageEl) {
    const root = messageEl
        ? messageEl.querySelector('.message-content')
        : document.querySelector('.message.assistant:last-child .message-content');
    if (!root) return;
    root.querySelectorAll('.thinking-dots, .continuation-loading, .retry-loading').forEach((el) =>
        el.remove()
    );
}

/**
 * 发送包含工具结果的请求（工具调用的 continuation 轮）
 *
 * 设计要点：
 *  - UI 按钮状态（sendButton/cancelButton/disabled）完全交给 RequestStateMachine._updateUI 管理，
 *    本函数不再手动操作；这是 history bug "completed→sending" 之类竞态的根因
 *  - 工具调用链中状态机串行流转 TOOL_CALLING → CONTINUATION → STREAMING → (TOOL_CALLING | COMPLETED)
 *  - 本函数只负责：扩展临时消息、标记 continuation、调用 sendToAPI、还原临时消息、清理 loading DOM
 *
 * @param {Array} toolResultMessages - 工具结果消息
 * @param {Object} _apiConfig - API 配置（保留入参以兼容老调用方，目前未使用）
 * @param {HTMLElement|null} assistantMessageEl - 要复用的助手消息元素
 */
export async function resendWithToolResults(
    toolResultMessages,
    _apiConfig,
    assistantMessageEl = null
) {
    logger.info('[Handler] 发送工具结果消息...');

    const sessionId = state.currentSessionId;
    const backup = extendMessagesTemporarily(toolResultMessages);

    // 标记 continuation 并绑定要复用的消息元素（语义化复合 setter）
    setToolCallContinuation(assistantMessageEl);

    // 状态机：TOOL_CALLING → CONTINUATION（必须在 sendToAPI 之前转换，否则状态非法）
    if (requestStateMachine.canTransition(RequestState.CONTINUATION)) {
        requestStateMachine.transition(RequestState.CONTINUATION, { assistantMessageEl });
    }

    try {
        await sendToAPI();
        logger.debug('[Handler] Continuation 请求完成');
    } catch (error) {
        // sendToAPI 内部 handleSendError 已经处理过常规错误（含状态机 transition→ERROR），
        // 此 catch 仅兜底"handleSendError 抛二次异常"等极端情况
        logger.error('[Handler] Continuation 请求失败:', error);
        setIsToolCallPending(false);
        if (
            state.currentSessionId === sessionId &&
            assistantMessageEl &&
            assistantMessageEl.isConnected
        ) {
            const contentDiv = assistantMessageEl.querySelector('.message-content');
            if (contentDiv) {
                // 用 appendChild 而非 innerHTML +=，避免重解析子树破坏思维链/代码块/Mermaid 的 click listener
                const errEl = document.createElement('div');
                errEl.className = 'error-message continuation-error';
                errEl.textContent = `工具调用后续请求失败: ${error.message}`;
                contentDiv.appendChild(errEl);
            }
        }
        throw error;
    } finally {
        restoreMessages(backup);
        setIsSavingContinuation(false);

        // 只有不再有新工具调用时，才认为本轮真正结束
        if (!state.isToolCallPending) {
            removeLoadingIndicators(assistantMessageEl);
        } else {
            logger.debug('[Handler] 检测到新的工具调用，保留 loading 等待下一轮工具执行');
        }
        // 注意：sendButton/cancelButton/isLoading 状态由状态机 _updateUI hook 接管，
        // 这里不再手动操作（避免与状态机抢 UI 控制权）
    }
}

/**
 * 初始化 API 处理器
 */
export function initAPIHandler() {
    // 监听发送请求事件
    eventBus.on('api:send-requested', () => {
        sendToAPI().catch((err) => logger.error('[handler] sendToAPI 失败:', err));
    });

    // 监听重新发送请求事件（retry功能）
    eventBus.on('api:resend-requested', () => {
        sendToAPI().catch((err) => logger.error('[handler] sendToAPI 失败:', err));
    });

    // 监听取消请求事件
    eventBus.on('api:cancel-requested', () => {
        cancelCurrentRequest();
    });

    // 监听流式错误事件
    eventBus.on('stream:error', ({ errorCode, errorMessage }) => {
        logger.error('[Handler] 流式错误:', errorCode, errorMessage);

        // 后台任务的流错误不应干扰当前会话的状态
        if (!requestStateMachine.isBusy()) {
            logger.debug('[Handler] 忽略后台任务的流式错误（状态机已空闲）');
            return;
        }

        // 使用状态机转换到错误状态
        requestStateMachine.transition(RequestState.ERROR, {
            error: { code: errorCode, message: errorMessage }
        });

        // 清理旧版状态标志（向后兼容）
        setIsLoading(false);
        setIsSending(false);
        setIsToolCallPending(false);
    });

    logger.info('API handler initialized');
}
