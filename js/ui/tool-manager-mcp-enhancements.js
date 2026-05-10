/**
 * 工具管理器 MCP 增强功能
 * 提供 MCP 工具分组和批量操作能力
 */

import { state } from '../core/state.js';
import { eventBus } from '../core/events.js';
import { getAllTools, setToolEnabled, isToolEnabled } from '../tools/manager.js';
import { showNotification } from './notifications.js';
import { getIcon } from '../utils/icons.js';
import { escapeHtml } from '../utils/helpers.js';
import { selectTool } from './tool-manager.js';
import { logger } from '../utils/logger.js';

let initialized = false;
let isBatchUpdating = false;
const unsubscribeCallbacks = [];
const collapsedServerIds = new Set();

function getToolManagerModal() {
    return document.getElementById('tool-manager-modal');
}

function getToolsListContainer() {
    return getToolManagerModal()?.querySelector('#tools-list-container') || null;
}

function isToolManagerOpen() {
    const modal = getToolManagerModal();
    return Boolean(modal && modal.classList.contains('active'));
}

function getServerName(serverId) {
    const server = state.mcpServers?.find((item) => item.id === serverId);
    return server?.name || serverId;
}

function getVisibleTools() {
    return getAllTools().filter((tool) => !tool.hidden);
}

function getSelectedToolId() {
    return getToolManagerModal()?.querySelector('.tool-item.selected')?.dataset.toolId || null;
}

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

function renderToolItem(tool, type, selectedToolId) {
    const enabled = isToolEnabled(tool.id);
    const selected = selectedToolId === tool.id ? 'selected' : '';
    const toolName = escapeHtml(tool.name || tool.id);
    const icon = getToolIcon(tool.id, type);

    return `
        <div class="tool-item ${selected}" data-tool-id="${escapeHtml(tool.id)}" data-type="${type}">
            <div class="tool-item-content">
                <span class="tool-icon">${icon}</span>
                <span class="tool-name">${toolName}</span>
            </div>
            <label class="tool-enable-switch-container">
                <input
                    type="checkbox"
                    class="tool-enable-switch"
                    data-tool-id="${escapeHtml(tool.id)}"
                    ${enabled ? 'checked' : ''}>
                <span class="switch-slider"></span>
            </label>
        </div>
    `;
}

function renderStandardGroup(title, tools, type, selectedToolId) {
    if (tools.length === 0) return '';

    const itemsHtml = tools.map((tool) => renderToolItem(tool, type, selectedToolId)).join('');

    return `
        <div class="tool-group">
            <div class="tool-group-header">
                <span class="tool-group-title">${title}</span>
                <span class="tool-group-count">(${tools.length})</span>
            </div>
            <div class="tool-group-items">
                ${itemsHtml}
            </div>
        </div>
    `;
}

function renderMCPServerGroup(serverId, serverName, tools, selectedToolId) {
    const allEnabled = tools.every((tool) => isToolEnabled(tool.id));
    const collapsed = collapsedServerIds.has(serverId) ? 'collapsed' : '';
    const serverTitle = escapeHtml(serverName);
    const itemsHtml = tools.map((tool) => renderToolItem(tool, 'mcp', selectedToolId)).join('');

    return `
        <div class="tool-group mcp-server-group ${collapsed}" data-server-id="${escapeHtml(serverId)}">
            <div class="tool-group-header mcp-server-header">
                <div class="mcp-server-info">
                    <svg class="collapse-icon" width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                        <path d="M6 10l4-4-4-4v8z"/>
                    </svg>
                    <span class="tool-group-title">MCP · ${serverTitle}</span>
                    <span class="tool-group-count">(${tools.length})</span>
                </div>
                <div class="mcp-batch-actions">
                    <button type="button" class="mcp-batch-btn" data-server-id="${escapeHtml(serverId)}">
                        ${allEnabled ? '全部禁用' : '全部启用'}
                    </button>
                </div>
            </div>
            <div class="tool-group-items mcp-tools-container">
                ${itemsHtml}
            </div>
        </div>
    `;
}

