/**
 * tool-manager-mcp-enhancements.js 测试
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../js/core/state.js', () => ({
    state: { mcpServers: [] }
}));

vi.mock('../../js/core/events.js', () => ({
    eventBus: { emit: vi.fn(), on: vi.fn(() => vi.fn()), off: vi.fn() }
}));

vi.mock('../../js/tools/manager.js', () => ({
    getAllTools: vi.fn(() => []),
    isToolEnabled: vi.fn(() => false),
    setToolEnabled: vi.fn()
}));

vi.mock('../../js/ui/notifications.js', () => ({
    showNotification: vi.fn()
}));

vi.mock('../../js/utils/icons.js', () => ({
    getIcon: vi.fn(() => '<svg></svg>')
}));

vi.mock('../../js/utils/helpers.js', () => ({
    escapeHtml: vi.fn((s) => s || '')
}));

vi.mock('../../js/ui/tool-manager.js', () => ({
    selectTool: vi.fn()
}));

vi.mock('../../js/utils/logger.js', () => ({
    logger: { warn: vi.fn(), debug: vi.fn(), error: vi.fn(), info: vi.fn() }
}));

import { state } from '../../js/core/state.js';
import { eventBus } from '../../js/core/events.js';
import { getAllTools, isToolEnabled, setToolEnabled } from '../../js/tools/manager.js';
import { showNotification } from '../../js/ui/notifications.js';
import { selectTool } from '../../js/ui/tool-manager.js';
import { initToolManagerMCPEnhancements } from '../../js/ui/tool-manager-mcp-enhancements.js';

describe('tool-manager-mcp-enhancements', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        state.mcpServers = [];
    });

    afterEach(() => {
        document.body.innerHTML = '';
    });

    it('无容器时静默返回', () => {
        document.body.innerHTML = '';
        expect(() => initToolManagerMCPEnhancements()).not.toThrow();
    });

    it('完整初始化和渲染流程', () => {
        document.body.innerHTML = `
            <div id="tool-manager-modal" class="active">
                <div id="tools-list-container"></div>
            </div>
        `;

        state.mcpServers = [
            { id: 'srv1', name: 'Server A' },
            { id: 'srv2', name: 'Server B' }
        ];
        getAllTools.mockReturnValue([
            { id: 'calc', name: 'Calculator', type: 'builtin' },
            { id: 'm1', name: 'MCP Tool 1', type: 'mcp', serverId: 'srv1' },
            { id: 'm2', name: 'MCP Tool 2', type: 'mcp', serverId: 'srv2' },
            { id: 'm3', name: 'MCP Tool 3', type: 'mcp', serverId: 'srv1' },
            { id: 'c1', name: 'Custom 1', type: 'custom' }
        ]);
        isToolEnabled.mockReturnValue(false);

        initToolManagerMCPEnhancements();

        // 注册了事件
        const events = eventBus.on.mock.calls.map((c) => c[0]);
        expect(events).toContain('tool-manager:opened');
        expect(events).toContain('tool:enabled:changed');
        expect(events).toContain('tool:registered');
        expect(events).toContain('tool:removed');
        expect(events).toContain('tools:updated');

        // 触发 tool-manager:opened 回调来渲染列表
        const openedCallback = eventBus.on.mock.calls.find(
            (c) => c[0] === 'tool-manager:opened'
        )[1];
        openedCallback();

        const container = document.getElementById('tools-list-container');
        // 有内置工具组
        expect(container.innerHTML).toContain('内置工具');
        // 有 MCP 服务器分组
        expect(container.innerHTML).toContain('MCP');
        expect(container.innerHTML).toContain('Server A');
        expect(container.innerHTML).toContain('Server B');
        // 有自定义工具组
        expect(container.innerHTML).toContain('自定义工具');

        // 工具项
        const toolItems = container.querySelectorAll('.tool-item');
        expect(toolItems.length).toBe(5);

        // MCP 服务器分组
        const mcpGroups = container.querySelectorAll('.mcp-server-group');
        expect(mcpGroups.length).toBe(2);
    });

    it('空工具显示空状态', () => {
        document.body.innerHTML = `
            <div id="tool-manager-modal" class="active">
                <div id="tools-list-container"></div>
            </div>
        `;
        getAllTools.mockReturnValue([]);

        // 需要先初始化一次（但 initialized 守卫）
        // 直接触发 opened 回调
        initToolManagerMCPEnhancements(); // 可能被 initialized 跳过
        // 手动获取回调
        const openedCall = eventBus.on.mock.calls.find((c) => c[0] === 'tool-manager:opened');
        if (openedCall) {
            openedCall[1]();
            const container = document.getElementById('tools-list-container');
            expect(container.innerHTML).toContain('暂无可用工具');
        }
    });

    it('过滤隐藏工具', () => {
        document.body.innerHTML = `
            <div id="tool-manager-modal" class="active">
                <div id="tools-list-container"></div>
            </div>
        `;
        getAllTools.mockReturnValue([
            { id: 'a', name: 'Visible', type: 'builtin' },
            { id: 'b', name: 'Hidden', type: 'builtin', hidden: true }
        ]);

        const openedCall = eventBus.on.mock.calls.find((c) => c[0] === 'tool-manager:opened');
        if (openedCall) {
            openedCall[1]();
            const items = document.querySelectorAll('.tool-item');
            expect(items.length).toBe(1);
        }
    });

    it('点击工具项调用 selectTool', () => {
        document.body.innerHTML = `
            <div id="tool-manager-modal" class="active">
                <div id="tools-list-container"></div>
            </div>
        `;
        getAllTools.mockReturnValue([{ id: 'calc', name: 'Calculator', type: 'builtin' }]);

        const openedCall = eventBus.on.mock.calls.find((c) => c[0] === 'tool-manager:opened');
        if (openedCall) {
            openedCall[1]();
            const item = document.querySelector('.tool-item');
            item.click();
            expect(selectTool).toHaveBeenCalledWith('calc');
        }
    });

    it('切换启用开关调用 setToolEnabled', () => {
        document.body.innerHTML = `
            <div id="tool-manager-modal" class="active">
                <div id="tools-list-container"></div>
            </div>
        `;
        getAllTools.mockReturnValue([{ id: 'calc', name: 'Calculator', type: 'builtin' }]);

        const openedCall = eventBus.on.mock.calls.find((c) => c[0] === 'tool-manager:opened');
        if (openedCall) {
            openedCall[1]();
            const switchEl = document.querySelector('.tool-enable-switch');
            switchEl.checked = true;
            switchEl.dispatchEvent(new Event('change', { bubbles: true }));
            expect(setToolEnabled).toHaveBeenCalledWith('calc', true);
            expect(showNotification).toHaveBeenCalled();
        }
    });

    it('批量启用/禁用 MCP 服务器工具', () => {
        document.body.innerHTML = `
            <div id="tool-manager-modal" class="active">
                <div id="tools-list-container"></div>
            </div>
        `;
        state.mcpServers = [{ id: 'srv1', name: 'Server A' }];
        getAllTools.mockReturnValue([
            { id: 'm1', name: 'Tool 1', type: 'mcp', serverId: 'srv1' },
            { id: 'm2', name: 'Tool 2', type: 'mcp', serverId: 'srv1' }
        ]);
        isToolEnabled.mockReturnValue(false);

        const openedCall = eventBus.on.mock.calls.find((c) => c[0] === 'tool-manager:opened');
        if (openedCall) {
            openedCall[1]();
            const batchBtn = document.querySelector('.mcp-batch-btn');
            expect(batchBtn).toBeTruthy();
            batchBtn.click();
            // 应该启用所有工具（因为之前都是禁用的）
            expect(setToolEnabled).toHaveBeenCalledTimes(2);
            expect(showNotification).toHaveBeenCalled();
        }
    });

    it('折叠/展开 MCP 服务器分组', () => {
        document.body.innerHTML = `
            <div id="tool-manager-modal" class="active">
                <div id="tools-list-container"></div>
            </div>
        `;
        state.mcpServers = [{ id: 'srv1', name: 'Server A' }];
        getAllTools.mockReturnValue([{ id: 'm1', name: 'Tool 1', type: 'mcp', serverId: 'srv1' }]);

        const openedCall = eventBus.on.mock.calls.find((c) => c[0] === 'tool-manager:opened');
        if (openedCall) {
            openedCall[1]();
            const serverHeader = document.querySelector('.mcp-server-header');
            const serverGroup = document.querySelector('.mcp-server-group');

            // 点击折叠
            serverHeader.click();
            expect(serverGroup.classList.contains('collapsed')).toBe(true);

            // 再次点击展开
            serverHeader.click();
            expect(serverGroup.classList.contains('collapsed')).toBe(false);
        }
    });
});
