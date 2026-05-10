/**
 * API 密钥管理 UI
 * - 密钥列表渲染、折叠面板
 * - 密钥的添加/删除/编辑/启禁用
 * - 密钥轮询设置
 * - 密钥掩码显示
 */

import { state } from '../core/state.js';
import {
    addApiKey,
    removeApiKey,
    setCurrentKey,
    updateApiKey,
    setKeyRotationConfig,
    ensureApiKeysArray,
    clearModelsCache
} from './manager.js';
import { escapeHtml } from '../utils/helpers.js';
import { showNotification } from '../ui/notifications.js';
import { showConfirmDialog } from '../utils/dialogs.js';
import {
    applyModalLayerZIndex,
    bindTopmostEscape,
    MODAL_LAYER_Z_INDEX,
    setupModalFocus
} from '../utils/modal-stack.js';

/**
 * 遮蔽 API 密钥
 */
export function maskApiKey(key) {
    if (!key) return '未设置';
    if (key.length <= 8) return '****';
    return key.substring(0, 4) + '...' + key.substring(key.length - 4);
}

/**
 * 渲染可折叠的 API 密钥管理区域
 */
export function renderApiKeysCollapsible(provider) {
    ensureApiKeysArray(provider);

    const keysCount = provider.apiKeys?.length || 0;
    const currentKey = provider.apiKeys?.find((k) => k.id === provider.currentKeyId);
    const currentKeyPreview = currentKey ? maskApiKey(currentKey.key) : '未设置';
    const rotationEnabled = provider.keyRotation?.enabled || false;

    return `
        <div class="api-keys-collapsible">
            <button type="button" class="api-keys-header" id="toggle-api-keys-panel">
                <div class="api-keys-header-left">
                    <svg class="collapse-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polyline points="9 18 15 12 9 6"/>
                    </svg>
                    <span class="api-keys-title">API 密钥管理</span>
                    <span class="api-keys-count">${keysCount} 个密钥</span>
                </div>
                <div class="api-keys-header-right">
                    ${rotationEnabled ? '<span class="rotation-badge">轮询中</span>' : ''}
                    <span class="current-key-preview">${currentKeyPreview}</span>
                </div>
            </button>
            <div class="api-keys-panel" id="api-keys-panel" style="display: none;">
                <div class="api-keys-list" id="api-keys-list">
                    ${renderApiKeyItems(provider)}
                </div>

                <div class="add-key-form" id="add-key-form">
                    <div class="add-key-inputs">
                        <input type="password" id="new-api-key-input" placeholder="输入新的 API 密钥" />
                        <input type="text" id="new-api-key-name" placeholder="名称（可选）" />
                    </div>
                    <button type="button" class="btn-secondary btn-add-key" id="add-api-key-btn">+ 添加</button>
                </div>

                <div class="rotation-settings">
                    <div class="rotation-toggle">
                        <label class="toggle-switch-modern">
                            <input type="checkbox" id="rotation-enabled" ${rotationEnabled ? 'checked' : ''} />
                            <span class="toggle-slider"></span>
                        </label>
                        <div class="rotation-label">
                            <span>自动轮询</span>
                            <p class="form-hint">在多个密钥之间自动切换</p>
                        </div>
                    </div>
                    <div class="rotation-options" id="rotation-options" style="display: ${rotationEnabled ? 'flex' : 'none'};">
                        <div class="rotation-option">
                            <label for="rotation-strategy">轮询策略</label>
                            <select id="rotation-strategy">
                                <option value="round-robin" ${provider.keyRotation?.strategy === 'round-robin' ? 'selected' : ''}>顺序轮询</option>
                                <option value="random" ${provider.keyRotation?.strategy === 'random' ? 'selected' : ''}>随机选择</option>
                                <option value="least-used" ${provider.keyRotation?.strategy === 'least-used' ? 'selected' : ''}>最少使用</option>
                                <option value="smart" ${provider.keyRotation?.strategy === 'smart' ? 'selected' : ''}>智能选择</option>
                            </select>
                        </div>
                        <div class="rotation-option">
                            <label class="checkbox-label">
                                <input type="checkbox" id="rotate-on-error" ${provider.keyRotation?.rotateOnError !== false ? 'checked' : ''} />
                                <span>错误时自动切换</span>
                            </label>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `;
}

