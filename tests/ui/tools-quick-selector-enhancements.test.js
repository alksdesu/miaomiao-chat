/**
 * tools-quick-selector-enhancements.js 测试
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../js/core/state.js', () => ({
    state: {
        mcpServers: []
    }
}));

vi.mock('../../js/core/events.js', () => ({
    eventBus: {
        emit: vi.fn(),
        on: vi.fn(() => vi.fn()),
        off: vi.fn()
    }
}));

vi.mock('../../js/tools/manager.js', () => ({
    getAllTools: vi.fn(() => []),
    isToolEnabled: vi.fn(() => false),
    setToolEnabled: vi.fn()
}));

vi.mock('../../js/utils/helpers.js', () => ({
    escapeHtml: vi.fn((s) => s || '')
}));

vi.mock('../../js/utils/logger.js', () => ({
    logger: { warn: vi.fn(), debug: vi.fn(), error: vi.fn(), info: vi.fn() }
}));

import { state } from '../../js/core/state.js';
import { getAllTools, isToolEnabled } from '../../js/tools/manager.js';
import {
    enhancedRenderQuickToolsList,
    initQuickSelectorEnhancements
} from '../../js/ui/tools-quick-selector-enhancements.js';

describe('tools-quick-selector-enhancements', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        state.mcpServers = [];
        document.body.innerHTML = '';
    });

    afterEach(() => {
        document.body.innerHTML = '';
    });

    // ========== enhancedRenderQuickToolsList ==========
    describe('enhancedRenderQuickToolsList', () => {
        it('无容器静默返回', () => {
            expect(() => enhancedRenderQuickToolsList()).not.toThrow();
        });

        it('无工具显示空状态', () => {
            document.body.innerHTML = `
                <div class="tools-quick-selector">
                    <div class="tools-list-container"></div>
                </div>
            `;
            getAllTools.mockReturnValue([]);

            enhancedRenderQuickToolsList();
            const container = document.querySelector('.tools-list-container');
            expect(container.innerHTML).toContain('暂无可用工具');
        });

        it('渲染内置工具组', () => {
            document.body.innerHTML = `
                <div class="tools-quick-selector">
                    <div class="tools-list-container"></div>
                </div>
            `;
            getAllTools.mockReturnValue([{ id: 'calc', name: 'Calculator', type: 'builtin' }]);

            enhancedRenderQuickToolsList();
            const groups = document.querySelectorAll('.quick-tool-group');
            expect(groups.length).toBeGreaterThanOrEqual(1);
        });

        it('MCP 工具按服务器分组', () => {
            document.body.innerHTML = `
                <div class="tools-quick-selector">
                    <div class="tools-list-container"></div>
                </div>
            `;
            state.mcpServers = [
                { id: 'srv1', name: 'Server A' },
                { id: 'srv2', name: 'Server B' }
            ];
            getAllTools.mockReturnValue([
                { id: 'm1', name: 'Tool 1', type: 'mcp', serverId: 'srv1' },
                { id: 'm2', name: 'Tool 2', type: 'mcp', serverId: 'srv2' },
                { id: 'm3', name: 'Tool 3', type: 'mcp', serverId: 'srv1' }
            ]);

            enhancedRenderQuickToolsList();
            const mcpGroups = document.querySelectorAll('.quick-selector-mcp-group');
            expect(mcpGroups.length).toBe(2);
        });

        it('过滤 hidden 工具', () => {
            document.body.innerHTML = `
                <div class="tools-quick-selector">
                    <div class="tools-list-container"></div>
                </div>
            `;
            getAllTools.mockReturnValue([
                { id: 'a', name: 'Visible', type: 'builtin' },
                { id: 'b', name: 'Hidden', type: 'builtin', hidden: true }
            ]);

            enhancedRenderQuickToolsList();
            const items = document.querySelectorAll('.quick-tool-item');
            expect(items.length).toBe(1);
        });

        it('启用状态计数正确', () => {
            document.body.innerHTML = `
                <div class="tools-quick-selector">
                    <div class="tools-list-container"></div>
                </div>
            `;
            getAllTools.mockReturnValue([
                { id: 'a', name: 'A', type: 'builtin' },
                { id: 'b', name: 'B', type: 'builtin' }
            ]);
            isToolEnabled.mockImplementation((id) => id === 'a');

            enhancedRenderQuickToolsList();
            const countText = document.querySelector('.group-count');
            expect(countText.textContent).toContain('1/2');
        });

        it('自定义工具显示在单独组', () => {
            document.body.innerHTML = `
                <div class="tools-quick-selector">
                    <div class="tools-list-container"></div>
                </div>
            `;
            getAllTools.mockReturnValue([{ id: 'c1', name: 'Custom 1', type: 'custom' }]);

            enhancedRenderQuickToolsList();
            const groups = document.querySelectorAll('.quick-tool-group');
            expect(groups.length).toBe(1);
        });
    });

    // ========== initQuickSelectorEnhancements ==========
    describe('initQuickSelectorEnhancements', () => {
        it('无容器静默返回', () => {
            expect(() => initQuickSelectorEnhancements()).not.toThrow();
        });
    });
});
