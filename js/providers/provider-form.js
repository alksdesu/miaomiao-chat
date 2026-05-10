/**
 * 提供商表单（新增/编辑）
 * - 表单渲染、字段填充
 * - 表单验证与保存
 * - 端点提示与建议
 * - OpenClaw 连接管理
 */

import { state } from '../core/state.js';
import { eventBus } from '../core/events.js';
import {
    createProvider,
    updateProvider,
    deleteProvider,
    removeModelFromProvider,
    getActiveApiKey
} from './manager.js';
import { escapeHtml } from '../utils/helpers.js';
import { showNotification } from '../ui/notifications.js';
import { showConfirmDialog } from '../utils/dialogs.js';
import { setSelectedProviderId } from './shared-state.js';
import { renderProvidersList, showEmptyState } from './provider-list.js';
import { renderApiKeysCollapsible, bindApiKeysEvents } from './key-manager-ui.js';
import {
    showModelsManageModal,
    showAddCustomModelDialog,
    openEditModelModal,
    renderModelsList
} from './model-selector.js';

// OpenClaw 连接状态 listener
let _openclawStatusUnsubs = [];

// 端点提示文案
const ENDPOINT_HINTS = {
    openai: '示例: https://api.openai.com/v1/chat/completions 或 http://localhost:8000/v1/chat/completions',
    'openai-responses': '示例: https://api.openai.com/v1/responses 或自定义代理地址/v1/responses',
    gemini: '示例: https://generativelanguage.googleapis.com 或自定义代理地址',
    claude: '示例: https://api.anthropic.com/v1/messages 或自定义代理地址',
    openclaw: '示例: ws://localhost:18789'
};

// 可高置信度建议的目标路径
const ENDPOINT_SUGGESTION_PATHS = {
    openai: '/v1/chat/completions',
    'openai-responses': '/v1/responses',
    claude: '/v1/messages'
};

/**
 * 显示右侧提供商表单
 */
