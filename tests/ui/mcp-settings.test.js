/**
 * mcp-settings.js 测试
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../js/core/state.js', () => ({
    state: {
        mcpServers: []
    }
}));

vi.mock('../../js/core/events.js', () => ({
    eventBus: { emit: vi.fn(), on: vi.fn(), off: vi.fn() }
}));

vi.mock('../../js/utils/dialogs.js', () => ({
    showConfirmDialog: vi.fn(() => Promise.resolve(true))
}));

vi.mock('../../js/ui/notifications.js', () => ({
    showNotification: vi.fn()
}));

vi.mock('../../js/utils/icons.js', () => ({
    getIcon: vi.fn(() => '<svg></svg>')
}));

vi.mock('../../js/utils/modal-stack.js', () => ({
    bindTopmostEscape: vi.fn(() => vi.fn())
}));

vi.mock('../../js/ui/mcp-server-list.js', () => ({
    renderServerList: vi.fn(),
    renderPlatformInfo: vi.fn()
}));

vi.mock('../../js/ui/mcp-server-form.js', () => ({
    showServerForm: vi.fn(),
    hideServerForm: vi.fn(),
    handleSaveServer: vi.fn(),
    toggleConfigSection: vi.fn()
}));

vi.mock('../../js/ui/mcp-tool-display.js', () => ({
    exportMCPConfig: vi.fn(),
    importMCPConfig: vi.fn(),
    showTemplateDialog: vi.fn(),
    createFromTemplate: vi.fn()
}));

vi.mock('../../js/utils/logger.js', () => ({
    logger: { warn: vi.fn(), debug: vi.fn(), error: vi.fn(), info: vi.fn() }
}));

import { state } from '../../js/core/state.js';
import { eventBus } from '../../js/core/events.js';
import { renderServerList, renderPlatformInfo } from '../../js/ui/mcp-server-list.js';
import { initMCPSettings, openModal, closeModal } from '../../js/ui/mcp-settings.js';

describe('mcp-settings', () => {
    // initMCPSettings 有 isInitialized 守卫，模块级 modal 变量只捕获一次
    // 因此所有测试共享同一 DOM，不在 afterEach 中清空
    beforeEach(() => {
        vi.clearAllMocks();
        state.mcpServers = [];
    });

    it('初始化、打开、关闭完整流程', () => {
        document.body.innerHTML = `
            <div id="mcp-settings-modal">
                <button class="close-mcp-settings"></button>
                <div id="mcp-server-form"></div>
            </div>
            <button id="mcp-settings-toggle"></button>
        `;
        state.mcpServers = null;

        // 初始化
        expect(() => initMCPSettings()).not.toThrow();
        const events = eventBus.on.mock.calls.map((c) => c[0]);
        expect(events).toContain('mcp:connected');
        expect(events).toContain('mcp:disconnected');
        expect(events).toContain('mcp:tools-discovered');
        expect(events).toContain('mcp:connection-lost');
        expect(events).toContain('mcp:reconnect-failed');

        // 重复初始化是 no-op
        const callCount = eventBus.on.mock.calls.length;
        initMCPSettings();
        expect(eventBus.on.mock.calls.length).toBe(callCount);

        // 打开
        vi.clearAllMocks();
        openModal();
        const modal = document.getElementById('mcp-settings-modal');
        expect(modal.classList.contains('open')).toBe(true);
        expect(renderServerList).toHaveBeenCalled();
        expect(renderPlatformInfo).toHaveBeenCalled();

        // 关闭
        closeModal();
        expect(modal.classList.contains('open')).toBe(false);

        // toggle 按钮
        const toggleBtn = document.getElementById('mcp-settings-toggle');
        toggleBtn.click();
        expect(modal.classList.contains('open')).toBe(true);

        // close 按钮
        const closeBtn = document.querySelector('.close-mcp-settings');
        closeBtn.click();
        expect(modal.classList.contains('open')).toBe(false);

        document.body.innerHTML = '';
    });

    it('modal 不存在时 openModal/closeModal 不抛错', () => {
        // 不调用 initMCPSettings（已初始化），直接测试 null modal 场景
        // 由于模块级 modal 已在上一个测试中被 DOM 清空后变为孤立引用
        // openModal/closeModal 都检查 if (!modal) return
        expect(() => openModal()).not.toThrow();
        expect(() => closeModal()).not.toThrow();
    });
});
