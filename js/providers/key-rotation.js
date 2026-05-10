/**
 * 密钥轮换策略模块
 * 多密钥管理、轮询策略、错误时自动切换
 * 从 providers/manager.js 拆分
 */

import { state } from '../core/state.js';
import { eventBus } from '../core/events.js';
import { saveCurrentConfig } from '../state/config.js';
import { clearModelsCache } from './models-cache.js';
import { logger } from '../utils/logger.js';

// 密钥统计数据保存防抖
let statsUpdateTimeout = null;

function saveKeyStatsDebounced() {
    if (statsUpdateTimeout) {
        clearTimeout(statsUpdateTimeout);
    }
    statsUpdateTimeout = setTimeout(() => {
        saveCurrentConfig();
    }, 2000);
}

/**
 * 生成密钥 ID
 */
export function generateKeyId() {
    return `key-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * 确保提供商有 apiKeys 数组（兼容旧数据）
 */
export function ensureApiKeysArray(provider) {
    if (!provider.apiKeys) {
        provider.apiKeys = [];
        provider.currentKeyId = null;
        provider.keyRotation = {
            enabled: false,
            strategy: 'round-robin',
            rotateOnError: true,
            currentIndex: 0
        };

        if (provider.apiKey) {
            const keyId = generateKeyId();
            provider.apiKeys.push({
                id: keyId,
                key: provider.apiKey,
                name: '密钥 1',
                enabled: true,
                usageCount: 0,
                lastUsed: null,
                errorCount: 0
            });
            provider.currentKeyId = keyId;
        }
    }
}

/**
 * 添加 API 密钥
 */
export function addApiKey(providerId, key, name = '') {
    const provider = state.providers.find((p) => p.id === providerId);
    if (!provider) return null;

    ensureApiKeysArray(provider);

    const isDuplicate = provider.apiKeys.some((k) => k.key === key);
    if (isDuplicate) {
        logger.warn(`[addApiKey] 密钥已存在于提供商 ${provider.name}`);
        return null;
    }

    const keyId = generateKeyId();
    const keyName = name || `密钥 ${provider.apiKeys.length + 1}`;

    const newKey = {
        id: keyId,
        key: key,
        name: keyName,
        enabled: true,
        usageCount: 0,
        lastUsed: null,
        errorCount: 0
    };

    provider.apiKeys.push(newKey);

    if (provider.apiKeys.length === 1) {
        provider.currentKeyId = keyId;
        provider.apiKey = key;
    }

    saveCurrentConfig();
    return newKey;
}

/**
 * 删除 API 密钥
 */
export function removeApiKey(providerId, keyId) {
    const provider = state.providers.find((p) => p.id === providerId);
    if (!provider || !provider.apiKeys) return false;

    const index = provider.apiKeys.findIndex((k) => k.id === keyId);
    if (index === -1) return false;

    provider.apiKeys.splice(index, 1);

    // 调整轮询索引
    if (provider.keyRotation) {
        const enabledKeys = provider.apiKeys.filter((k) => k.enabled);
        if (index < provider.keyRotation.currentIndex) {
            provider.keyRotation.currentIndex--;
        }
        if (enabledKeys.length > 0 && provider.keyRotation.currentIndex >= enabledKeys.length) {
            provider.keyRotation.currentIndex = 0;
        }
    }

    // 如果删除的是当前密钥，切换到第一个可用密钥
    if (provider.currentKeyId === keyId) {
        const nextKey = provider.apiKeys.find((k) => k.enabled);
        provider.currentKeyId = nextKey?.id || null;
        provider.apiKey = nextKey?.key || '';

        clearModelsCache(providerId);
        logger.info(`[removeApiKey] 删除了当前密钥，已切换到 ${nextKey?.name || '无'}，并清除缓存`);
    }

    saveCurrentConfig();
    return true;
}

/**
 * 设置当前使用的密钥
 */
export function setCurrentKey(providerId, keyId) {
    const provider = state.providers.find((p) => p.id === providerId);
    if (!provider || !provider.apiKeys) return false;

    const key = provider.apiKeys.find((k) => k.id === keyId);
    if (!key) return false;

    provider.currentKeyId = keyId;
    provider.apiKey = key.key;

    clearModelsCache(providerId);
    saveCurrentConfig();
    return true;
}

/**
 * 更新密钥信息
 */
export function updateApiKey(providerId, keyId, updates) {
    const provider = state.providers.find((p) => p.id === providerId);
    if (!provider || !provider.apiKeys) return null;

    const key = provider.apiKeys.find((k) => k.id === keyId);
    if (!key) return null;

    Object.assign(key, updates);

    if (provider.currentKeyId === keyId && updates.key) {
        provider.apiKey = updates.key;
        clearModelsCache(providerId);
    }

    saveCurrentConfig();
    return key;
}

/**
 * 获取当前有效的 API 密钥
 */
export function getActiveApiKey(providerId) {
    const provider = state.providers.find((p) => p.id === providerId);
    if (!provider) return '';

    ensureApiKeysArray(provider);

    if (!provider.apiKeys || provider.apiKeys.length === 0) {
        return provider.apiKey || '';
    }

    // 如果开启了轮询，使用轮询逻辑
    if (provider.keyRotation?.enabled) {
        return getRotatedKey(provider);
    }

    const currentKey = provider.apiKeys.find((k) => k.id === provider.currentKeyId && k.enabled);
    if (currentKey) {
        return currentKey.key;
    }

    const firstEnabled = provider.apiKeys.find((k) => k.enabled);
    return firstEnabled?.key || provider.apiKey || '';
}

/**
 * 根据轮询策略获取密钥
 */
function getRotatedKey(provider) {
    const enabledKeys = provider.apiKeys.filter((k) => k.enabled);
    if (enabledKeys.length === 0) return provider.apiKey || '';

    const rotation = provider.keyRotation;
    let selectedKey;

    switch (rotation.strategy) {
        case 'random':
            selectedKey = enabledKeys[Math.floor(Math.random() * enabledKeys.length)];
            break;

        case 'least-used':
            selectedKey = enabledKeys.reduce((min, k) => (k.usageCount < min.usageCount ? k : min));
            break;

        case 'smart':
            selectedKey = enabledKeys.reduce((best, k) => {
                const score = k.usageCount + k.errorCount * 10;
                const bestScore = best.usageCount + best.errorCount * 10;
                return score < bestScore ? k : best;
            });
            break;

        case 'round-robin':
        default: {
            const index = rotation.currentIndex % enabledKeys.length;
            selectedKey = enabledKeys[index];
            rotation.currentIndex = (index + 1) % enabledKeys.length;
            break;
        }
    }

    selectedKey.usageCount++;
    selectedKey.lastUsed = Date.now();
    saveKeyStatsDebounced();

    return selectedKey.key;
}

/**
 * 轮询切换到下一个密钥（遇到错误时调用）
 */
export function rotateToNextKey(providerId, markError = false) {
    const provider = state.providers.find((p) => p.id === providerId);
    if (!provider || !provider.apiKeys || provider.apiKeys.length <= 1) {
        return provider?.apiKey || '';
    }

    ensureApiKeysArray(provider);

    if (markError) {
        const currentKey = provider.apiKeys.find((k) => k.id === provider.currentKeyId);
        if (currentKey) {
            currentKey.errorCount++;
            saveKeyStatsDebounced();
        }
    }

    const enabledKeys = provider.apiKeys.filter((k) => k.enabled && k.id !== provider.currentKeyId);
    if (enabledKeys.length === 0) {
        return provider.apiKey || '';
    }

    const nextKey = enabledKeys[0];
    const previousKeyId = provider.currentKeyId;

    provider.currentKeyId = nextKey.id;
    provider.apiKey = nextKey.key;

    clearModelsCache(providerId);
    saveCurrentConfig();

    eventBus.emit('ui:notification', {
        message: `已自动切换到备用密钥: ${nextKey.name}`,
        type: 'info',
        duration: 5000
    });

    logger.info(`[KeyRotation] 切换密钥: ${previousKeyId} → ${nextKey.id} (${nextKey.name})`);

    return nextKey.key;
}

/**
 * 设置密钥轮询配置
 */
export function setKeyRotationConfig(providerId, config) {
    const provider = state.providers.find((p) => p.id === providerId);
    if (!provider) return;

    ensureApiKeysArray(provider);

    provider.keyRotation = {
        ...provider.keyRotation,
        ...config
    };

    saveCurrentConfig();
}
