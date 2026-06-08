/**
 * tool-manager-config.js 测试
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../js/tools/manager.js', () => ({
    getTool: vi.fn(() => null),
    registerCustomTool: vi.fn(),
    removeTool: vi.fn(),
    getAllTools: vi.fn(() => []),
    isToolEnabled: vi.fn(() => false),
    setToolEnabled: vi.fn()
}));

vi.mock('../../js/tools/history.js', () => ({
    getToolHistory: vi.fn(() => []),
    clearToolHistory: vi.fn()
}));

vi.mock('../../js/state/sessions.js', () => ({
    debouncedSaveSession: vi.fn()
}));

vi.mock('../../js/ui/notifications.js', () => ({
    showNotification: vi.fn()
}));

vi.mock('../../js/utils/dialogs.js', () => ({
    showConfirmDialog: vi.fn(() => Promise.resolve(true))
}));

vi.mock('../../js/utils/helpers.js', () => ({
    escapeHtml: vi.fn((s) => s || '')
}));

vi.mock('../../js/utils/icons.js', () => ({
    getIcon: vi.fn(() => '<svg></svg>')
}));

vi.mock('../../js/utils/modal-stack.js', () => ({
    bindTopmostEscape: vi.fn(() => vi.fn()),
    getFocusableElements: vi.fn(() => []),
    setupModalFocus: vi.fn(() => vi.fn())
}));

vi.mock('../../js/utils/logger.js', () => ({
    logger: { warn: vi.fn(), debug: vi.fn(), error: vi.fn(), info: vi.fn() }
}));

import {
    getTool,
    registerCustomTool,
    removeTool,
    getAllTools,
    isToolEnabled,
    setToolEnabled
} from '../../js/tools/manager.js';
import { getToolHistory, clearToolHistory } from '../../js/tools/history.js';
import { debouncedSaveSession } from '../../js/state/sessions.js';
import { showNotification } from '../../js/ui/notifications.js';
import { showConfirmDialog } from '../../js/utils/dialogs.js';
import {
    showToolForm,
    showEmptyState,
    handleValidateSchema,
    handleTestTool,
    handleDeleteTool,
    handleSaveTool,
    loadPermissionsTab,
    loadHistoryTab,
    getTestDialogCleanup
} from '../../js/ui/tool-manager-config.js';

describe('tool-manager-config', () => {
    let modal;

    beforeEach(() => {
        vi.clearAllMocks();
        document.body.innerHTML = `
            <div id="tool-manager-modal">
                <div id="tool-detail-container"></div>
            </div>
        `;
        modal = document.getElementById('tool-manager-modal');
    });

    afterEach(() => {
        document.body.innerHTML = '';
    });

    // ========== getTestDialogCleanup ==========
    describe('getTestDialogCleanup', () => {
        it('初始值为 null', () => {
            expect(getTestDialogCleanup()).toBeNull();
        });
    });

    // ========== showEmptyState ==========
    describe('showEmptyState', () => {
        it('渲染空状态 UI', () => {
            showEmptyState(modal);
            const container = modal.querySelector('#tool-detail-container');
            expect(container.innerHTML).toContain('选择工具查看详情');
            expect(container.querySelector('.empty-state')).toBeTruthy();
        });

        it('无容器静默返回', () => {
            document.body.innerHTML = '<div id="tool-manager-modal"></div>';
            modal = document.getElementById('tool-manager-modal');
            expect(() => showEmptyState(modal)).not.toThrow();
        });
    });

    // ========== showToolForm ==========
    describe('showToolForm', () => {
        it('工具不存在调用 showEmptyState', () => {
            getTool.mockReturnValue(null);
            const callbacks = {
                onEditingChange: vi.fn(),
                showEmptyState: vi.fn(),
                bindFormButtons: vi.fn()
            };

            const result = showToolForm(modal, 'nonexistent', callbacks);
            expect(result).toBe(false);
            expect(callbacks.showEmptyState).toHaveBeenCalled();
        });

        it('渲染内置工具表单（只读）', () => {
            getTool.mockReturnValue({
                id: 'calc',
                name: 'Calculator',
                type: 'builtin',
                description: 'Math tool',
                parameters: { type: 'object', properties: {} }
            });
            const callbacks = {
                onEditingChange: vi.fn(),
                showEmptyState: vi.fn(),
                bindFormButtons: vi.fn()
            };

            const result = showToolForm(modal, 'calc', callbacks);
            expect(result).toBe(true);
            expect(callbacks.onEditingChange).toHaveBeenCalledWith(false);
            expect(callbacks.bindFormButtons).toHaveBeenCalled();

            const nameInput = modal.querySelector('#tool-name-input');
            expect(nameInput).toBeTruthy();
            expect(nameInput.readOnly).toBe(true);
        });

        it('渲染自定义工具表单（可编辑）', () => {
            getTool.mockReturnValue({
                id: 'custom1',
                name: 'My Tool',
                type: 'custom',
                description: 'Custom tool desc',
                parameters: { type: 'object', properties: {} }
            });
            const callbacks = {
                onEditingChange: vi.fn(),
                showEmptyState: vi.fn(),
                bindFormButtons: vi.fn()
            };

            const result = showToolForm(modal, 'custom1', callbacks);
            expect(result).toBe(true);

            const nameInput = modal.querySelector('#tool-name-input');
            expect(nameInput.readOnly).toBe(false);

            // 有保存/删除按钮
            expect(modal.querySelector('#save-tool-btn')).toBeTruthy();
            expect(modal.querySelector('#delete-tool-btn')).toBeTruthy();

            // 输入变化触发 onEditingChange
            vi.clearAllMocks();
            nameInput.dispatchEvent(new Event('input'));
            expect(callbacks.onEditingChange).toHaveBeenCalledWith(true);
        });

        it('直接传入工具对象', () => {
            const toolObj = {
                id: 'direct',
                name: 'Direct Tool',
                type: 'custom',
                description: '',
                parameters: {}
            };
            const callbacks = {
                onEditingChange: vi.fn(),
                showEmptyState: vi.fn(),
                bindFormButtons: vi.fn()
            };

            const result = showToolForm(modal, toolObj, callbacks);
            expect(result).toBe(true);
        });

        it('无容器返回 false', () => {
            document.body.innerHTML = '<div id="tool-manager-modal"></div>';
            modal = document.getElementById('tool-manager-modal');
            getTool.mockReturnValue({ id: 'x', name: 'X', type: 'builtin', parameters: {} });
            const callbacks = {
                onEditingChange: vi.fn(),
                showEmptyState: vi.fn(),
                bindFormButtons: vi.fn()
            };
            expect(showToolForm(modal, 'x', callbacks)).toBe(false);
        });
    });

    // ========== handleValidateSchema ==========
    describe('handleValidateSchema', () => {
        it('有效 schema 显示成功', () => {
            document.body.innerHTML = `
                <div id="tool-manager-modal">
                    <textarea id="tool-schema-input">{"type": "object", "properties": {}}</textarea>
                    <div id="schema-validation-result"></div>
                </div>
            `;
            modal = document.getElementById('tool-manager-modal');

            handleValidateSchema(modal);

            const result = modal.querySelector('#schema-validation-result');
            expect(result.className).toContain('success');
        });

        it('无效 JSON 显示错误', () => {
            document.body.innerHTML = `
                <div id="tool-manager-modal">
                    <textarea id="tool-schema-input">{invalid json}</textarea>
                    <div id="schema-validation-result"></div>
                </div>
            `;
            modal = document.getElementById('tool-manager-modal');

            handleValidateSchema(modal);

            const result = modal.querySelector('#schema-validation-result');
            expect(result.className).toContain('error');
        });

        it('非 object 类型显示错误', () => {
            document.body.innerHTML = `
                <div id="tool-manager-modal">
                    <textarea id="tool-schema-input">{"type": "array"}</textarea>
                    <div id="schema-validation-result"></div>
                </div>
            `;
            modal = document.getElementById('tool-manager-modal');

            handleValidateSchema(modal);

            const result = modal.querySelector('#schema-validation-result');
            expect(result.className).toContain('error');
        });

        it('无输入元素静默返回', () => {
            document.body.innerHTML = '<div id="tool-manager-modal"></div>';
            modal = document.getElementById('tool-manager-modal');
            expect(() => handleValidateSchema(modal)).not.toThrow();
        });
    });

    // ========== handleTestTool ==========
    describe('handleTestTool', () => {
        it('无选中工具显示错误通知', async () => {
            await handleTestTool(null);
            expect(showNotification).toHaveBeenCalledWith('请先选择要测试的工具', 'error');
        });

        it('工具不存在显示错误通知', async () => {
            getTool.mockReturnValue(null);
            await handleTestTool('nonexistent');
            expect(showNotification).toHaveBeenCalledWith('工具不存在', 'error');
        });
    });

    // ========== handleDeleteTool ==========
    describe('handleDeleteTool', () => {
        it('无选中工具静默返回', async () => {
            const onDeleted = vi.fn();
            await handleDeleteTool(null, onDeleted);
            expect(onDeleted).not.toHaveBeenCalled();
        });

        it('工具不存在静默返回', async () => {
            getTool.mockReturnValue(null);
            const onDeleted = vi.fn();
            await handleDeleteTool('x', onDeleted);
            expect(onDeleted).not.toHaveBeenCalled();
        });

        it('用户确认后删除', async () => {
            getTool.mockReturnValue({ id: 'custom1', name: 'My Tool' });
            showConfirmDialog.mockResolvedValue(true);
            const onDeleted = vi.fn();

            await handleDeleteTool('custom1', onDeleted);

            expect(removeTool).toHaveBeenCalledWith('custom1');
            expect(debouncedSaveSession).toHaveBeenCalled();
            expect(showNotification).toHaveBeenCalled();
            expect(onDeleted).toHaveBeenCalled();
        });

        it('用户取消不删除', async () => {
            getTool.mockReturnValue({ id: 'custom1', name: 'My Tool' });
            showConfirmDialog.mockResolvedValue(false);
            const onDeleted = vi.fn();

            await handleDeleteTool('custom1', onDeleted);

            expect(removeTool).not.toHaveBeenCalled();
            expect(onDeleted).not.toHaveBeenCalled();
        });
    });

    // ========== handleSaveTool ==========
    describe('handleSaveTool', () => {
        function setupSaveForm(
            name = 'my_tool',
            desc = 'desc',
            schema = '{"type":"object","properties":{}}'
        ) {
            document.body.innerHTML = `
                <div id="tool-manager-modal">
                    <input id="tool-name-input" value="${name}" />
                    <textarea id="tool-description-input">${desc}</textarea>
                    <textarea id="tool-schema-input">${schema}</textarea>
                    <input type="checkbox" id="require-approval-checkbox" />
                    <input type="checkbox" id="allow-filesystem-checkbox" />
                    <input type="checkbox" id="allow-network-checkbox" />
                    <input type="number" id="rate-limit-max-input" value="10" />
                    <input type="number" id="rate-limit-window-input" value="1" />
                    <select id="rate-limit-unit-select"><option value="minute">分钟</option></select>
                </div>
            `;
            return document.getElementById('tool-manager-modal');
        }

        it('名称为空显示错误', async () => {
            modal = setupSaveForm('', 'desc');
            const onSaved = vi.fn();
            await handleSaveTool(modal, 'tool1', onSaved);
            expect(showNotification).toHaveBeenCalledWith('请输入工具名称', 'error');
            expect(onSaved).not.toHaveBeenCalled();
        });

        it('描述为空显示错误', async () => {
            modal = setupSaveForm('name', '');
            const onSaved = vi.fn();
            await handleSaveTool(modal, 'tool1', onSaved);
            expect(showNotification).toHaveBeenCalledWith('请输入工具描述', 'error');
            expect(onSaved).not.toHaveBeenCalled();
        });

        it('无效 schema 显示错误', async () => {
            modal = setupSaveForm('name', 'desc', '{bad json}');
            const onSaved = vi.fn();
            await handleSaveTool(modal, 'tool1', onSaved);
            expect(showNotification).toHaveBeenCalledWith(
                expect.stringContaining('Schema 格式错误'),
                'error'
            );
        });

        it('非 object schema 显示错误', async () => {
            modal = setupSaveForm('name', 'desc', '{"type":"array"}');
            const onSaved = vi.fn();
            await handleSaveTool(modal, 'tool1', onSaved);
            expect(showNotification).toHaveBeenCalledWith(
                expect.stringContaining('Schema 格式错误'),
                'error'
            );
        });

        it('成功保存工具', async () => {
            modal = setupSaveForm('my_tool', 'A test tool');
            const onSaved = vi.fn();
            await handleSaveTool(modal, 'tool1', onSaved);

            expect(registerCustomTool).toHaveBeenCalled();
            expect(debouncedSaveSession).toHaveBeenCalled();
            expect(showNotification).toHaveBeenCalledWith('工具已保存', 'success');
            expect(onSaved).toHaveBeenCalled();
        });

        it('注册失败显示错误', async () => {
            modal = setupSaveForm('my_tool', 'desc');
            registerCustomTool.mockImplementation(() => {
                throw new Error('dup');
            });
            const onSaved = vi.fn();
            await handleSaveTool(modal, 'tool1', onSaved);
            expect(showNotification).toHaveBeenCalledWith(
                expect.stringContaining('保存失败'),
                'error'
            );
            expect(onSaved).not.toHaveBeenCalled();
        });

        it('无输入元素静默返回', async () => {
            document.body.innerHTML = '<div id="tool-manager-modal"></div>';
            modal = document.getElementById('tool-manager-modal');
            await handleSaveTool(modal, 'tool1', vi.fn());
            expect(registerCustomTool).not.toHaveBeenCalled();
        });
    });

    // ========== loadPermissionsTab ==========
    describe('loadPermissionsTab', () => {
        it('无容器静默返回', () => {
            expect(() => loadPermissionsTab()).not.toThrow();
        });

        it('空工具显示提示', () => {
            document.body.innerHTML += '<div id="permissions-list-container"></div>';
            getAllTools.mockReturnValue([]);
            loadPermissionsTab();
            const container = document.getElementById('permissions-list-container');
            expect(container.innerHTML).toContain('暂无工具');
        });

        it('渲染工具权限列表', () => {
            document.body.innerHTML += '<div id="permissions-list-container"></div>';
            getAllTools.mockReturnValue([
                { id: 'calc', name: 'Calculator', type: 'builtin' },
                { id: 'ws', name: 'Web Search', type: 'builtin' }
            ]);
            isToolEnabled.mockImplementation((id) => id === 'calc');

            loadPermissionsTab();

            const container = document.getElementById('permissions-list-container');
            const items = container.querySelectorAll('.permission-item');
            expect(items.length).toBe(2);

            // 切换权限
            const checkbox = container.querySelector('input[type="checkbox"]');
            checkbox.checked = false;
            checkbox.dispatchEvent(new Event('change'));
            expect(setToolEnabled).toHaveBeenCalled();
            expect(showNotification).toHaveBeenCalled();
        });

        it('过滤隐藏工具', () => {
            document.body.innerHTML += '<div id="permissions-list-container"></div>';
            getAllTools.mockReturnValue([
                { id: 'a', name: 'A', type: 'builtin' },
                { id: 'b', name: 'B', type: 'builtin', hidden: true }
            ]);

            loadPermissionsTab();

            const items = document.querySelectorAll('.permission-item');
            expect(items.length).toBe(1);
        });
    });

    // ========== loadHistoryTab ==========
    describe('loadHistoryTab', () => {
        it('无容器静默返回', () => {
            expect(() => loadHistoryTab()).not.toThrow();
        });

        it('空历史显示提示', () => {
            document.body.innerHTML += '<div id="history-list-container"></div>';
            getToolHistory.mockReturnValue([]);
            loadHistoryTab();
            const container = document.getElementById('history-list-container');
            expect(container.innerHTML).toContain('暂无执行历史');
        });

        it('渲染执行历史', () => {
            document.body.innerHTML += '<div id="history-list-container"></div>';
            getToolHistory.mockReturnValue([
                {
                    toolId: 'calc',
                    toolName: 'Calculator',
                    timestamp: Date.now(),
                    success: true,
                    duration: 50
                },
                {
                    toolId: 'ws',
                    toolName: 'Web Search',
                    timestamp: Date.now(),
                    success: false,
                    duration: 100
                }
            ]);

            loadHistoryTab();

            const container = document.getElementById('history-list-container');
            const items = container.querySelectorAll('.history-item');
            expect(items.length).toBe(2);
            expect(items[0].classList.contains('success')).toBe(true);
            expect(items[1].classList.contains('error')).toBe(true);
        });

        it('清空历史按钮', async () => {
            document.body.innerHTML += `
                <div id="history-list-container"></div>
                <button id="clear-history-btn"></button>
            `;
            getToolHistory.mockReturnValue([
                { toolId: 'calc', toolName: 'Calc', timestamp: Date.now(), success: true }
            ]);
            showConfirmDialog.mockResolvedValue(true);

            loadHistoryTab();

            const clearBtn = document.getElementById('clear-history-btn');
            await clearBtn.onclick();

            expect(clearToolHistory).toHaveBeenCalled();
            expect(showNotification).toHaveBeenCalledWith('执行历史已清空', 'success');
        });
    });
});