/**
 * 渲染密钥列表项
 */
function renderApiKeyItems(provider) {
    const apiKeys = provider.apiKeys || [];

    if (apiKeys.length === 0) {
        return '<div class="empty-keys">暂无密钥，请添加</div>';
    }

    return apiKeys
        .map((key) => {
            const isCurrent = key.id === provider.currentKeyId;
            const maskedKey = maskApiKey(key.key);
            const displayName = key.name || maskedKey;

            return `
            <div class="api-key-item ${isCurrent ? 'current' : ''} ${!key.enabled ? 'disabled' : ''}" data-key-id="${escapeHtml(key.id)}">
                <label class="key-select">
                    <input type="radio" name="current-key" value="${escapeHtml(key.id)}" ${isCurrent ? 'checked' : ''} ${!key.enabled ? 'disabled' : ''} />
                    <span class="key-info">
                        <span class="key-name">${escapeHtml(displayName)}</span>
                        <span class="key-preview">${escapeHtml(maskedKey)}</span>
                        ${key.usageCount > 0 ? `<span class="key-stats">使用 ${key.usageCount} 次</span>` : ''}
                    </span>
                </label>
                <div class="key-actions">
                    <button type="button" class="key-edit-btn" data-key-id="${escapeHtml(key.id)}" title="编辑">✎</button>
                    <button type="button" class="key-toggle-btn" data-key-id="${escapeHtml(key.id)}" title="${key.enabled ? '禁用' : '启用'}">
                        ${key.enabled ? '✓' : '✗'}
                    </button>
                    <button type="button" class="key-delete-btn" data-key-id="${escapeHtml(key.id)}" title="删除">×</button>
                </div>
            </div>
        `;
        })
        .join('');
}

/**
 * 显示编辑密钥对话框
 */
async function showEditKeyDialog(providerId, keyId) {
    const provider = state.providers.find((p) => p.id === providerId);
    if (!provider) return;

    const key = provider.apiKeys?.find((k) => k.id === keyId);
    if (!key) return;

    const dialog = document.createElement('div');
    dialog.className = 'modal active';
    applyModalLayerZIndex(dialog, MODAL_LAYER_Z_INDEX.settingsNested);
    // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
    dialog.innerHTML = `
        <div class="modal-overlay"></div>
        <div class="modal-content modal-mobile-compact" style="--modal-compact-max-width: 500px;">
            <div class="modal-header">
                <h3 id="edit-key-dialog-title">编辑密钥</h3>
                <button type="button" class="modal-close" id="close-edit-key">×</button>
            </div>
            <div class="modal-body">
                <div class="form-group">
                    <label for="edit-key-name">密钥名称（可选）</label>
                    <input type="text" id="edit-key-name" class="text-input" value="${escapeHtml(key.name || '')}" placeholder="例如：主密钥、备用密钥">
                </div>
                <div class="form-group">
                    <label for="edit-key-value">API 密钥</label>
                    <input type="password" id="edit-key-value" class="text-input" value="${escapeHtml(key.key)}" placeholder="输入新的 API 密钥">
                    <button type="button" id="toggle-key-visibility" class="btn-secondary" style="margin-top: 8px;">显示密钥</button>
                </div>
            </div>
            <div class="modal-footer">
                <button type="button" class="btn-secondary" id="cancel-edit-key">取消</button>
                <button type="button" class="btn-primary" id="save-edit-key">保存</button>
            </div>
        </div>
    `;

    document.body.appendChild(dialog);

    let removeEscapeListener = null;
    let removeDialogFocus = setupModalFocus(dialog, {
        labelledBy: 'edit-key-dialog-title',
        initialFocus: '#edit-key-name'
    });

    const closeDialog = () => {
        removeEscapeListener?.();
        removeEscapeListener = null;
        removeDialogFocus?.();
        removeDialogFocus = null;

        if (dialog.isConnected) {
            dialog.remove();
        }
    };

    dialog.querySelector('#close-edit-key').addEventListener('click', closeDialog);
    dialog.querySelector('#cancel-edit-key').addEventListener('click', closeDialog);
    dialog.querySelector('.modal-overlay').addEventListener('click', closeDialog);

    removeEscapeListener = bindTopmostEscape(dialog, closeDialog);

    const keyInput = dialog.querySelector('#edit-key-value');
    const toggleBtn = dialog.querySelector('#toggle-key-visibility');
    toggleBtn.addEventListener('click', () => {
        if (keyInput.type === 'password') {
            keyInput.type = 'text';
            toggleBtn.textContent = '隐藏密钥';
        } else {
            keyInput.type = 'password';
            toggleBtn.textContent = '显示密钥';
        }
    });

    dialog.querySelector('#save-edit-key').addEventListener('click', () => {
        const newName = dialog.querySelector('#edit-key-name').value.trim();
        const newKey = dialog.querySelector('#edit-key-value').value.trim();

        if (!newKey) {
            showNotification('密钥不能为空', 'error');
            return;
        }

        updateApiKey(providerId, keyId, {
            name: newName,
            key: newKey
        });

        if (provider.currentKeyId === keyId) {
            provider.apiKey = newKey;
            clearModelsCache(providerId);
        }

        showNotification('密钥已更新', 'success');
        closeDialog();
        refreshApiKeysList(providerId);
    });
}

