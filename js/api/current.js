/**
 * 当前请求上下文 facade
 *
 * providers 层与 api/messages/stream 等消费层之间的唯一同步查询出口。
 * 非 UI 层（handler / multi-stream / parts-builder / renderer / image-retry / openai /
 * gemini-adapter / orchestrator / openclaw）一律 import 本模块，不再直接 import
 * providers/manager.js — 让 providers 层成为 self-contained 写入者 + 事件发射者，
 * 单向依赖 providers/manager → api/current → 消费方。
 *
 * 注意：本模块仍同步代理 providers/manager 调用（getCurrentProvider 内部副作用
 * syncProviderState 保持原语义不变），不引入镜像缓存以避免破坏 streamingInFlight
 * 延后清理时机。
 */

import { state, elements } from '../core/state.js';
import {
    getCurrentProvider as _getCurrentProvider,
    getActiveApiKey,
    getModelDisplayName as _getModelDisplayName,
    getCurrentModelCapabilities as _getCurrentModelCapabilities
} from '../providers/manager.js';

/**
 * 获取当前提供商对象
 * @returns {object|null}
 */
export function getCurrentProvider() {
    return _getCurrentProvider();
}

/**
 * 获取当前端点（从提供商获取，缺省时回退到 apiFormat 默认地址）
 * @returns {string} API 端点
 */
export function getCurrentEndpoint() {
    const provider = _getCurrentProvider();

    if (provider && provider.endpoint) {
        return provider.endpoint;
    }

    // 如果没有提供商或端点，返回默认端点
    const format = state.apiFormat;
    const defaultEndpoints = {
        openai: 'https://api.openai.com/v1/chat/completions',
        'openai-responses': 'https://api.openai.com/v1/responses',
        'openai-image': 'https://api.openai.com/v1/images/generations',
        gemini: 'https://generativelanguage.googleapis.com',
        claude: 'https://api.anthropic.com/v1/messages',
        openclaw: 'ws://localhost:18789'
    };

    return defaultEndpoints[format] || '';
}

/**
 * 获取当前 API 密钥（从提供商获取，支持多密钥轮询）
 * @returns {string} API 密钥
 */
export function getCurrentApiKey() {
    const provider = _getCurrentProvider();
    if (!provider) return '';

    // 使用多密钥管理的 getActiveApiKey 函数
    return getActiveApiKey(provider.id);
}

/**
 * 获取当前模型（三级 fallback：下拉选中 → provider.models[0] → 空串）
 * @returns {string} 模型名称
 */
export function getCurrentModel() {
    // 优先返回下拉列表选中的模型
    if (elements.modelSelect?.value) {
        return elements.modelSelect.value;
    }

    // 如果下拉列表为空，尝试从当前提供商的第一个模型获取
    const currentProvider = _getCurrentProvider();
    if (currentProvider?.models && currentProvider.models.length > 0) {
        const firstModel = currentProvider.models[0];
        return typeof firstModel === 'string' ? firstModel : firstModel?.id || '';
    }

    // 最后返回空字符串
    return '';
}

/**
 * 获取当前 provider 下的活跃 API key（暴露给非 UI 消费方）
 * @param {string} providerId
 * @returns {string}
 */
export function getCurrentActiveApiKey(providerId) {
    return getActiveApiKey(providerId);
}

/**
 * 获取模型显示名称（facade）
 * @param {string} modelId
 * @param {object} [provider]
 * @returns {string}
 */
export function getModelDisplayName(modelId, provider = null) {
    return _getModelDisplayName(modelId, provider);
}

/**
 * 获取当前选中模型的能力配置（facade）
 * @returns {object|null}
 */
export function getCurrentModelCapabilities() {
    return _getCurrentModelCapabilities();
}
