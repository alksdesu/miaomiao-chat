import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const mouse = {
    move: vi.fn(async (x, y) => ({ x, y })),
    pressButton: vi.fn(async () => {}),
    releaseButton: vi.fn(async () => {}),
    click: vi.fn(async () => {})
};
const keyboard = {
    pressDown: vi.fn(async () => {}),
    release: vi.fn(async () => {}),
    press: vi.fn(async () => {}),
    type: vi.fn(async () => {})
};
const screenshot = {
    capture: vi.fn(async () => ({ base64: 'SHOT', format: 'png' })),
    captureRegion: vi.fn(),
    getGeometry: vi.fn()
};

// manager.js 以 CommonJS 加载各子模块，先占住模块缓存，避免加载原生输入库、electron 与审计日志写盘
const STUBS = {
    mouse,
    keyboard,
    screenshot,
    display: { getInputSpace: vi.fn(), getInfo: vi.fn() },
    bash: { execute: vi.fn() },
    'text-editor': { read: vi.fn(), write: vi.fn() },
    audit: { log: vi.fn(async () => {}) }
};
const managerPath = require.resolve('../../electron/computer-use/manager.js');
const originals = Object.keys(STUBS).map((name) => {
    const path = require.resolve(`../../electron/computer-use/${name}.js`);
    const original = require.cache[path];
    require.cache[path] = { id: path, filename: path, loaded: true, exports: STUBS[name] };
    return [path, original];
});
const manager = require(managerPath);

afterAll(() => {
    delete require.cache[managerPath];
    for (const [path, original] of originals) {
        if (original) {
            require.cache[path] = original;
        } else {
            delete require.cache[path];
        }
    }
});

beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    manager.updatePermissions({
        mouse: false,
        keyboard: false,
        screenshot: true,
        bash: false,
        textEditor: false
    });
});

describe('ComputerUseManager 释放按键与鼠标', () => {
    it('没有键盘、鼠标权限时仍能松开已按住的键和按钮', async () => {
        await manager.releaseKey('shift');
        await manager.releaseMouseButton('left');

        expect(keyboard.release).toHaveBeenCalledWith('shift');
        expect(mouse.releaseButton).toHaveBeenCalledWith('left');
    });

    it('权限中途被关掉后，按住与按下仍被拒绝，松开照常', async () => {
        manager.updatePermissions({ mouse: true, keyboard: true });
        await manager.holdKey('ctrl');
        await manager.pressMouseButton('left');

        manager.updatePermissions({ mouse: false, keyboard: false });

        await expect(manager.holdKey('alt')).rejects.toThrow('Keyboard permission denied');
        await expect(manager.pressMouseButton('left')).rejects.toThrow('Mouse permission denied');
        await manager.releaseKey('ctrl');
        await manager.releaseMouseButton('left');
        expect(keyboard.pressDown).toHaveBeenCalledTimes(1);
        expect(mouse.pressButton).toHaveBeenCalledTimes(1);
        expect(keyboard.release).toHaveBeenCalledWith('ctrl');
        expect(mouse.releaseButton).toHaveBeenCalledWith('left');
    });
});

describe('ComputerUseManager 权限更新', () => {
    it('接受鼠标、键盘、截图三项并按新权限放行或拒绝', async () => {
        manager.updatePermissions({ mouse: true, keyboard: true, screenshot: false });

        await manager.holdKey('shift');
        await manager.clickMouse('left');
        await expect(manager.captureScreen()).rejects.toThrow('Screenshot permission denied');
        expect(keyboard.pressDown).toHaveBeenCalledWith('shift');
        expect(mouse.click).toHaveBeenCalledWith('left');
        expect(screenshot.capture).not.toHaveBeenCalled();
    });

    it('非布尔值整体拒绝，原有权限不变', async () => {
        expect(() => manager.updatePermissions({ mouse: 'true' })).toThrow(
            'Computer Use 权限 mouse 必须是布尔值'
        );
        await expect(manager.clickMouse('left')).rejects.toThrow('Mouse permission denied');
    });
});
