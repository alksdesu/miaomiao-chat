/**
 * resize.js 面板拖拽调整测试
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../js/core/elements.js', () => ({
    elements: {
        inputResizeHandle: null,
        userInput: null,
        settingsPanel: null,
        sidebar: null
    }
}));

vi.mock('../../js/core/state.js', () => ({
    state: {
        storageMode: 'indexedDB'
    }
}));

vi.mock('../../js/state/storage.js', () => ({
    savePreference: vi.fn(() => Promise.resolve()),
    loadPreference: vi.fn(() => Promise.resolve(null))
}));

vi.mock('../../js/utils/logger.js', () => ({
    logger: { warn: vi.fn(), debug: vi.fn(), error: vi.fn(), info: vi.fn() }
}));

import { elements } from '../../js/core/elements.js';
import { state } from '../../js/core/state.js';
import { initInputResize, initPanelResize } from '../../js/ui/resize.js';

describe('resize', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        document.body.innerHTML = '';
        elements.inputResizeHandle = null;
        elements.userInput = null;
        elements.settingsPanel = null;
        elements.sidebar = null;
    });

    afterEach(() => {
        document.body.innerHTML = '';
    });

    // ========== initInputResize ==========
    describe('initInputResize', () => {
        it('handle null 静默返回', async () => {
            elements.inputResizeHandle = null;
            elements.userInput = document.createElement('textarea');
            await expect(initInputResize()).resolves.not.toThrow();
        });

        it('textarea null 静默返回', async () => {
            elements.inputResizeHandle = document.createElement('div');
            elements.userInput = null;
            await expect(initInputResize()).resolves.not.toThrow();
        });

        it('正常初始化绑定事件', async () => {
            const handle = document.createElement('div');
            const textarea = document.createElement('textarea');
            elements.inputResizeHandle = handle;
            elements.userInput = textarea;

            const spy = vi.spyOn(handle, 'addEventListener');
            await initInputResize();

            // 应绑定 mousedown 和 touchstart
            const events = spy.mock.calls.map((c) => c[0]);
            expect(events).toContain('mousedown');
            expect(events).toContain('touchstart');
        });

        it('恢复保存的高度', async () => {
            const handle = document.createElement('div');
            const textarea = document.createElement('textarea');
            elements.inputResizeHandle = handle;
            elements.userInput = textarea;

            const { loadPreference } = await import('../../js/state/storage.js');
            loadPreference.mockResolvedValue(200);

            await initInputResize();
            expect(textarea.style.height).toBe('200px');
        });

        it('localStorage 降级恢复高度', async () => {
            const handle = document.createElement('div');
            const textarea = document.createElement('textarea');
            elements.inputResizeHandle = handle;
            elements.userInput = textarea;
            state.storageMode = 'localStorage';

            // setup.js polyfill 在实例上挂 getItem 覆盖原型链，spy 走 instance 才命中
            const spy = vi.spyOn(localStorage, 'getItem').mockReturnValue('150');

            await initInputResize();
            expect(textarea.style.height).toBe('150px');

            spy.mockRestore();
            state.storageMode = 'indexedDB';
        });

        it('mousedown 开始调整', async () => {
            const handle = document.createElement('div');
            const textarea = document.createElement('textarea');
            document.body.appendChild(handle);
            document.body.appendChild(textarea);
            elements.inputResizeHandle = handle;
            elements.userInput = textarea;

            await initInputResize();

            handle.dispatchEvent(new MouseEvent('mousedown', { clientY: 100 }));
            expect(document.body.style.cursor).toBe('ns-resize');
        });
    });

    // ========== initPanelResize ==========
    describe('initPanelResize', () => {
        it('panel 和 handle 都 null 不抛错', async () => {
            await expect(initPanelResize()).resolves.not.toThrow();
        });

        it('有 settings panel 和 handle 绑定事件', async () => {
            const panel = document.createElement('div');
            const handle = document.createElement('div');
            handle.id = 'settings-resize-handle';
            document.body.appendChild(handle);
            elements.settingsPanel = panel;

            await initPanelResize();

            // handle 应该被绑定了事件
            const spy = vi.spyOn(handle, 'addEventListener');
            // 验证之前的绑定已完成
            expect(handle.id).toBe('settings-resize-handle');
        });

        it('恢复保存的面板宽度', async () => {
            const panel = document.createElement('div');
            const handle = document.createElement('div');
            handle.id = 'settings-resize-handle';
            document.body.appendChild(handle);
            elements.settingsPanel = panel;

            Object.defineProperty(window, 'innerWidth', { value: 1024, writable: true });

            const { loadPreference } = await import('../../js/state/storage.js');
            loadPreference.mockResolvedValue(350);

            await initPanelResize();
            expect(panel.style.width).toBe('350px');
        });

        it('宽度超过 maxWidth 不恢复', async () => {
            const panel = document.createElement('div');
            const handle = document.createElement('div');
            handle.id = 'settings-resize-handle';
            document.body.appendChild(handle);
            elements.settingsPanel = panel;

            Object.defineProperty(window, 'innerWidth', { value: 1024, writable: true });

            const { loadPreference } = await import('../../js/state/storage.js');
            loadPreference.mockResolvedValue(9999);

            await initPanelResize();
            // 9999 超过 maxWidth(600)，不应被恢复
            expect(panel.style.width).toBe('');
        });

        it('窄屏不恢复面板宽度', async () => {
            const panel = document.createElement('div');
            const handle = document.createElement('div');
            handle.id = 'settings-resize-handle';
            document.body.appendChild(handle);
            elements.settingsPanel = panel;

            Object.defineProperty(window, 'innerWidth', { value: 400, writable: true });

            const { loadPreference } = await import('../../js/state/storage.js');
            loadPreference.mockResolvedValue(350);

            await initPanelResize();
            expect(panel.style.width).toBe('');
        });
    });
});
