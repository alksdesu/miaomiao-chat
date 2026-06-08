/**
 * API 格式切换功能
 * 处理 OpenAI/Gemini/Claude 格式切换
 */

import { state } from '../core/state.js';
import { elements } from '../core/elements.js';
import { eventBus } from '../core/events.js';
import { saveCurrentConfig } from '../state/config.js';
import { populateModelSelect } from './models.js';
import { logger } from '../utils/logger.js';

/**
 * 切换 API 格式
 * @param {string} format - 目标格式 ('openai'|'openai-responses'|'gemini'|'claude')
 * @param {boolean} shouldFetchModels - 是否获取模型列表
 */
export function setApiFormat(format, shouldFetchModels = true) {
    // 验证格式有效性（支持 openai-responses）
    if (!['openai', 'openai-responses', 'gemini', 'claude', 'openclaw'].includes(format)) {
        logger.warn(`无效的 API 格式: ${format}`);
        return;
    }

    const oldFormat = state.apiFormat;
    state.apiFormat = format;

    // 更新配置面板显示：只显示当前格式对应的配置面板
    document.querySelectorAll('.api-config').forEach((panel) => {
        panel.style.display = 'none';
    });
    const configPanel = document.getElementById(`${format}-config`);
    if (configPanel) {
        configPanel.style.display = 'block';
    }

    // 如果格式相同，无需转换消息，直接返回
    if (oldFormat === format) {
        return;
    }

    // 显示/隐藏 Gemini 图片配置 (兼容旧 UI)
    if (elements.geminiImageConfig) {
        elements.geminiImageConfig.style.display = format === 'gemini' ? 'block' : 'none';
    }

    // 更新端点 placeholder（支持 openai-responses）
    const placeholders = {
        openai: 'API 端点 (如: http://localhost:8000/v1/chat/completions)',
        'openai-responses': 'API 端点 (如: https://api.openai.com/v1/responses)',
        gemini: 'API 端点 (如: https://generativelanguage.googleapis.com)',
        claude: 'API 端点 (如: https://api.anthropic.com/v1/messages)',
        openclaw: 'WebSocket 地址 (如: ws://localhost:18789)'
    };
    if (elements.apiEndpoint) {
        elements.apiEndpoint.placeholder = placeholders[format] || placeholders.openai;
    }

    saveCurrentConfig();

    // 切换格式后重新加载模型列表
    if (shouldFetchModels) {
        // 延迟调用，确保配置已保存
        setTimeout(() => populateModelSelect(), 100);
    }
}

/**
 * 初始化格式切换功能
 */
export function initFormatSwitcher() {
    // 旧的格式按钮已移除，现在通过提供商管理切换格式

    // 监听配置加载时的格式切换请求
    eventBus.on('config:format-change-requested', ({ format, shouldFetchModels }) => {
        setApiFormat(format, shouldFetchModels);
    });

    logger.debug('Format switcher initialized');
}
