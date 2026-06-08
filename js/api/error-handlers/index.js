/**
 * 错误派发表
 *
 * classifyError 给出 kind → HANDLERS 表查 handler → 执行副作用。
 *
 * fall-through 规则：image-retry-candidate 失败时返回 `{handled:false, displayError}`,
 * dispatcher 自动接力到 GENERIC handler，并传递改写后的 displayError（compose 模式）。
 *
 * 任一 handler 自身抛错被 dispatcher catch 并交给 GENERIC 兜底，确保 cleanupAfterSend
 * 在 finally 一定能跑到，不让 sendToAPI 卡在错误处理阶段。
 */

import { ErrorKind } from '../error-classifier.js';
import { handleUserAbort } from './user-abort.js';
import { handleCrossSession } from './cross-session.js';
import { handleImageRetryAttempt } from './image-retry-handler.js';
import { handleGenericError } from './generic.js';
import { logger } from '../../utils/logger.js';

const HANDLERS = Object.freeze({
    [ErrorKind.USER_ABORT]: handleUserAbort,
    [ErrorKind.CROSS_SESSION]: handleCrossSession,
    [ErrorKind.TIMEOUT]: handleImageRetryAttempt,
    [ErrorKind.IMAGE_RETRY_CANDIDATE]: handleImageRetryAttempt,
    [ErrorKind.GENERIC]: handleGenericError
});

/**
 * @param {import('../error-classifier.js').ClassifiedError} classification
 * @param {import('../handler-context.js').HandlerContext} ctx
 * @returns {Promise<{handled: true}>}
 */
export async function dispatchErrorHandler(classification, ctx) {
    const { kind } = classification;
    const handler = HANDLERS[kind] || handleGenericError;

    let result;
    try {
        result = await handler(classification, ctx);
    } catch (err) {
        logger.error(`[ErrorDispatcher] ${kind} handler 自身抛错，fall-through 到 GENERIC:`, err);
        return handleGenericError(classification, ctx);
    }

    // image-retry-candidate 失败 fall-through 到 GENERIC，保留改写后的 displayError
    if (!result?.handled && kind !== ErrorKind.GENERIC) {
        return handleGenericError(
            {
                ...classification,
                displayError: result?.displayError ?? classification.displayError
            },
            ctx
        );
    }

    return result;
}

export { ErrorKind };
