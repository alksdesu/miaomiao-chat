/**
 * 安卓返回键分发
 *
 * 当前方案只按界面层分发，不按浏览器历史分发。
 * 即使 `backButton` 事件携带 `canGoBack`，这里也会显式忽略，
 * 因为本项目的“子页面”本质上都是各种弹层、详情层和表单层。
 *
 * 打开态映射：
 * - `.open`：`#mcp-settings-modal`、`#image-viewer-modal`、`#settings-panel`、`#sidebar`
 * - `.active`：`#providers-modal`、`#quick-messages-modal`、`#edit-quick-message-modal`、`#models-manage-modal`、`.tools-quick-selector`
 * - 计算样式可见：`#tool-manager-modal`、`#edit-model-modal`、`#tool-test-dialog-modal`、`#input-dialog-modal`、`#confirm-dialog-modal`、`#update-modal-overlay`、`#openclaw-cron-overlay`、`#openclaw-approval-overlay`
 * - 动态创建：`#code-editor-modal`、`#fullscreen-preview-overlay`、`.tool-detail-modal`
 * - 动态高层对话框：`body` 直属 `.modal.active` 且没有 `id` 的节点，取最后追加的可见项
 */

import { isAndroid } from '../utils/platform.js';
import { showNotification } from './notifications.js';
import { logger } from '../utils/logger.js';

const ROOT_EXIT_WINDOW_MS = 2000;

let isInitialized = false;
let backButtonListenerHandle = null;
let lastRootBackAt = 0;

function isActuallyVisible(element) {
    if (!element || element.nodeType !== 1 || !element.isConnected) {
        return false;
    }

    const computedStyle = window.getComputedStyle(element);
    if (computedStyle.display === 'none' || computedStyle.visibility === 'hidden') {
        return false;
    }

    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
}

function isElementDisabled(element) {
    return element.hasAttribute('disabled') || ('disabled' in element && element.disabled === true);
}

function safeClick(selectors, root = document) {
    const selectorList = Array.isArray(selectors) ? selectors : [selectors];

    for (const selector of selectorList) {
        const candidates = Array.from(root.querySelectorAll(selector));

        for (const element of candidates) {
            if (!isActuallyVisible(element) || isElementDisabled(element)) {
                continue;
            }

            element.click();
            return true;
        }
    }

    return false;
}

function getTopDynamicDialog() {
    const dialogs = Array.from(document.body.children).filter((child) => {
        return child.matches?.('.modal.active:not([id])') && isActuallyVisible(child);
    });

    return dialogs.length > 0 ? dialogs[dialogs.length - 1] : null;
}

function markLayerHandled() {
    lastRootBackAt = 0;
    return true;
}

