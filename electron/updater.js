const log = require('electron-log');

let autoUpdater = null;
let mainWindow = null;
let silentUpdate = false;
let checkUpdateOnStartup = true;

let updaterListenersInstalled = false;
let startupCheckTimer = null;
let operationSequence = 0;
let activeCheck = null;
let activeDownload = null;

function nextOperationId() {
    operationSequence += 1;
    return operationSequence;
}

function isWindowUsable(win = mainWindow) {
    return !!(
        win &&
        typeof win.isDestroyed === 'function' &&
        !win.isDestroyed() &&
        win.webContents &&
        typeof win.webContents.isDestroyed === 'function' &&
        !win.webContents.isDestroyed()
    );
}

function bindUpdaterWindow(win) {
    mainWindow = isWindowUsable(win) ? win : null;
}

function sendToRenderer(channel, payload) {
    if (!isWindowUsable()) {
        return false;
    }

    mainWindow.webContents.send(channel, payload);
    return true;
}

function sendNotification(data) {
    sendToRenderer('notification', data);
}

function isManualCheck(context) {
    return !!(context && context.sources instanceof Set && context.sources.has('manual'));
}

function formatCheckLabel(context = activeCheck) {
    if (!context?.sources || context.sources.size === 0) {
        return '更新检查';
    }

    if (context.sources.has('auto') && context.sources.has('manual')) {
        return '自动/手动联合检查';
    }

    return context.sources.has('manual') ? '手动检查' : '自动检查';
}

function formatDownloadLabel(context = activeDownload) {
    if (!context) {
        return '更新下载';
    }

    const modeLabel = context.silent ? '静默下载' : '交互下载';
    const triggerLabelMap = {
        renderer: '界面触发',
        'auto-check': '自动检查触发',
        'manual-check': '手动检查触发'
    };
    const triggerLabel = triggerLabelMap[context.triggerSource] || '未知触发';

    return `${modeLabel}（${triggerLabel}）`;
}

function clearStartupCheckTimer() {
    if (!startupCheckTimer) {
        return;
    }

    clearTimeout(startupCheckTimer);
    startupCheckTimer = null;
}

function scheduleStartupCheck() {
    clearStartupCheckTimer();

    if (!checkUpdateOnStartup) {
        return;
    }

    startupCheckTimer = setTimeout(() => {
        startupCheckTimer = null;
        requestCheckForUpdates('auto');
    }, 3000);
}

function clearOperationTimeout(context) {
    if (context?.timeoutId) {
        clearTimeout(context.timeoutId);
        context.timeoutId = null;
    }
}

function resetStaleOperations() {
    if (activeCheck?.errorHandled) {
        clearOperationTimeout(activeCheck);
        activeCheck = null;
    }

    if (activeDownload?.errorHandled) {
        clearOperationTimeout(activeDownload);
        activeDownload = null;
    }
}

