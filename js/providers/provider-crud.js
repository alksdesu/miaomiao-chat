/**
 * 提供商增删改查 + 旧配置迁移
 * 从 providers/manager.js 拆分
 */

import { logger } from '../utils/logger.js';
import { state } from '../core/state.js';
import { elements } from '../core/elements.js';
import { eventBus } from '../core/events.js';
import { saveCurrentConfig } from '../state/config.js';
import { syncProviderState } from './provider-sync.js';
import { generateKeyId } from './key-rotation.js';

/**
 * 生成唯一 ID
 */
function generateId(prefix = 'provider') {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * 创建提供商
 */
export function createProvider(data) {
    const apiKeys = [];
    let currentKeyId = null;

    if (data.apiKey) {
        const keyId = generateKeyId();
        apiKeys.push({
            id: keyId,
            key: data.apiKey,
            name: '密钥 1',
            enabled: true,
            usageCount: 0,
            lastUsed: null,
            errorCount: 0
        });
        currentKeyId = keyId;
    }

    const provider = {
        id: generateId(),
        name: data.name,
        apiFormat: data.apiFormat,
        endpoint: data.endpoint ?? '',
        apiKey: data.apiKey || '',
        apiKeys: apiKeys,
        currentKeyId: currentKeyId,
        keyRotation: {
            enabled: false,
            strategy: 'round-robin',
            rotateOnError: true,
            currentIndex: 0
        },
        enabled: true,
        models: data.models || [],
        createdAt: Date.now(),
        geminiApiKeyInHeader: data.geminiApiKeyInHeader || false,
        modelParams: null
    };

    state.providers.push(provider);
    saveCurrentConfig();
    eventBus.emit('providers:added', { provider });

    return provider;
}

/**
 * 更新提供商
 */
export function updateProvider(id, updates) {
    const index = state.providers.findIndex((p) => p.id === id);
    if (index === -1) return null;

    Object.assign(state.providers[index], updates);

    const provider = state.providers[index];
    if (
        state.currentProviderId === id ||
        (provider.models &&
            provider.models.some((m) => {
                const modelId = typeof m === 'string' ? m : m.id;
                return modelId === state.selectedModel;
            }))
    ) {
        syncProviderState(provider);
        logger.debug(`[updateProvider] 立即同步提供商状态到全局 state`);
    }

    saveCurrentConfig();
    eventBus.emit('providers:updated', { id, provider: state.providers[index] });

    return state.providers[index];
}

/**
 * 删除提供商
 */
export function deleteProvider(id) {
    const index = state.providers.findIndex((p) => p.id === id);
    if (index === -1) return false;

    if (state.currentProviderId === id) {
        const remaining = state.providers.filter((p) => p.id !== id && p.enabled);
        const fallback = remaining[0] || state.providers.find((p) => p.id !== id);
        state.currentProviderId = fallback?.id || null;
        if (fallback) {
            syncProviderState(fallback);
        }
    }

    state.providers.splice(index, 1);
    saveCurrentConfig();
    eventBus.emit('providers:deleted', { id });

    return true;
}

/**
 * 获取默认端点
 */
function getDefaultEndpoint(apiFormat) {
    const defaults = {
        openai: 'https://api.openai.com',
        'openai-responses': 'https://api.openai.com/v1/responses',
        gemini: 'https://generativelanguage.googleapis.com',
        claude: 'https://api.anthropic.com',
        openclaw: 'ws://localhost:18789'
    };
    return defaults[apiFormat] || '';
}

/**
 * 获取默认提供商名称
 */
function getDefaultProviderName(format) {
    const names = {
        openai: 'OpenAI',
        'openai-responses': 'OpenAI Responses',
        gemini: 'Google Gemini',
        claude: 'Anthropic Claude',
        openclaw: 'OpenClaw'
    };
    return names[format] || format;
}

/**
 * 从旧配置迁移到提供商系统 (首次运行)
 */
export function migrateFromLegacyConfig() {
    if (state.providers.length > 0) {
        logger.debug('提供商系统已初始化,跳过迁移');
        return;
    }

    logger.debug('检测到旧配置,开始迁移到提供商系统...');

    const backup = {
        apiFormat: state.apiFormat,
        endpoints: { ...state.endpoints },
        apiKeys: { ...state.apiKeys },
        customModels: { ...state.customModels },
        geminiApiKeyInHeader: state.geminiApiKeyInHeader,
        selectedModel: elements.modelSelect?.value || state.selectedModel || ''
    };
    localStorage.setItem('config-backup-pre-migration', JSON.stringify(backup));
    logger.debug('已备份旧配置到 localStorage.config-backup-pre-migration');

    ['openai', 'gemini', 'claude'].forEach((format) => {
        if (state.apiKeys[format] || state.endpoints[format]) {
            const models = [];

            if (state.customModels[format]) {
                models.push(state.customModels[format]);
            }

            if (format === state.apiFormat && backup.selectedModel) {
                const currentModel = backup.selectedModel;
                if (!models.includes(currentModel)) {
                    models.push(currentModel);
                }
            }

            if (models.length === 0) {
                const defaultModel =
                    format === 'gemini'
                        ? 'gemini-2.0-flash'
                        : format === 'claude'
                          ? 'claude-3-5-sonnet-20241022'
                          : 'gpt-4o';
                models.push(defaultModel);
            }

            const provider = createProvider({
                name: getDefaultProviderName(format),
                apiFormat: format,
                endpoint: state.endpoints[format] || getDefaultEndpoint(format),
                apiKey: state.apiKeys[format] || '',
                models: models,
                geminiApiKeyInHeader: format === 'gemini' ? state.geminiApiKeyInHeader : false
            });

            logger.debug(
                `  迁移 ${format} → "${provider.name}" (${models.length} 个模型: ${models.join(', ')})`
            );
        }
    });

    const hasCurrentFormatProvider = state.providers.some((p) => p.apiFormat === state.apiFormat);
    if (!hasCurrentFormatProvider && state.apiFormat) {
        const models = [];
        if (state.customModels[state.apiFormat]) {
            models.push(state.customModels[state.apiFormat]);
        }
        if (backup.selectedModel && !models.includes(backup.selectedModel)) {
            models.push(backup.selectedModel);
        }
        if (models.length === 0) {
            const defaultModel =
                state.apiFormat === 'gemini'
                    ? 'gemini-2.0-flash'
                    : state.apiFormat === 'claude'
                      ? 'claude-3-5-sonnet-20241022'
                      : 'gpt-4o';
            models.push(defaultModel);
        }

        const provider = createProvider({
            name: getDefaultProviderName(state.apiFormat),
            apiFormat: state.apiFormat,
            endpoint: state.endpoints[state.apiFormat] || getDefaultEndpoint(state.apiFormat),
            apiKey: state.apiKeys[state.apiFormat] || '',
            models: models,
            geminiApiKeyInHeader: state.apiFormat === 'gemini' ? state.geminiApiKeyInHeader : false
        });
        logger.debug(`  创建默认提供商 "${provider.name}" (${models.length} 个模型)`);
    }

    logger.debug(`迁移完成: 创建了 ${state.providers.length} 个提供商`);
}
