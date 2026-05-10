/**
 * 工具调用管理界面 - 入口编排模块
 * 委托列表渲染到 tool-manager-list.js，配置编辑到 tool-manager-config.js
 */

import { eventBus } from '../core/events.js';
import { showConfirmDialog } from '../utils/dialogs.js';
import { bindTopmostEscape, setupModalFocus } from '../utils/modal-stack.js';
import {
    renderToolsList as _renderToolsList,
    handleToolSearch as _handleToolSearch
} from './tool-manager-list.js';
import {
    showToolForm as _showToolForm,
    showEmptyState as _showEmptyState,
    handleValidateSchema as _handleValidateSchema,
    handleTestTool as _handleTestTool,
    handleDeleteTool as _handleDeleteTool,
    handleSaveTool as _handleSaveTool,
    loadPermissionsTab,
    loadHistoryTab,
    getTestDialogCleanup
} from './tool-manager-config.js';
import { logger } from '../utils/logger.js';

// re-export 拆分模块的公共 API
export { renderToolsList } from './tool-manager-list.js';
export { handleToolSearch } from './tool-manager-list.js';
export {
    showToolForm,
    showEmptyState,
    handleValidateSchema,
    handleTestTool,
    handleDeleteTool,
    handleSaveTool,
    loadPermissionsTab,
    loadHistoryTab
} from './tool-manager-config.js';

// ========== 模块状态 ==========

let modal = null;
let selectedToolId = null;
let isEditing = false;
let removeFocusTrap = null;
let removeModalEscape = null;

// ========== 初始化 ==========

/**
 * 初始化工具管理界面
 */
export function initToolManager() {
    logger.debug('[Tool Manager] 初始化工具管理界面...');

    createModal();

    const toggleBtn = document.getElementById('tools-manager-toggle');
    if (toggleBtn) {
        toggleBtn.addEventListener('click', openModal);
    }

    setupEventListeners();

    document.getElementById('tool-mobile-back-btn')?.addEventListener('click', backToToolList);

    document.querySelectorAll('.mobile-close-tools').forEach((btn) => {
        btn.addEventListener('click', closeModal);
    });

    logger.debug('[Tool Manager] 工具管理界面已初始化');
}

/**
 * 创建模态框 DOM，绑定基础事件
 */
function createModal() {
    modal = document.getElementById('tool-manager-modal');
    if (!modal) {
        logger.error('[Tool Manager] 未找到模态框元素 #tool-manager-modal');
        return;
    }

    const closeBtn = modal.querySelector('.close-tool-manager');
    const tabBtns = modal.querySelectorAll('.tab-btn');
    const searchInput = modal.querySelector('#tool-search-input');
    const addCustomBtn = modal.querySelector('#add-custom-tool-btn');

    if (closeBtn) {
        closeBtn.addEventListener('click', closeModal);
    }

    tabBtns.forEach((btn) => {
        btn.addEventListener('click', () => handleTabSwitch(btn.dataset.tab));
    });

    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            closeModal();
        }
    });

    if (searchInput) {
        searchInput.addEventListener('input', (e) => _handleToolSearch(modal, e));
    }

    if (addCustomBtn) {
        addCustomBtn.addEventListener('click', handleAddCustomTool);
    }

    bindFormButtons();
}

/**
 * 绑定表单按钮事件
 */
function bindFormButtons() {
    const validateBtn = modal.querySelector('#validate-schema-btn');
    if (validateBtn) {
        validateBtn.addEventListener('click', () => _handleValidateSchema(modal));
    }

    const testBtn = modal.querySelector('#test-tool-btn');
    if (testBtn) {
        testBtn.addEventListener('click', () => _handleTestTool(selectedToolId));
    }

    const deleteBtn = modal.querySelector('#delete-tool-btn');
    if (deleteBtn) {
        deleteBtn.addEventListener('click', () =>
            _handleDeleteTool(selectedToolId, () => {
                showEmpty();
                refreshList();
            })
        );
    }

    const cancelBtn = modal.querySelector('#cancel-tool-btn');
    if (cancelBtn) {
        cancelBtn.addEventListener('click', handleCancelEdit);
    }

    const saveBtn = modal.querySelector('#save-tool-btn');
    if (saveBtn) {
        saveBtn.addEventListener('click', () =>
            _handleSaveTool(modal, selectedToolId, () => {
                isEditing = false;
                refreshList();
                selectTool(selectedToolId);
            })
        );
    }
}

/**
 * 设置事件监听器
 */
