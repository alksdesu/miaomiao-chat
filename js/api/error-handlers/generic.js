/**
 * 通用错误处理器（兜底）
 *
 * 在当前会话写错误 DOM + saveErrorMessage 落库 + 状态机 transition → ERROR。
 */

import { state } from '../../core/state.js';
import { requestStateMachine, RequestState } from '../../core/request-state-machine.js';
import { saveAssistantMessageAsync } from '../../messages/sync.js';
import { setCurrentMessageIndex } from '../../messages/dom-sync.js';
import { renderHumanizedError } from '../../utils/errors.js';
import { safeSetHTML } from '../../utils/helpers.js';
import { requestTaskRegistry } from '../../core/request-task-registry.js';

/**
 * @param {import('../error-classifier.js').ClassifiedError} classification
 * @returns {Promise<{handled: true}>}
 */
export async function handleGenericError(classification, ctx) {
    const { displayError } = classification;
    const errorHtml = renderHumanizedError(displayError);
    const foreground =
        ctx.sessionId === state.currentSessionId &&
        (!ctx.task || (requestTaskRegistry.owns(ctx.task) && !ctx.task.isDetached));
    const target = ctx.assistantMessageEl?.querySelector?.('.message-content') || null;

    if (foreground && target) safeSetHTML(target, errorHtml);
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
            errorData: displayError,
            errorHtml
        }
    );
    if (foreground) setCurrentMessageIndex(messageIndex);

    if (ctx.task) {
        requestTaskRegistry.setPhase(ctx.task, RequestState.ERROR);
        requestStateMachine.transitionFor(ctx.task, RequestState.ERROR, { error: displayError });
    } else {
        requestStateMachine.transition(RequestState.ERROR, { error: displayError });
    }
    return { handled: true };
}