export function showProviderForm(providerId) {
    const container = document.getElementById('provider-detail-content');
    if (!container) return;

    const provider = providerId ? state.providers.find((p) => p.id === providerId) : null;
    const isEdit = !!provider;

    // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
    container.innerHTML = `
        <form class="provider-form" id="provider-detail-form">
            ${
                isEdit
                    ? `
                <div class="form-group provider-enable-toggle">
                    <div class="toggle-container">
                        <label class="toggle-switch-modern">
                            <input type="checkbox" id="detail-provider-enabled" ${provider.enabled ? 'checked' : ''} />
                            <span class="toggle-slider"></span>
                        </label>
                        <div class="toggle-label-group">
                            <label for="detail-provider-enabled" class="toggle-title">在模型列表中显示此提供商的模型</label>
                            <p class="toggle-hint">启用后，该提供商的模型会出现在设置面板的模型下拉列表中</p>
                        </div>
                    </div>
                </div>
            `
                    : ''
            }

            <div class="form-group">
                <label for="detail-provider-name">提供商名称 *</label>
                <input type="text" id="detail-provider-name" value="${provider ? escapeHtml(provider.name) : ''}"
                       placeholder="例如 OpenAI GPT-4" required />
            </div>

            <div class="form-group">
                <label for="detail-provider-format">API 格式 *</label>
                <select id="detail-provider-format" required>
                    <option value="openai" ${provider?.apiFormat === 'openai' ? 'selected' : ''}>OpenAI (Chat Completions)</option>
                    <option value="openai-responses" ${provider?.apiFormat === 'openai-responses' ? 'selected' : ''}>OpenAI (Responses API)</option>
                    <option value="gemini" ${provider?.apiFormat === 'gemini' ? 'selected' : ''}>Gemini</option>
                    <option value="claude" ${provider?.apiFormat === 'claude' ? 'selected' : ''}>Claude</option>
                    <option value="openclaw" ${provider?.apiFormat === 'openclaw' ? 'selected' : ''}>OpenClaw</option>
                </select>
                ${isEdit ? '<p class="form-hint">修改格式后需确保端点与新格式匹配</p>' : ''}
            </div>

            <div class="form-group">
                <label for="detail-provider-endpoint">API 地址</label>
                <input type="text" id="detail-provider-endpoint" value="${provider ? escapeHtml(provider.endpoint) : ''}"
                       placeholder="留空使用默认地址" />
                <div class="form-hint endpoint-hint" id="endpoint-hint-text"></div>
            </div>

            <div class="form-group api-keys-section">
                ${
                    isEdit
                        ? renderApiKeysCollapsible(provider)
                        : `
                    <label for="detail-provider-apikey">API 密钥</label>
                    <div class="password-input-wrapper">
                        <input type="password" id="detail-provider-apikey" value=""
                               placeholder="sk-..." />
                        <button type="button" class="password-toggle-btn" id="toggle-apikey-btn">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                                <circle cx="12" cy="12" r="3"/>
                            </svg>
                        </button>
                    </div>
                `
                }
            </div>

            <div class="form-group gemini-only" style="display: ${provider?.apiFormat === 'gemini' || !provider ? 'block' : 'none'};">
                <div class="form-group-inline">
                    <input type="checkbox" id="detail-provider-gemini-header"
                           ${provider?.geminiApiKeyInHeader ? 'checked' : ''} />
                    <label for="detail-provider-gemini-header">通过请求头传递 API Key</label>
                </div>
                <p class="form-hint">启用后使用 x-goog-api-key 请求头（适用于代理）</p>
            </div>

            ${
                isEdit && provider?.apiFormat === 'openclaw'
                    ? `
                <div class="form-group openclaw-connection-section">
                    <label>连接状态</label>
                    <div class="openclaw-connection-status">
                        <span class="openclaw-status-dot" id="openclaw-status-dot"></span>
                        <span id="openclaw-status-text">未连接</span>
                        <button type="button" id="openclaw-connect-btn" class="btn-secondary">连接</button>
                        <button type="button" id="openclaw-disconnect-btn" class="btn-secondary" style="display:none;">断开</button>
                    </div>
                </div>
            `
                    : ''
            }

            ${
                isEdit
                    ? `
                <div class="form-group">
                    <label>已添加模型 (${provider.models?.length || 0})</label>
                    <div class="provider-models-list">
                        ${renderModelsList(provider)}
                    </div>
                    <div class="models-actions">
                        <button type="button" id="manage-models-btn" class="btn-secondary">... 管理模型</button>
                        <button type="button" id="add-custom-model-btn" class="btn-secondary">+ 添加自定义</button>
                    </div>
                    <p class="form-hint">只有添加的模型会出现在设置面板的模型下拉列表中</p>
                </div>
            `
                    : ''
            }
        </form>

        <div class="detail-footer">
            ${
                isEdit
                    ? `
                <button type="button" class="btn-danger" id="delete-provider-btn">删除</button>
            `
                    : ''
            }
            <button type="button" class="btn-secondary" id="cancel-form-btn">取消</button>
            <button type="button" class="btn-primary" id="save-provider-btn">保存</button>
        </div>
    `;

    bindFormEvents(providerId);
}

/**
 * 绑定表单事件
 */
