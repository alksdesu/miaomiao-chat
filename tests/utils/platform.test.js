/**
 * utils/platform.js 平台检测测试
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

// 每次测试前重置模块以清除缓存的 _platform
let detectPlatform, isElectron, isAndroid, isWeb, getIpcRenderer;

beforeEach(async () => {
    vi.resetModules();

    // 清理全局对象
    delete window.electronAPI;
    delete window.electron;
    delete window.Capacitor;

    const mod = await import('../../js/utils/platform.js');
    detectPlatform = mod.detectPlatform;
    isElectron = mod.isElectron;
    isAndroid = mod.isAndroid;
    isWeb = mod.isWeb;
    getIpcRenderer = mod.getIpcRenderer;
});

describe('detectPlatform', () => {
    it('检测 Electron（通过 electronAPI）', () => {
        window.electronAPI = { isElectron: () => true };
        expect(detectPlatform()).toBe('electron');
    });

    it('检测 Electron（通过 electron.ipcRenderer）', () => {
        window.electron = { ipcRenderer: {} };
        expect(detectPlatform()).toBe('electron');
    });

    it('检测 Android（Capacitor）', () => {
        window.Capacitor = { getPlatform: () => 'android' };
        expect(detectPlatform()).toBe('android');
    });

    it('默认为 web', () => {
        expect(detectPlatform()).toBe('web');
    });

    it('缓存检测结果', () => {
        expect(detectPlatform()).toBe('web');
        // 后续添加 electron 不会改变结果
        window.electronAPI = { isElectron: () => true };
        expect(detectPlatform()).toBe('web');
    });
});

describe('isElectron', () => {
    it('Electron 环境返回 true', () => {
        window.electron = { ipcRenderer: {} };
        expect(isElectron()).toBe(true);
    });

    it('非 Electron 返回 false', () => {
        expect(isElectron()).toBe(false);
    });
});

describe('isAndroid', () => {
    it('Android 环境返回 true', () => {
        window.Capacitor = { getPlatform: () => 'android' };
        expect(isAndroid()).toBe(true);
    });

    it('非 Android 返回 false', () => {
        expect(isAndroid()).toBe(false);
    });
});

describe('isWeb', () => {
    it('Web 环境返回 true', () => {
        expect(isWeb()).toBe(true);
    });
});

describe('getIpcRenderer', () => {
    it('Electron 环境返回 ipcRenderer', () => {
        const mockIpc = { invoke: vi.fn() };
        window.electron = { ipcRenderer: mockIpc };
        expect(getIpcRenderer()).toBe(mockIpc);
    });

    it('非 Electron 返回 null', () => {
        expect(getIpcRenderer()).toBeNull();
    });
});
