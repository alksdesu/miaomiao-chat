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
        return;
    }

    try {
        await saveToStore(STORES.PREFERENCES, key, value);
    } catch (error) {
        logger.warn(
            `[Storage] savePreference("${key}") 写入 IndexedDB 失败，降级到 localStorage:`,
            error
        );
        if (!safeLocalStorageSet(key, fallbackValue)) {
            throw error;
        }
    }
}

/**
 * 加载偏好设置
 * @param {string} key - 偏好设置键
 * @returns {Promise<any|null>} 偏好设置值
 */
export async function loadPreference(key) {
    // IndexedDB 不可用时，直接从 localStorage 读取
    if (!getDB()) {
        return safeLocalStorageGet(key);
    }

    try {
        const value = await loadFromStore(STORES.PREFERENCES, key);
        // 兼容历史数据：IndexedDB 没有时尝试 localStorage
        if (value === null || value === undefined) {
            return safeLocalStorageGet(key);
        }
        return value;
    } catch (error) {
        logger.warn(
            `[Storage] loadPreference("${key}") 读取 IndexedDB 失败，降级到 localStorage:`,
            error
        );
        return safeLocalStorageGet(key);
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
