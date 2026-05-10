/**
 * 模型选择器
 * - 模型管理弹窗（从 API 拉取模型列表）
 * - 模型搜索 / 全选 / 反选
 * - 自定义模型添加
 * - 模型编辑弹窗（名称、能力标签）
 */

import { state } from '../core/state.js';
import { eventBus } from '../core/events.js';
import {
    addModelToProvider,
    addModelsToProvider,
    fetchProviderModels,
    updateProvider
} from './manager.js';
import { renderCapabilityBadges } from '../utils/capability-badges.js';
import { showInputDialog } from '../utils/dialogs.js';
import { escapeHtml } from '../utils/helpers.js';
import { showNotification } from '../ui/notifications.js';
import { getIcon } from '../utils/icons.js';
import { bindTopmostEscape } from '../utils/modal-stack.js';
import { getSelectedProviderId } from './shared-state.js';

// 延迟导入，避免循环依赖
let _showProviderForm;
async function getShowProviderForm() {
    if (!_showProviderForm) {
        const mod = await import('./provider-form.js');
        _showProviderForm = mod.showProviderForm;
    }
    return _showProviderForm;
}

let removeModelsManageEscape = null;
let removeEditModelEscape = null;

// ========== 模型管理弹窗 ==========

function beginModelsManageSession(modal, providerId) {
    modal._sessionId = (modal._sessionId || 0) + 1;
    modal._providerId = providerId;
    return modal._sessionId;
}

function invalidateModelsManageSession(modal) {
    modal._sessionId = (modal._sessionId || 0) + 1;
    delete modal._providerId;
}

function isModelsManageSessionActive(modal, providerId, sessionId) {
    return (
        !!modal &&
        modal.classList.contains('active') &&
        modal._providerId === providerId &&
        modal._sessionId === sessionId
    );
}

export function closeModelsManageModal() {
    const modal = document.getElementById('models-manage-modal');
    if (!modal) return;

    modal.classList.remove('active');

    clearTimeout(modal._modelsManageSearchTimeout);
    modal._modelsManageSearchTimeout = null;
    invalidateModelsManageSession(modal);

    const searchInput = document.getElementById('models-search-input');
    if (searchInput) {
        searchInput.value = '';
        searchInput.replaceWith(searchInput.cloneNode(true));
    }

    const bulkActions = document.getElementById('models-bulk-actions');
    if (bulkActions) {
        bulkActions.style.display = 'none';
    }

    removeModelsManageEscape?.();
    removeModelsManageEscape = null;
}

function bindModelsManageCloseActions() {
    const modal = document.getElementById('models-manage-modal');
    if (!modal) return;

    removeModelsManageEscape?.();
    removeModelsManageEscape = bindTopmostEscape(modal, closeModelsManageModal);

    const closeBtn = document.getElementById('close-models-manage');
    const cancelBtn = document.getElementById('cancel-models-manage');
    closeBtn?.replaceWith(closeBtn.cloneNode(true));
    document
        .getElementById('close-models-manage')
        ?.addEventListener('click', closeModelsManageModal);
    cancelBtn?.replaceWith(cancelBtn.cloneNode(true));
    document
        .getElementById('cancel-models-manage')
        ?.addEventListener('click', closeModelsManageModal);
}

/**
 * 打开模型管理弹窗
 */
