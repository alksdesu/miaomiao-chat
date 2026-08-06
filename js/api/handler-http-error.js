/**
 * HTTP 非 2xx 响应处理
 *
 * 先试 image-retry（图片超限自动压缩重试），失败再判跨会话：
 *   - 跨会话：错误必须写回原会话不污染当前会话 → saveAssistantMessageToBackground
 *   - 同会话：humanized error 显示 + saveErrorMessage 落库当前会话
 *
 * sendToAPI 递归通过 lazy import 打破循环依赖：handler.js → 本文件 → handler.js。
 */

import { state } from '../core/state.js';
import { eventBus } from '../core/events.js';
import { requestStateMachine, RequestState } from '../core/request-state-machine.js';
import { saveAssistantMessageAsync, saveAssistantMessageToBackground } from '../messages/sync.js';
import { setCurrentMessageIndex } from '../messages/dom-sync.js';
import { renderHumanizedError } from '../utils/errors.js';
import { safeSetHTML } from '../utils/helpers.js';
import { logger } from '../utils/logger.js';
import { attemptImageCompressionRetry, resetAllImageRetryState } from './image-retry.js';
import { requestTaskRegistry } from '../core/request-task-registry.js';

/**
 * 跨会话路径：错误消息落库到原会话不污染当前会话
 */
async function persistErrorToBackground(ctx, errorData, status) {
    const errorHtml = renderHumanizedError(errorData, status);
    let persisted = false;
    try {
        const result = await saveAssistantMessageToBackground(
            ctx.sessionId,
            [],
            {
                model: ctx.requestProfile?.modelDisplayName,
                provider: ctx.requestProfile?.providerName,
                raw: {}
            },
            { isError: true, errorData, errorHtml }
        );
        persisted = !!result;
    } catch (err) {
        logger.error('[handler-http-error] saveAssistantMessageToBackground 抛错:', err);
    }
    if (!persisted) {
        eventBus.emit('ui:notification', {
            type: 'warning',
            message: '错误消息未持久化（原会话可能已删除）',
            duration: 5000
        });
    }
}

/**
 * @param {Response} response
 * @param {import('./handler-context.js').HandlerContext} ctx
 * @returns {Promise<{retried: boolean}>}
 */
export async function handleHttpErrorResponse(response, ctx) {
    let errorData;
    try {
        errorData = await response.json();
    } catch {
        errorData = { error: { message: `HTTP ${response.status}` } };
    }

    const retried = await attemptImageCompressionRetry(
        errorData,
        ctx.assistantMessageEl,
        ctx.sessionId,
        ctx.task
    );
    if (retried) {
        // 压缩重试属自动流程，弹「已强制重置」success 通知会误导用户
        if (ctx.timeoutId) {
            clearTimeout(ctx.timeoutId);
            ctx.timeoutId = null;
        }
        // lazy import 打破循环依赖：handler.js → handler-http-error.js → handler.js
        const { sendToAPI } = await import('./handler.js');
        await sendToAPI({ task: ctx.task });
        return { retried: true };
    }

    resetAllImageRetryState(ctx.sessionId, ctx.task);

    // 跨会话守卫：响应到达时用户已切走，错误必须写原会话不写当前会话
    // 与 cross-session error-handler 行为一致：background 落库 + 失败通知 + 状态机重置
    if (ctx.sessionId !== state.currentSessionId || ctx.task?.isDetached) {
        logger.warn(
            `[handler-http-error] 跨会话场景: ctx.sessionId=${ctx.sessionId} current=${state.currentSessionId}，错误写回原会话`
        );
        await persistErrorToBackground(ctx, errorData, response.status);
        // 与 handler-cleanup 的会话归属判断对齐：状态机是全局单例，切会话后可能
        // 已被当前会话新请求占用，无条件转 ERROR 会让新请求的取消按钮消失
        if (requestStateMachine.sessionId === ctx.sessionId) {
            requestStateMachine.transition(RequestState.ERROR, {
                error: { status: response.status }
            });
        }
        return { retried: false };
    }

    const errorHtml = renderHumanizedError(errorData, response.status);
    const target = ctx.assistantMessageEl?.querySelector?.('.message-content') || null;
    if (target) safeSetHTML(target, errorHtml);
    const messageIndex = await saveAssistantMessageAsync(
        [],
        {
            model: ctx.requestProfile?.modelDisplayName,
            provider: ctx.requestProfile?.providerName,
            raw: {}
        },
        {
            sessionId: ctx.sessionId,
            forceBackground: ctx.task?.isDetached === true,
            isError: true,
            errorData,
            errorHtml
        }
    );
    if (
        ctx.sessionId === state.currentSessionId &&
        !ctx.task?.isDetached &&
        (!ctx.task || requestTaskRegistry.owns(ctx.task))
    ) {
        setCurrentMessageIndex(messageIndex);
    }
    if (ctx.task && requestTaskRegistry.owns(ctx.task)) {
        requestTaskRegistry.setPhase(ctx.task, RequestState.ERROR);
        requestStateMachine.transitionFor(ctx.task, RequestState.ERROR, {
            error: { status: response.status }
        });
    }
    return { retried: false };
}
