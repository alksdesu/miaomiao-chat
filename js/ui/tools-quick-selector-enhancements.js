/**
 * 工具快速选择器 MCP 增强功能
 * 提供 MCP 工具按服务器分组显示
 */

import { state } from '../core/state.js';
import { eventBus } from '../core/events.js';
import { getAllTools, setToolEnabled, isToolEnabled } from '../tools/manager.js';
import { escapeHtml } from '../utils/helpers.js';
import { logger } from '../utils/logger.js';

let initialized = false;
let selectorOpen = false;
let isBatchUpdating = false;
const unsubscribeCallbacks = [];

function getQuickSelectorPanel() {
    return document.querySelector('.tools-quick-selector');
}

function getQuickListContainer() {
    return getQuickSelectorPanel()?.querySelector('.tools-list-container') || null;
}

function getVisibleTools() {
    return getAllTools().filter((tool) => !tool.hidden);
}

function getServerName(serverId) {
    const server = state.mcpServers?.find((item) => item.id === serverId);
    return server?.name || serverId;
}

function getQuickToolIcon(type) {
    const icons = {
        builtin: '🔧',
        mcp: '🔌',
        custom: '⚙️'
    };
    return icons[type] || '📦';
}

function renderQuickToolItem(tool, extraClass = '') {
    const enabled = isToolEnabled(tool.id);
    const toolName = escapeHtml(tool.name || tool.id);
    const toolIcon = escapeHtml(getQuickToolIcon(tool.type));
    const className = `tool-checkbox-item quick-tool-item ${extraClass}`.trim();

    return `
        <label class="${className}" data-tool-id="${escapeHtml(tool.id)}">
            <input
                type="checkbox"
                data-tool-id="${escapeHtml(tool.id)}"
                ${enabled ? 'checked' : ''}
                aria-label="${toolName}">
            <span class="checkbox-custom" aria-hidden="true"></span>
            <span class="tool-icon">${toolIcon}</span>
            <span class="tool-name">${toolName}</span>
            ${tool.type === 'mcp' ? '<span class="tool-badge mcp">MCP</span>' : ''}
        </label>
    `;
}

function renderStandardGroup(title, tools) {
    if (tools.length === 0) return '';

    const enabledCount = tools.filter((tool) => isToolEnabled(tool.id)).length;
    const itemsHtml = tools.map((tool) => renderQuickToolItem(tool)).join('');

    return `
        <div class="tools-group quick-tool-group">
            <div class="tools-group-title quick-tool-group-header">
                <span class="group-name">${title}</span>
                <span class="group-count">(${enabledCount}/${tools.length})</span>
            </div>
            ${itemsHtml}
        </div>
    `;
}

function renderMCPServerGroup(serverId, serverName, tools) {
    const allEnabled = tools.every((tool) => isToolEnabled(tool.id));
    const enabledCount = tools.filter((tool) => isToolEnabled(tool.id)).length;
    const itemsHtml = tools.map((tool) => renderQuickToolItem(tool, 'mcp-sub-item')).join('');

    return `
        <div class="tools-group quick-tool-group quick-selector-mcp-group" data-server-id="${escapeHtml(serverId)}">
            <div class="tools-group-title quick-selector-mcp-header">
                <div>
                    <span class="quick-selector-mcp-name">${escapeHtml(serverName)}</span>
                    <span class="group-count"> (${enabledCount}/${tools.length})</span>
                </div>
                <button type="button" class="quick-selector-mcp-toggle" data-server-id="${escapeHtml(serverId)}">
                    ${allEnabled ? '全部禁用' : '全部启用'}
                </button>
            </div>
            <div class="quick-selector-mcp-tools">
                ${itemsHtml}
            </div>
        </div>
    `;
}

