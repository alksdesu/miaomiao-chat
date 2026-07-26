/**
 * 用户主动取消处理器（AbortError 且非 TimeoutError reason）
 *
 * 跨会话场景仅做本次后台任务自身清理：不动当前会话 DOM，不发通知，
 * 不碰全局工具状态；requestStateMachine 是全局单例，切会话后可能已被
 * 当前会话新请求占用，仅当状态机仍持有本次请求的 abortController 时才 cancel。
 *
 * 本会话场景：parser 已部分保存（displayError.partialSaved）时保留已渲染内容
 * （取消提示由 finalizeStreamWithError 以 append 方式注入），仅在无内容时
 * 整体覆盖为「请求已取消」提示。
 *
 * 工具调用执行中 / continuation 流式中途的 abort 会让 isToolCallPending 与
 * toolCallContinuationElement 残留 → 下次 sendToAPI 复用过期 element 导致
 * currentAssistantMessage=null 让流式渲染 no-op，必须主动清理。
 */

import { state } from '../../core/state.js';
import { eventBus } from '../../core/events.js';
import { requestStateMachine } from '../../core/request-state-machine.js';
import { clearToolCallContinuation } from '../../core/state-mutations.js';
import { safeSetHTML } from '../../utils/helpers.js';
import { logger } from '../../utils/logger.js';

/**
 * @param {import('../error-classifier.js').ClassifiedError} classification
 * @param {import('../handler-context.js').HandlerContext} ctx
 * @returns {Promise<{handled: true}>}
 */
export async function handleUserAbort(classification, ctx) {
    const { isCrossSession, displayError } = classification;
    const partialSaved = displayError?.partialSaved === true;
    const ownsStateMachine =
        !!ctx.abortController && ctx.abortController === requestStateMachine.abortController;

    if (isCrossSession) {
        logger.debug(`[ErrorHandler/user-abort] 跨会话 abort 跳过 UI 操作: ${ctx.sessionId}`);
        if (ownsStateMachine) {
            requestStateMachine.cancel();
        }
        return { handled: true };
    }

    if (!partialSaved && state.currentAssistantMessage) {
        safeSetHTML(
            state.currentAssistantMessage,
            '<div class="error-message">[!] 请求已取消</div>'
        );
    }
    eventBus.emit('ui:notification', { message: '请求已取消', type: 'info' });

    state.isToolCallPending = false;
    clearToolCallContinuation();
    // 部分保存路径的 commitError 已发 stream:error 驱动状态机走 ERROR → IDLE，
    // 再 cancel 会触发非法状态转换日志
    if (!partialSaved && ownsStateMachine) {
        requestStateMachine.cancel();
    }

    return { handled: true };
}
