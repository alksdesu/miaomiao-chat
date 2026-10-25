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

export function clearRequestNoticesForTests() {
    shownNoticeKeys.clear();
}