async function dispatchAndroidBack() {
    const fullscreenPreviewOverlay = document.getElementById('fullscreen-preview-overlay');
    if (
        isActuallyVisible(fullscreenPreviewOverlay) &&
        safeClick('.fullscreen-preview-close', fullscreenPreviewOverlay)
    ) {
        return markLayerHandled();
    }

    const inputDialog = document.getElementById('input-dialog-modal');
    if (
        isActuallyVisible(inputDialog) &&
        safeClick(['#input-dialog-cancel', '#close-input-dialog'], inputDialog)
    ) {
        return markLayerHandled();
    }

    const confirmDialog = document.getElementById('confirm-dialog-modal');
    if (
        isActuallyVisible(confirmDialog) &&
        safeClick(['#confirm-dialog-cancel', '#close-confirm-dialog'], confirmDialog)
    ) {
        return markLayerHandled();
    }

    const topDynamicDialog = getTopDynamicDialog();
    if (
        topDynamicDialog &&
        safeClick(
            [
                '#json-paste-cancel',
                '#import-cancel',
                '#template-cancel',
                '#cancel-edit-key',
                '.modal-close',
                '.modal-overlay'
            ],
            topDynamicDialog
        )
    ) {
        return markLayerHandled();
    }

    const codeEditorModal = document.getElementById('code-editor-modal');
    if (
        isActuallyVisible(codeEditorModal) &&
        safeClick(['.close-modal-btn', '.cancel-btn'], codeEditorModal)
    ) {
        return markLayerHandled();
    }

    const toolDetailModal = document.querySelector('.tool-detail-modal');
    if (
        isActuallyVisible(toolDetailModal) &&
        safeClick('.tool-detail-close-btn', toolDetailModal)
    ) {
        return markLayerHandled();
    }

    const toolTestDialog = document.getElementById('tool-test-dialog-modal');
    if (
        isActuallyVisible(toolTestDialog) &&
        safeClick(['#close-tool-test-dialog', '#tool-test-close-btn'], toolTestDialog)
    ) {
        return markLayerHandled();
    }

    const editQuickMessageModal = document.getElementById('edit-quick-message-modal');
    if (
        editQuickMessageModal?.classList.contains('active') &&
        isActuallyVisible(editQuickMessageModal) &&
        safeClick(['#cancel-edit-qm-btn', '#close-edit-qm-modal'], editQuickMessageModal)
    ) {
        return markLayerHandled();
    }

    const editModelModal = document.getElementById('edit-model-modal');
    if (
        isActuallyVisible(editModelModal) &&
        safeClick(['#cancel-edit-model', '#close-edit-model'], editModelModal)
    ) {
        return markLayerHandled();
    }

    const modelsManageModal = document.getElementById('models-manage-modal');
    if (
        modelsManageModal?.classList.contains('active') &&
        isActuallyVisible(modelsManageModal) &&
        safeClick(['#close-models-manage', '#cancel-models-manage'], modelsManageModal)
    ) {
        return markLayerHandled();
    }

    const providersModal = document.getElementById('providers-modal');
    const providersContent = document.querySelector('.providers-modal-content');
    if (
        providersModal?.classList.contains('active') &&
        isActuallyVisible(providersModal) &&
        providersContent?.classList.contains('mobile-detail-view') &&
        safeClick('#mobile-back-btn', providersModal)
    ) {
        return markLayerHandled();
    }

    const toolManagerModal = document.getElementById('tool-manager-modal');
    const toolManagerContent = document.querySelector('.tool-manager-content');
    if (
        isActuallyVisible(toolManagerModal) &&
        toolManagerContent?.classList.contains('mobile-detail-view') &&
        safeClick('#tool-mobile-back-btn', toolManagerModal)
    ) {
        return markLayerHandled();
    }

    const mcpSettingsModal = document.getElementById('mcp-settings-modal');
    if (
        mcpSettingsModal?.classList.contains('open') &&
        isActuallyVisible(mcpSettingsModal) &&
        safeClick('#mcp-cancel-server-btn', mcpSettingsModal)
    ) {
        return markLayerHandled();
    }

    const quickMessagesModal = document.getElementById('quick-messages-modal');
    if (
        quickMessagesModal?.classList.contains('active') &&
        isActuallyVisible(quickMessagesModal) &&
        safeClick('#close-quick-messages-modal', quickMessagesModal)
    ) {
        return markLayerHandled();
    }

    const toolsQuickSelector = document.querySelector('.tools-quick-selector');
    if (
        toolsQuickSelector?.classList.contains('active') &&
        isActuallyVisible(toolsQuickSelector) &&
        safeClick('.close-selector', toolsQuickSelector)
    ) {
        return markLayerHandled();
    }

    if (
        isActuallyVisible(toolManagerModal) &&
        safeClick(['.close-tool-manager', '.mobile-close-tools'], toolManagerModal)
    ) {
        return markLayerHandled();
    }

    if (
        providersModal?.classList.contains('active') &&
        isActuallyVisible(providersModal) &&
        safeClick(['#close-providers-modal', '#mobile-close-providers'], providersModal)
    ) {
        return markLayerHandled();
    }

    if (
        mcpSettingsModal?.classList.contains('open') &&
        isActuallyVisible(mcpSettingsModal) &&
        safeClick('.close-mcp-settings', mcpSettingsModal)
    ) {
        return markLayerHandled();
    }

    const updateModalOverlay = document.getElementById('update-modal-overlay');
    if (
        isActuallyVisible(updateModalOverlay) &&
        safeClick('#update-modal-close', updateModalOverlay)
    ) {
        return markLayerHandled();
    }

    const openclawCronOverlay = document.getElementById('openclaw-cron-overlay');
    if (
        isActuallyVisible(openclawCronOverlay) &&
        safeClick('#openclaw-cron-close', openclawCronOverlay)
    ) {
        return markLayerHandled();
    }

    const openclawApprovalOverlay = document.getElementById('openclaw-approval-overlay');
    if (isActuallyVisible(openclawApprovalOverlay)) {
        showNotification('请明确选择允许或拒绝', 'info');
        return markLayerHandled();
    }

    const imageViewerModal = document.getElementById('image-viewer-modal');
    if (imageViewerModal?.classList.contains('open') && isActuallyVisible(imageViewerModal)) {
        window.closeImageViewer?.();
        return markLayerHandled();
    }

    const settingsPanel = document.getElementById('settings-panel');
    if (settingsPanel?.classList.contains('open') && isActuallyVisible(settingsPanel)) {
        const { toggleSettings } = await import('./settings.js');
        toggleSettings();
        return markLayerHandled();
    }

    const mobileOverflowMenu = document.getElementById('mobile-overflow-menu');
    if (mobileOverflowMenu?.classList.contains('open') && isActuallyVisible(mobileOverflowMenu)) {
        mobileOverflowMenu.classList.remove('open');
        return markLayerHandled();
    }

    const sidebar = document.getElementById('sidebar');
    if (sidebar?.classList.contains('open') && isActuallyVisible(sidebar)) {
        const { toggleSidebar } = await import('./sidebar.js');
        await toggleSidebar();
        return markLayerHandled();
    }

    const cancelEditButton = document.getElementById('cancel-edit');
    if (
        cancelEditButton?.classList.contains('show') &&
        isActuallyVisible(cancelEditButton) &&
        safeClick('#cancel-edit')
    ) {
        return markLayerHandled();
    }

    return false;
}

