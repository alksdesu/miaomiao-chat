/**
 * API 处理器主编排
 *
 * 三大对外入口：
 *   - sendToAPI              常规发送 / 重发 / continuation 复用统一入口
 *   - cancelCurrentRequest   用户点取消按钮 / 状态泄漏强制重置（→ handler-cancel.js）
 *   - resendWithToolResults  工具结果回写后 continuation 轮触发（→ handler-continuation.js）
 *
 * 拆分职责（详见各子模块 JSDoc）：
 *   - handler-context.js        HandlerContext 不可变快照
 *   - placeholder-resolver.js   三分支 placeholder 收口（continuation/image-retry/new）
 *   - error-classifier.js       错误初判（kind + displayError 改写）
 *   - error-handlers/           5 种 kind → 4 个 handler 派发
 *   - handler-non-stream.js     非流式响应处理（多回复并发 + 工具调用早期返回）
 *   - handler-stream-entry.js   流式响应 adapter 路由
 *   - handler-http-error.js     HTTP 非 2xx 错误处理（含 image-retry）
 *   - handler-cleanup.js        finally 清理（后台任务 + 通知）
 *   - handler-cancel.js         取消请求编排（含单飞守卫）
 *   - handler-continuation.js   工具结果回写后续轮
 *   - handler-loading-dots.js   thinking-dots DOM 工厂（零裸 innerHTML）
 */

import { state } from '../core/state.js';
import { eventBus } from '../core/events.js';
import { requestStateMachine, RequestState } from '../core/request-state-machine.js';
import { getSendFunction } from './factory.js';
import { resetStreamStats } from '../stream/stats.js';
import { handleMultiStreamResponses } from '../stream/multi-stream.js';
import { logger } from '../utils/logger.js';

import { createHandlerContext } from './handler-context.js';
import { resolvePlaceholder } from './placeholder-resolver.js';
import { classifyError } from './error-classifier.js';
import { dispatchErrorHandler } from './error-handlers/index.js';
import { handleNonStreamResponse } from './handler-non-stream.js';
import { handleStreamResponse } from './handler-stream-entry.js';
import { handleHttpErrorResponse } from './handler-http-error.js';
import { cleanupAfterSend } from './handler-cleanup.js';
import { cancelCurrentRequest } from './handler-cancel.js';

// 保持向后兼容：handler.js 历史导出 (cancelCurrentRequest / resendWithToolResults /
// getCurrentEndpoint / getCurrentApiKey / getCurrentModel) 全部从子模块 re-export
// orchestrator.js 动态 import handler.js 拿 resendWithToolResults，路径不变
export { cancelCurrentRequest } from './handler-cancel.js';
export { resendWithToolResults } from './handler-continuation.js';
export { getCurrentEndpoint, getCurrentApiKey, getCurrentModel } from './current.js';

/**
 * 发送到 API（主入口）
 */
