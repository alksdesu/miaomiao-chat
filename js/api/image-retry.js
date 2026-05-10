/**
 * 图片压缩自动重试
 * 检测图片大小超限错误，自动压缩后重试请求
 */

import { logger } from '../utils/logger.js';
import { state } from '../core/state.js';
import { getCurrentProvider } from '../providers/manager.js';
import {
    rebuildMessageIdMap,
    setIsImageCompressionRetry,
    setImageRetryMessageElement
} from '../core/state-mutations.js';

/**
 * 尝试图片压缩重试
 * 检测是否为图片大小超限错误，如果是则压缩图片并准备重试
 * @param {Object} errorData - 错误数据（可以是 API 错误响应或 Error 对象）
 * @param {HTMLElement} assistantMessageEl - 当前助手消息元素
 * @returns {boolean} 是否已触发重试（调用方应 return 跳过后续错误处理）
 */
export async function attemptImageCompressionRetry(errorData, assistantMessageEl) {
    const { isImageSizeError, compressImagesInMessages } = await import('../utils/images.js');

    if (!isImageSizeError(errorData) || state._imageCompressionRetried) {
        return false;
    }

    logger.warn('[ImageRetry] 检测到图片大小超限错误，自动压缩图片并重试...');

    // 防止无限循环
    state._imageCompressionRetried = true;

    // 压缩消息中的图片
    const provider = getCurrentProvider();
    const apiFormat = provider?.apiFormat || 'openai';
    const fastMode = state.fastImageCompression || false;

    if (state.messages && state.messages.length > 0) {
        state.messages = await compressImagesInMessages(state.messages, apiFormat, fastMode);
        rebuildMessageIdMap();
    }

    logger.debug('[ImageRetry] 图片压缩完成，准备重新发送请求...');

    // 设置重试标志，让 sendToAPI 复用当前消息元素
    setIsImageCompressionRetry(true);
    setImageRetryMessageElement(assistantMessageEl);

    // 显示加载提示
    if (state.currentAssistantMessage) {
        // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
        state.currentAssistantMessage.innerHTML =
            '<div class="thinking-dots retry-loading"><span></span><span></span><span></span></div>' +
            '<div style="margin-top: 8px; font-size: 12px; color: #888;">图片过大，已自动压缩后重试...</div>';
    }

    return true;
}

/**
 * 重置所有图片重试相关状态
 * - _imageCompressionRetried: 无限重试防护标记
 * - isImageCompressionRetry: sendToAPI 复用消息元素的信号
 * - imageRetryMessageElement: 要复用的 DOM 元素引用
 */
export function resetAllImageRetryState() {
    state._imageCompressionRetried = false;
    setIsImageCompressionRetry(false);
    setImageRetryMessageElement(null);
}
