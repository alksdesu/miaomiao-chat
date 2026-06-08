/**
 * settings.js 测试
 * 设置面板：toggleSettings, parseAppSettings, cleanup
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../js/core/state.js', () => ({
    state: {
        fastImageCompression: false,
        pdfMode: 'standard',
        codeExecutionEnabled: false,
        computerUseEnabled: false,
        computerUsePermissions: { bash: true, textEditor: true },
        bashConfig: { workingDirectory: '', timeout: 30, requireConfirmation: false }
    }
}));

vi.mock('../../js/core/elements.js', () => ({
    elements: {
        settingsPanel: null,
        settingsToggle: null,
        closeSettings: null,
        apiEndpoint: null,
        apiKey: null,
        modelSelect: null
    }
}));

vi.mock('../../js/core/events.js', () => ({
    eventBus: {
        on: vi.fn(() => vi.fn()),
        emit: vi.fn()
    }
}));

vi.mock('../../js/state/config.js', () => ({
    saveCurrentConfig: vi.fn()
}));

vi.mock('../../js/state/storage.js', () => ({
    savePreference: vi.fn(),
    loadPreference: vi.fn()
}));

vi.mock('../../js/ui/notifications.js', () => ({
    showNotification: vi.fn()
}));

vi.mock('../../js/utils/platform.js', () => ({
    isElectron: vi.fn(() => false),
    isAndroid: vi.fn(() => false)
}));

import { elements } from '../../js/core/elements.js';
import { toggleSettings, initSettings, cleanupSettings } from '../../js/ui/settings.js';

beforeEach(() => {
    vi.clearAllMocks();

    // jsdom 不支持 matchMedia，手动 mock
    window.matchMedia = vi.fn().mockReturnValue({
        matches: false,
        media: '',
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn()
    });

    elements.settingsPanel = document.createElement('div');
    elements.settingsToggle = document.createElement('button');
    elements.settingsToggle.focus = vi.fn();
    elements.closeSettings = document.createElement('button');
    elements.apiEndpoint = document.createElement('input');
    elements.apiKey = document.createElement('input');
    elements.modelSelect = document.createElement('select');
    document.body.innerHTML = '';
});

describe('toggleSettings', () => {
    it('切换 open class', () => {
        toggleSettings();
        expect(elements.settingsPanel.classList.contains('open')).toBe(true);

        toggleSettings();
        expect(elements.settingsPanel.classList.contains('open')).toBe(false);
    });

    it('settingsPanel 为 null 时不报错', () => {
        elements.settingsPanel = null;
        expect(() => toggleSettings()).not.toThrow();
    });

    it('打开时设置 inert', () => {
        const appContainer = document.createElement('div');
        appContainer.className = 'app-container';
        document.body.appendChild(appContainer);

        toggleSettings();
        expect(appContainer.getAttribute('inert')).toBe('');
    });

    it('关闭时移除 inert', () => {
        const appContainer = document.createElement('div');
        appContainer.className = 'app-container';
        document.body.appendChild(appContainer);

        toggleSettings(); // open
        toggleSettings(); // close
        expect(appContainer.hasAttribute('inert')).toBe(false);
    });

    it('关闭时焦点回到 toggle 按钮', () => {
        toggleSettings(); // open
        toggleSettings(); // close
        expect(elements.settingsToggle.focus).toHaveBeenCalled();
    });
});

describe('initSettings', () => {
    it('调用不报错', () => {
        expect(() => initSettings()).not.toThrow();
    });
});

describe('cleanupSettings', () => {
    it('清理后不报错', () => {
        expect(() => cleanupSettings()).not.toThrow();
    });

    it('多次清理不报错', () => {
        cleanupSettings();
        cleanupSettings();
    });
});