function setupUpdateListeners() {
    if (!autoUpdater || updaterListenersInstalled) {
        return;
    }

    updaterListenersInstalled = true;

    autoUpdater.on('checking-for-update', () => {
        log.info(`[Updater] ${formatCheckLabel()}：正在检查更新...`);
    });

    autoUpdater.on('update-available', (info) => {
        const checkContext = activeCheck;
        clearOperationTimeout(checkContext);
        activeCheck = null;

        log.info(`[Updater] ${formatCheckLabel(checkContext)}：发现新版本 ${info.version}`);

        if (silentUpdate) {
            log.info(`[Updater] ${formatCheckLabel(checkContext)}：静默模式开始后台下载`);
            downloadUpdate({
                silent: true,
                triggerSource: isManualCheck(checkContext) ? 'manual-check' : 'auto-check'
            });
            sendNotification({
                type: 'info',
                title: '发现新版本',
                message: `v${info.version} 正在后台下载，下次启动时自动安装`
            });
            return;
        }

        showUpdateDialog(info);
    });

    autoUpdater.on('update-not-available', (info) => {
        const checkContext = activeCheck;
        clearOperationTimeout(checkContext);
        activeCheck = null;

        const version = info?.version || autoUpdater?.currentVersion?.version || '当前版本';
        log.info(`[Updater] ${formatCheckLabel(checkContext)}：当前已是最新版本 ${version}`);

        if (!isManualCheck(checkContext)) {
            return;
        }

        sendNotification({
            type: 'success',
            title: '已是最新版本',
            message: `当前版本 v${version} 已是最新`
        });
    });

    autoUpdater.on('download-progress', (progressObj) => {
        const percent = Math.round(progressObj.percent);
        log.info(`[Updater] ${formatDownloadLabel()}：下载进度 ${percent}%`);

        sendToRenderer('update-progress', {
            percent,
            transferred: progressObj.transferred,
            total: progressObj.total,
            bytesPerSecond: progressObj.bytesPerSecond
        });
    });

    autoUpdater.on('update-downloaded', (info) => {
        const downloadContext = activeDownload;
        clearOperationTimeout(downloadContext);
        activeDownload = null;

        log.info(`[Updater] ${formatDownloadLabel(downloadContext)}：更新下载完成 ${info.version}`);

        sendToRenderer('update-downloaded', {
            version: info.version,
            releaseNotes: info.releaseNotes || ''
        });

        sendNotification({
            type: 'success',
            title: '更新已下载',
            message: `v${info.version} 将在下次启动时自动安装`
        });
    });

    autoUpdater.on('error', (error) => {
        if (activeDownload) {
            if (activeDownload.errorHandled) {
                log.warn('[Updater] 已忽略重复的下载错误事件:', error);
                return;
            }

            handleDownloadError(error, activeDownload, 'event');
            return;
        }

        if (activeCheck) {
            if (activeCheck.errorHandled) {
                log.warn('[Updater] 已忽略重复的检查错误事件:', error);
                return;
            }

            handleCheckError(error, activeCheck, 'event');
            return;
        }

        log.error('[Updater] 未归类的更新错误:', error);
        sendNotification({
            type: 'error',
            title: '更新失败',
            message: `更新过程中出错: ${error?.message || '未知错误'}`
        });
    });
}

function handleCheckError(error, checkContext, origin) {
    if (!checkContext || checkContext.errorHandled) {
        return;
    }

    checkContext.errorHandled = true;
    log.error(`[Updater] ${formatCheckLabel(checkContext)}失败（${origin}）:`, error);

    if (!isManualCheck(checkContext)) {
        log.info('[Updater] 自动检查失败按静默策略处理，不向用户显示提示');
        return;
    }

    sendNotification({
        type: 'error',
        title: '检查更新失败',
        message: '无法连接到更新服务器，请检查网络连接'
    });
}

function handleDownloadError(error, downloadContext, origin) {
    if (!downloadContext || downloadContext.errorHandled) {
        return;
    }

    downloadContext.errorHandled = true;
    log.error(`[Updater] ${formatDownloadLabel(downloadContext)}失败（${origin}）:`, error);

    sendNotification({
        type: 'error',
        title: '更新失败',
        message: `更新下载失败: ${error?.message || '未知错误'}`
    });
}

function requestCheckForUpdates(source = 'manual') {
    if (!autoUpdater) {
        log.warn('[Updater] 更新器尚未初始化，无法检查更新');
        return Promise.resolve(null);
    }

    resetStaleOperations();

    if (activeCheck) {
        activeCheck.sources.add(source);

        if (source === 'manual' && !activeCheck.manualFeedbackShown) {
            activeCheck.manualFeedbackShown = true;
            sendNotification({
                type: 'info',
                title: '检查更新',
                message: '正在检查更新...'
            });
        }

        log.info(`[Updater] ${source === 'manual' ? '手动' : '自动'}检查请求复用当前任务`);
        return activeCheck.promise;
    }

    const checkContext = {
        id: nextOperationId(),
        sources: new Set([source]),
        manualFeedbackShown: source === 'manual',
        errorHandled: false,
        promise: null,
        timeoutId: null
    };

    activeCheck = checkContext;

    if (checkContext.manualFeedbackShown) {
        sendNotification({
            type: 'info',
            title: '检查更新',
            message: '正在检查更新...'
        });
    }

    log.info(`[Updater] ${formatCheckLabel(checkContext)}开始`);

    const checkPromise = autoUpdater.checkForUpdates().catch((error) => {
        setImmediate(() => {
            handleCheckError(error, checkContext, 'promise');
        });
        return null;
    });

    checkContext.promise = checkPromise;

    // 超时回收：防止网络挂起导致 activeCheck 永久占位
    checkContext.timeoutId = setTimeout(() => {
        if (activeCheck === checkContext && !checkContext.errorHandled) {
            log.warn(`[Updater] ${formatCheckLabel(checkContext)}超时（60秒），重置状态`);
            checkContext.errorHandled = true;
            activeCheck = null;
        }
    }, 60000);

    return checkPromise;
}

