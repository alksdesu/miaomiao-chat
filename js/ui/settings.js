/**
 * 设置面板模块
 * 处理设置面板的显示和交互
 */

import { state } from '../core/state.js';
import { elements } from '../core/elements.js';
import { eventBus } from '../core/events.js';
import { saveCurrentConfig } from '../state/config.js';
import { savePreference, loadPreference } from '../state/storage.js';
import { showNotification } from './notifications.js';
import { isElectron, isAndroid } from '../utils/platform.js';
import { checkForUpdatesManually } from '../update/apk-updater.js';
import { trapFocus, removeFocusTrap, acquireInert, releaseInert } from '../utils/focus-trap.js';
import { logger } from '../utils/logger.js';

let settingsInitialized = false;
let settingsCleanupCallbacks = [];
let settingsSubscriptions = [];

let updateSettingsInitialized = false;
let updateSettingsInitPromise = null;
let updateSettingsCleanupCallbacks = [];
let updateSettingsSubscriptions = [];
let cachedAppSettings = {};

let mobileAccordionMediaQuery = null;
let mobileAccordionChangeHandler = null;
let mobileAccordionBound = false;
let mobileAccordionApplied = false;

function addManagedListener(cleanupList, target, eventName, handler, options) {
    if (!target) {
        return;
    }

    target.addEventListener(eventName, handler, options);
    cleanupList.push(() => {
        target.removeEventListener(eventName, handler, options);
    });
}

function runCleanupList(cleanupList) {
    cleanupList.forEach((cleanup) => {
        if (typeof cleanup === 'function') {
            cleanup();
        }
    });
}

function initializeSettingsOverlay() {
    const settingsOverlay = document.querySelector('.settings-overlay');
    if (!settingsOverlay) {
        return;
    }

    settingsOverlay.style.position = 'fixed';
    settingsOverlay.style.inset = '0';
    settingsOverlay.style.background = 'rgba(56, 56, 56, 0.6)';
    settingsOverlay.style.visibility = 'hidden';
    settingsOverlay.style.opacity = '0';
    settingsOverlay.style.pointerEvents = 'none';
    settingsOverlay.style.zIndex = '100';
    settingsOverlay.style.cursor = 'pointer';
    settingsOverlay.style.border = 'none';
    settingsOverlay.style.padding = '0';
    settingsOverlay.style.transition = 'opacity 0.2s ease-out, visibility 0.2s ease-out';
}

/**
 * 切换设置面板
 */
export function toggleSettings() {
    if (!elements.settingsPanel) return;

    const isOpening = !elements.settingsPanel.classList.contains('open');
    elements.settingsPanel.classList.toggle('open');

    const overlay = document.querySelector('.settings-overlay');
    if (overlay) {
        if (isOpening) {
            overlay.style.visibility = 'visible';
            overlay.style.opacity = '1';
            overlay.style.pointerEvents = 'auto';
            overlay.style.zIndex = '100';
        } else {
            overlay.style.visibility = 'hidden';
            overlay.style.opacity = '0';
            overlay.style.pointerEvents = 'none';
        }
    }

    elements.settingsToggle?.setAttribute('aria-expanded', isOpening ? 'true' : 'false');

    if (isOpening) {
        trapFocus(elements.settingsPanel);
        acquireInert();
        // 等开合动画启动后再移焦点，避免聚焦尚不可见的元素失败
        setTimeout(() => {
            if (elements.settingsPanel?.classList.contains('open')) {
                elements.closeSettings?.focus();
            }
        }, 100);
    } else {
        removeFocusTrap(elements.settingsPanel);
        releaseInert();
        elements.settingsToggle?.focus();
    }
}

function handleSettingsOverlayClick(event) {
    event.stopPropagation();
    toggleSettings();
}

