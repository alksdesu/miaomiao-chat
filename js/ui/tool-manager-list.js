/**
 * 工具列表渲染、搜索过滤、分类展示
 * 从 tool-manager.js 拆分
 */

import { getAllTools, isToolEnabled, setToolEnabled, getTool } from '../tools/manager.js';
import { showNotification } from './notifications.js';
import { escapeHtml } from '../utils/helpers.js';
import { getIcon } from '../utils/icons.js';

/**
 * 渲染工具列表（左侧面板）
 * @param {HTMLElement} modal - 模态框元素
 * @param {string|null} selectedToolId - 当前选中的工具 ID
 * @param {Function} onSelectTool - 工具选中回调
 */
export function renderToolsList(modal, selectedToolId, onSelectTool) {
    const listContainer = modal.querySelector('#tools-list-container');
    if (!listContainer) return;

    // 过滤掉 hidden 工具（如 Computer Use）
    const allTools = getAllTools().filter((t) => !t.hidden);

    // 按类型分组
    const builtinTools = allTools.filter((t) => t.type === 'builtin');
    const mcpTools = allTools.filter((t) => t.type === 'mcp');
    const customTools = allTools.filter((t) => t.type === 'custom');

    // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
    listContainer.innerHTML = `
        ${renderToolGroup('内置工具', builtinTools, 'builtin', selectedToolId)}
        ${renderToolGroup('MCP 工具', mcpTools, 'mcp', selectedToolId)}
        ${renderToolGroup('自定义工具', customTools, 'custom', selectedToolId)}
    `;

    const toolItems = listContainer.querySelectorAll('.tool-item');
    const enableSwitches = listContainer.querySelectorAll('.tool-enable-switch');
    const switchContainers = listContainer.querySelectorAll('.tool-enable-switch-container');

    // 绑定工具项点击事件
    toolItems.forEach((item) => {
        item.addEventListener('click', () => {
            onSelectTool(item.dataset.toolId);
        });
    });

    // 启用开关的 label 容器：点击不冒泡到外层 tool-item，避免触发工具选中
    switchContainers.forEach((label) => {
        label.addEventListener('click', (e) => e.stopPropagation());
    });

    // 绑定启用开关
    enableSwitches.forEach((switchEl) => {
        switchEl.addEventListener('change', (e) => {
            e.stopPropagation();
            const toolId = e.target.dataset.toolId;
            const enabled = e.target.checked;
            setToolEnabled(toolId, enabled);
            showNotification(`工具 ${enabled ? '已启用' : '已禁用'}`, 'success');
        });
    });
}

/**
 * 渲染工具分组
 */
function renderToolGroup(title, tools, type, selectedToolId) {
    if (tools.length === 0) return '';

    const toolsHtml = tools
        .map((tool) => {
            const enabled = isToolEnabled(tool.id);
            const selected = selectedToolId === tool.id ? 'selected' : '';
            const icon = getToolIcon(tool.id, type);

            return `
            <div class="tool-item ${selected}" data-tool-id="${escapeHtml(tool.id)}" data-type="${type}">
                <div class="tool-item-content">
                    <span class="tool-icon">${icon}</span>
                    <span class="tool-name">${escapeHtml(tool.name)}</span>
                </div>
                <label class="tool-enable-switch-container">
                    <input type="checkbox"
                           class="tool-enable-switch"
                           data-tool-id="${escapeHtml(tool.id)}"
                           ${enabled ? 'checked' : ''}>
                    <span class="switch-slider"></span>
                </label>
            </div>
        `;
        })
        .join('');

    return `
        <div class="tool-group">
            <div class="tool-group-header">
                <span class="tool-group-title">${title}</span>
                <span class="tool-group-count">(${tools.length})</span>
            </div>
            <div class="tool-group-items">
                ${toolsHtml}
            </div>
        </div>
    `;
}

/**
 * 获取工具图标（返回 SVG）
 */
function getToolIcon(toolId, type) {
    const iconMap = {
        web_search: 'globe',
        calculator: 'barChart',
        datetime: 'clock',
        unit_converter: 'barChart',
        text_formatter: 'type',
        random_generator: 'star'
    };

    let iconName = iconMap[toolId];

    if (!iconName) {
        if (type === 'mcp') iconName = 'plug';
        else if (type === 'custom') iconName = 'tool';
        else iconName = 'settings';
    }

    return getIcon(iconName, { size: 16, className: 'tool-icon' });
}

/**
 * 处理工具搜索
 * @param {HTMLElement} modal - 模态框元素
 * @param {Event} e - 输入事件
 */
export function handleToolSearch(modal, e) {
    const query = e.target.value.toLowerCase().trim();

    const toolItems = modal.querySelectorAll('.tool-item');
    toolItems.forEach((item) => {
        const toolId = item.dataset.toolId;
        const tool = getTool(toolId);

        if (!tool) {
            item.style.display = 'none';
            return;
        }

        const nameMatch = tool.name.toLowerCase().includes(query);
        const descMatch = (tool.description || '').toLowerCase().includes(query);

        item.style.display = nameMatch || descMatch ? 'flex' : 'none';
    });

    // 隐藏空分组
    modal.querySelectorAll('.tool-group').forEach((group) => {
        const visibleItems = group.querySelectorAll('.tool-item[style*="flex"]').length;
        group.style.display = visibleItems > 0 ? 'block' : 'none';
    });
}
