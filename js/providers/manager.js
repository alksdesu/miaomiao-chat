/**
 * 提供商管理模块 - 核心入口
 * getCurrentProvider / switchProvider / 模型管理 / 模型拉取
 * 密钥轮换委托到 key-rotation.js，增删改查委托到 provider-crud.js
 */

import { state } from '../core/state.js';
import { elements } from '../core/elements.js';
import { eventBus } from '../core/events.js';
import { saveCurrentConfig, getDefaultCapabilities } from '../state/config.js';
import { getCacheEntry, setCacheEntry } from './models-cache.js';
import { syncProviderState } from './provider-sync.js';
import { logger } from '../utils/logger.js';

// re-export 拆分模块的公共 API，保持导入兼容
export {
    createProvider,
    updateProvider,
    deleteProvider,
    migrateFromLegacyConfig
} from './provider-crud.js';
export {
    ensureApiKeysArray,
    addApiKey,
    removeApiKey,
    setCurrentKey,
    updateApiKey,
    getActiveApiKey,
    rotateToNextKey,
    setKeyRotationConfig
} from './key-rotation.js';
// re-export 提取的共享模块，保持导入兼容
export { clearModelsCache } from './models-cache.js';
export { syncProviderState } from './provider-sync.js';

// 供子模块调用的内部导入
import { getActiveApiKey } from './key-rotation.js';

// ========== 核心查询 ==========

/**
 * 获取当前提供商（根据选中的模型自动判断）
 */
export function getCurrentProvider() {
    // 优先1: 使用存储的 currentProviderId
    if (state.currentProviderId) {
        const provider = state.providers.find((p) => p.id === state.currentProviderId);
        if (provider && provider.enabled) {
            logger.debug(
                `[getCurrentProvider] 使用 currentProviderId: ${provider.name} (${provider.id})`
            );
            syncProviderState(provider);
            return provider;
        } else {
            logger.warn(
                `[getCurrentProvider] currentProviderId 无效或已禁用: ${state.currentProviderId}`
            );
            state.currentProviderId = null;
        }
    }

    // 2. 获取当前选中的模型
    let selectedModel = null;

    if (typeof elements !== 'undefined' && elements.modelSelect?.value) {
        selectedModel = elements.modelSelect.value;
    } else if (state.selectedModel) {
        selectedModel = state.selectedModel;
    }

    // 3. 如果有选中的模型，找到包含该模型的提供商
    if (selectedModel) {
        const matchingProviders = state.providers.filter((p) => {
            if (!p.enabled || !p.models) return false;
            return p.models.some((m) => {
                if (typeof m === 'string') return m === selectedModel;
                if (typeof m === 'object' && m.id) return m.id === selectedModel;
                return false;
            });
        });

        if (matchingProviders.length > 0) {
            const formatMatched = matchingProviders.find((p) => p.apiFormat === state.apiFormat);
            const provider = formatMatched || matchingProviders[0];

            logger.debug(
                `[getCurrentProvider] 根据模型查找: ${provider.name} (${selectedModel}, apiFormat: ${provider.apiFormat})`
            );
            if (matchingProviders.length > 1) {
                logger.warn(
                    `[getCurrentProvider] 多个提供商包含模型 ${selectedModel}, 使用: ${provider.name} (apiFormat: ${provider.apiFormat})`
                );
            }
            syncProviderState(provider);
            return provider;
        }
    }

    // 4. 返回第一个启用的提供商
    const firstEnabled = state.providers.find((p) => p.enabled);
    if (firstEnabled) {
        logger.debug(`[getCurrentProvider] 使用第一个启用的提供商: ${firstEnabled.name}`);
        syncProviderState(firstEnabled);
        return firstEnabled;
    }

    // 5. 最后返回第一个提供商（即使未启用）
    const fallback = state.providers[0];
    logger.warn(`[getCurrentProvider] 使用第一个提供商（可能未启用）: ${fallback?.name || 'none'}`);
    syncProviderState(fallback);
    return fallback;
}

/**
 * 获取模型的友好显示名称
 */