function syncGeneralSettingsUI() {
    const fastImageCompressionSwitch = document.getElementById('fast-image-compression');
    if (fastImageCompressionSwitch) {
        fastImageCompressionSwitch.checked = state.fastImageCompression || false;
    }

    const pdfModeSelect = document.getElementById('pdf-mode-select');
    if (pdfModeSelect) {
        pdfModeSelect.value = state.pdfMode || 'standard';
    }

    const codeExecSwitch = document.getElementById('code-execution-enabled');
    if (codeExecSwitch) {
        codeExecSwitch.checked = state.codeExecutionEnabled || false;
    }
    document
        .getElementById('toggle-code-exec')
        ?.classList.toggle('active', state.codeExecutionEnabled || false);

    const computerUseGroup = document.getElementById('computer-use-settings-group');
    if (computerUseGroup) {
        computerUseGroup.style.display = isElectron() ? '' : 'none';
    }

    const devtoolsGroup = document.getElementById('devtools-settings-group');
    if (devtoolsGroup) {
        devtoolsGroup.style.display = isElectron() ? 'none' : '';
    }

    const computerUseSwitch = document.getElementById('computer-use-enabled');
    if (computerUseSwitch) {
        computerUseSwitch.checked = state.computerUseEnabled || false;
    }
    document
        .getElementById('toggle-computer-use')
        ?.classList.toggle('active', state.computerUseEnabled || false);

    const permissionIds = ['bash', 'text-editor'];
    const permissionKeys = ['bash', 'textEditor'];
    permissionIds.forEach((id, index) => {
        const checkbox = document.getElementById(`allow-${id}`);
        if (checkbox) {
            const key = permissionKeys[index];
            checkbox.checked = state.computerUsePermissions?.[key] !== false;
        }
    });

    const bashConfig = state.bashConfig || {};

    const bashWorkingDir = document.getElementById('bash-working-dir');
    if (bashWorkingDir) {
        bashWorkingDir.value = bashConfig.workingDirectory || '';
    }

    const bashTimeout = document.getElementById('bash-timeout');
    if (bashTimeout) {
        bashTimeout.value = bashConfig.timeout || 30;
    }

    const bashConfirm = document.getElementById('bash-require-confirmation');
    if (bashConfirm) {
        bashConfirm.checked = bashConfig.requireConfirmation ?? false;
    }
}

// Electron 主进程 ComputerUseManager 在创建时使用默认权限/Bash 配置，
// 渲染层每次改动必须立即 IPC 推送，否则主进程永远拿不到用户设置。
function syncBashConfigToMain() {
    if (!isElectron() || !window.electronAPI?.computerUse_updateBashConfig) {
        return;
    }
    Promise.resolve(window.electronAPI.computerUse_updateBashConfig({ ...state.bashConfig })).catch(
        (error) => {
            logger.warn('[Settings] 推送 bashConfig 到主进程失败:', error);
        }
    );
}

function syncPermissionsToMain() {
    if (!isElectron() || !window.electronAPI?.computerUse_updatePermissions) {
        return;
    }
    Promise.resolve(
        window.electronAPI.computerUse_updatePermissions({ ...state.computerUsePermissions })
    ).catch((error) => {
        logger.warn('[Settings] 推送 computerUsePermissions 到主进程失败:', error);
    });
}

