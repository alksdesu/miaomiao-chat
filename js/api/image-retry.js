/**
 * 图片压缩自动重试
 * 检测图片大小超限错误，自动压缩后重试请求
 */

import { logger } from '../utils/logger.js';
import { state } from '../core/state.js';
import { getCurrentProvider } from './current.js';
import { isImageSizeError, compressImagesInMessages } from '../utils/images.js';
import { replaceAllMessages, setImageRetry, clearImageRetry } from '../core/state-mutations.js';
import { renderImageRetryLoading } from './handler-loading-dots.js';

/**
 * 把多形态错误输入归一为统一 schema `{error:{message,type,status?}}`。
 * 两个入口异构：HTTP 非 2xx 走 `await response.json()` 拿到 API JSON（已有 .error），
 * catch 路径拿到的是 throw 出来的 Error / DOMException / 字符串。归一化后下游 `isImageSizeError`
 * 与统一展示走同一字段路径。
 */
export function normalizeImageRetryInput(input) {
    if (!input) return { error: { type: 'unknown', message: 'Unknown error' } };
    if (typeof input === 'string') return { error: { type: 'unknown', message: input } };
    if (input?.error?.message) return input;
    if (input instanceof Error || input?.message) {
        return {
            error: {
                type: input.name || input.type || 'error',
                message: input.message || String(input),
                status: input.status ?? null
            }
        };
    }
    return { error: { type: 'unknown', message: String(input) } };
}

/**
 * 尝试图片压缩重试
 * 检测是否为图片大小超限错误，如果是则压缩图片并准备重试
 *
 * @param {Object} input - 错误数据（API JSON / Error / 字符串均可，内部归一）
 * @param {HTMLElement} assistantMessageEl - 当前助手消息元素
 * @param {string} sessionId - 触发重试的会话 ID（必传：防止跨会话锁错位 + retry 期间会话漂移）
 * @returns {boolean} 是否已触发重试（调用方应 return 跳过后续错误处理）
 */
export async function attemptImageCompressionRetry(input, assistantMessageEl, sessionId) {
    if (!sessionId) {
        // 强制必传：缺省 fallback 到 state.currentSessionId 会让 retry 期间用户切会话后
        // 锁记到错误的 session 上，下次同会话首次 retry 被误锁失败
        logger.error('[ImageRetry] sessionId 必传');
        return false;
    }

    const errorData = normalizeImageRetryInput(input);

    if (!isImageSizeError(errorData) || state._imageCompressionRetriedSessions.has(sessionId)) {
        return false;
    }

    // 跨会话守卫：调用方 sessionId 与 state.currentSessionId 不一致时，
    // 退出，因 compressImagesInMessages 读 state.messages（=当前会话）会把另一会话的内容压成 sid 的
    // 让 sendError 路径走错误降级（写回 backgroundSession），不污染另一会话
    if (sessionId !== state.currentSessionId) {
        logger.warn(
            `[ImageRetry] 跨会话场景跳过 retry: sourceSession=${sessionId} current=${state.currentSessionId}`
        );
        // 仍设置 retry 锁，防止 backgroundTask 完成后再次触发
        state._imageCompressionRetriedSessions.add(sessionId);
        return false;
    }

    logger.warn('[ImageRetry] 检测到图片大小超限错误，自动压缩图片并重试...');

    // 防止无限循环（per-sessionId 锁；跨会话切换不会误锁后一会话的首次重试机会）
    state._imageCompressionRetriedSessions.add(sessionId);

    // 压缩消息中的图片
    const provider = getCurrentProvider();
    const apiFormat = provider?.apiFormat || 'openai';
    const fastMode = state.fastImageCompression || false;

    if (state.messages && state.messages.length > 0) {
        const compressed = await compressImagesInMessages(state.messages, apiFormat, fastMode);
        replaceAllMessages(compressed);
    }

    logger.debug('[ImageRetry] 图片压缩完成，准备重新发送请求...');

    // 设置重试标志并绑定要复用的消息元素 + 发起会话 ID（resolver 跨会话守卫读取）
    setImageRetry(assistantMessageEl, sessionId);

    // 显示加载提示（DOM 工厂构造，零裸 innerHTML）
    if (state.currentAssistantMessage) {
        state.currentAssistantMessage.replaceChildren();
        const fragment = renderImageRetryLoading();
        state.currentAssistantMessage.appendChild(fragment);
    }

    return true;
}

/**
 * 重置所有图片重试相关状态
 * - per-sessionId 锁：清除指定会话的锁
 * - isImageCompressionRetry + imageRetryMessageElement: 由 clearImageRetry 复合清理
 *
 * @param {string} sessionId - 要清除锁的会话 ID（必传：避免 fallback 误清当前会话锁）
 */
export function resetAllImageRetryState(sessionId) {
    if (!sessionId) {
        logger.error('[ImageRetry] resetAllImageRetryState: sessionId 必传');
        return;
    }
    state._imageCompressionRetriedSessions.delete(sessionId);
    clearImageRetry();
}
