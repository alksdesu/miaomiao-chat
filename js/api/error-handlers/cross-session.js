/**
 * 跨会话错误处理器
 *
 * 用户在请求往返期间切换了会话 → 错误必须写回原会话，不能污染当前会话 state.messages。
 * 走 saveAssistantMessageToBackground 把错误消息落库到 ctx.sessionId 对应的会话。
 *
 * persisted 判定：saveAssistantMessageToBackground 在原会话已被删除时返回 falsy；
 * 此时弹 warn 通知告知用户「错误未持久化」，避免静默丢失。
 */

import { saveAssistantMessageToBackground } from '../../messages/sync.js';
import { renderHumanizedError } from '../../utils/errors.js';
import { requestStateMachine } from '../../core/request-state-machine.js';
import { eventBus } from '../../core/events.js';
import { logger } from '../../utils/logger.js';

/**
 * 把任意 displayError 归一为 `{error:{type,message}}` 结构（renderHumanizedError 期望）
 */
function ensureErrorPayload(displayError) {
    if (displayError?.error) return displayError;
    return {
        error: {
            type: displayError?.name || 'unknown',
            message: displayError?.message || String(displayError)
        }
    };
}

/**
 * @param {import('../error-classifier.js').ClassifiedError} classification
 * @param {import('../handler-context.js').HandlerContext} ctx
 * @returns {Promise<{handled: true}>}
 */
export async function handleCrossSession(classification, ctx) {
    const { displayError } = classification;
    const errorPayload = ensureErrorPayload(displayError);
    const errorHtml = renderHumanizedError(errorPayload);

    let persisted = false;
    try {
        const result = await saveAssistantMessageToBackground(
            ctx.sessionId,
            [],
            { raw: {} },
            { isError: true, errorData: errorPayload, errorHtml }
        );
        persisted = !!result;
    } catch (err) {
        logger.error('[ErrorHandler/cross-session] saveAssistantMessageToBackground 抛错:', err);
    }

    if (!persisted) {
        eventBus.emit('ui:notification', {
            type: 'warning',
            message: '错误消息未持久化（原会话可能已删除）',
            duration: 5000
        });
    }

    requestStateMachine.forceReset();
    return { handled: true };
}
