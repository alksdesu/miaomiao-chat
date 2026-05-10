/**
 * 模型缓存管理
 * 从 manager.js 提取，避免 manager.js <-> key-rotation.js 循环依赖
 */

import { logger } from '../utils/logger.js';

// 模型缓存
const modelsCache = new Map();

/**
 * 获取缓存条目
 * @param {string} providerId - 提供商 ID
 * @returns {object|undefined} 缓存条目 { models, timestamp }
 */
export function getCacheEntry(providerId) {
    return modelsCache.get(providerId);
}

/**
 * 设置缓存条目
 * @param {string} providerId - 提供商 ID
 * @param {object} entry - { models, timestamp }
 */
export function setCacheEntry(providerId, entry) {
    modelsCache.set(providerId, entry);
}

/**
 * 清除提供商的模型缓存
 * @param {string} [providerId] - 提供商 ID，不传则清除所有
 */
export function clearModelsCache(providerId) {
    if (providerId) {
        modelsCache.delete(providerId);
        logger.debug(`已清除提供商 ${providerId} 的模型缓存`);
    } else {
        modelsCache.clear();
        logger.debug('已清除所有模型缓存');
    }
}