export function getModelDisplayName(modelId, provider = null) {
    if (!modelId) return 'unknown';

    const targetProvider = provider || getCurrentProvider();

    if (!targetProvider || !targetProvider.models) {
        return modelId;
    }

    const modelConfig = targetProvider.models.find((m) => {
        if (typeof m === 'string') return m === modelId;
        if (typeof m === 'object' && m.id) return m.id === modelId;
        return false;
    });

    if (!modelConfig) return modelId;

    if (typeof modelConfig === 'object' && modelConfig.name) {
        return modelConfig.name;
    }

    return modelId;
}

/**
 * 获取当前选中模型的能力配置
 */
export function getCurrentModelCapabilities() {
    const provider = getCurrentProvider();
    if (!provider || !provider.models) {
        logger.warn('[getCurrentModelCapabilities] 无有效的提供商或模型列表');
        return null;
    }

    const selectedModel = state.selectedModel || elements.modelSelect?.value;
    if (!selectedModel) {
        logger.warn('[getCurrentModelCapabilities] 未选中任何模型');
        return null;
    }

    const modelConfig = provider.models.find((m) => {
        if (typeof m === 'string') return m === selectedModel;
        if (typeof m === 'object' && m.id) return m.id === selectedModel;
        return false;
    });

    if (!modelConfig) {
        logger.warn(`[getCurrentModelCapabilities] 未找到模型配置: ${selectedModel}`);
        return getDefaultCapabilities(provider.apiFormat);
    }

    if (typeof modelConfig === 'string') {
        logger.debug(`[getCurrentModelCapabilities] 模型 ${selectedModel} 使用默认能力（v1格式）`);
        return getDefaultCapabilities(provider.apiFormat);
    }

    const capabilities = modelConfig.capabilities || getDefaultCapabilities(provider.apiFormat);
    logger.debug(`[getCurrentModelCapabilities] 模型 ${selectedModel} 能力:`, capabilities);
    return capabilities;
}

// ========== 模型管理 ==========

const CACHE_DURATION = 30 * 60 * 1000;

/**
 * 添加单个模型到提供商
 */
export function addModelToProvider(providerId, modelData) {
    const provider = state.providers.find((p) => p.id === providerId);
    if (!provider) return false;

    if (!provider.models) {
        provider.models = [];
    }

    let modelObj;
    if (typeof modelData === 'string') {
        modelObj = {
            id: modelData,
            name: modelData,
            capabilities: getDefaultCapabilities(provider.apiFormat)
        };
    } else if (typeof modelData === 'object' && modelData.id) {
        modelObj = {
            id: modelData.id,
            name: modelData.name || modelData.id,
            capabilities: modelData.capabilities || getDefaultCapabilities(provider.apiFormat)
        };
    } else {
        logger.error('无效的模型数据:', modelData);
        return false;
    }

    const exists = provider.models.some((m) => {
        const mId = typeof m === 'string' ? m : m.id;
        return mId === modelObj.id;
    });

    if (exists) {
        logger.warn(`模型 ${modelObj.id} 已存在于提供商 ${provider.name}`);
        return false;
    }

    provider.models.push(modelObj);
    saveCurrentConfig();
    eventBus.emit('providers:models-changed', { providerId, provider });
    logger.info(`已添加模型 ${modelObj.id} 到提供商 ${provider.name}`);

    return true;
}

/**
 * 从提供商移除模型
 */
export function removeModelFromProvider(providerId, modelId) {
    const provider = state.providers.find((p) => p.id === providerId);
    if (!provider || !provider.models) return false;

    const index = provider.models.findIndex((m) => {
        if (typeof m === 'string') return m === modelId;
        if (typeof m === 'object' && m.id) return m.id === modelId;
        return false;
    });

    if (index === -1) return false;

    provider.models.splice(index, 1);
    saveCurrentConfig();
    eventBus.emit('providers:models-changed', { providerId, provider });
    logger.info(`已移除模型 ${modelId} 从提供商 ${provider.name}`);

    return true;
}

/**
 * 批量添加模型到提供商
 */