function bindGeneralSettingsEvents() {
    addManagedListener(
        settingsCleanupCallbacks,
        document.querySelector('.settings-overlay'),
        'click',
        handleSettingsOverlayClick,
        true
    );
    addManagedListener(settingsCleanupCallbacks, elements.settingsToggle, 'click', toggleSettings);
    addManagedListener(settingsCleanupCallbacks, elements.closeSettings, 'click', toggleSettings);

    const configLoadedUnsubscribe = eventBus.on('config:loaded', () => {
        syncGeneralSettingsUI();
        // 配置加载后将持久化的 bashConfig / permissions 推送给主进程，
        // 覆盖 ComputerUseManager 构造时的默认值
        syncBashConfigToMain();
        syncPermissionsToMain();
    });
    settingsSubscriptions.push(configLoadedUnsubscribe);

    addManagedListener(settingsCleanupCallbacks, elements.apiEndpoint, 'input', saveCurrentConfig);
    addManagedListener(settingsCleanupCallbacks, elements.apiKey, 'input', saveCurrentConfig);
    addManagedListener(settingsCleanupCallbacks, elements.modelSelect, 'change', saveCurrentConfig);

    const fastImageCompressionSwitch = document.getElementById('fast-image-compression');
    addManagedListener(settingsCleanupCallbacks, fastImageCompressionSwitch, 'change', (event) => {
        state.fastImageCompression = event.target.checked;
        saveCurrentConfig();
        logger.debug('[Settings] ⚡ 高速图片压缩模式已', event.target.checked ? '启用' : '禁用');
    });

    const pdfModeSelect = document.getElementById('pdf-mode-select');
    addManagedListener(settingsCleanupCallbacks, pdfModeSelect, 'change', (event) => {
        state.pdfMode = event.target.value;
        saveCurrentConfig();
        logger.debug(`[Settings] PDF 处理模式: ${event.target.value}`);
    });

    const codeExecSwitch = document.getElementById('code-execution-enabled');
    addManagedListener(settingsCleanupCallbacks, codeExecSwitch, 'change', (event) => {
        state.codeExecutionEnabled = event.target.checked;
        document
            .getElementById('toggle-code-exec')
            ?.classList.toggle('active', event.target.checked);
        saveCurrentConfig();
        logger.debug('[Settings] 📊 Code Execution 已', event.target.checked ? '启用' : '禁用');
    });

    const computerUseSwitch = document.getElementById('computer-use-enabled');
    addManagedListener(settingsCleanupCallbacks, computerUseSwitch, 'change', (event) => {
        state.computerUseEnabled = event.target.checked;
        document
            .getElementById('toggle-computer-use')
            ?.classList.toggle('active', event.target.checked);
        saveCurrentConfig();
        logger.debug('[Settings] 💻 Computer Use 已', event.target.checked ? '启用' : '禁用');
    });

    const permissionIds = ['bash', 'text-editor'];
    const permissionKeys = ['bash', 'textEditor'];
    permissionIds.forEach((id, index) => {
        const checkbox = document.getElementById(`allow-${id}`);
        const key = permissionKeys[index];
        addManagedListener(settingsCleanupCallbacks, checkbox, 'change', (event) => {
            state.computerUsePermissions[key] = event.target.checked;
            saveCurrentConfig();
            syncPermissionsToMain();
            logger.debug(`[Settings] 💻 ${key} 权限已`, event.target.checked ? '启用' : '禁用');
        });
    });

    const bashWorkingDir = document.getElementById('bash-working-dir');
    addManagedListener(settingsCleanupCallbacks, bashWorkingDir, 'input', (event) => {
        state.bashConfig.workingDirectory = event.target.value;
        saveCurrentConfig();
        syncBashConfigToMain();
    });

    const bashTimeout = document.getElementById('bash-timeout');
    addManagedListener(settingsCleanupCallbacks, bashTimeout, 'input', (event) => {
        state.bashConfig.timeout = parseInt(event.target.value, 10) || 30;
        saveCurrentConfig();
        syncBashConfigToMain();
    });

    const bashConfirm = document.getElementById('bash-require-confirmation');
    addManagedListener(settingsCleanupCallbacks, bashConfirm, 'change', (event) => {
        state.bashConfig.requireConfirmation = event.target.checked;
        saveCurrentConfig();
        syncBashConfigToMain();
    });

    const devtoolsToggle = document.getElementById('devtools-toggle');
    addManagedListener(settingsCleanupCallbacks, devtoolsToggle, 'change', (event) => {
        if (event.target.checked) {
            eventBus.emit('devtools:show');
        } else {
            eventBus.emit('devtools:toggle');
        }
    });
}

