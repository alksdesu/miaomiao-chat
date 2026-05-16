/**
 * 更新弹窗模块
 * 处理自定义样式的更新提示弹窗
 */

import { logger } from '../utils/logger.js';
import { showNotification } from '../ui/notifications.js';
import { isAndroid, isElectron } from '../utils/platform.js';
import { bindTopmostEscape } from '../utils/modal-stack.js';

const DEFAULT_RELEASE_NOTES = '建议您更新到最新版本以获得更好的体验';
const DEFAULT_PROGRESS_TEXT = '正在下载... 0%';

let modalInitialized = false;
let modalCleanupCallbacks = [];
let modalSubscriptions = [];
let autoHideTimer = null;
let modalState = createInitialModalState();

function createInitialModalState() {
    return {
        visible: false,
        phase: 'prompt',
        updateInfo: null,
        progressPercent: 0,
        progressText: DEFAULT_PROGRESS_TEXT
    };
}

function addManagedListener(target, eventName, handler, options) {
    if (!target) {
        return;
    }

    target.addEventListener(eventName, handler, options);
    modalCleanupCallbacks.push(() => {
        target.removeEventListener(eventName, handler, options);
    });
}

function clearAutoHideTimer() {
    if (!autoHideTimer) {
        return;
    }

    clearTimeout(autoHideTimer);
    autoHideTimer = null;
}

function getModalElements() {
    return {
        overlay: document.getElementById('update-modal-overlay'),
        closeBtn: document.getElementById('update-modal-close'),
        versionEl: document.getElementById('update-modal-version'),
        descriptionEl: document.getElementById('update-modal-description'),
        actionsContainer: document.querySelector('.update-modal-actions'),
        progressContainer: document.getElementById('update-progress-container'),
        progressFill: document.getElementById('update-progress-fill'),
        progressText: document.getElementById('update-progress-text')
    };
}

function normalizeReleaseNotes(releaseNotes) {
    if (typeof releaseNotes === 'string' && releaseNotes.trim()) {
        return releaseNotes;
    }

    if (Array.isArray(releaseNotes)) {
        const flattenedNotes = releaseNotes
            .map((item) => item?.note || item?.releaseNotes || '')
            .filter(Boolean);
        return flattenedNotes.join('\n\n') || DEFAULT_RELEASE_NOTES;
    }

    return DEFAULT_RELEASE_NOTES;
}

function normalizeUpdateInfo(info = null) {
    if (!info || typeof info !== 'object') {
        return null;
    }

    return {
        version: info.version || '',
        releaseNotes: normalizeReleaseNotes(info.releaseNotes)
    };
}

function buildPromptActionsMarkup() {
    if (isAndroid()) {
        return `
            <button type="button" class="update-btn update-btn-primary" id="update-now-btn" data-update-action="update-now">
                立刻更新
            </button>
        `;
    }

    return `
        <button type="button" class="update-btn update-btn-primary" id="update-now-btn" data-update-action="update-now">
            立刻更新
        </button>
        <button type="button" class="update-btn update-btn-secondary" id="update-silent-btn" data-update-action="update-silent">
            静默更新
        </button>
    `;
}

function buildDownloadedActionsMarkup() {
    if (!isElectron()) {
        return '';
    }

    return `
        <button type="button" class="update-btn update-btn-primary" id="install-restart-btn" data-update-action="install-now">
            立即重启安装
        </button>
        <button type="button" class="update-btn update-btn-secondary" id="install-later-btn" data-update-action="install-later">
            稍后安装
        </button>
    `;
}

function renderActions(actionsContainer) {
    if (!actionsContainer) {
        return;
    }

    if (modalState.phase === 'downloading') {
        actionsContainer.style.display = 'none';
        return;
    }

    const renderKey = `${modalState.phase}:${isAndroid() ? 'android' : 'electron'}`;
    if (actionsContainer.dataset.renderKey !== renderKey) {
        // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
        actionsContainer.innerHTML =
            modalState.phase === 'downloaded'
                ? buildDownloadedActionsMarkup()
                : buildPromptActionsMarkup();
        actionsContainer.dataset.renderKey = renderKey;
    }

    actionsContainer.style.display = actionsContainer.innerHTML.trim() ? 'flex' : 'none';
}

function renderProgress(progressContainer, progressFill, progressText) {
    if (progressContainer) {
        progressContainer.style.display = modalState.phase === 'downloading' ? 'block' : 'none';
    }

    if (progressFill) {
        progressFill.style.width = `${Math.max(0, Math.min(100, Math.round(modalState.progressPercent)))}%`;
    }

    if (progressText) {
        progressText.textContent = modalState.progressText;
    }
}