export function enhancedRenderQuickToolsList() {
    const container = getQuickListContainer();
    if (!container) return;

    const allTools = getVisibleTools();
    if (allTools.length === 0) {
        // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
        container.innerHTML = '<p class="empty-state">暂无可用工具<br>点击下方“管理”添加工具</p>';
        return;
    }

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
    html += renderStandardGroup('内置工具', builtinTools);

    const sortedServerIds = Array.from(toolsByServer.keys()).sort((left, right) => {
        return getServerName(left).localeCompare(getServerName(right), 'zh-CN');
    });

    sortedServerIds.forEach((serverId) => {
        html += renderMCPServerGroup(
            serverId,
            getServerName(serverId),
            toolsByServer.get(serverId) || []
        );
    });

    html += renderStandardGroup('自定义工具', customTools);
    // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
    container.innerHTML = html;
}

function toggleAllServerToolsQuick(serverId) {
    const serverTools = getVisibleTools().filter(
        (tool) => tool.type === 'mcp' && tool.serverId === serverId
    );
    if (serverTools.length === 0) return;

    const shouldEnable = !serverTools.every((tool) => isToolEnabled(tool.id));

    isBatchUpdating = true;
    try {
        serverTools.forEach((tool) => {
            setToolEnabled(tool.id, shouldEnable);
        });
    } finally {
        isBatchUpdating = false;
    }

    if (selectorOpen) {
        enhancedRenderQuickToolsList();
    }

    updateQuickButtonState();
}

function updateQuickButtonState() {
    const toggleBtn = document.getElementById('toggle-tools');
    if (!toggleBtn) return;

    const visibleTools = getVisibleTools();
    const enabledTools = visibleTools.filter((tool) => isToolEnabled(tool.id));
    const badgeElement = toggleBtn.querySelector('.tools-badge') || createBadge();

    badgeElement.textContent = `${enabledTools.length}/${visibleTools.length}`;
    badgeElement.style.display = enabledTools.length > 0 ? 'flex' : 'none';

    if (!toggleBtn.querySelector('.tools-badge')) {
        toggleBtn.appendChild(badgeElement);
    }

    toggleBtn.classList.toggle('has-enabled', enabledTools.length > 0);
}

function createBadge() {
    const badge = document.createElement('span');
    badge.className = 'tools-badge';
    badge.style.cssText = `
        position: absolute;
        top: -4px;
        right: -4px;
        background: var(--md-blue);
        color: white;
        font-size: 10px;
        padding: 2px 4px;
        border-radius: 8px;
        display: flex;
        align-items: center;
        justify-content: center;
        min-width: 16px;
    `;
    return badge;
}

function handleQuickListClick(event) {
    const toggleButton = event.target.closest('.quick-selector-mcp-toggle');
    if (!toggleButton) return;

    event.preventDefault();
    event.stopPropagation();
    toggleAllServerToolsQuick(toggleButton.dataset.serverId);
}

function refreshSelectorView() {
    if (isBatchUpdating) {
        updateQuickButtonState();
        return;
    }

    if (selectorOpen) {
        enhancedRenderQuickToolsList();
    }
    updateQuickButtonState();
}

export function initQuickSelectorEnhancements() {
    if (initialized) return;

    const container = getQuickListContainer();
    if (!container) {
        logger.warn('[Quick Selector MCP] 未找到快捷工具列表容器，跳过增强初始化');
        return;
    }

    container.addEventListener('click', handleQuickListClick);

    unsubscribeCallbacks.push(
        eventBus.on('tools:selector:opened', () => {
            selectorOpen = true;
            enhancedRenderQuickToolsList();
            updateQuickButtonState();
        }),
        eventBus.on('tools:selector:closed', () => {
            selectorOpen = false;
            updateQuickButtonState();
        }),
        eventBus.on('tool:enabled:changed', refreshSelectorView),
        eventBus.on('tool:registered', refreshSelectorView),
        eventBus.on('tool:removed', refreshSelectorView),
        eventBus.on('tools:updated', refreshSelectorView)
    );

    selectorOpen = getQuickSelectorPanel()?.classList.contains('active') || false;
    if (selectorOpen) {
        enhancedRenderQuickToolsList();
    }
    updateQuickButtonState();

    initialized = true;
    logger.debug('[Quick Selector MCP] 增强功能已初始化');
}