function setupMobileSettingsAccordion() {
    if (mobileAccordionApplied) {
        return;
    }

    mobileAccordionApplied = true;

    const groups = document.querySelectorAll('.settings-content > .settings-group');
    groups.forEach((group, index) => {
        if (group.querySelector('details')) {
            return;
        }

        const label = group.querySelector('.settings-label');
        if (!label) {
            return;
        }

        const body = document.createElement('div');
        body.className = 'settings-group-body';

        const children = Array.from(group.children).filter((child) => child !== label);
        children.forEach((child) => body.appendChild(child));
        group.appendChild(body);

        group.classList.add('accordion');
        label.setAttribute('tabindex', '0');
        label.setAttribute('role', 'button');
        if (index === 0) {
            group.classList.add('expanded');
            label.setAttribute('aria-expanded', 'true');
            requestAnimationFrame(() => {
                body.style.maxHeight = `${body.scrollHeight}px`;
            });
        } else {
            body.classList.add('collapsed');
            label.setAttribute('aria-expanded', 'false');
        }

        const clickHandler = () => {
            const isExpanded = group.classList.contains('expanded');
            if (isExpanded) {
                group.classList.remove('expanded');
                body.classList.add('collapsed');
                body.style.maxHeight = '0px';
                label.setAttribute('aria-expanded', 'false');
                return;
            }

            group.classList.add('expanded');
            body.classList.remove('collapsed');
            body.style.maxHeight = `${body.scrollHeight}px`;
            label.setAttribute('aria-expanded', 'true');
        };

        const keydownHandler = (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                clickHandler();
            }
        };

        label.addEventListener('click', clickHandler);
        label.addEventListener('keydown', keydownHandler);
        label._settingsAccordionClickHandler = clickHandler;
        label._settingsAccordionKeydownHandler = keydownHandler;
    });
}

function teardownMobileSettingsAccordion() {
    if (!mobileAccordionApplied) {
        return;
    }

    mobileAccordionApplied = false;

    const groups = document.querySelectorAll('.settings-content > .settings-group.accordion');
    groups.forEach((group) => {
        group.classList.remove('accordion', 'expanded');

        const label = group.querySelector('.settings-label');
        if (label?._settingsAccordionClickHandler) {
            label.removeEventListener('click', label._settingsAccordionClickHandler);
            delete label._settingsAccordionClickHandler;
        }
        if (label?._settingsAccordionKeydownHandler) {
            label.removeEventListener('keydown', label._settingsAccordionKeydownHandler);
            delete label._settingsAccordionKeydownHandler;
        }
        if (label) {
            label.removeAttribute('tabindex');
            label.removeAttribute('role');
            label.removeAttribute('aria-expanded');
        }

        const body = group.querySelector('.settings-group-body');
        if (!body) {
            return;
        }

        while (body.firstChild) {
            group.appendChild(body.firstChild);
        }
        body.remove();
    });
}

/**
 * 移动端设置面板手风琴折叠
 * 768px 以下将设置组转为可折叠的手风琴
 */
function initMobileSettingsAccordion() {
    if (!mobileAccordionMediaQuery) {
        mobileAccordionMediaQuery = window.matchMedia('(max-width: 768px)');
    }

    if (!mobileAccordionBound) {
        mobileAccordionChangeHandler = (event) => {
            if (event.matches) {
                setupMobileSettingsAccordion();
            } else {
                teardownMobileSettingsAccordion();
            }
        };

        mobileAccordionMediaQuery.addEventListener('change', mobileAccordionChangeHandler);
        settingsCleanupCallbacks.push(() => {
            if (mobileAccordionMediaQuery && mobileAccordionChangeHandler) {
                mobileAccordionMediaQuery.removeEventListener(
                    'change',
                    mobileAccordionChangeHandler
                );
            }
        });
        mobileAccordionBound = true;
    }

    if (mobileAccordionMediaQuery.matches) {
        setupMobileSettingsAccordion();
    } else {
        teardownMobileSettingsAccordion();
    }
}

