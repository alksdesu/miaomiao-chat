/**
 * tools-quick-selector.js 测试
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../js/core/events.js', () => ({
    eventBus: { emit: vi.fn(), on: vi.fn(), off: vi.fn() }
}));

vi.mock('../../js/utils/icons.js', () => ({
    getIcon: vi.fn(() => '<svg></svg>')
}));

vi.mock('../../js/utils/helpers.js', () => ({
    escapeHtml: vi.fn((s) => s || '')
}));

vi.mock('../../js/tools/manager.js', () => ({
    getAllTools: vi.fn(() => []),
    isToolEnabled: vi.fn(() => false),
    setToolEnabled: vi.fn()
}));

vi.mock('../../js/utils/logger.js', () => ({
    logger: { warn: vi.fn(), debug: vi.fn(), error: vi.fn(), info: vi.fn() }
}));

import { eventBus } from '../../js/core/events.js';
import { getAllTools, isToolEnabled, setToolEnabled } from '../../js/tools/manager.js';
import { initToolsQuickSelector } from '../../js/ui/tools-quick-selector.js';

describe('tools-quick-selector', () => {
    // initToolsQuickSelector 缓存模块级 selectorPanel 和 isOpen，只能初始化一次
    // 所有测试共享同一实例

    it('toggle-tools 不存在时静默返回', () => {
        document.body.innerHTML = '';
        expect(() => initToolsQuickSelector()).not.toThrow();
    });

    it('完整初始化和交互流程', () => {
        document.body.innerHTML = '<div><button id="toggle-tools"></button></div>';
        getAllTools.mockReturnValue([
            { id: 'calc', name: 'Calculator', type: 'builtin' },
            { id: 'ws', name: 'Web Search', type: 'builtin' },
            { id: 'm1', name: 'MCP Tool', type: 'mcp' }
        ]);
        isToolEnabled.mockReturnValue(false);

        initToolsQuickSelector();

        // 创建了选择器面板
        const panel = document.querySelector('.tools-quick-selector');
        expect(panel).toBeTruthy();
        expect(panel.querySelector('.selector-header')).toBeTruthy();
        expect(panel.querySelector('.selector-search')).toBeTruthy();
        expect(panel.querySelector('.tools-list-container')).toBeTruthy();

        // 注册了事件
        const events = eventBus.on.mock.calls.map((c) => c[0]);
        expect(events).toContain('tool:enabled:changed');
        expect(events).toContain('tool:registered');
        expect(events).toContain('tool:removed');

        // 点击 toggle 打开面板
        const toggleBtn = document.getElementById('toggle-tools');
        toggleBtn.click();
        expect(panel.classList.contains('active')).toBe(true);

        // 渲染了工具列表
        const items = document.querySelectorAll('.tool-checkbox-item');
        expect(items.length).toBe(3);

        // 分组显示
        const groups = document.querySelectorAll('.tools-group');
        expect(groups.length).toBeGreaterThanOrEqual(1);

        // 搜索过滤
        const searchInput = document.querySelector('.selector-search');
        searchInput.value = 'calc';
        searchInput.dispatchEvent(new Event('input'));
        const visibleAfterSearch = Array.from(
            document.querySelectorAll('.tool-checkbox-item')
        ).filter((i) => i.style.display !== 'none');
        expect(visibleAfterSearch.length).toBe(1);

        // 清空搜索
        searchInput.value = '';
        searchInput.dispatchEvent(new Event('input'));

        // 全选按钮
        vi.clearAllMocks();
        getAllTools.mockReturnValue([
            { id: 'calc', name: 'Calculator', type: 'builtin' },
            { id: 'ws', name: 'Web Search', type: 'builtin' }
        ]);
        isToolEnabled.mockReturnValue(false);
        const selectAllBtn = document.querySelector('#select-all-tools');
        selectAllBtn.click();
        expect(setToolEnabled).toHaveBeenCalled();

        // 管理按钮
        vi.clearAllMocks();
        const manageBtn = document.querySelector('#open-tools-manage');
        manageBtn.click();
        expect(eventBus.emit).toHaveBeenCalledWith('tools:manage:open');

        // 关闭按钮
        const closeBtn = document.querySelector('.close-selector');
        closeBtn.click();
        expect(panel.classList.contains('active')).toBe(false);

        document.body.innerHTML = '';
    });
});
