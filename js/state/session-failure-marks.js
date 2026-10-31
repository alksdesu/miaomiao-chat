/**
 * 侧栏「生成失败」标记的持久化与跨标签页同步：标记变化时写入偏好并广播，启动时恢复
 */

import { eventBus } from '../core/events.js';
import { EVENTS } from '../core/events-registry.js';
import { requestTaskRegistry } from '../core/request-task-registry.js';
import { savePreference, loadPreference } from './preferences-storage.js';
import { withDBLock } from './indexeddb.js';
import { broadcastEvent } from './tab-sync.js';
import { logger } from '../utils/logger.js';

const FAILED_SESSIONS_PREF_KEY = 'failedSessionIds';
// 多个标签页同时改写同一份列表时串行化，整份覆盖会丢掉对方刚加的标记
const FAILED_SESSIONS_LOCK = 'webchat-failed-session-marks';

async function loadStoredFailedSessionIds() {
    const stored = await loadPreference(FAILED_SESSIONS_PREF_KEY);
    return Array.isArray(stored) ? stored.filter((id) => typeof id === 'string' && id) : [];
}

/**
 * 锁内读出最新列表再改写，只增删本次变化涉及的会话
 * @param {(ids: string[]) => string[]} update
 */
function updateStoredFailedSessionIds(update) {
    return withDBLock(FAILED_SESSIONS_LOCK, async () => {
        const current = await loadStoredFailedSessionIds();
        const next = update(current);
        const unchanged =
            next.length === current.length && next.every((id, index) => id === current[index]);
        if (!unchanged) await savePreference(FAILED_SESSIONS_PREF_KEY, next);
    });
}

function persistFailureChange(sessionId, failed) {
    return updateStoredFailedSessionIds((ids) => {
        if (!failed) return ids.filter((id) => id !== sessionId);
        return ids.includes(sessionId) ? ids : [...ids, sessionId];
    });
}

eventBus.on(EVENTS.SESSION_FAILURE_CHANGED, ({ sessionId, failed } = {}) => {
    if (!sessionId || typeof failed !== 'boolean') return;
    // 落库后再广播：对方据此回写的清除必然排在本次写入之后，不会被它覆盖回去
    persistFailureChange(sessionId, failed)
        .catch((e) => {
            logger.warn('[FailureMarks] 失败标记持久化失败:', e);
        })
        .finally(() => {
            broadcastEvent('session-failure-changed', { sessionId, failed });
        });
});

/**
 * 启动时恢复失败标记，并剔除已删除会话残留的记录
 * @param {string[]} existingSessionIds - 库内现存的会话 ID
 */
export async function restoreSessionFailureMarks(existingSessionIds) {
    const existing = new Set(existingSessionIds || []);
    const stored = await loadStoredFailedSessionIds();
    const kept = stored.filter((id) => existing.has(id));
    requestTaskRegistry.restoreFailures(kept);
    if (kept.length === stored.length) return;
    await updateStoredFailedSessionIds((ids) => ids.filter((id) => existing.has(id)));
}
