/**
 * 通用错误处理器（兜底）
 *
 * 在当前会话写错误 DOM + saveErrorMessage 落库 + 状态机 transition → ERROR。
 */

import { state } from '../../core/state.js';
import { requestStateMachine, RequestState } from '../../core/request-state-machine.js';
import { saveErrorMessage } from '../../messages/sync.js';
import { setCurrentMessageIndex } from '../../messages/dom-sync.js';
import { renderHumanizedError } from '../../utils/errors.js';
import { safeSetHTML } from '../../utils/helpers.js';

/**
 * @param {import('../error-classifier.js').ClassifiedError} classification
 * @returns {Promise<{handled: true}>}
 */
export async function handleGenericError(classification) {
    const { displayError } = classification;
    const errorHtml = renderHumanizedError(displayError);

    if (state.currentAssistantMessage) {
        safeSetHTML(state.currentAssistantMessage, errorHtml);
        const messageIndex = saveErrorMessage(displayError, null, renderHumanizedError);
        setCurrentMessageIndex(messageIndex);
    }

    requestStateMachine.transition(RequestState.ERROR, { error: displayError });
    return { handled: true };
}