function parseAppSettings(rawValue) {
    if (!rawValue) {
        return {};
    }

    if (typeof rawValue === 'string') {
        return JSON.parse(rawValue);
    }

    if (typeof rawValue === 'object') {
        return { ...rawValue };
    }

    return {};
}

async function loadStoredAppSettings() {
    try {
        const settingsValue = await loadPreference('appSettings');
        cachedAppSettings = parseAppSettings(settingsValue);
    } catch (error) {
        cachedAppSettings = {};
        logger.error('[Settings] 读取更新设置失败:', error);
    }

    return cachedAppSettings;
}

async function persistAppSettings() {
    await savePreference('appSettings', JSON.stringify(cachedAppSettings));

    if (isElectron() && window.electronAPI?.saveSettings) {
        window.electronAPI.saveSettings(cachedAppSettings);
    }
}

async function resolveCurrentVersionText() {
    if (window.electronAPI?.getVersion) {
        try {
            return await window.electronAPI.getVersion();
        } catch (error) {
            logger.warn('[Settings] 获取 Electron 版本号失败:', error);
            return '1.1.1';
        }
    }

    if (window.Capacitor?.Plugins?.App) {
        try {
            const { App } = window.Capacitor.Plugins;
            const info = await App.getInfo();
            return info.version;
        } catch (error) {
            logger.warn('[Settings] 获取 Capacitor 版本号失败:', error);
            return '未知';
        }
    }

    return '未知';
}

function getUpdateSettingsElements() {
    return {
        updateSettingsSection: document.getElementById('update-settings'),
        checkUpdateStartupToggle: document.getElementById('check-update-startup'),
        defaultSilentUpdateToggle: document.getElementById('default-silent-update'),
        manualCheckUpdateBtn: document.getElementById('manual-check-update-btn'),
        currentVersionNumber: document.getElementById('current-version-number')
    };
}

async function syncUpdateSettingsUI() {
    const {
        updateSettingsSection,
        checkUpdateStartupToggle,
        defaultSilentUpdateToggle,
        currentVersionNumber
    } = getUpdateSettingsElements();

    if (!updateSettingsSection) {
        return;
    }

    if (!isElectron() && !isAndroid()) {
        updateSettingsSection.style.display = 'none';
        return;
    }

    updateSettingsSection.style.display = 'block';

    const [appSettings, versionText] = await Promise.all([
        loadStoredAppSettings(),
        resolveCurrentVersionText()
    ]);

    if (checkUpdateStartupToggle) {
        checkUpdateStartupToggle.checked = appSettings.checkUpdateOnStartup !== false;
    }

    if (defaultSilentUpdateToggle) {
        defaultSilentUpdateToggle.checked = appSettings.silentUpdate || false;
    }

    if (currentVersionNumber) {
        currentVersionNumber.textContent = versionText;
    }
}

async function handleCheckUpdateStartupToggleChange(event) {
    const enabled = event.target.checked;
    cachedAppSettings = {
        ...cachedAppSettings,
        checkUpdateOnStartup: enabled
    };

    try {
        await persistAppSettings();
        logger.debug('[Settings] 启动检查更新设置已保存:', enabled);
    } catch (error) {
        logger.error('[Settings] 保存启动检查更新设置失败:', error);
    }
}

async function handleDefaultSilentUpdateToggleChange(event) {
    const enabled = event.target.checked;
    cachedAppSettings = {
        ...cachedAppSettings,
        silentUpdate: enabled
    };

    try {
        await persistAppSettings();
        // 通知 Electron 主进程更新静默更新状态
        if (window.electronAPI?.setSilentUpdate) {
            window.electronAPI.setSilentUpdate(enabled);
        }
        logger.debug('[Settings] 静默更新设置已保存:', enabled);
    } catch (error) {
        logger.error('[Settings] 保存静默更新设置失败:', error);
    }
}

