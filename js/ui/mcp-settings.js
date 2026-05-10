/**
 * MCP 服务器配置 UI - 入口模块
 * 负责初始化、模态框管理、事件绑定编排
 * 具体逻辑拆分到 mcp-server-list / mcp-server-form / mcp-tool-display
 */

import { state } from '../core/state.js';
import { eventBus } from '../core/events.js';
import { showConfirmDialog } from '../utils/dialogs.js';
import { showNotification } from './notifications.js';
import { setMcpServers } from '../core/state-mutations.js';
import { getIcon } from '../utils/icons.js';
import { bindTopmostEscape } from '../utils/modal-stack.js';

// 子模块
import { renderServerList, renderPlatformInfo } from './mcp-server-list.js';
import {
    showServerForm,
    hideServerForm,
    handleSaveServer,
    toggleConfigSection
} from './mcp-server-form.js';
import {
    exportMCPConfig,
    importMCPConfig,
    showTemplateDialog,
    createFromTemplate
} from './mcp-tool-display.js';
import { logger } from '../utils/logger.js';

// re-export 供外部使用
export { exportMCPConfig, importMCPConfig, showTemplateDialog, createFromTemplate };

// 模态框相关变量
let modal = null;
let isFormOpen = false;
let removeFocusTrap = null;
let removeModalEscape = null;
let isInitialized = false;

/**
 * 设置表单开启状态的回调（供子模块调用）
 * @param {boolean} open
 */
function setFormOpen(open) {
    isFormOpen = open;
}

/**
 * 创建焦点陷阱 - WCAG 2.4.3 合规
 * @param {HTMLElement} container - 容器元素
 * @returns {Function} 移除焦点陷阱的函数
 */
function createFocusTrap(container) {
    if (!container) return () => {};

    const focusableSelector =
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

    function handleTab(e) {
        if (e.key !== 'Tab') return;

        const focusableElements = container.querySelectorAll(focusableSelector);
        const firstElement = focusableElements[0];
        const lastElement = focusableElements[focusableElements.length - 1];

        if (e.shiftKey) {
            if (document.activeElement === firstElement) {
                e.preventDefault();
                lastElement?.focus();
            }
        } else {
            if (document.activeElement === lastElement) {
                e.preventDefault();
                firstElement?.focus();
            }
        }
    }

    container.addEventListener('keydown', handleTab);

    return () => {
        container.removeEventListener('keydown', handleTab);
    };
}

// ========== 初始化 ==========

/**
 * 初始化 MCP 设置 UI
 */
export function initMCPSettings() {
    if (isInitialized) {
        logger.debug('[MCP Settings] 已初始化，跳过');
        return;
    }

    logger.debug('[MCP Settings] 初始化...');

    modal = document.getElementById('mcp-settings-modal');
    if (!modal) {
        logger.error('[MCP Settings] 未找到模态框 #mcp-settings-modal');
        return;
    }

    const toggleBtn = document.getElementById('mcp-settings-toggle');
    if (toggleBtn) {
        toggleBtn.addEventListener('click', openModal);
    } else {
        logger.warn('[MCP Settings] 未找到触发按钮 #mcp-settings-toggle');
    }

    setupModalEvents();
    bindFormEvents();
    setupEventListeners();

    if (!state.mcpServers) {
        setMcpServers([]);
    }

    isInitialized = true;
    logger.debug('[MCP Settings] 初始化完成');
}

/**
 * 设置模态框事件
 */
function setupModalEvents() {
    const closeBtn = modal.querySelector('.close-mcp-settings');
    if (closeBtn) {
        closeBtn.addEventListener('click', closeModal);
    }

    modal.addEventListener('click', (e) => {
        if (e.target === modal) closeModal();
    });
}

/**
 * 打开模态框
 */
export function openModal() {
    if (!modal) return;
    modal.classList.add('open');
    renderPlatformInfo(modal);
    renderServerList(modal);

    removeFocusTrap = createFocusTrap(modal);

    removeModalEscape?.();
    removeModalEscape = bindTopmostEscape(modal, () => {
        if (isFormOpen) hideServerForm(modal, setFormOpen);
        else closeModal();
    });
}

/**
 * 关闭模态框
 */
