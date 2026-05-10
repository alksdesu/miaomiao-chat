/**
 * 当前请求上下文工具函数
 * 从 handler.js 提取，避免 openclaw.js -> handler.js -> factory.js 循环依赖
 */

import { state, elements } from '../core/state.js';
import { getCurrentProvider, getActiveApiKey } from '../providers/manager.js';

/**
 * 获取当前端点（从提供商获取）
 * @returns {string} API 端点
 */
export function getCurrentEndpoint() {
    const provider = getCurrentProvider();

    if (provider && provider.endpoint) {
        return provider.endpoint;
    }

    // 如果没有提供商或端点，返回默认端点
    const format = state.apiFormat;
    const defaultEndpoints = {
        openai: 'https://api.openai.com/v1/chat/completions',
        'openai-responses': 'https://api.openai.com/v1/responses',
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
    const provider = getCurrentProvider();
    if (!provider) return '';

    // 使用多密钥管理的 getActiveApiKey 函数
    return getActiveApiKey(provider.id);
}

/**
 * 获取当前模型（三级fallback）
 * @returns {string} 模型名称
 */
export function getCurrentModel() {
    // 优先返回下拉列表选中的模型
    if (elements.modelSelect?.value) {
        return elements.modelSelect.value;
    }

    // 如果下拉列表为空，尝试从当前提供商的第一个模型获取
    const currentProvider = getCurrentProvider();
    if (currentProvider?.models && currentProvider.models.length > 0) {
        return currentProvider.models[0];
    }

    // 最后返回空字符串
    return '';
}
