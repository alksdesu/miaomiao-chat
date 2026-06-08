/**
 * quick-toggles.js 测试
 * 快捷开关同步和初始化
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../js/core/state.js', () => ({
    state: {
        streamEnabled: true,
        thinkingEnabled: false,
        webSearchEnabled: false,
        codeExecutionEnabled: false,
        computerUseEnabled: false,
        monitorEnabled: false,
        sessionDirty: false,
        thinkingStrength: 'medium',
        apiFormat: 'openai'
    }
}));

vi.mock('../../js/core/events.js', () => {
    const handlers = {};
    return {
        eventBus: {
            on: vi.fn((event, handler) => {
                handlers[event] = handler;
                return () => delete handlers[event];
            }),
            emit: vi.fn(),
            _handlers: handlers
        }
    };
});

vi.mock('../../js/state/config.js', () => ({
    saveCurrentConfig: vi.fn()
}));

vi.mock('../../js/ui/input.js', () => ({
    handleAttachFile: vi.fn()
}));

vi.mock('../../js/utils/platform.js', () => ({
    isElectron: vi.fn(() => false),
    isAndroid: vi.fn(() => false),
    detectPlatform: vi.fn(() => 'web')
}));

// 5c-C 收敛 ui/quick-toggles 静态 import 后必须 mock 这几个模块
vi.mock('../../js/tools/manager.js', () => ({
    setToolEnabled: vi.fn(),
    getToolStats: vi.fn(() => ({ enabled: 0 })),
    loadToolStates: vi.fn(async () => {}),
    getToolsForAPI: vi.fn(() => [])
}));

vi.mock('../../js/devtools/monitor-state.js', () => ({
    setMonitorEnabled: vi.fn(async () => {}),
    isMonitorEnabled: vi.fn(() => false),
    syncMonitorOnSessionSwitch: vi.fn()
}));

vi.mock('../../js/ui/openclaw-cron.js', () => ({
    openCronPanel: vi.fn()
}));

vi.mock('../../js/api/openclaw.js', () => ({
    openclawClient: { connected: false, connect: vi.fn(), send: vi.fn() }
}));

import { state } from '../../js/core/state.js';
import { saveCurrentConfig } from '../../js/state/config.js';
import {
    syncQuickToggles,
    initQuickToggles,
    exposeToggleFunctions
} from '../../js/ui/quick-toggles.js';

beforeEach(() => {
    vi.clearAllMocks();
    state.streamEnabled = true;
    state.thinkingEnabled = false;
    state.webSearchEnabled = false;
    state.codeExecutionEnabled = false;
    state.computerUseEnabled = false;

    document.body.innerHTML = `
        <button id="toggle-stream"></button>
        <button id="toggle-thinking"></button>
        <button id="toggle-websearch"></button>
        <button id="toggle-code-exec"></button>
        <button id="toggle-computer-use"></button>
    `;
});

describe('syncQuickToggles', () => {
    it('同步 stream 按钮状态 — active', () => {
        state.streamEnabled = true;
        syncQuickToggles();
        expect(document.getElementById('toggle-stream').classList.contains('active')).toBe(true);
    });

    it('同步 stream 按钮状态 — inactive', () => {
        state.streamEnabled = false;
        syncQuickToggles();
        expect(document.getElementById('toggle-stream').classList.contains('active')).toBe(false);
    });

    it('同步 thinking 按钮状态', () => {
        state.thinkingEnabled = true;
        syncQuickToggles();
        expect(document.getElementById('toggle-thinking').classList.contains('active')).toBe(true);
    });

    it('同步 websearch 按钮状态', () => {
        state.webSearchEnabled = true;
        syncQuickToggles();
        expect(document.getElementById('toggle-websearch').classList.contains('active')).toBe(true);
    });

    it('同步 code-exec 按钮状态', () => {
        state.codeExecutionEnabled = true;
        syncQuickToggles();
        expect(document.getElementById('toggle-code-exec').classList.contains('active')).toBe(true);
    });

    it('同步 computer-use 按钮状态', () => {
        state.computerUseEnabled = true;
        syncQuickToggles();
        expect(document.getElementById('toggle-computer-use').classList.contains('active')).toBe(
            true
        );
    });

    it('元素不存在时不报错', () => {
        document.body.innerHTML = '';
        expect(() => syncQuickToggles()).not.toThrow();
    });
});

describe('exposeToggleFunctions', () => {
    it('暴露 toggleThinking 到 window', () => {
        exposeToggleFunctions();
        expect(typeof window.toggleThinking).toBe('function');
    });

    it('暴露 handleThinkingKeydown 到 window', () => {
        exposeToggleFunctions();
        expect(typeof window.handleThinkingKeydown).toBe('function');
    });

    it('toggleThinking 切换 collapsed class', () => {
        exposeToggleFunctions();
        const block = document.createElement('div');
        const header = document.createElement('div');
        header.setAttribute = vi.fn();
        block.appendChild(header);
        document.body.appendChild(block);

        window.toggleThinking(header);
        expect(block.classList.contains('collapsed')).toBe(true);

        window.toggleThinking(header);
        expect(block.classList.contains('collapsed')).toBe(false);
    });

    it('handleThinkingKeydown 响应 Enter', () => {
        exposeToggleFunctions();
        const block = document.createElement('div');
        const header = document.createElement('div');
        header.setAttribute = vi.fn();
        block.appendChild(header);
        document.body.appendChild(block);

        const event = { key: 'Enter', preventDefault: vi.fn() };
        window.handleThinkingKeydown(event, header);
        expect(event.preventDefault).toHaveBeenCalled();
        expect(block.classList.contains('collapsed')).toBe(true);
    });

    it('handleThinkingKeydown 响应 Space', () => {
        exposeToggleFunctions();
        const block = document.createElement('div');
        const header = document.createElement('div');
        header.setAttribute = vi.fn();
        block.appendChild(header);

        const event = { key: ' ', preventDefault: vi.fn() };
        window.handleThinkingKeydown(event, header);
        expect(event.preventDefault).toHaveBeenCalled();
    });

    it('handleThinkingKeydown 忽略其他键', () => {
        exposeToggleFunctions();
        const block = document.createElement('div');
        const header = document.createElement('div');
        block.appendChild(header);

        const event = { key: 'a', preventDefault: vi.fn() };
        window.handleThinkingKeydown(event, header);
        expect(event.preventDefault).not.toHaveBeenCalled();
    });
});

describe('initQuickToggles', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        state.streamEnabled = false;
        state.thinkingEnabled = false;
        state.webSearchEnabled = false;
        document.body.innerHTML = `
            <button id="toggle-stream"></button>
            <button id="toggle-thinking"></button>
            <button id="toggle-websearch"></button>
            <input type="checkbox" id="stream-enabled" />
            <input type="checkbox" id="thinking-enabled" />
            <div id="thinking-strength-group"></div>
            <div id="thinking-hint"></div>
            <div id="claude-adaptive-row"></div>
            <div id="thinking-budget-group"></div>
            <input type="checkbox" id="web-search-enabled" />
        `;
    });

    it('不抛错', () => {
        expect(() => initQuickToggles()).not.toThrow();
    });

    it('元素不存在时不抛错', () => {
        document.body.innerHTML = '';
        expect(() => initQuickToggles()).not.toThrow();
    });

    it('stream 按钮点击翻转 state.streamEnabled', () => {
        state.streamEnabled = false;
        initQuickToggles();
        const btn = document.getElementById('toggle-stream');
        btn.click();
        expect(state.streamEnabled).toBe(true);
        expect(saveCurrentConfig).toHaveBeenCalled();
    });

    it('thinking 按钮点击翻转 state.thinkingEnabled', () => {
        state.thinkingEnabled = false;
        initQuickToggles();
        const btn = document.getElementById('toggle-thinking');
        btn.click();
        expect(state.thinkingEnabled).toBe(true);
        expect(saveCurrentConfig).toHaveBeenCalled();
    });

    it('websearch 按钮点击翻转 state.webSearchEnabled', () => {
        state.webSearchEnabled = false;
        initQuickToggles();
        const btn = document.getElementById('toggle-websearch');
        btn.click();
        expect(state.webSearchEnabled).toBe(true);
    });

    it('stream 按钮同步设置面板 checkbox', () => {
        state.streamEnabled = false;
        initQuickToggles();
        document.getElementById('toggle-stream').click();
        const panelSwitch = document.getElementById('stream-enabled');
        expect(panelSwitch.checked).toBe(true);
    });

    it('thinking 按钮同步 strength-group 显隐', () => {
        state.thinkingEnabled = false;
        initQuickToggles();
        document.getElementById('toggle-thinking').click();
        const strengthGroup = document.getElementById('thinking-strength-group');
        expect(strengthGroup.style.display).toBe('flex');
    });
});