function renderModalState() {
    const {
        overlay,
        versionEl,
        descriptionEl,
        actionsContainer,
        progressContainer,
        progressFill,
        progressText
    } = getModalElements();

    if (!overlay) {
        return;
    }

    const info = normalizeUpdateInfo(modalState.updateInfo);

    if (versionEl) {
        versionEl.textContent = info?.version ? `v${info.version}` : '';
    }

    if (descriptionEl) {
        descriptionEl.textContent = info?.releaseNotes || DEFAULT_RELEASE_NOTES;
    }

    overlay.style.display = modalState.visible ? 'flex' : 'none';
    renderActions(actionsContainer);
    renderProgress(progressContainer, progressFill, progressText);
}

function setModalState(nextState) {
    modalState = {
        ...modalState,
        ...nextState
    };
    renderModalState();
}

function resetModalState(options = {}) {
    const nextInfo = Object.prototype.hasOwnProperty.call(options, 'updateInfo')
        ? normalizeUpdateInfo(options.updateInfo)
        : modalState.updateInfo;
    const nextVisible = options.visible === true;

    clearAutoHideTimer();
    modalState = {
        ...createInitialModalState(),
        visible: nextVisible,
        updateInfo: nextInfo
    };
    renderModalState();
}

function handleCloseRequest() {
    logger.debug('[UpdateModal] 用户选择：暂不更新');
    hideUpdateModal();
}

function handleOverlayClick(event) {
    const { overlay } = getModalElements();
    if (event.target === overlay) {
        hideUpdateModal();
    }
}

async function handleAndroidUpdateNow() {
    logger.debug('[UpdateModal] Android: 用户选择立刻更新');
    showProgress();

    try {
        const { downloadAndInstallAPK } = await import('./apk-updater.js');
        const currentUpdateInfo = window._currentUpdateInfo;

        if (!currentUpdateInfo?.downloadUrl || !currentUpdateInfo?.fileName) {
            showNotification('更新信息不可用，请重试', 'error');
            hideUpdateModal();
            return;
        }

        await downloadAndInstallAPK(
            currentUpdateInfo.downloadUrl,
            currentUpdateInfo.fileName,
            (progress) => {
                if (progress.status === 'downloading') {
                    updateProgress(progress.percent);
                    return;
                }

                if (progress.status === 'downloaded') {
                    setModalState({
                        progressPercent: 100,
                        progressText: '下载完成，准备安装...'
                    });
                    clearAutoHideTimer();
                    autoHideTimer = setTimeout(() => {
                        hideUpdateModal();
                    }, 3000);
                    return;
                }

                if (progress.status === 'error') {
                    showNotification(`更新失败: ${progress.error}`, 'error');
                    hideUpdateModal();
                }
            }
        );
    } catch (error) {
        logger.error('[UpdateModal] Android 更新异常:', error);
        showNotification(`更新失败: ${error.message || '未知错误'}`, 'error');
        hideUpdateModal();
    }
}

function handleElectronUpdateNow() {
    logger.debug('[UpdateModal] 用户选择：立刻更新');
    showProgress();
    window.electronAPI?.downloadUpdate?.();
}

function handleElectronSilentUpdate() {
    logger.debug('[UpdateModal] 用户选择：静默更新');
    hideUpdateModal();
    window.electronAPI?.downloadUpdateSilent?.();
}

function handleInstallNow() {
    logger.debug('[UpdateModal] 用户选择：立即重启安装');
    window.electronAPI?.installUpdateAndRestart?.();
}

function handleInstallLater() {
    logger.debug('[UpdateModal] 用户选择：稍后安装');
    hideUpdateModal();
}

async function handleActionClick(event) {
    const actionButton = event.target.closest('[data-update-action]');
    if (!actionButton) {
        return;
    }

    const action = actionButton.dataset.updateAction;
    switch (action) {
        case 'update-now':
            if (isAndroid()) {
                await handleAndroidUpdateNow();
            } else {
                handleElectronUpdateNow();
            }
            break;
        case 'update-silent':
            handleElectronSilentUpdate();
            break;
        case 'install-now':
            handleInstallNow();
            break;
        case 'install-later':
            handleInstallLater();
            break;
        default:
            break;
    }
}

function handleElectronUpdateAvailable(info) {
    logger.debug('[UpdateModal] 收到更新可用事件:', info);
    showUpdateModal(info);
}