/**
 * 绑定 API 密钥管理事件
 */
export function bindApiKeysEvents(providerId) {
    const provider = state.providers.find((p) => p.id === providerId);
    if (!provider) return;

    // 折叠/展开
    const toggleBtn = document.getElementById('toggle-api-keys-panel');
    const panel = document.getElementById('api-keys-panel');

    toggleBtn?.addEventListener('click', () => {
        const isExpanded = panel.style.display !== 'none';
        panel.style.display = isExpanded ? 'none' : 'block';
        toggleBtn.classList.toggle('expanded', !isExpanded);
    });

    // 添加密钥
    document.getElementById('add-api-key-btn')?.addEventListener('click', () => {
        const keyInput = document.getElementById('new-api-key-input');
        const nameInput = document.getElementById('new-api-key-name');
        const key = keyInput?.value.trim();
        const name = nameInput?.value.trim();

        if (!key) {
            showNotification('请输入 API 密钥', 'warning');
            return;
        }

        const newKey = addApiKey(providerId, key, name);
        if (newKey) {
            showNotification('密钥已添加', 'success');
            keyInput.value = '';
            nameInput.value = '';
            refreshApiKeysList(providerId);
        } else {
            showNotification('添加失败：密钥可能已存在', 'error');
        }
    });

    // 事件委托
    const listContainer = document.getElementById('api-keys-list');
    if (listContainer) {
        listContainer.dataset.providerId = providerId;

        if (!listContainer.dataset.eventsBound) {
            listContainer.dataset.eventsBound = 'true';

            listContainer.addEventListener('click', async (e) => {
                const target = e.target.closest('button, input');
                if (!target) return;

                const currentProviderId = listContainer.dataset.providerId;
                const currentProvider = state.providers.find((p) => p.id === currentProviderId);
                if (!currentProvider) return;

                if (target.classList.contains('key-edit-btn')) {
                    e.stopPropagation();
                    const keyId = target.dataset.keyId;
                    showEditKeyDialog(currentProviderId, keyId);
                    return;
                }

                if (target.classList.contains('key-delete-btn')) {
                    e.stopPropagation();
                    const keyId = target.dataset.keyId;
                    const keyObj = currentProvider.apiKeys?.find((k) => k.id === keyId);

                    const confirmed = await showConfirmDialog(
                        `确定删除密钥 "${keyObj?.name || maskApiKey(keyObj?.key)}"？`,
                        '确认删除'
                    );

                    if (confirmed) {
                        removeApiKey(currentProviderId, keyId);
                        refreshApiKeysList(currentProviderId);
                        showNotification('密钥已删除', 'success');
                    }
                    return;
                }

                if (target.classList.contains('key-toggle-btn')) {
                    e.stopPropagation();
                    const keyId = target.dataset.keyId;
                    const keyObj = currentProvider.apiKeys?.find((k) => k.id === keyId);
                    if (keyObj) {
                        const willDisable = keyObj.enabled;

                        updateApiKey(currentProviderId, keyId, { enabled: !keyObj.enabled });

                        if (willDisable && currentProvider.currentKeyId === keyId) {
                            const nextEnabledKey = currentProvider.apiKeys.find(
                                (k) => k.enabled && k.id !== keyId
                            );
                            if (nextEnabledKey) {
                                setCurrentKey(currentProviderId, nextEnabledKey.id);
                                showNotification(
                                    `密钥已禁用，已自动切换到：${nextEnabledKey.name}`,
                                    'info'
                                );
                            } else {
                                showNotification('密钥已禁用，当前无其他可用密钥', 'warning');
                            }
                        } else {
                            showNotification(willDisable ? '密钥已禁用' : '密钥已启用', 'success');
                        }

                        refreshApiKeysList(currentProviderId);
                    }
                    return;
                }

                if (target.name === 'current-key' && target.type === 'radio') {
                    const keyId = target.value;
                    setCurrentKey(currentProviderId, keyId);
                    refreshApiKeysList(currentProviderId);
                    showNotification('已切换当前密钥', 'success');
                    return;
                }
            });
        }
    }

    // 轮询开关
    document.getElementById('rotation-enabled')?.addEventListener('change', (e) => {
        const enabled = e.target.checked;
        const optionsPanel = document.getElementById('rotation-options');
        if (optionsPanel) {
            optionsPanel.style.display = enabled ? 'flex' : 'none';
        }
        setKeyRotationConfig(providerId, { enabled });
        refreshApiKeysHeader(providerId);
    });

    // 轮询策略
    document.getElementById('rotation-strategy')?.addEventListener('change', (e) => {
        setKeyRotationConfig(providerId, { strategy: e.target.value });
    });

    // 错误时切换
    document.getElementById('rotate-on-error')?.addEventListener('change', (e) => {
        setKeyRotationConfig(providerId, { rotateOnError: e.target.checked });
    });
}

