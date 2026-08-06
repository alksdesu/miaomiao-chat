/**
 * 图片压缩自动重试
 * 检测图片大小超限错误，自动压缩后重试请求
 */

import { logger } from '../utils/logger.js';
import { state } from '../core/state.js';
import { isImageSizeError, compressImagesInMessages } from '../utils/images.js';
import { replaceAllMessages, setImageRetry, clearImageRetry } from '../core/state-mutations.js';
import { renderImageRetryLoading } from './handler-loading-dots.js';
import { materializeSessionMessages } from '../state/session-message-repository.js';
import { resolveMessagesMediaForApi } from '../state/media-blob-store.js';
import { loadSessionMessages } from '../state/storage.js';
import { requestTaskRegistry } from '../core/request-task-registry.js';

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
export async function attemptImageCompressionRetry(
    input,
    assistantMessageEl,
    sessionId,
    task = null
) {
    if (!sessionId) {
        // 强制必传：缺省 fallback 到 state.currentSessionId 会让 retry 期间用户切会话后
        // 锁记到错误的 session 上，下次同会话首次 retry 被误锁失败
        logger.error('[ImageRetry] sessionId 必传');
        return false;
    }

    const errorData = normalizeImageRetryInput(input);
    const isForeground = () =>
        sessionId === state.currentSessionId &&
        (!task || (requestTaskRegistry.owns(task) && !task.isDetached));

    if (
        !isImageSizeError(errorData) ||
        task?.imageRetryAttempted ||
        state._imageCompressionRetriedSessions.has(sessionId)
    ) {
        return false;
    }

    if (task && !requestTaskRegistry.owns(task)) return false;
    if (!task && sessionId !== state.currentSessionId) {
        state._imageCompressionRetriedSessions.add(sessionId);
        return false;
    }

    logger.warn('[ImageRetry] 检测到图片大小超限错误，自动压缩图片并重试...');

    // 防止无限循环（per-sessionId 锁；跨会话切换不会误锁后一会话的首次重试机会）
    state._imageCompressionRetriedSessions.add(sessionId);
    if (task) task.imageRetryAttempted = true;

    const apiFormat = task?.requestProfile?.providerApiFormat || 'openai';
    const fastMode =
        task?.requestProfile?.state?.fastImageCompression ?? state.fastImageCompression;

    let sourceMessages =
        task?.requestContext?.sourceMessages ||
        (isForeground() ? state.messageStore?.toArray?.() || [...(state.messages || [])] : null);
    if (!Array.isArray(sourceMessages)) {
        sourceMessages = (await loadSessionMessages(sessionId))?.messages || [];
    } else {
        sourceMessages = await materializeSessionMessages(sessionId, sourceMessages);
    }
    if (task && !requestTaskRegistry.owns(task)) return false;

    if (sourceMessages.length > 0) {
        const messages = await resolveMessagesMediaForApi(sourceMessages);
        if (task && !requestTaskRegistry.owns(task)) return false;
        const compressed = await compressImagesInMessages(messages, apiFormat, fastMode);
        if (task && !requestTaskRegistry.owns(task)) return false;
        if (task) task.retryMessages = compressed;
        if (isForeground()) replaceAllMessages(compressed);
    }

    logger.debug('[ImageRetry] 图片压缩完成，准备重新发送请求...');

    // 设置重试标志并绑定要复用的消息元素 + 发起会话 ID（resolver 跨会话守卫读取）
    if (task) task.isImageRetry = true;
    if (isForeground()) setImageRetry(assistantMessageEl, sessionId);

    // 显示加载提示（DOM 工厂构造，零裸 innerHTML）
    const contentElement = assistantMessageEl?.classList?.contains('message-content')
        ? assistantMessageEl
        : assistantMessageEl?.querySelector?.('.message-content') || state.currentAssistantMessage;
    if (isForeground() && contentElement) {
        contentElement.replaceChildren();
        const fragment = renderImageRetryLoading();
        contentElement.appendChild(fragment);
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
export function resetAllImageRetryState(sessionId, task = null) {
    if (!sessionId) {
        logger.error('[ImageRetry] resetAllImageRetryState: sessionId 必传');
        return;
    }
    state._imageCompressionRetriedSessions.delete(sessionId);
    if (task) {
        task.isImageRetry = false;
        task.imageRetryAttempted = false;
        task.retryMessages = null;
    }
    if (!state.imageRetrySessionId || state.imageRetrySessionId === sessionId) clearImageRetry();
}