function bindFormEvents(providerId) {
    const isEdit = !!providerId;
    const formatSelect = document.getElementById('detail-provider-format');
    const endpointInput = document.getElementById('detail-provider-endpoint');
    const endpointHint = document.getElementById('endpoint-hint-text');

    // 保存
    document.getElementById('save-provider-btn')?.addEventListener('click', () => {
        saveProviderForm(providerId);
    });

    // 取消
    document.getElementById('cancel-form-btn')?.addEventListener('click', () => {
        if (isEdit) {
            showProviderForm(providerId);
        } else {
            showEmptyState();
            setSelectedProviderId(null);
            renderProvidersList();
        }
    });

    // 删除
    document.getElementById('delete-provider-btn')?.addEventListener('click', async () => {
        const provider = state.providers.find((p) => p.id === providerId);
        if (!provider) return;

        const confirmed = await showConfirmDialog(
            `确定删除提供商 "${provider.name}"？`,
            '确认删除'
        );
        if (confirmed) {
            deleteProvider(providerId);
        }
    });

    // 密码显示切换
    document.getElementById('toggle-apikey-btn')?.addEventListener('click', () => {
        const input = document.getElementById('detail-provider-apikey');
        if (input) {
            input.type = input.type === 'password' ? 'text' : 'password';
        }
    });

    // API 格式切换
    formatSelect?.addEventListener('change', (e) => {
        const apiFormat = e.target.value;
        const geminiOnly = document.querySelector('.gemini-only');
        if (geminiOnly) {
            geminiOnly.style.display = apiFormat === 'gemini' ? 'block' : 'none';
        }
        updateEndpointHint(apiFormat);
    });

    // 初始化端点提示
    const initialFormat = formatSelect?.value;
    if (initialFormat) {
        updateEndpointHint(initialFormat);
    }

    // 端点编辑时清理旧建议
    endpointInput?.addEventListener('input', () => {
        const apiFormat = formatSelect?.value;
        if (apiFormat) {
            updateEndpointHint(apiFormat);
        }
    });

    // 端点失焦时给出建议
    endpointInput?.addEventListener('blur', () => {
        const apiFormat = formatSelect?.value;
        if (!apiFormat) return;

        const suggestion = getEndpointSuggestion(endpointInput.value.trim(), apiFormat);
        updateEndpointHint(apiFormat, suggestion);
    });

    // 端点建议动作
    endpointHint?.addEventListener('click', (event) => {
        const actionLink = event.target?.closest?.('[data-endpoint-hint-action]');
        if (!actionLink) return;

        event.preventDefault();

        const apiFormat = formatSelect?.value;
        const suggestion = endpointHint.dataset.suggestion;
        if (!apiFormat) return;

        if (actionLink.dataset.endpointHintAction === 'apply' && suggestion && endpointInput) {
            endpointInput.value = suggestion;
        }

        updateEndpointHint(apiFormat);
    });

    // 密钥管理事件
    if (isEdit) {
        bindApiKeysEvents(providerId);
    }

    // 模型管理
    if (isEdit) {
        document.getElementById('manage-models-btn')?.addEventListener('click', () => {
            showModelsManageModal(providerId);
        });

        document.getElementById('add-custom-model-btn')?.addEventListener('click', () => {
            showAddCustomModelDialog(providerId);
        });

        document.querySelectorAll('.remove-model-btn').forEach((btn) => {
            btn.addEventListener('click', async () => {
                const modelId = btn.dataset.model;
                const confirmed = await showConfirmDialog(
                    `确定移除模型 "${modelId}"？`,
                    '确认移除'
                );
                if (confirmed) {
                    removeModelFromProvider(providerId, modelId);
                    showProviderForm(providerId);
                }
            });
        });

        document.querySelectorAll('.edit-model-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
                const modelId = btn.dataset.modelId;
                openEditModelModal(providerId, modelId);
            });
        });

        bindOpenClawConnectionEvents(providerId);
    }
}

/**
 * 保存提供商表单
 */
function saveProviderForm(providerId) {
    const name = document.getElementById('detail-provider-name')?.value.trim();
    const apiFormat = document.getElementById('detail-provider-format')?.value;
    const endpoint = document.getElementById('detail-provider-endpoint')?.value.trim();
    const apiKey = document.getElementById('detail-provider-apikey')?.value.trim();
    const geminiApiKeyInHeader =
        document.getElementById('detail-provider-gemini-header')?.checked || false;
    const enabled = document.getElementById('detail-provider-enabled')?.checked ?? true;

    if (!name) {
        showNotification('请输入提供商名称', 'error');
        return;
    }

    if (!apiFormat) {
        showNotification('请选择API格式', 'error');
        return;
    }

    if (
        endpoint &&
        !endpoint.startsWith('http://') &&
        !endpoint.startsWith('https://') &&
        !endpoint.startsWith('ws://') &&
        !endpoint.startsWith('wss://')
    ) {
        showNotification('API 地址必须以 http://, https://, ws:// 或 wss:// 开头', 'error');
        return;
    }

    const duplicateName = state.providers.find((p) => p.name === name && p.id !== providerId);
    if (duplicateName) {
        showNotification(`已存在同名提供商 "${name}"`, 'error');
        return;
    }

    const finalEndpoint = endpoint ?? '';

    const data = {
        name,
        apiFormat,
        endpoint: finalEndpoint,
        apiKey,
        geminiApiKeyInHeader,
        enabled
    };

    if (providerId) {
        updateProvider(providerId, data);
        eventBus.emit('ui:notification', { message: '提供商已更新', type: 'success' });
    } else {
        const provider = createProvider(data);
        setSelectedProviderId(provider.id);
        renderProvidersList();
        showProviderForm(provider.id);
        eventBus.emit('ui:notification', { message: '提供商已创建', type: 'success' });
    }
}