export async function showModelsManageModal(providerId) {
    const provider = state.providers.find((p) => p.id === providerId);
    if (!provider) return;

    const modal = document.getElementById('models-manage-modal');
    const title = document.getElementById('models-manage-title');
    const loading = document.getElementById('models-loading');
    const checklist = document.getElementById('models-checklist');

    if (!modal || !loading || !checklist) return;

    const sessionId = beginModelsManageSession(modal, providerId);

    modal.classList.add('active');
    title.textContent = `从 API 添加模型 - ${provider.name}`;

    bindModelsManageCloseActions();

    loading.style.display = 'flex';
    // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
    checklist.innerHTML = '';
    updateSelectedCount();

    try {
        const allModels = await fetchProviderModels(providerId, true);

        if (!isModelsManageSessionActive(modal, providerId, sessionId)) {
            return;
        }

        loading.style.display = 'none';
        title.textContent = `从 API 添加模型 - ${provider.name}（共 ${allModels.length} 个）`;

        renderModelsChecklist(providerId, allModels);
        bindModelsManageEvents(providerId, sessionId, allModels);
    } catch (error) {
        if (!isModelsManageSessionActive(modal, providerId, sessionId)) {
            return;
        }

        loading.style.display = 'none';

        let errorHint = '';
        if (error.status === 401) {
            errorHint =
                '<p style="color: var(--text-secondary); font-size: 0.9em; margin-top: 8px;">提示: 请检查 API 密钥是否正确</p>';
        } else if (error.status === 429) {
            errorHint =
                '<p style="color: var(--text-secondary); font-size: 0.9em; margin-top: 8px;">提示: API 速率限制，请稍后重试</p>';
        }

        // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
        checklist.innerHTML = `
            <div style="padding: 40px; text-align: center; color: var(--text-error);">
                <p>拉取模型失败: ${escapeHtml(error.message)}</p>
                ${errorHint}
                <button type="button" class="btn-secondary" id="retry-fetch-models">重试</button>
            </div>
        `;

        document.getElementById('retry-fetch-models')?.addEventListener('click', () => {
            showModelsManageModal(providerId);
        });
    }
}

/**
 * 渲染模型复选框列表
 */
function renderModelsChecklist(providerId, allModels) {
    const provider = state.providers.find((p) => p.id === providerId);
    if (!provider) return;

    const checklist = document.getElementById('models-checklist');
    const searchInput = document.getElementById('models-search-input');
    const bulkActions = document.getElementById('models-bulk-actions');

    if (!checklist) return;

    if (!checklist._scrollBound) {
        checklist.addEventListener('scroll', () => {
            checklist.classList.toggle('scrolled', checklist.scrollTop > 10);
        });
        checklist._scrollBound = true;
    }

    const searchQuery = searchInput?.value.toLowerCase() || '';

    const filteredModels = searchQuery
        ? allModels.filter((m) => {
              const modelId = typeof m === 'string' ? m : m.id;
              const modelName = typeof m === 'string' ? m : m.name || m.id;
              return (
                  modelId.toLowerCase().includes(searchQuery) ||
                  modelName.toLowerCase().includes(searchQuery)
              );
          })
        : allModels;

    if (filteredModels.length === 0) {
        // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
        checklist.innerHTML = `
            <div style="padding: 40px; text-align: center; color: var(--text-secondary);">
                <p>没有找到匹配的模型</p>
            </div>
        `;
        if (bulkActions) bulkActions.style.display = 'none';
        updateSelectedCount();
        checklist.classList.toggle('scrolled', checklist.scrollTop > 10);
        return;
    }

    if (bulkActions) bulkActions.style.display = 'flex';

    // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
    checklist.innerHTML = filteredModels
        .map((model) => {
            const modelId = typeof model === 'string' ? model : model.id;
            const modelName = typeof model === 'string' ? model : model.name || model.id;

            const isChecked =
                provider.models?.some((m) => {
                    const existingId = typeof m === 'string' ? m : m.id;
                    return existingId === modelId;
                }) || false;

            return `
            <div class="model-checkbox-item">
                <input type="checkbox" id="model-${escapeHtml(modelId)}" value="${escapeHtml(modelId)}"
                       ${isChecked ? 'checked' : ''} />
                <label for="model-${escapeHtml(modelId)}">${escapeHtml(modelName)}</label>
            </div>
        `;
        })
        .join('');

    updateSelectedCount();
    checklist.classList.toggle('scrolled', checklist.scrollTop > 10);
}

function bindModelsChecklistChangeEvents(checklist) {
    checklist?.querySelectorAll('input[type="checkbox"]').forEach((checkbox) => {
        checkbox.addEventListener('change', updateSelectedCount);
    });
}

/**
 * 绑定模型管理弹窗事件
 */
