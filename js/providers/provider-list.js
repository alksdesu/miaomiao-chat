/**
 * 提供商列表渲染与交互
 * - 左侧列表渲染、搜索过滤、选中高亮
 * - 列表项点击 / 开关切换
 * - 空状态显示
 * - 移动端视图切换
 */

import { state } from '../core/state.js';
import { elements } from '../core/elements.js';
import { eventBus } from '../core/events.js';
import { updateProvider } from './manager.js';
import { escapeHtml } from '../utils/helpers.js';
import { getSelectedProviderId, setSelectedProviderId } from './shared-state.js';

// 延迟导入，避免循环依赖
let _showProviderForm;
async function getShowProviderForm() {
    if (!_showProviderForm) {
        const mod = await import('./provider-form.js');
        _showProviderForm = mod.showProviderForm;
    }
    return _showProviderForm;
}

/**
 * 渲染左侧提供商列表
 */
export function renderProvidersList() {
    const container = elements.providersList;
    if (!container) return;

    const searchQuery = elements.providersSearchInput?.value.toLowerCase() || '';

    let providers = state.providers;
    if (searchQuery) {
        providers = providers.filter(
            (p) =>
                p.name.toLowerCase().includes(searchQuery) ||
                p.apiFormat.toLowerCase().includes(searchQuery)
        );
    }

    if (providers.length === 0) {
        // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
        container.innerHTML = `
            <div style="padding: 20px; text-align: center; color: var(--text-secondary);">
                <p>暂无提供商</p>
            </div>
        `;
        return;
    }

    // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
    container.innerHTML = providers.map((provider) => renderProviderItem(provider)).join('');

    // 绑定点击事件
    container.querySelectorAll('.provider-item').forEach((item) => {
        item.addEventListener('click', async (e) => {
            if (e.target.closest('.provider-toggle-btn')) return;

            const id = item.dataset.providerId;
            setSelectedProviderId(id);
            renderProvidersList();
            const showForm = await getShowProviderForm();
            showForm(id);
            showMobileDetail();
        });
    });

    // 绑定开关按钮
    container.querySelectorAll('.provider-toggle-btn').forEach((btn) => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const id = btn.dataset.providerId;
            toggleProviderEnabled(id);
        });
    });
}

/**
 * 渲染单个提供商项
 */
function renderProviderItem(provider) {
    const isSelected = provider.id === getSelectedProviderId();
    const formatLabels = {
        openai: 'OpenAI',
        'openai-responses': 'OpenAI Responses',
        'openai-image': 'OpenAI Image',
        gemini: 'Gemini',
        claude: 'Claude',
        openclaw: 'OpenClaw'
    };

    const modelCount = provider.models?.length || 0;

    return `
        <div class="provider-item ${isSelected ? 'selected' : ''}"
             data-provider-id="${escapeHtml(provider.id)}">
            <div class="provider-item-avatar ${provider.apiFormat}">
                ${escapeHtml(provider.name.charAt(0).toUpperCase())}
            </div>
            <div class="provider-item-info">
                <div class="provider-item-name">${escapeHtml(provider.name)}</div>
                <div class="provider-item-format">${formatLabels[provider.apiFormat]} · ${modelCount}个模型</div>
            </div>
            <button class="provider-toggle-btn" data-provider-id="${escapeHtml(provider.id)}" title="${provider.enabled ? '禁用（不显示模型）' : '启用（显示模型）'}">
                <div class="toggle-switch ${provider.enabled ? 'on' : 'off'}">
                    <span class="toggle-label">${provider.enabled ? 'ON' : 'OFF'}</span>
                </div>
            </button>
        </div>
    `;
}

/**
 * 显示右侧空状态
 */
export function showEmptyState() {
    const container = document.getElementById('provider-detail-content');
    if (!container) return;

    // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
    container.innerHTML = `
        <div class="empty-detail">
            <svg width="80" height="80" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <path d="M12 2L2 7l10 5 10-5-10-5z"/>
                <path d="M2 17l10 5 10-5M2 12l10 5 10-5"/>
            </svg>
            <p>选择或添加一个提供商</p>
        </div>
    `;
}

/**
 * 切换提供商启用状态
 */
async function toggleProviderEnabled(providerId) {
    const provider = state.providers.find((p) => p.id === providerId);
    if (!provider) return;

    provider.enabled = !provider.enabled;
    updateProvider(providerId, { enabled: provider.enabled });

    renderProvidersList();

    if (getSelectedProviderId() === providerId) {
        const showForm = await getShowProviderForm();
        showForm(providerId);
    }

    eventBus.emit('ui:notification', {
        message: `${provider.name} 已${provider.enabled ? '启用' : '禁用'}`,
        type: 'success'
    });
}

/**
 * 移动端：切换到详情视图
 */
export function showMobileDetail() {
    if (window.innerWidth <= 768) {
        document.querySelector('.providers-modal-content')?.classList.add('mobile-detail-view');
    }
}

/**
 * 移动端：返回列表视图
 */
export function backToProviderList() {
    document.querySelector('.providers-modal-content')?.classList.remove('mobile-detail-view');
}