/**
 * 刷新密钥列表
 */
function refreshApiKeysList(providerId) {
    const provider = state.providers.find((p) => p.id === providerId);
    if (!provider) return;

    const listContainer = document.getElementById('api-keys-list');
    if (listContainer) {
        // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
        listContainer.innerHTML = renderApiKeyItems(provider);
        bindApiKeysEvents(providerId);
    }

    refreshApiKeysHeader(providerId);
}

/**
 * 刷新密钥面板头部
 */
function refreshApiKeysHeader(providerId) {
    const provider = state.providers.find((p) => p.id === providerId);
    if (!provider) return;

    const countSpan = document.querySelector('.api-keys-count');
    if (countSpan) {
        countSpan.textContent = `${provider.apiKeys?.length || 0} 个密钥`;
    }

    const currentKey = provider.apiKeys?.find((k) => k.id === provider.currentKeyId);
    const previewSpan = document.querySelector('.current-key-preview');
    if (previewSpan) {
        previewSpan.textContent = currentKey ? maskApiKey(currentKey.key) : '未设置';
    }

    const headerRight = document.querySelector('.api-keys-header-right');
    const existingBadge = headerRight?.querySelector('.rotation-badge');
    if (provider.keyRotation?.enabled && !existingBadge) {
        const badge = document.createElement('span');
        badge.className = 'rotation-badge';
        badge.textContent = '轮询中';
        headerRight?.insertBefore(badge, headerRight.firstChild);
    } else if (!provider.keyRotation?.enabled && existingBadge) {
        existingBadge.remove();
    }
}
