/**
 * 请求预检提示：当前型号不支持的参数被丢弃或改写时告知用户，同一会话里同一项只提示一次
 */

import { eventBus } from '../core/events.js';
import { EVENTS } from '../core/events-registry.js';
import { logger } from '../utils/logger.js';

/**
 * @typedef {Object} RequestNotice
 * @property {string} key     去重键
 * @property {string} message 提示文案
 */

const shownNoticeKeys = new Set();

/**
 * @param {string|null} sessionId
 * @param {RequestNotice[]} notices
 */
export function emitRequestNotices(sessionId, notices) {
    for (const notice of notices || []) {
        if (!notice?.key || !notice.message) continue;
        const dedupeKey = `${sessionId || ''}\u0000${notice.key}`;
        if (shownNoticeKeys.has(dedupeKey)) {
            logger.debug(`[RequestNotice] ${notice.message}`);
            continue;
        }
        shownNoticeKeys.add(dedupeKey);
        logger.info(`[RequestNotice] ${notice.message}`);
        eventBus.emit(EVENTS.UI_NOTIFICATION, {
            message: notice.message,
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
