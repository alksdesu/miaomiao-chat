/**
 * 会话任务的跨标签页存在感：执行任务的标签页以 exclusive 模式持有按会话 + 标签页命名的 Web Lock，
 * 其他标签页查询锁判断会话是否正在别处执行，并以 shared 模式排队等待释放。
 */

import { eventBus } from '../core/events.js';
import { EVENTS } from '../core/events-registry.js';
import { logger } from '../utils/logger.js';
import { getTabId } from './tab-sync.js';

const LOCK_PREFIX = 'webchat-session-task:';

const _ownHolds = new Map();
const _activeElsewhere = new Set();
const _watchedLocks = new Set();

function getLockManager() {
    if (typeof navigator === 'undefined') return null;
    const locks = navigator.locks;
    return typeof locks?.request === 'function' && typeof locks?.query === 'function'
        ? locks
        : null;
}

/**
 * @param {string} sessionId
 * @param {string} [tabId] - 缺省为本页
 * @returns {string}
 */
export function getSessionTaskLockName(sessionId, tabId = getTabId()) {
    return `${LOCK_PREFIX}${sessionId}:${tabId}`;
}

/**
 * 本页开始执行会话任务：持锁直到 untilPromise 结束；页面冻结时锁仍被持有，关闭或崩溃后自动释放
 * @param {string} sessionId
 * @param {Promise<any>} untilPromise
 * @returns {boolean} 是否已发出持锁请求（Web Locks 不可用时为 false）
 */
export function holdSessionTaskLock(sessionId, untilPromise) {
    const locks = getLockManager();
    if (!sessionId || !locks) return false;
    _ownHolds.set(sessionId, (_ownHolds.get(sessionId) || 0) + 1);
    const releaseSignal = Promise.resolve(untilPromise).catch(() => {});
    Promise.resolve()
        .then(() => locks.request(getSessionTaskLockName(sessionId), () => releaseSignal))
        .catch((error) => logger.warn('[SessionTaskPresence] 会话任务锁请求失败:', error))
        .finally(() => {
            const remaining = (_ownHolds.get(sessionId) || 1) - 1;
            if (remaining > 0) _ownHolds.set(sessionId, remaining);
            else _ownHolds.delete(sessionId);
        });
    return true;
}

/**
 * 本页是否持有（或正在排队持有）该会话的任务锁
 * @param {string} sessionId
 * @returns {boolean}
 */
export function isHoldingSessionTaskLock(sessionId) {
    return (_ownHolds.get(sessionId) || 0) > 0;
}

/**
 * 持锁方（exclusive 模式）已持有或正在排队的锁名；shared 模式的条目是等待释放的观察方，不代表任务仍在执行
 * @returns {Promise<Set<string>|null>} 无法查询时为 null
 */
export async function queryActiveLockNames() {
    const locks = getLockManager();
    if (!locks) return null;
    try {
        const { held = [], pending = [] } = await locks.query();
        return new Set(
            [...held, ...pending]
                .filter((lock) => lock?.name && lock.mode !== 'shared')
                .map((lock) => lock.name)
        );
    } catch (error) {
        logger.warn('[SessionTaskPresence] 查询锁状态失败:', error);
        return null;
    }
}

function findRemoteLockNames(names, sessionId) {
    const prefix = `${LOCK_PREFIX}${sessionId}:`;
    const ownName = getSessionTaskLockName(sessionId);
    return [...names].filter(
        (name) =>
            name.startsWith(prefix) && !name.slice(prefix.length).includes(':') && name !== ownName
    );
}

function watchRemoteLock(sessionId, lockName) {
    const locks = getLockManager();
    if (!locks || _watchedLocks.has(lockName)) return;
    _watchedLocks.add(lockName);
    let failed = false;
    Promise.resolve()
        .then(() => locks.request(lockName, { mode: 'shared' }, () => {}))
        .catch((error) => {
            failed = true;
            logger.debug('[SessionTaskPresence] 等待其他标签页释放任务锁失败:', error);
        })
        .finally(() => {
            _watchedLocks.delete(lockName);
            if (!failed) handleRemoteLockReleased(sessionId);
        });
}

async function handleRemoteLockReleased(sessionId) {
    // 对方可能在释放后立刻为新任务重新持锁，重新查询确认后才算结束
    const stillActive = await refreshSessionTaskActivity(sessionId);
    if (!stillActive) eventBus.emit(EVENTS.SESSION_REMOTE_TASK_ENDED, { sessionId });
}

/**
 * 查询会话是否正在其他标签页执行任务，更新缓存；执行中时排队等待对方释放
 * @param {string} sessionId
 * @returns {Promise<boolean>} 查询失败时为 false
 */
export async function refreshSessionTaskActivity(sessionId) {
    if (!sessionId) return false;
    const names = await queryActiveLockNames();
    const remoteLocks = names ? findRemoteLockNames(names, sessionId) : [];
    if (remoteLocks.length === 0) {
        _activeElsewhere.delete(sessionId);
        return false;
    }
    _activeElsewhere.add(sessionId);
    remoteLocks.forEach((lockName) => watchRemoteLock(sessionId, lockName));
    return true;
}

/**
 * 最近一次查询时会话是否在其他标签页执行中（同步读缓存，供渲染使用）
 * @param {string} sessionId
 * @returns {boolean}
 */
export function isSessionTaskActiveElsewhere(sessionId) {
    return !!sessionId && _activeElsewhere.has(sessionId);
}

export function resetSessionTaskPresenceForTests() {
    _ownHolds.clear();
    _activeElsewhere.clear();
    _watchedLocks.clear();
}