async function handleManualCheckUpdate() {
    logger.debug('[Settings] 手动检查更新');

    if (isElectron() && window.electronAPI?.checkForUpdates) {
        window.electronAPI.checkForUpdates();
        return;
    }

    if (isAndroid()) {
        await checkForUpdatesManually();
    }
}

function handleElectronUpdateNotification(data) {
    logger.debug('[Settings] 更新通知:', data);

    const message =
        typeof data?.message === 'string' && data.message.trim()
            ? data.message.trim()
            : typeof data?.title === 'string'
              ? data.title.trim()
              : '';
    if (!message) {
        return;
    }

    showNotification(message, data?.type || 'info');
}

function bindUpdateSettingsEvents() {
    const { checkUpdateStartupToggle, defaultSilentUpdateToggle, manualCheckUpdateBtn } =
        getUpdateSettingsElements();

    addManagedListener(
        updateSettingsCleanupCallbacks,
        checkUpdateStartupToggle,
        'change',
        handleCheckUpdateStartupToggleChange
    );
    addManagedListener(
        updateSettingsCleanupCallbacks,
        defaultSilentUpdateToggle,
        'change',
        handleDefaultSilentUpdateToggleChange
    );
    addManagedListener(
        updateSettingsCleanupCallbacks,
        manualCheckUpdateBtn,
        'click',
        handleManualCheckUpdate
    );

    if (!isElectron() || !window.electronAPI) {
        return;
    }

    const progressUnsubscribe = window.electronAPI.onUpdateProgress?.((progress) => {
        logger.debug('[Settings] 更新进度:', `${progress.percent}%`);
    });
    const notificationUnsubscribe = window.electronAPI.onNotification?.(
        handleElectronUpdateNotification
    );

    [progressUnsubscribe, notificationUnsubscribe].forEach((unsubscribe) => {
        if (typeof unsubscribe === 'function') {
            updateSettingsSubscriptions.push(unsubscribe);
        }
    });
}

/**
 * 初始化更新设置
 */
async function initUpdateSettings() {
    if (updateSettingsInitialized) {
        await syncUpdateSettingsUI();
        return;
    }

    if (updateSettingsInitPromise) {
        return updateSettingsInitPromise;
    }

    updateSettingsInitPromise = (async () => {
        await syncUpdateSettingsUI();
        bindUpdateSettingsEvents();
        updateSettingsInitialized = true;
        logger.debug('Update settings initialized');
    })().finally(() => {
        updateSettingsInitPromise = null;
    });

    return updateSettingsInitPromise;
}

/**
 * 初始化设置面板
 */
export function initSettings() {
    initializeSettingsOverlay();
    syncGeneralSettingsUI();
    initMobileSettingsAccordion();
    void initUpdateSettings();

    if (settingsInitialized) {
        return;
    }

    bindGeneralSettingsEvents();
    settingsInitialized = true;
    logger.debug('Settings panel initialized');
}

export function cleanupSettings() {
    runCleanupList(updateSettingsCleanupCallbacks);
    updateSettingsCleanupCallbacks = [];

    updateSettingsSubscriptions.forEach((unsubscribe) => {
        if (typeof unsubscribe === 'function') {
            unsubscribe();
        }
    });
    updateSettingsSubscriptions = [];

    runCleanupList(settingsCleanupCallbacks);
    settingsCleanupCallbacks = [];

    settingsSubscriptions.forEach((unsubscribe) => {
        if (typeof unsubscribe === 'function') {
            unsubscribe();
        }
    });
    settingsSubscriptions = [];

    teardownMobileSettingsAccordion();
    mobileAccordionBound = false;
    mobileAccordionMediaQuery = null;
    mobileAccordionChangeHandler = null;

    settingsInitialized = false;
    updateSettingsInitialized = false;
    updateSettingsInitPromise = null;
}