function setupEventListeners() {
    eventBus.on('tool:registered', refreshList);
    eventBus.on('tool:enabled:changed', refreshList);
    eventBus.on('tool:removed', refreshList);
    eventBus.on('tools:updated', refreshList);
    eventBus.on('tools:manage:open', openModal);
}

// ========== 内部辅助 ==========

function refreshList() {
    _renderToolsList(modal, selectedToolId, selectTool);
}

function showEmpty() {
    _showEmptyState(modal);
    selectedToolId = null;
    isEditing = false;
}

// ========== 模态框控制 ==========

function finalizeModalClose() {
    getTestDialogCleanup()?.();
    modal.classList.remove('active');
    showEmpty();
    modal.querySelector('.tool-manager-content')?.classList.remove('mobile-detail-view');

    if (removeFocusTrap) {
        removeFocusTrap();
        removeFocusTrap = null;
    }

    removeModalEscape?.();
    removeModalEscape = null;

    logger.debug('[Tool Manager] 关闭工具管理界面');
}

/**
 * 打开模态框
 */
export function openModal() {
    if (!modal) return;

    modal.classList.add('active');
    refreshList();
    showEmpty();

    removeFocusTrap?.();
    removeFocusTrap = setupModalFocus(modal, {
        labelledBy: 'tool-manager-title',
        initialFocus: '#tool-search-input'
    });

    removeModalEscape?.();
    removeModalEscape = bindTopmostEscape(modal, closeModal);

    eventBus.emit('tool-manager:opened');
    logger.debug('[Tool Manager] 打开工具管理界面');
}

/**
 * 关闭模态框
 */
export function closeModal() {
    if (!modal) return;

    if (isEditing) {
        showConfirmDialog('有未保存的更改，确定要关闭吗？', '确认关闭').then((confirmed) => {
            if (confirmed) {
                finalizeModalClose();
            }
        });
    } else {
        finalizeModalClose();
    }
}

function showMobileToolDetail() {
    if (window.innerWidth <= 768 && modal) {
        modal.querySelector('.tool-manager-content')?.classList.add('mobile-detail-view');
    }
}

function backToToolList() {
    modal?.querySelector('.tool-manager-content')?.classList.remove('mobile-detail-view');
}

// ========== 工具选择 ==========

/**
 * 选择工具
 */
export function selectTool(toolId) {
    selectedToolId = toolId;

    modal.querySelectorAll('.tool-item').forEach((item) => {
        item.classList.toggle('selected', item.dataset.toolId === toolId);
    });

    const callbacks = {
        onEditingChange: (val) => {
            isEditing = val;
        },
        showEmptyState: showEmpty,
        bindFormButtons
    };

    _showToolForm(modal, toolId, callbacks);
    showMobileToolDetail();
}

// ========== 新建自定义工具 ==========

function handleAddCustomTool() {
    selectedToolId = `custom_${Date.now()}`;

    const newTool = {
        id: selectedToolId,
        name: '',
        description: '',
        type: 'custom',
        parameters: {
            type: 'object',
            properties: {},
            required: []
        },
        enabled: true
    };

    const callbacks = {
        onEditingChange: (val) => {
            isEditing = val;
        },
        showEmptyState: showEmpty,
        bindFormButtons
    };

    _showToolForm(modal, newTool, callbacks);
    showMobileToolDetail();

    logger.debug('[Tool Manager] 创建新工具');
}

// ========== 取消编辑 ==========

function handleCancelEdit() {
    if (isEditing) {
        showConfirmDialog('有未保存的更改，确定要取消吗？', '确认取消').then((confirmed) => {
            if (confirmed) {
                showEmpty();
            }
        });
    } else {
        showEmpty();
    }
}

// ========== Tab 切换 ==========

function handleTabSwitch(tabId) {
    if (!modal) return;

    modal.querySelector('.tool-manager-content')?.classList.remove('mobile-detail-view');

    modal.querySelectorAll('.tab-btn').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.tab === tabId);
    });

    modal.querySelectorAll('.tab-content').forEach((content) => {
        content.classList.toggle('active', content.dataset.tab === tabId);
    });

    logger.debug(`[Tool Manager] 切换到 Tab: ${tabId}`);

    if (tabId === 'permissions') {
        loadPermissionsTab();
    } else if (tabId === 'history') {
        loadHistoryTab();
    }
}

// ========== 重置 ==========

function _resetForm() {
    selectedToolId = null;
    isEditing = false;
    showEmpty();
}

logger.debug('[Tool Manager] 工具管理 UI 模块已加载');
