/**
 * tool-manager.js 测试
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../js/core/events.js', () => ({
    eventBus: { emit: vi.fn(), on: vi.fn(), off: vi.fn() }
}));

vi.mock('../../js/utils/dialogs.js', () => ({
    showConfirmDialog: vi.fn(() => Promise.resolve(true))
}));

vi.mock('../../js/utils/modal-stack.js', () => ({
    bindTopmostEscape: vi.fn(() => vi.fn()),
    setupModalFocus: vi.fn(() => vi.fn())
}));

vi.mock('../../js/ui/tool-manager-list.js', () => ({
    renderToolsList: vi.fn(),
    handleToolSearch: vi.fn()
}));

vi.mock('../../js/ui/tool-manager-config.js', () => ({
    showToolForm: vi.fn(),
    showEmptyState: vi.fn(),
    handleValidateSchema: vi.fn(),
    handleTestTool: vi.fn(),
    handleDeleteTool: vi.fn(),
    handleSaveTool: vi.fn(),
    loadPermissionsTab: vi.fn(),
    loadHistoryTab: vi.fn(),
    getTestDialogCleanup: vi.fn(() => null)
}));

vi.mock('../../js/utils/logger.js', () => ({
    logger: { warn: vi.fn(), debug: vi.fn(), error: vi.fn(), info: vi.fn() }
}));

import { eventBus } from '../../js/core/events.js';
import { renderToolsList } from '../../js/ui/tool-manager-list.js';
import {
    showEmptyState,
    loadPermissionsTab,
    loadHistoryTab
} from '../../js/ui/tool-manager-config.js';
import { initToolManager, openModal, closeModal, selectTool } from '../../js/ui/tool-manager.js';

describe('tool-manager', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        document.body.innerHTML = `
            <div id="tool-manager-modal">
                <button class="close-tool-manager"></button>
                <div class="tool-manager-content">
                    <div class="tab-btn" data-tab="tools">工具</div>
                    <div class="tab-btn" data-tab="permissions">权限</div>
                    <div class="tab-btn" data-tab="history">历史</div>
                    <div class="tab-content" data-tab="tools"></div>
                    <div class="tab-content" data-tab="permissions"></div>
                    <div class="tab-content" data-tab="history"></div>
                    <input id="tool-search-input" />
                    <button id="add-custom-tool-btn"></button>
                </div>
            </div>
            <button id="tools-manager-toggle"></button>
            <button id="tool-mobile-back-btn"></button>
        `;
    });

    afterEach(() => {
        document.body.innerHTML = '';
    });

    // ========== initToolManager ==========
    describe('initToolManager', () => {
        it('初始化不抛错', () => {
            expect(() => initToolManager()).not.toThrow();
        });

        it('注册事件监听器', () => {
            initToolManager();
            const events = eventBus.on.mock.calls.map((c) => c[0]);
            expect(events).toContain('tool:registered');
            expect(events).toContain('tool:enabled:changed');
            expect(events).toContain('tool:removed');
            expect(events).toContain('tools:updated');
            expect(events).toContain('tools:manage:open');
        });

        it('modal 不存在不抛错', () => {
            document.body.innerHTML = '';
            expect(() => initToolManager()).not.toThrow();
        });
    });

    // ========== openModal ==========
    describe('openModal', () => {
        it('添加 active 类', () => {
            initToolManager();
            openModal();
            const modal = document.getElementById('tool-manager-modal');
            expect(modal.classList.contains('active')).toBe(true);
        });

        it('调用 renderToolsList', () => {
            initToolManager();
            openModal();
            expect(renderToolsList).toHaveBeenCalled();
        });

        it('调用 showEmptyState', () => {
            initToolManager();
            openModal();
            expect(showEmptyState).toHaveBeenCalled();
        });

        it('发出 tool-manager:opened 事件', () => {
            initToolManager();
            openModal();
            expect(eventBus.emit).toHaveBeenCalledWith('tool-manager:opened');
        });

        it('modal 为 null 静默返回', () => {
            document.body.innerHTML = '';
            initToolManager();
            expect(() => openModal()).not.toThrow();
        });
    });

    // ========== closeModal ==========
    describe('closeModal', () => {
        it('移除 active 类', () => {
            initToolManager();
            openModal();
            closeModal();
            const modal = document.getElementById('tool-manager-modal');
            expect(modal.classList.contains('active')).toBe(false);
        });
    });

    // ========== selectTool ==========
    describe('selectTool', () => {
        it('设置 tool-item 为 selected', () => {
            initToolManager();

            const modal = document.getElementById('tool-manager-modal');
            const toolItem = document.createElement('div');
            toolItem.className = 'tool-item';
            toolItem.dataset.toolId = 'calc';
            modal.appendChild(toolItem);

            selectTool('calc');
            expect(toolItem.classList.contains('selected')).toBe(true);
        });

        it('取消其他 tool-item 的 selected', () => {
            initToolManager();

            const modal = document.getElementById('tool-manager-modal');
            const item1 = document.createElement('div');
            item1.className = 'tool-item selected';
            item1.dataset.toolId = 'a';
            const item2 = document.createElement('div');
            item2.className = 'tool-item';
            item2.dataset.toolId = 'b';
            modal.append(item1, item2);

            selectTool('b');
            expect(item1.classList.contains('selected')).toBe(false);
            expect(item2.classList.contains('selected')).toBe(true);
        });
    });

    // ========== tab 切换 ==========
    describe('tab 切换', () => {
        it('点击 permissions tab 调用 loadPermissionsTab', () => {
            initToolManager();
            const permissionsTab = document.querySelector('[data-tab="permissions"].tab-btn');
            permissionsTab.click();
            expect(loadPermissionsTab).toHaveBeenCalled();
        });

        it('点击 history tab 调用 loadHistoryTab', () => {
            initToolManager();
            const historyTab = document.querySelector('[data-tab="history"].tab-btn');
            historyTab.click();
            expect(loadHistoryTab).toHaveBeenCalled();
        });
    });

    // ========== 关闭按钮 ==========
    describe('关闭按钮', () => {
        it('点击关闭按钮关闭模态框', () => {
            initToolManager();
            openModal();

            const closeBtn = document.querySelector('.close-tool-manager');
            closeBtn.click();

            const modal = document.getElementById('tool-manager-modal');
            expect(modal.classList.contains('active')).toBe(false);
        });

        it('toggle 按钮打开模态框', () => {
            initToolManager();

            const toggleBtn = document.getElementById('tools-manager-toggle');
            toggleBtn.click();

            const modal = document.getElementById('tool-manager-modal');
            expect(modal.classList.contains('active')).toBe(true);
        });
    });
});
