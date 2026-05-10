/**
 * 提供商管理 UI 控制器（入口编排）
 * 实际逻辑分布在：
 *   provider-list.js   — 列表渲染
 *   provider-form.js   — 表单编辑
 *   key-manager-ui.js  — 密钥管理 UI
 *   model-selector.js  — 模型选择器
 */

import { logger } from '../utils/logger.js';
import { state } from '../core/state.js';
import { elements } from '../core/elements.js';
import { eventBus } from '../core/events.js';
import { bindTopmostEscape } from '../utils/modal-stack.js';
import { getSelectedProviderId, setSelectedProviderId } from './shared-state.js';
import {
    renderProvidersList,
    showEmptyState,
    showMobileDetail,
    backToProviderList
} from './provider-list.js';
import { showProviderForm } from './provider-form.js';
import { initModelSelectorEvents } from './model-selector.js';

// 从 shared-state.js 重导出，保持向后兼容
export { getSelectedProviderId, setSelectedProviderId } from './shared-state.js';

let removeProvidersModalEscape = null;

/**
 * 初始化提供商 UI
 */
export function initProvidersUI() {
    // 打开/关闭模态框
    elements.providersToggle?.addEventListener('click', openProvidersModal);
    elements.closeProvidersModal?.addEventListener('click', closeProvidersModal);
    elements.providersModal
        ?.querySelector('.modal-overlay')
        ?.addEventListener('click', closeProvidersModal);

    // 搜索
    elements.providersSearchInput?.addEventListener('input', renderProvidersList);

    // 添加按钮
    elements.addProviderBtn?.addEventListener('click', () => {
        showProviderForm(null);
        showMobileDetail();
    });

    // 移动端
    document.getElementById('mobile-back-btn')?.addEventListener('click', backToProviderList);
    document
        .getElementById('mobile-close-providers')
        ?.addEventListener('click', closeProvidersModal);

    // 监听提供商变更事件
    eventBus.on('providers:added', () => {
        renderProvidersList();
    });

    eventBus.on('providers:updated', () => {
        renderProvidersList();
        if (getSelectedProviderId()) {
            showProviderForm(getSelectedProviderId());
        }
    });

    eventBus.on('providers:deleted', ({ id }) => {
        renderProvidersList();
        if (getSelectedProviderId() === id) {
            setSelectedProviderId(null);
            showEmptyState();
        }
    });

    eventBus.on('providers:switched', () => {
        renderProvidersList();
    });

    // 模型编辑弹窗全局事件
    initModelSelectorEvents();

    logger.debug('Providers UI initialized (split layout)');
}

/**
 * 打开提供商模态框
 */
function openProvidersModal() {
    const modal = elements.providersModal;
    if (!modal) return;

    modal.classList.add('active');
    renderProvidersList();

    removeProvidersModalEscape?.();
    removeProvidersModalEscape = bindTopmostEscape(modal, closeProvidersModal);

    if (state.providers.length > 0) {
        const firstEnabled = state.providers.find((p) => p.enabled);
        setSelectedProviderId(firstEnabled ? firstEnabled.id : state.providers[0].id);
        showProviderForm(getSelectedProviderId());
    } else {
        showEmptyState();
    }
}

/**
 * 关闭提供商模态框
 */
function closeProvidersModal() {
    const modal = elements.providersModal;
    if (!modal) return;

    removeProvidersModalEscape?.();
    removeProvidersModalEscape = null;

    modal.classList.remove('active');
    setSelectedProviderId(null);
    modal.querySelector('.providers-modal-content')?.classList.remove('mobile-detail-view');
}
