/**
 * 平台检测工具
 * 统一 Electron / Android(Capacitor) / Web 三平台判断
 */

let _platform = null;

/**
 * 检测当前运行平台（结果缓存）
 * @returns {'electron'|'android'|'web'}
 */
export function detectPlatform() {
    if (_platform) return _platform;

    if (window.electronAPI?.isElectron?.() || window.electron?.ipcRenderer) {
        _platform = 'electron';
    } else if (window.Capacitor && window.Capacitor.getPlatform() === 'android') {
        _platform = 'android';
    } else {
        _platform = 'web';
    }
    return _platform;
}

export function isElectron() { return detectPlatform() === 'electron'; }
export function isAndroid() { return detectPlatform() === 'android'; }
export function isWeb()     { return detectPlatform() === 'web'; }

/**
 * Electron IPC renderer（仅 Electron 环境可用）
 */
export function getIpcRenderer() {
    return window.electron?.ipcRenderer || null;
}