export function addModelsToProvider(providerId, modelDataList) {
    const provider = state.providers.find((p) => p.id === providerId);
    if (!provider) return 0;

    if (!provider.models) {
        provider.models = [];
    }

    let addedCount = 0;
    modelDataList.forEach((modelData) => {
        let modelObj;
        if (typeof modelData === 'string') {
            modelObj = {
                id: modelData,
                name: modelData,
                capabilities: getDefaultCapabilities(provider.apiFormat)
            };
        } else if (typeof modelData === 'object' && modelData.id) {
            modelObj = {
                id: modelData.id,
                name: modelData.name || modelData.id,
                capabilities: modelData.capabilities || getDefaultCapabilities(provider.apiFormat)
            };
        } else {
            logger.warn('跳过无效的模型数据:', modelData);
            return;
        }

        const exists = provider.models.some((m) => {
            const mId = typeof m === 'string' ? m : m.id;
            return mId === modelObj.id;
        });

        if (!exists) {
            provider.models.push(modelObj);
            addedCount++;
        }
    });

    if (addedCount > 0) {
        saveCurrentConfig();
        eventBus.emit('providers:models-changed', { providerId, provider });
        logger.info(`批量添加了 ${addedCount} 个模型到提供商 ${provider.name}`);
    }

    return addedCount;
}

/**
 * 从 API 拉取提供商的模型列表（带缓存）
 */
export async function fetchProviderModels(providerId, forceRefresh = false) {
    const provider = state.providers.find((p) => p.id === providerId);
    if (!provider) {
        throw new Error(`提供商不存在: ${providerId}`);
    }

    const cached = getCacheEntry(providerId);
    if (!forceRefresh && cached && Date.now() - cached.timestamp < CACHE_DURATION) {
        logger.debug(`使用缓存的模型列表 (${provider.name})`);
        return cached.models;
    }

    logger.info(`从 API 拉取模型列表 (${provider.name})...`);

    const models = await fetchModelsFromAPI(provider);
    setCacheEntry(providerId, { models, timestamp: Date.now() });

    return models;
}

/**
 * 获取默认端点
 */
function getDefaultEndpoint(apiFormat) {
    const defaults = {
        openai: 'https://api.openai.com',
        'openai-responses': 'https://api.openai.com/v1/responses',
        'openai-image': 'https://api.openai.com/v1/images/generations',
        gemini: 'https://generativelanguage.googleapis.com',
        claude: 'https://api.anthropic.com',
        openclaw: 'ws://localhost:18789'
    };
    return defaults[apiFormat] || '';
}

function deriveOpenAIModelsEndpoint(endpoint) {
    let url;
    try {
        url = new URL(endpoint);
    } catch {
        throw new Error('模型列表地址无效，请检查 API 地址');
    }

    const normalizedPath = url.pathname.replace(/\/+$/, '') || '/';

    let modelsPath;
    if (normalizedPath.endsWith('/chat/completions')) {
        modelsPath = normalizedPath.slice(0, -'/chat/completions'.length) + '/models';
    } else if (normalizedPath.endsWith('/responses')) {
        modelsPath = normalizedPath.slice(0, -'/responses'.length) + '/models';
    } else if (normalizedPath.endsWith('/images/generations')) {
        modelsPath = normalizedPath.slice(0, -'/images/generations'.length) + '/models';
    } else if (normalizedPath.endsWith('/images/edits')) {
        modelsPath = normalizedPath.slice(0, -'/images/edits'.length) + '/models';
    } else if (normalizedPath.endsWith('/messages')) {
        modelsPath = normalizedPath.slice(0, -'/messages'.length) + '/models';
    } else if (normalizedPath === '/' || normalizedPath === '/v1') {
        modelsPath = '/v1/models';
    } else {
        throw new Error(
            '当前 API 地址包含自定义路径，无法安全推导模型列表地址；请填写标准聊天端点或留空使用默认地址后重试'
        );
    }

    const modelsUrl = new URL(url.toString());
    modelsUrl.pathname = modelsPath;
    return modelsUrl.toString();
}

/**
 * 内部：从 API 拉取模型列表
 */