function handleElectronUpdateProgress(progress) {
    if (!modalState.visible || modalState.phase !== 'downloading') {
        return;
    }

    logger.debug('[UpdateModal] 下载进度:', `${progress.percent}%`);
    updateProgress(progress.percent);
}

function handleElectronUpdateDownloaded(info) {
    logger.debug('[UpdateModal] 更新下载完成:', info);

    if (!modalState.visible || modalState.phase !== 'downloading') {
        resetModalState({
            visible: false,
            updateInfo: info || modalState.updateInfo
        });
        return;
    }

    setModalState({
        phase: 'downloaded',
        updateInfo: normalizeUpdateInfo(info) || modalState.updateInfo,
        progressPercent: 100,
        progressText: '下载完成！'
    });
}

function bindElectronSubscriptions() {
    if (!window.electronAPI) {
        return;
    }

    const handleElectronNotification = (data) => {
        if (!modalState.visible || modalState.phase !== 'downloading' || data?.type !== 'error') {
            return;
        }

        if (data.title === '更新失败' || data.title === '检查更新失败') {
            hideUpdateModal();
        }
    };

    const subscriptions = [
        window.electronAPI.onUpdateAvailable?.(handleElectronUpdateAvailable),
        window.electronAPI.onUpdateProgress?.(handleElectronUpdateProgress),
        window.electronAPI.onUpdateDownloaded?.(handleElectronUpdateDownloaded),
        window.electronAPI.onNotification?.(handleElectronNotification)
    ];

    subscriptions.forEach((unsubscribe) => {
        if (typeof unsubscribe === 'function') {
            modalSubscriptions.push(unsubscribe);
        }
    });
}

/**
 * 显示更新弹窗
 * @param {Object} info - 更新信息
 * @param {string} info.version - 新版本号
 * @param {string} info.releaseNotes - 更新说明
 */
export function showUpdateModal(info) {
    if (!modalInitialized) {
        initUpdateModal();
    }

    const normalizedInfo = normalizeUpdateInfo(info);
    setModalState({
        visible: true,
        phase: 'prompt',
        updateInfo: normalizedInfo,
        progressPercent: 0,
        progressText: DEFAULT_PROGRESS_TEXT
    });

    logger.debug('[UpdateModal] 显示更新弹窗:', normalizedInfo);
}

/**
 * 隐藏更新弹窗
 */
export function hideUpdateModal() {
    resetModalState({
        visible: false,
        updateInfo: modalState.updateInfo
    });
    logger.debug('[UpdateModal] 隐藏更新弹窗');
}

/**
 * 更新下载进度
 * @param {number} percent - 进度百分比 (0-100)
 */
export function updateProgress(percent) {
    setModalState({
        progressPercent: percent,
        progressText: `正在下载... ${Math.round(percent)}%`
    });
}

/**
 * 显示下载进度
 */
export function showProgress() {
    setModalState({
        phase: 'downloading',
        visible: true,
        progressPercent: 0,
        progressText: DEFAULT_PROGRESS_TEXT
    });
}

/**
 * 初始化更新弹窗
 */
export function initUpdateModal() {
    if (!isElectron() && !isAndroid()) {
        logger.debug('[UpdateModal] 非 Electron/Android 环境，跳过初始化');
        return false;
    }

    if (modalInitialized) {
        return true;
    }

    const { overlay, closeBtn, actionsContainer } = getModalElements();
    if (!overlay) {
        logger.error('[UpdateModal] 更新弹窗元素未找到');
        return false;
    }

    modalInitialized = true;

    addManagedListener(closeBtn, 'click', handleCloseRequest);
    addManagedListener(overlay, 'click', handleOverlayClick);
    addManagedListener(actionsContainer, 'click', handleActionClick);

    // Esc 关闭弹窗（downloading 阶段也允许：仅隐藏 UI，不取消下载）
    const unbindEscape = bindTopmostEscape(overlay, handleCloseRequest);
    modalCleanupCallbacks.push(unbindEscape);

    if (isElectron()) {
        bindElectronSubscriptions();
    }

    renderModalState();
    logger.debug(`[UpdateModal] ${isAndroid() ? 'Android' : 'Electron'} 更新弹窗已初始化`);
    return true;
}

export function cleanupUpdateModal() {
    modalSubscriptions.forEach((unsubscribe) => {
        if (typeof unsubscribe === 'function') {
            unsubscribe();
        }
    });
    modalSubscriptions = [];

    modalCleanupCallbacks.forEach((cleanup) => {
        cleanup();
    });
    modalCleanupCallbacks = [];

    clearAutoHideTimer();
    modalState = createInitialModalState();
    renderModalState();
    modalInitialized = false;
}