async function handleRootBackAction() {
    const now = Date.now();
    const appPlugin = window.Capacitor?.Plugins?.App;

    if (now - lastRootBackAt <= ROOT_EXIT_WINDOW_MS) {
        await appPlugin?.exitApp?.();
        return true;
    }

    lastRootBackAt = now;
    showNotification('再按一次退出应用', 'info', ROOT_EXIT_WINDOW_MS);
    return true;
}

async function handleAndroidBackButton(event) {
    try {
        // 当前返回完全按界面层分发，不按浏览器历史分发。
        void event?.canGoBack;

        const handled = await dispatchAndroidBack();
        if (handled) {
            return;
        }

        await handleRootBackAction();
    } catch (error) {
        logger.error('[Android Back] 返回处理失败:', error);
    }
}

export async function initAndroidBackHandler() {
    if (!isAndroid()) {
        return false;
    }

    if (isInitialized || backButtonListenerHandle) {
        return true;
    }

    const appPlugin = window.Capacitor?.Plugins?.App;
    if (!appPlugin?.addListener) {
        logger.warn('[Android Back] Capacitor App 插件不可用，跳过返回监听初始化');
        return false;
    }

    isInitialized = true;

    try {
        backButtonListenerHandle = await appPlugin.addListener(
            'backButton',
            handleAndroidBackButton
        );
        logger.debug('[Android Back] 安卓返回监听已初始化');
        return true;
    } catch (error) {
        isInitialized = false;
        logger.error('[Android Back] 初始化失败:', error);
        return false;
    }
}
