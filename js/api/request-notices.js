/**
 * 请求预检提示：当前型号不支持的参数被丢弃或改写时告知用户，同一会话里同样的提示只出现一次
 */

import { state } from '../core/state.js';
import { eventBus } from '../core/events.js';
import { EVENTS } from '../core/events-registry.js';
import { logger } from '../utils/logger.js';

/**
 * @typedef {Object} RequestNotice
 * @property {string} key     提示项
 * @property {string} message 提示文案
 */

const shownNoticeKeys = new Set();

/**
 * 给后台会话的提示加上会话名，用户不在该会话时也能分辨提示来自哪里
 * @param {string|null} sessionId
 * @param {string} message
 * @returns {string}
 */
export function withSessionLabel(sessionId, message) {
    const session = sessionId ? state.sessions?.find((item) => item.id === sessionId) : null;
    return `「${session?.name || '会话'}」${message}`;
}

/**
 * @param {string|null} sessionId
 * @param {RequestNotice[]} notices
 * @param {{ modelName?: string }} [context] - modelName 写进提示，换了模型的同类提示会重新出现
 */
export function emitRequestNotices(sessionId, notices, { modelName = '' } = {}) {
    for (const notice of notices || []) {
        if (!notice?.key || !notice.message) continue;
        const text = modelName ? `${modelName}：${notice.message}` : notice.message;
        const dedupeKey = `${sessionId || ''}\u0000${notice.key}\u0000${text}`;
        if (shownNoticeKeys.has(dedupeKey)) {
            logger.debug(`[RequestNotice] ${text}`);
            continue;
        }
        shownNoticeKeys.add(dedupeKey);
        logger.info(`[RequestNotice] ${text}`);
        const isBackground = !!sessionId && sessionId !== state.currentSessionId;
        eventBus.emit(EVENTS.UI_NOTIFICATION, {
            message: isBackground ? withSessionLabel(sessionId, text) : text,
            type: 'warning',
            duration: 6000
        });
    }
}

/**
 * XML 工具模式下工具写进提示词，联网搜索、代码执行这类服务端工具无法这样调用
 * @param {Object} stateRef
 * @param {RequestNotice[]|undefined} notices
 */
export function pushXmlBuiltinToolsNotice(stateRef, notices) {
    if (!notices) return;
    const names = [];
    if (stateRef.webSearchEnabled) names.push('联网搜索');
    if (stateRef.codeExecutionEnabled) names.push('代码执行');
    if (names.length === 0) return;
    notices.push({
        key: 'xml.builtin-tools',
        message: `XML 工具模式下无法使用${names.join('、')}，本次请求未附带`
    });
}

export function clearRequestNoticesForTests() {
    shownNoticeKeys.clear();
}