export function closeModal() {
    if (!modal) return;

    if (isFormOpen) {
        showConfirmDialog('表单未保存，确定关闭吗？').then((confirmed) => {
            if (confirmed) {
                hideServerForm(modal, setFormOpen);
                modal.classList.remove('open');

                if (removeFocusTrap) {
                    removeFocusTrap();
                    removeFocusTrap = null;
                }

                removeModalEscape?.();
                removeModalEscape = null;
            }
        });
    } else {
        modal.classList.remove('open');

        if (removeFocusTrap) {
            removeFocusTrap();
            removeFocusTrap = null;
        }

        removeModalEscape?.();
        removeModalEscape = null;
    }
}

/**
 * 绑定表单相关事件（事件委托）
 */
function bindFormEvents() {
    modal.addEventListener('click', (e) => {
        if (e.target.id === 'mcp-add-server-btn' || e.target.closest('#mcp-add-server-btn')) {
            showServerForm(modal, setFormOpen);
        } else if (
            e.target.id === 'mcp-save-server-btn' ||
            e.target.closest('#mcp-save-server-btn')
        ) {
            handleSaveServer(modal, setFormOpen);
        } else if (
            e.target.id === 'mcp-cancel-server-btn' ||
            e.target.closest('#mcp-cancel-server-btn')
        ) {
            hideServerForm(modal, setFormOpen);
        } else if (
            e.target.id === 'mcp-import-config-btn' ||
            e.target.closest('#mcp-import-config-btn')
        ) {
            importMCPConfig(modal);
        } else if (
            e.target.id === 'mcp-export-config-btn' ||
            e.target.closest('#mcp-export-config-btn')
        ) {
            exportMCPConfig();
        } else if (e.target.id === 'mcp-template-btn' || e.target.closest('#mcp-template-btn')) {
            showTemplateDialog(modal);
        }
    });

    modal.addEventListener('change', (e) => {
        if (e.target.id === 'mcp-server-type') {
            const isLocal = e.target.value === 'local';
            toggleConfigSection(modal, isLocal);
        }
    });
}

/**
 * 设置事件总线监听器
 */
function setupEventListeners() {
    eventBus.on('mcp:connected', () => {
        renderServerList(modal);
    });

    eventBus.on('mcp:disconnected', () => {
        renderServerList(modal);
    });

    eventBus.on('mcp:tools-discovered', () => {
        renderServerList(modal);
    });

    eventBus.on('mcp:connection-lost', (data) => {
        logger.warn(`[MCP Settings] 连接丢失: ${data.serverName}`);
        showNotification(
            `${getIcon('alertCircle', { size: 14 })} ${data.serverName} 连接断开，将在 5 秒后自动重连...`,
            'warning'
        );
        renderServerList(modal);
    });

    eventBus.on('mcp:reconnect-failed', (data) => {
        logger.error(`[MCP Settings] 自动重连失败: ${data.serverName}`);
        showNotification(
            `${getIcon('xCircle', { size: 14 })} ${data.serverName} 自动重连失败，请手动重试`,
            'error'
        );
        renderServerList(modal);
    });

    if (window.electron) {
        eventBus.on('mcp:server-restarting', (data) => {
            logger.debug(`[MCP Settings] 服务器重启中: ${data.serverId} (尝试 ${data.attempt})`);
            showNotification(
                `${getIcon('loader', { size: 14 })} MCP 服务器正在重启... (${data.attempt}/3)`,
                'info'
            );
        });

        eventBus.on('mcp:server-restarted', (data) => {
            logger.debug(`[MCP Settings] 服务器重启成功: ${data.serverId}`);
            showNotification(
                `${getIcon('checkCircle', { size: 14 })} MCP 服务器已自动恢复`,
                'success'
            );
            renderServerList(modal);
        });

        eventBus.on('mcp:server-restart-failed', (data) => {
            logger.error(`[MCP Settings] 服务器重启失败: ${data.serverId}`);
            showNotification(
                `${getIcon('xCircle', { size: 14 })} MCP 服务器重启失败，请手动重新连接`,
                'error'
            );
            renderServerList(modal);
        });

        eventBus.on('mcp:restart-limit-exceeded', (data) => {
            logger.error(`[MCP Settings] 达到重启上限: ${data.serverId}`);
            showNotification(
                `${getIcon('xCircle', { size: 14 })} MCP 服务器频繁崩溃，已停止自动重启`,
                'error'
            );
            renderServerList(modal);
        });
    }
}

logger.debug('[MCP Settings] MCP 配置 UI 模块已加载');
