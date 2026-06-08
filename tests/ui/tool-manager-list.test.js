/**
 * tool-manager-list.js 工具列表渲染测试
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../js/tools/manager.js', () => ({
    getAllTools: vi.fn(() => []),
    isToolEnabled: vi.fn(() => true),
    setToolEnabled: vi.fn(),
    getTool: vi.fn(() => null)
}));

vi.mock('../../js/ui/notifications.js', () => ({
    showNotification: vi.fn()
}));

vi.mock('../../js/utils/helpers.js', () => ({
    escapeHtml: vi.fn((s) => s)
}));

vi.mock('../../js/utils/icons.js', () => ({
    getIcon: vi.fn(() => '<svg></svg>')
}));

import { getAllTools, isToolEnabled, setToolEnabled, getTool } from '../../js/tools/manager.js';
import { showNotification } from '../../js/ui/notifications.js';
import { renderToolsList, handleToolSearch } from '../../js/ui/tool-manager-list.js';

describe('tool-manager-list', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        document.body.innerHTML = '';
    });

    afterEach(() => {
        document.body.innerHTML = '';
    });

    describe('renderToolsList', () => {
        it('容器不存在静默返回', () => {
            const modal = document.createElement('div');
            expect(() => renderToolsList(modal, null, vi.fn())).not.toThrow();
        });

        it('空工具列表渲染空分组', () => {
            const modal = document.createElement('div');
            modal.innerHTML = '<div id="tools-list-container"></div>';
            getAllTools.mockReturnValue([]);

            renderToolsList(modal, null, vi.fn());
            const groups = modal.querySelectorAll('.tool-group');
            expect(groups.length).toBe(0);
        });

        it('渲染 builtin 工具', () => {
            const modal = document.createElement('div');
            modal.innerHTML = '<div id="tools-list-container"></div>';
            getAllTools.mockReturnValue([
                { id: 'web_search', name: 'Web Search', type: 'builtin' }
            ]);

            renderToolsList(modal, null, vi.fn());
            const items = modal.querySelectorAll('.tool-item');
            expect(items.length).toBe(1);
        });

        it('按类型分组渲染', () => {
            const modal = document.createElement('div');
            modal.innerHTML = '<div id="tools-list-container"></div>';
            getAllTools.mockReturnValue([
                { id: 't1', name: 'Builtin', type: 'builtin' },
                { id: 't2', name: 'MCP', type: 'mcp' },
                { id: 't3', name: 'Custom', type: 'custom' }
            ]);

            renderToolsList(modal, null, vi.fn());
            const groups = modal.querySelectorAll('.tool-group');
            expect(groups.length).toBe(3);
        });

        it('过滤 hidden 工具', () => {
            const modal = document.createElement('div');
            modal.innerHTML = '<div id="tools-list-container"></div>';
            getAllTools.mockReturnValue([
                { id: 't1', name: 'Visible', type: 'builtin' },
                { id: 't2', name: 'Hidden', type: 'builtin', hidden: true }
            ]);

            renderToolsList(modal, null, vi.fn());
            const items = modal.querySelectorAll('.tool-item');
            expect(items.length).toBe(1);
        });

        it('点击工具项调用 onSelectTool', () => {
            const modal = document.createElement('div');
            modal.innerHTML = '<div id="tools-list-container"></div>';
            getAllTools.mockReturnValue([{ id: 'web_search', name: 'Search', type: 'builtin' }]);
            const onSelect = vi.fn();

            renderToolsList(modal, null, onSelect);
            modal.querySelector('.tool-item').click();
            expect(onSelect).toHaveBeenCalledWith('web_search');
        });

        it('开关切换调用 setToolEnabled', () => {
            const modal = document.createElement('div');
            modal.innerHTML = '<div id="tools-list-container"></div>';
            getAllTools.mockReturnValue([{ id: 'calc', name: 'Calculator', type: 'builtin' }]);

            renderToolsList(modal, null, vi.fn());
            const switchEl = modal.querySelector('.tool-enable-switch');
            switchEl.checked = false;
            switchEl.dispatchEvent(new Event('change', { bubbles: true }));
            expect(setToolEnabled).toHaveBeenCalledWith('calc', false);
            expect(showNotification).toHaveBeenCalled();
        });

        it('选中的工具标记 selected', () => {
            const modal = document.createElement('div');
            modal.innerHTML = '<div id="tools-list-container"></div>';
            getAllTools.mockReturnValue([
                { id: 't1', name: 'Tool1', type: 'builtin' },
                { id: 't2', name: 'Tool2', type: 'builtin' }
            ]);

            renderToolsList(modal, 't2', vi.fn());
            const selected = modal.querySelector('.tool-item.selected');
            expect(selected.dataset.toolId).toBe('t2');
        });
    });

    describe('handleToolSearch', () => {
        it('按名称搜索', () => {
            const modal = document.createElement('div');
            modal.innerHTML = `
                <div class="tool-group">
                    <div class="tool-item" data-tool-id="t1" style="display: flex"></div>
                    <div class="tool-item" data-tool-id="t2" style="display: flex"></div>
                </div>
            `;
            getTool.mockImplementation((id) => {
                if (id === 't1') return { name: 'Web Search', description: '' };
                if (id === 't2') return { name: 'Calculator', description: '' };
                return null;
            });

            handleToolSearch(modal, { target: { value: 'web' } });
            const items = modal.querySelectorAll('.tool-item');
            expect(items[0].style.display).toBe('flex');
            expect(items[1].style.display).toBe('none');
        });

        it('按描述搜索', () => {
            const modal = document.createElement('div');
            modal.innerHTML = `
                <div class="tool-group">
                    <div class="tool-item" data-tool-id="t1" style="display: flex"></div>
                </div>
            `;
            getTool.mockReturnValue({ name: 'Tool', description: 'searches the internet' });

            handleToolSearch(modal, { target: { value: 'internet' } });
            expect(modal.querySelector('.tool-item').style.display).toBe('flex');
        });

        it('空搜索显示全部', () => {
            const modal = document.createElement('div');
            modal.innerHTML = `
                <div class="tool-group">
                    <div class="tool-item" data-tool-id="t1" style="display: none"></div>
                </div>
            `;
            getTool.mockReturnValue({ name: 'Tool', description: 'desc' });

            handleToolSearch(modal, { target: { value: '' } });
            expect(modal.querySelector('.tool-item').style.display).toBe('flex');
        });

        it('工具不存在时隐藏', () => {
            const modal = document.createElement('div');
            modal.innerHTML = `
                <div class="tool-group">
                    <div class="tool-item" data-tool-id="unknown" style="display: flex"></div>
                </div>
            `;
            getTool.mockReturnValue(null);

            handleToolSearch(modal, { target: { value: 'test' } });
            expect(modal.querySelector('.tool-item').style.display).toBe('none');
        });
    });
});