async function fetchModelsFromAPI(provider) {
    const { apiFormat, endpoint, geminiApiKeyInHeader } = provider;
    const effectiveEndpoint = endpoint || getDefaultEndpoint(apiFormat);
    const apiKey = getActiveApiKey(provider.id);

    let allModels = [];

    try {
        if (apiFormat === 'openclaw') {
            try {
                const { openclawClient } = await import('../api/openclaw.js');
                if (!openclawClient.connected) {
                    const result = await openclawClient.connect(effectiveEndpoint, apiKey);
                    if (!result.success) throw new Error(result.error);
                }
                const result = await openclawClient.send('models.list');
                const models = Array.isArray(result) ? result : result?.models || [];
                return models.map((m) => ({
                    id: typeof m === 'string' ? m : m.id,
                    name: typeof m === 'string' ? m : m.name || m.id,
                    capabilities: getDefaultCapabilities('openai')
                }));
            } catch (e) {
                logger.warn('[OpenClaw] 获取模型列表失败:', e.message);
                return [];
            }
        } else if (apiFormat === 'gemini') {
            const baseModelsEndpoint = `${effectiveEndpoint.replace(/\/$/, '')}/v1beta/models`;
            logger.debug('Fetching Gemini models from:', baseModelsEndpoint);
            logger.debug(
                '[Gemini] geminiApiKeyInHeader:',
                geminiApiKeyInHeader,
                'apiKey:',
                apiKey ? '***' + apiKey.slice(-4) : 'undefined'
            );

            let pageToken = null;

            do {
                let modelsEndpoint = baseModelsEndpoint;
                const queryParams = [];

                const headers = {};
                if (geminiApiKeyInHeader) {
                    headers['x-goog-api-key'] = apiKey;
                } else {
                    queryParams.push(`key=${apiKey}`);
                }

                queryParams.push('pageSize=100');
                if (pageToken) {
                    queryParams.push(`pageToken=${pageToken}`);
                }

                if (queryParams.length > 0) {
                    modelsEndpoint += '?' + queryParams.join('&');
                }

                const response = await fetch(modelsEndpoint, {
                    method: 'GET',
                    headers: headers
                });

                if (!response.ok) {
                    throw new Error(`HTTP error! status: ${response.status}`);
                }

                const data = await response.json();
                const models = data.models || [];
                allModels = allModels.concat(models);
                pageToken = data.nextPageToken || null;
            } while (pageToken);

            logger.debug(`Total Gemini models fetched: ${allModels.length}`);

            return allModels
                .map((m) => ({
                    id: m.name.replace('models/', ''),
                    supportsChat: m.supportedGenerationMethods?.includes('generateContent') || false
                }))
                .sort((a, b) => {
                    if (a.supportsChat && !b.supportsChat) return -1;
                    if (!a.supportsChat && b.supportsChat) return 1;
                    return a.id.localeCompare(b.id);
                })
                .map((m) => ({
                    id: m.id,
                    name: m.id,
                    capabilities: getDefaultCapabilities('gemini')
                }));
        } else if (apiFormat === 'claude') {
            const modelsEndpoint = deriveOpenAIModelsEndpoint(effectiveEndpoint);
            logger.debug('Fetching Claude models from:', modelsEndpoint);

            const response = await fetch(modelsEndpoint, {
                method: 'GET',
                headers: {
                    'x-api-key': apiKey,
                    'anthropic-version': '2023-06-01',
                    'anthropic-dangerous-direct-browser-access': 'true'
                }
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const data = await response.json();
            const models = data.data || [];
            return models.map((m) => ({
                id: m.id,
                name: m.id,
                capabilities: getDefaultCapabilities(apiFormat)
            }));
        } else {
            const modelsEndpoint = deriveOpenAIModelsEndpoint(effectiveEndpoint);
            logger.debug('Fetching OpenAI models from:', modelsEndpoint);

            const response = await fetch(modelsEndpoint, {
                method: 'GET',
                headers: {
                    Authorization: `Bearer ${apiKey}`
                }
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const data = await response.json();
            const models = data.data || [];
            return models.map((m) => ({
                id: m.id,
                name: m.id,
                capabilities: getDefaultCapabilities(apiFormat)
            }));
        }
    } catch (error) {
        logger.error(`拉取模型失败 (${provider.name}):`, error);
        throw error;
    }
}