function showUpdateDialog(info) {
    log.info('[Updater] 向渲染进程发送更新可用事件');

    sendToRenderer('update-available', {
        version: info.version,
        releaseNotes: info.releaseNotes || '建议您更新到最新版本以获得更好的体验'
    });
}

function downloadUpdate(options = {}) {
    if (!autoUpdater) {
        log.warn('[Updater] 更新器尚未初始化，无法下载更新');
        return Promise.resolve(null);
    }

    resetStaleOperations();

    if (activeDownload) {
        log.info('[Updater] 已存在进行中的下载任务，忽略新的下载请求');
        return activeDownload.promise;
    }

    const downloadContext = {
        id: nextOperationId(),
        silent: options.silent === true,
        triggerSource: options.triggerSource || 'renderer',
        errorHandled: false,
        promise: null,
        timeoutId: null
    };

    activeDownload = downloadContext;
    log.info(`[Updater] ${formatDownloadLabel(downloadContext)}开始`);

    const downloadPromise = autoUpdater.downloadUpdate().catch((error) => {
        setImmediate(() => {
            handleDownloadError(error, downloadContext, 'promise');
        });
        return null;
    });

    downloadContext.promise = downloadPromise;

    // 超时回收：防止网络挂起导致 activeDownload 永久占位（5 分钟）
    downloadContext.timeoutId = setTimeout(() => {
        if (activeDownload === downloadContext && !downloadContext.errorHandled) {
            log.warn(`[Updater] ${formatDownloadLabel(downloadContext)}超时（300秒），重置状态`);
            downloadContext.errorHandled = true;
            activeDownload = null;
        }
    }, 300000);

    return downloadPromise;
}

/**
 * 初始化更新器
 * @param {BrowserWindow} win - 主窗口实例
 * @param {Object} options - 配置选项
 * @param {boolean} options.silentUpdate - 是否静默更新
 * @param {boolean} options.checkUpdateOnStartup - 启动时是否检查更新
 */
function initUpdater(win, options = {}) {
    bindUpdaterWindow(win);

    if (!autoUpdater) {
        autoUpdater = require('electron-updater').autoUpdater;
    }

    silentUpdate = options.silentUpdate === true;
    checkUpdateOnStartup = options.checkUpdateOnStartup !== false;

    log.transports.file.level = 'info';
    autoUpdater.logger = log;
    autoUpdater.forceDevUpdateConfig = true;
    autoUpdater.autoDownload = false;

    log.info('[Updater] 使用 GitHub 公开仓库自动更新（依赖 package.json publish 配置）');

    setupUpdateListeners();
    scheduleStartupCheck();
}

function bindUpdaterWindowAndLog(win) {
    bindUpdaterWindow(win);
    log.info(`[Updater] 当前绑定窗口: ${mainWindow ? mainWindow.id : 'none'}`);
}

/**
 * 手动检查更新（带用户反馈）
 */
function checkForUpdatesManually() {
    return requestCheckForUpdates('manual');
}

/**
 * 更新静默模式设置（运行时调用）
 * @param {boolean} enabled - 是否启用静默更新
 */
function setSilentUpdate(enabled) {
    silentUpdate = enabled === true;
    log.info(`[Updater] 静默模式已${silentUpdate ? '启用' : '禁用'}`);
}

/**
 * 立即安装更新并重启应用
 * 必须在 update-downloaded 事件触发后调用
 */
function quitAndInstall() {
    if (!autoUpdater) {
        log.warn('[Updater] 更新器尚未初始化，无法执行安装');
        return;
    }

    log.info('[Updater] 立即安装更新并重启应用');
    setImmediate(() => {
        autoUpdater.quitAndInstall(false, true);
    });
}

module.exports = {
    initUpdater,
    bindUpdaterWindow: bindUpdaterWindowAndLog,
    checkForUpdatesManually,
    setSilentUpdate,
    downloadUpdate,
    quitAndInstall
};