export async function sendToAPI() {
    const ctx = createHandlerContext();
    logger.debug('[sendToAPI] ctx:', {
        endpoint: ctx.endpoint,
        model: ctx.model,
        sessionId: ctx.sessionId,
        apiFormat: state.apiFormat,
        currentProviderId: state.currentProviderId,
        hasApiKey: !!ctx.apiKey
    });

    requestStateMachine.transition(RequestState.SENDING, {
        abortController: ctx.abortController,
        sessionId: ctx.sessionId
    });

    // 请求超时——abort 携带 TimeoutError reason 让 classifyError 区分超时 vs 用户取消
    ctx.timeoutId = setTimeout(() => {
        ctx.abortController.abort(new DOMException('Request timeout', 'TimeoutError'));
        logger.warn(`请求超时（${ctx.timeoutMs}ms），已自动取消`);
    }, ctx.timeoutMs);

    resolvePlaceholder(ctx);

    // continuation 模式累计统计，image-retry 与 new 模式重置
    if (!ctx.isContinuationMode) {
        resetStreamStats();
    } else {
        logger.debug('[Handler] Continuation 模式，保留原有统计数据');
    }

    let requestSucceeded = false;
    try {
        const { requestFormat, adapter } = ctx;
        const canMultiStream = adapter?.supportsMultiStream !== false;

        // 流式多回复路径
        if (state.streamEnabled && state.replyCount > 1 && canMultiStream) {
            clearTimeout(ctx.timeoutId);
            ctx.timeoutId = null;
            await handleMultiStreamResponses(ctx);
            requestSucceeded = true;
            if (!state.isToolCallPending) {
                requestStateMachine.transition(RequestState.COMPLETED);
            }
            return;
        }

        // 多回复但 adapter 不支持并发：降级 + 提示
        if (state.streamEnabled && state.replyCount > 1 && !canMultiStream) {
            const name = adapter?.name || requestFormat;
            logger.warn(`[Handler] ${name} 不支持多回复并发，降级为单流`);
            eventBus.emit('ui:notification', {
                message: `${name} 不支持多回复并发，已自动降级为单回复`,
                type: 'warning',
                duration: 5000
            });
        }

        // 单回复（流式或非流式）
        logger.debug('[sendToAPI] 使用提供商原始格式:', requestFormat);
        const sendFn = getSendFunction(requestFormat);
        // 传 ctx.adapter 让薄壳用快照 adapter，而非请求往返期间重查 provider
        const response = await sendFn(
            ctx.endpoint,
            ctx.apiKey,
            ctx.model,
            ctx.abortController.signal,
            ctx.adapter
        );

        clearTimeout(ctx.timeoutId);
        ctx.timeoutId = null;

        if (!response.ok) {
            const { retried } = await handleHttpErrorResponse(response, ctx);
            if (retried) requestSucceeded = true;
            return;
        }

        // OpenClaw 走 WebSocket 必须走流式路径
        const forceStream = requestFormat === 'openclaw';
        requestStateMachine.transition(RequestState.STREAMING, {
            assistantMessageEl: ctx.assistantMessageEl
        });
        if (state.streamEnabled || forceStream) {
            await handleStreamResponse(response, ctx);
        } else {
            await handleNonStreamResponse(response, ctx);
        }

        // 请求成功完成（工具调用进行中由 continuation 流程管理状态机，跳过此处转换）
        requestSucceeded = true;
        if (!state.isToolCallPending) {
            requestStateMachine.transition(RequestState.COMPLETED);
        }
    } catch (error) {
        logger.error('[sendToAPI] Error:', error);
        const classification = classifyError(error, ctx);
        await dispatchErrorHandler(classification, ctx);
    } finally {
        cleanupAfterSend(ctx, requestSucceeded);
    }
}

/**
 * 初始化 API 处理器：注册事件监听
 */
export function initAPIHandler() {
    eventBus.on('api:send-requested', () => {
        sendToAPI().catch((err) => logger.error('[handler] sendToAPI 失败:', err));
    });

    eventBus.on('api:resend-requested', () => {
        sendToAPI().catch((err) => logger.error('[handler] sendToAPI 失败:', err));
    });

    eventBus.on('api:cancel-requested', () => {
        cancelCurrentRequest();
    });

    eventBus.on('stream:error', ({ errorCode, errorMessage }) => {
        logger.error('[Handler] 流式错误:', errorCode, errorMessage);

        // 后台任务的流错误不应干扰当前会话状态
        if (!requestStateMachine.isBusy()) {
            logger.debug('[Handler] 忽略后台任务的流式错误（状态机已空闲）');
            return;
        }

        // 用户取消的部分保存 commitError 也发 stream:error；CANCELLED 只允许回 IDLE
        if (requestStateMachine.getState() === RequestState.CANCELLED) {
            state.isToolCallPending = false;
            return;
        }

        requestStateMachine.transition(RequestState.ERROR, {
            error: { code: errorCode, message: errorMessage }
        });

        // 旧版状态标志清理（向后兼容）
        state.isLoading = false;
        state.isSending = false;
        state.isToolCallPending = false;
    });

    logger.info('API handler initialized');
}