function renderEnhancedToolsList() {
    const listContainer = getToolsListContainer();
    if (!listContainer) return;

    const allTools = getVisibleTools();
    if (allTools.length === 0) {
        // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
        listContainer.innerHTML = '<div class="empty-state">暂无可用工具</div>';
        return;
    }

    const selectedToolId = getSelectedToolId();
    const builtinTools = allTools.filter((tool) => tool.type === 'builtin');
    const customTools = allTools.filter((tool) => tool.type === 'custom');
    const mcpTools = allTools.filter((tool) => tool.type === 'mcp');

    const toolsByServer = new Map();
    mcpTools.forEach((tool) => {
        const serverId = tool.serverId || 'unknown';
        if (!toolsByServer.has(serverId)) {
            toolsByServer.set(serverId, []);
        }
        toolsByServer.get(serverId).push(tool);
    });

    let html = '';
    html += renderStandardGroup('内置工具', builtinTools, 'builtin', selectedToolId);

    const sortedServerIds = Array.from(toolsByServer.keys()).sort((left, right) => {
        return getServerName(left).localeCompare(getServerName(right), 'zh-CN');
    });

    sortedServerIds.forEach((serverId) => {
        const serverTools = toolsByServer.get(serverId) || [];
        html += renderMCPServerGroup(
            serverId,
            getServerName(serverId),
            serverTools,
            selectedToolId
        );
    });

    html += renderStandardGroup('自定义工具', customTools, 'custom', selectedToolId);
    // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
    listContainer.innerHTML = html;
}

function handleListClick(event) {
    const batchButton = event.target.closest('.mcp-batch-btn');
    if (batchButton) {
        event.preventDefault();
        event.stopPropagation();
        toggleAllServerTools(batchButton.dataset.serverId);
        return;
    }

    const serverHeader = event.target.closest('.mcp-server-header');
    if (serverHeader) {
        const serverGroup = serverHeader.closest('.mcp-server-group');
        if (!serverGroup) return;

        const serverId = serverGroup.dataset.serverId;
        if (collapsedServerIds.has(serverId)) {
            collapsedServerIds.delete(serverId);
            serverGroup.classList.remove('collapsed');
        } else {
            collapsedServerIds.add(serverId);
            serverGroup.classList.add('collapsed');
        }
        return;
    }

    const toolItem = event.target.closest('.tool-item');
    if (!toolItem || event.target.closest('.tool-enable-switch-container')) {
        return;
    }

    selectTool(toolItem.dataset.toolId);
}

function handleListChange(event) {
    const switchElement = event.target.closest('.tool-enable-switch');
    if (!switchElement) return;

    const { toolId } = switchElement.dataset;
    const enabled = switchElement.checked;
    setToolEnabled(toolId, enabled);
    showNotification(`工具 ${enabled ? '已启用' : '已禁用'}`, 'success');
}

function toggleAllServerTools(serverId) {
    const serverTools = getVisibleTools().filter(
        (tool) => tool.type === 'mcp' && tool.serverId === serverId
    );
    if (serverTools.length === 0) return;

    const shouldEnable = !serverTools.every((tool) => isToolEnabled(tool.id));
    const serverName = getServerName(serverId);

    isBatchUpdating = true;
    try {
        serverTools.forEach((tool) => {
            setToolEnabled(tool.id, shouldEnable);
        });
    } finally {
        isBatchUpdating = false;
    }

    if (isToolManagerOpen()) {
        renderEnhancedToolsList();
    }

    showNotification(
        `已${shouldEnable ? '启用' : '禁用'} ${serverName} 的所有工具 (${serverTools.length} 个)`,
        'success'
    );
}

function refreshWhenOpen() {
    if (isBatchUpdating || !isToolManagerOpen()) return;
    renderEnhancedToolsList();
}

export function initToolManagerMCPEnhancements() {
    if (initialized) return;

    const listContainer = getToolsListContainer();
    if (!listContainer) {
        logger.warn('[Tool Manager MCP] 未找到工具列表容器，跳过增强初始化');
        return;
    }

    listContainer.addEventListener('click', handleListClick);
    listContainer.addEventListener('change', handleListChange);

    unsubscribeCallbacks.push(
        eventBus.on('tool-manager:opened', renderEnhancedToolsList),
        eventBus.on('tool:enabled:changed', refreshWhenOpen),
        eventBus.on('tool:registered', refreshWhenOpen),
        eventBus.on('tool:removed', refreshWhenOpen),
        eventBus.on('tools:updated', refreshWhenOpen)
    );

    initialized = true;
    logger.debug('[Tool Manager MCP] MCP 增强功能已初始化');
}