// ========== 端点提示 ==========

function updateEndpointHint(apiFormat, suggestion = null) {
    const hint = document.getElementById('endpoint-hint-text');
    if (!hint) return;

    // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
    hint.innerHTML = '';
    hint.classList.toggle('endpoint-hint--suggestion', Boolean(suggestion));

    if (!suggestion) {
        delete hint.dataset.suggestion;
        hint.textContent = ENDPOINT_HINTS[apiFormat] || '请输入完整的API端点地址';
        return;
    }

    hint.dataset.suggestion = suggestion;
    // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
    hint.innerHTML = `
        <span>建议补全为：</span>
        <span class="endpoint-hint__value">${escapeHtml(suggestion)}</span>
        <span class="endpoint-hint__actions">
            <a href="#" data-endpoint-hint-action="apply">应用</a>
            <span>·</span>
            <a href="#" data-endpoint-hint-action="ignore">忽略</a>
        </span>
    `;
}

function normalizeEndpointPath(pathname) {
    const normalizedPath = pathname.replace(/\/+$/, '');
    return normalizedPath || '/';
}

function getEndpointSuggestion(endpoint, apiFormat) {
    const targetPath = ENDPOINT_SUGGESTION_PATHS[apiFormat];
    if (!endpoint || !targetPath) return null;

    try {
        const url = new URL(endpoint);
        const normalizedPath = normalizeEndpointPath(url.pathname);

        if (normalizedPath === targetPath) {
            return null;
        }

        if (normalizedPath !== '/' && normalizedPath !== '/v1') {
            return null;
        }

        url.pathname = targetPath;
        const suggestion = url.toString();
        return suggestion === endpoint ? null : suggestion;
    } catch {
        return null;
    }
}

// ========== OpenClaw 连接 ==========

function bindOpenClawConnectionEvents(providerId) {
    const connectBtn = document.getElementById('openclaw-connect-btn');
    const disconnectBtn = document.getElementById('openclaw-disconnect-btn');
    if (!connectBtn) return;

    _openclawStatusUnsubs.forEach((unsub) => unsub());
    _openclawStatusUnsubs = [];

    const getClient = async () => {
        const { openclawClient } = await import('../api/openclaw.js');
        return openclawClient;
    };

    const updateStatus = async () => {
        const dot = document.getElementById('openclaw-status-dot');
        const text = document.getElementById('openclaw-status-text');
        if (!dot || !text) return;

        const client = await getClient();
        const status = client.getStatus();

        const statusMap = {
            connected: { color: '#4caf50', label: '已连接' },
            connecting: { color: '#ff9800', label: '连接中...' },
            reconnecting: { color: '#ff9800', label: '重连中...' },
            disconnected: { color: '#f44336', label: '未连接' }
        };
        const s = statusMap[status] || statusMap.disconnected;
        dot.style.background = s.color;
        text.textContent = s.label;

        connectBtn.style.display = status === 'connected' ? 'none' : '';
        disconnectBtn.style.display = status === 'connected' ? '' : 'none';
    };

    connectBtn.addEventListener('click', async () => {
        const provider = state.providers.find((p) => p.id === providerId);
        if (!provider) return;

        const client = await getClient();
        const url = provider.endpoint || 'ws://localhost:18789';
        const token = getActiveApiKey(providerId);

        connectBtn.textContent = '连接中...';
        connectBtn.disabled = true;

        const result = await client.connect(url, token);
        connectBtn.textContent = '连接';
        connectBtn.disabled = false;

        if (result.success) {
            showNotification('OpenClaw 已连接', 'success');
        } else {
            showNotification(`连接失败: ${result.error}`, 'error');
        }
        updateStatus();
    });

    disconnectBtn.addEventListener('click', async () => {
        const client = await getClient();
        client.disconnect();
        showNotification('OpenClaw 已断开', 'info');
        updateStatus();
    });

    _openclawStatusUnsubs.push(
        eventBus.on('openclaw:connected', updateStatus),
        eventBus.on('openclaw:disconnected', updateStatus)
    );

    updateStatus();
}