function bindModelsManageEvents(providerId, sessionId, allModels) {
    const modal = document.getElementById('models-manage-modal');
    const searchInput = document.getElementById('models-search-input');
    const checklist = document.getElementById('models-checklist');
    const addBtn = document.getElementById('add-selected-models');

    if (!modal) return;

    // 搜索框防抖
    if (searchInput && !searchInput._searchBound) {
        searchInput.addEventListener('input', () => {
            clearTimeout(modal._modelsManageSearchTimeout);

            modal._modelsManageSearchTimeout = setTimeout(() => {
                if (!isModelsManageSessionActive(modal, providerId, sessionId)) {
                    return;
                }

                renderModelsChecklist(providerId, allModels);
                bindModelsChecklistChangeEvents(document.getElementById('models-checklist'));
            }, 300);
        });
        searchInput._searchBound = true;
    }

    bindModelsChecklistChangeEvents(checklist);

    // 全选
    const selectAllBtn = document.getElementById('select-all-models');
    selectAllBtn?.replaceWith(selectAllBtn.cloneNode(true));
    document.getElementById('select-all-models')?.addEventListener('click', () => {
        const checkboxes = checklist?.querySelectorAll('input[type="checkbox"]');
        checkboxes?.forEach((cb) => {
            cb.checked = true;
        });
        updateSelectedCount();
    });

    // 反选
    const deselectAllBtn = document.getElementById('deselect-all-models');
    deselectAllBtn?.replaceWith(deselectAllBtn.cloneNode(true));
    document.getElementById('deselect-all-models')?.addEventListener('click', () => {
        const checkboxes = checklist?.querySelectorAll('input[type="checkbox"]');
        checkboxes?.forEach((cb) => {
            cb.checked = !cb.checked;
        });
        updateSelectedCount();
    });

    // 添加选中的模型
    addBtn?.replaceWith(addBtn.cloneNode(true));
    document.getElementById('add-selected-models')?.addEventListener('click', async () => {
        const selectedCheckboxes = Array.from(
            checklist.querySelectorAll('input[type="checkbox"]:checked')
        );
        const selectedModels = selectedCheckboxes.map((cb) => cb.value);

        if (selectedModels.length === 0) {
            eventBus.emit('ui:notification', { message: '请至少选择一个模型', type: 'warning' });
            return;
        }

        const addedCount = addModelsToProvider(providerId, selectedModels);

        eventBus.emit('ui:notification', {
            message: `成功添加 ${addedCount} 个模型`,
            type: 'success'
        });

        closeModelsManageModal();
        const showForm = await getShowProviderForm();
        showForm(providerId);
    });
}

/**
 * 更新选中模型数量
 */
function updateSelectedCount() {
    const checklist = document.getElementById('models-checklist');
    const countSpan = document.getElementById('selected-models-count');

    if (!checklist || !countSpan) return;

    const selectedCount = checklist.querySelectorAll('input[type="checkbox"]:checked').length;
    countSpan.textContent = selectedCount.toString();
}

/**
 * 添加自定义模型
 */
export async function showAddCustomModelDialog(providerId) {
    const modelId = await showInputDialog('请输入模型ID:', '', '添加自定义模型');

    if (!modelId || !modelId.trim()) {
        return;
    }

    const success = addModelToProvider(providerId, modelId.trim());

    if (success) {
        eventBus.emit('ui:notification', {
            message: `模型 "${modelId.trim()}" 已添加`,
            type: 'success'
        });
        const showForm = await getShowProviderForm();
        showForm(providerId);
    } else {
        eventBus.emit('ui:notification', {
            message: `模型已存在`,
            type: 'warning'
        });
    }
}

// ========== 模型编辑弹窗 ==========

/**
 * 打开模型编辑弹窗
 */
