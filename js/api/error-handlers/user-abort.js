/**
 * 用户主动取消处理器（AbortError 且非 TimeoutError reason）
 *
 * 跨会话场景仅记日志：不动当前会话 DOM，不发通知（用户切到别处不应被打扰）。
 * 本会话场景：写「请求已取消」提示 DOM + 通知。
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
    const { isCrossSession } = classification;

    if (isCrossSession) {
        logger.debug(`[ErrorHandler/user-abort] 跨会话 abort 跳过 UI 操作: ${ctx.sessionId}`);
    } else {
        if (state.currentAssistantMessage) {
            safeSetHTML(
                state.currentAssistantMessage,
                '<div class="error-message">[!] 请求已取消</div>'
            );
        }
        eventBus.emit('ui:notification', { message: '请求已取消', type: 'info' });
    }

    state.isToolCallPending = false;
    clearToolCallContinuation();
    requestStateMachine.cancel();

    return { handled: true };
}
