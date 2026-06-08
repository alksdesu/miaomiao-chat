/**
 * 偏好设置存储
 * IndexedDB 优先，降级到 localStorage
 */

import {
    STORES,
    saveToStore,
    loadFromStore,
    loadAllFromStore,
    safeLocalStorageGet,
    safeLocalStorageSet,
    getDB
} from './indexeddb.js';
import { logger } from '../utils/logger.js';

// 降级写时打 dirty 标记：IDB 恢复后由 reconcileDirtyPreferences 回写让两侧最终一致
// 否则 IDB 恢复后旧值仍存在，loadPreference 优先读 IDB 拿到旧值，新 LS 写入永远读不到
const DIRTY_PREFIX = '__pref_dirty_';
function _markDirty(key) {
    safeLocalStorageSet(`${DIRTY_PREFIX}${key}`, '1');
}
function _isDirty(key) {
    return safeLocalStorageGet(`${DIRTY_PREFIX}${key}`) === '1';
}
function _clearDirty(key) {
    try {
        localStorage.removeItem(`${DIRTY_PREFIX}${key}`);
    } catch (_) {
        /* removeItem 失败也无妨 */
    }
}

// LS fallback 返回字符串，调用方期望对象时 .xxx 取属性 undefined
// 与 IDB 路径一致解析：成功 JSON 走对象，失败保留原字符串（向后兼容历史明文写入）
function _decodeFallback(raw) {
    if (raw === null || raw === undefined) return null;
    if (typeof raw !== 'string') return raw;
    try {
        return JSON.parse(raw);
    } catch {
        return raw;
    }
}

/**
 * 保存偏好设置
 * @param {string} key - 偏好设置键
 * @param {any} value - 偏好设置值
 * @returns {Promise<void>}
 */
export async function savePreference(key, value) {
    const fallbackValue = typeof value === 'string' ? value : JSON.stringify(value);

    // IndexedDB 不可用时，降级到 localStorage
    if (!getDB()) {
        if (!safeLocalStorageSet(key, fallbackValue)) {
            throw new Error(`保存偏好设置失败（localStorage 不可用）: ${key}`);
        }
        _markDirty(key);
        return;
    }

    try {
        await saveToStore(STORES.PREFERENCES, key, value);
        // IDB 写成功，若之前有 dirty 标记说明刚从降级恢复，清掉防 loadPreference 误走 LS
        if (_isDirty(key)) _clearDirty(key);
    } catch (error) {
        logger.warn(
            `[Storage] savePreference("${key}") 写入 IndexedDB 失败，降级到 localStorage:`,
            error
        );
        if (!safeLocalStorageSet(key, fallbackValue)) {
            throw error;
        }
        _markDirty(key);
    }
}

/**
 * 加载偏好设置
 * @param {string} key - 偏好设置键
 * @returns {Promise<any|null>} 偏好设置值
 */
export async function loadPreference(key) {
    // dirty 标记表示 LS 端是更新值，IDB 端可能是过期值，优先取 LS
    if (_isDirty(key)) {
        return _decodeFallback(safeLocalStorageGet(key));
    }

    // IndexedDB 不可用时，直接从 localStorage 读取
    if (!getDB()) {
        return _decodeFallback(safeLocalStorageGet(key));
    }

    try {
        const value = await loadFromStore(STORES.PREFERENCES, key);
        // 兼容历史数据：IndexedDB 没有时尝试 localStorage
        if (value === null || value === undefined) {
            return _decodeFallback(safeLocalStorageGet(key));
        }
        return value;
    } catch (error) {
        logger.warn(
            `[Storage] loadPreference("${key}") 读取 IndexedDB 失败，降级到 localStorage:`,
            error
        );
        return _decodeFallback(safeLocalStorageGet(key));
    }
}

/**
 * 加载所有偏好设置
 * @returns {Promise<Object>} 偏好设置对象
 */
export async function loadAllPreferences() {
    const items = await loadAllFromStore(STORES.PREFERENCES);
    const prefs = {};
    items.forEach((item) => {
        prefs[item.key] = item.value;
    });
    return prefs;
}