export function openEditModelModal(providerId, modelId) {
    const provider = state.providers.find((p) => p.id === providerId);
    if (!provider) return;

    const modelConfig = provider.models.find((m) => {
        return typeof m === 'string' ? m === modelId : m.id === modelId;
    });

    if (!modelConfig) return;

    const model =
        typeof modelConfig === 'string'
            ? {
                  id: modelConfig,
                  name: modelConfig,
                  capabilities: { imageInput: false, imageOutput: false }
              }
            : modelConfig;

    document.getElementById('edit-model-id').value = model.id;
    document.getElementById('edit-model-name').value = model.name || model.id;
    document.getElementById('edit-model-image-input').checked =
        model.capabilities?.imageInput || false;
    document.getElementById('edit-model-image-output').checked =
        model.capabilities?.imageOutput || false;

    const modal = document.getElementById('edit-model-modal');
    if (!modal) return;

    removeEditModelEscape?.();
    removeEditModelEscape = bindTopmostEscape(modal, closeEditModelModal);

    modal.classList.add('active');
    modal.dataset.providerId = providerId;
    modal.dataset.modelId = modelId;
}

/**
 * 保存编辑的模型
 */
export async function saveEditedModel() {
    const modal = document.getElementById('edit-model-modal');
    if (!modal) return;

    const providerId = modal.dataset.providerId;
    const modelId = modal.dataset.modelId;

    const provider = state.providers.find((p) => p.id === providerId);
    if (!provider) return;

    const newName = document.getElementById('edit-model-name').value.trim();
    const imageInput = document.getElementById('edit-model-image-input').checked;
    const imageOutput = document.getElementById('edit-model-image-output').checked;

    if (!newName) {
        showNotification('请输入模型名称', 'error');
        return;
    }

    const modelIndex = provider.models.findIndex((m) => {
        return typeof m === 'string' ? m === modelId : m.id === modelId;
    });

    if (modelIndex === -1) return;

    provider.models[modelIndex] = {
        id: modelId,
        name: newName,
        capabilities: {
            imageInput,
            imageOutput
        }
    };

    updateProvider(providerId, { models: provider.models });

    closeEditModelModal();

    if (getSelectedProviderId() === providerId) {
        const showForm = await getShowProviderForm();
        showForm(providerId);
    }

    eventBus.emit('ui:notification', { message: '模型已更新', type: 'success' });
}

/**
 * 关闭模型编辑弹窗
 */
export function closeEditModelModal() {
    const modal = document.getElementById('edit-model-modal');
    if (modal) {
        removeEditModelEscape?.();
        removeEditModelEscape = null;

        modal.classList.remove('active');
        delete modal.dataset.providerId;
        delete modal.dataset.modelId;
    }
}

/**
 * 渲染模型列表和操作按钮（供 provider-form 使用）
 */
export function renderModelsList(provider) {
    if (!provider.models || provider.models.length === 0) {
        return '<p class="empty-models">暂无模型，点击下方按钮添加</p>';
    }

    return provider.models
        .map((m) => {
            const modelId = typeof m === 'string' ? m : m.id;
            const modelName = typeof m === 'string' ? m : m.name || m.id;
            const capabilities = typeof m === 'object' ? m.capabilities : null;
            const badges = renderCapabilityBadges(capabilities);

            return `
            <div class="model-chip">
                <span class="model-chip-name">${escapeHtml(modelName)}${badges}</span>
                <button class="edit-model-btn" data-model-id="${escapeHtml(modelId)}" type="button" title="编辑模型">${getIcon('edit', { size: 14 })}</button>
                <button class="remove-model-btn" data-model="${escapeHtml(modelId)}" type="button" title="删除模型">×</button>
            </div>
        `;
        })
        .join('');
}

/**
 * 绑定模型编辑弹窗的全局关闭事件（initProvidersUI 时调用一次）
 */
export function initModelSelectorEvents() {
    document.getElementById('close-edit-model')?.addEventListener('click', closeEditModelModal);
    document.getElementById('cancel-edit-model')?.addEventListener('click', closeEditModelModal);
    document.getElementById('save-edit-model')?.addEventListener('click', saveEditedModel);
    document
        .getElementById('edit-model-modal')
        ?.querySelector('.modal-overlay')
        ?.addEventListener('click', closeEditModelModal);
    document
        .getElementById('models-manage-modal')
        ?.querySelector('.modal-overlay')
        ?.addEventListener('click', closeModelsManageModal);
}
