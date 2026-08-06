/**
 * 图片压缩重试候选处理器
 *
 * 输入：可能是图片大小超限错误的任意 displayError。
 * 行为：调 attemptImageCompressionRetry 走压缩 retry；成功则 sendToAPI 递归；
 * 失败 fall-through 到 GENERIC handler（保留原 displayError 或改写为 retry 抛出的错）。
 *
 * sendToAPI 递归调用通过 lazy import 打破循环：本模块挂在 error-handlers/ 下,
 * handler.js 进 import error-handlers/index.js，反向静态 import 会循环。
 */

import {
    attemptImageCompressionRetry,
    resetAllImageRetryState,
    normalizeImageRetryInput
} from '../image-retry.js';
import { logger } from '../../utils/logger.js';

/**
 * @param {import('../error-classifier.js').ClassifiedError} classification
 * @param {import('../handler-context.js').HandlerContext} ctx
 * @returns {Promise<{handled: boolean, displayError?: any}>}
 */
export async function handleImageRetryAttempt(classification, ctx) {
    const { displayError } = classification;

    let retried = false;
    let retryError = null;
    try {
        retried = await attemptImageCompressionRetry(
            normalizeImageRetryInput(displayError),
            ctx.assistantMessageEl,
            ctx.sessionId,
            ctx.task
        );
    } catch (err) {
        retryError = err;
        logger.error('[ErrorHandler/image-retry] 压缩重试自身抛错:', err);
    }

    if (retried) {
        // 压缩重试属自动流程，弹「已强制重置」success 通知会误导用户
        if (ctx.timeoutId) {
            clearTimeout(ctx.timeoutId);
            ctx.timeoutId = null;
        }
        // lazy import 打破循环依赖：handler.js → error-handlers/index.js → 本文件 → handler.js
        const { sendToAPI } = await import('../handler.js');
        await sendToAPI({ task: ctx.task });
        return { handled: true };
    }

    // 重试未触发或失败 → 释放锁，把（可能被改写的）displayError 透给 GENERIC handler
    resetAllImageRetryState(ctx.sessionId, ctx.task);
    return {
        handled: false,
        displayError: retryError ?? displayError
    };
}
