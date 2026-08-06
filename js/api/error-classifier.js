/**
 * 错误分类器：handleSendError 的初判阶段。
 *
 * 职责：识别错误 kind + 改写面向用户的 displayError（如 timeout 改写）。
 * 不做副作用（不发通知、不动 state、不触 retry）—— 副作用全部交给对应 handler。
 *
 * stream:error 事件路径不经此 classifier（独立 transition→ERROR），
 * 但 fromStreamError() 留作适配入口，便于未来对齐。
 */

import { state } from '../core/state.js';

/**
 * 错误种类枚举
 */
export const ErrorKind = Object.freeze({
    /** 用户主动取消（AbortError 且非 timeout reason） */
    USER_ABORT: 'user-abort',
    /** setTimeout 触发的 AbortError（携带 TimeoutError reason） */
    TIMEOUT: 'timeout',
    /** 错误发生时 ctx.sessionId !== state.currentSessionId */
    CROSS_SESSION: 'cross-session',
    /** 候选 image-retry 路径，需经 image-retry handler 进一步判定 */
    IMAGE_RETRY_CANDIDATE: 'image-retry-candidate',
    /** 兜底：以上都不是的常规错误 */
    GENERIC: 'generic'
});

/**
 * @typedef {Object} ClassifiedError
 * @property {string} kind             - ErrorKind 之一
 * @property {*} displayError          - 面向用户的错误对象（timeout 已改写为友好结构）
 * @property {boolean} isCrossSession  - 是否跨会话（cross-session handler 用）
 */

/**
 * @param {Error} error
 * @param {import('./handler-context.js').HandlerContext} ctx
 * @returns {ClassifiedError}
 */
export function classifyError(error, ctx) {
    // 现代浏览器 abort(reason) 时 fetch reject 的就是 reason 本身（TimeoutError DOMException）,
    // 旧实现 reject AbortError 需回查 signal.reason，两条路径都要覆盖
    const isTimeoutAbort =
        error?.name === 'TimeoutError' ||
        (error?.name === 'AbortError' &&
            ctx.abortController?.signal?.reason?.name === 'TimeoutError');
    const isCrossSession =
        ctx.sessionId !== state.currentSessionId || ctx.task?.isDetached === true;

    // user-abort 必须最先判（早期 return），cleanupAfterSend 在 finally 兜底
    if (error?.name === 'AbortError' && !isTimeoutAbort) {
        return { kind: ErrorKind.USER_ABORT, displayError: error, isCrossSession };
    }

    // timeout 改写 displayError（仍可能 fall-through 到 image-retry 候选）
    let displayError = error;
    if (isTimeoutAbort) {
        const timeoutSec = Math.round((ctx.timeoutMs ?? 0) / 1000);
        displayError = {
            error: {
                type: 'timeout',
                message: `请求超时（${timeoutSec}s 未收到响应）`
            }
        };
    }

    // cross-session 优先级高于 image-retry（避免 image-retry 锁写错会话）
    if (isCrossSession) {
        return { kind: ErrorKind.CROSS_SESSION, displayError, isCrossSession: true };
    }

    return {
        kind: isTimeoutAbort ? ErrorKind.TIMEOUT : ErrorKind.IMAGE_RETRY_CANDIDATE,
        displayError,
        isCrossSession: false
    };
}

/**
 * 适配 stream:error 事件 payload —— 未来扩展用，本期未启用
 * @param {{error: any}} payload
 * @param {import('./handler-context.js').HandlerContext} ctx
 * @returns {ClassifiedError}
 */
export function fromStreamError(payload, ctx) {
    return classifyError(payload?.error ?? payload, ctx);
}
