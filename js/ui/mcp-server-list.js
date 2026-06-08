/**
 * MCP 服务器列表渲染与连接管理
 * 负责服务器卡片渲染、状态显示、连接/断开/删除操作
 */

import { state } from '../core/state.js';
import { eventBus } from '../core/events.js';
import { mcpClient } from '../tools/mcp/client.js';
import { clearToolCache } from '../tools/mcp/tool-cache.js';
import { saveMCPServer, deleteMCPServer } from '../state/storage.js';
import { showNotification } from './notifications.js';
import { showConfirmDialog } from '../utils/dialogs.js';
import { escapeHtml } from '../utils/helpers.js';
import { getIcon } from '../utils/icons.js';
import { detectPlatform } from '../utils/platform.js';
import { logger } from '../utils/logger.js';

const platform = detectPlatform();

// 连接中的服务器：其他事件触发全量重渲时据此保持按钮禁用，防止并发双 connect
const connectingIds = new Set();

/**
 * 渲染服务器列表
 * @param {HTMLElement} modal - MCP 设置模态框
 */
export function renderServerList(modal) {
    if (!modal) return;

    const listContainer = modal.querySelector('#mcp-server-list');
    if (!listContainer) return;

    if (!state.mcpServers || state.mcpServers.length === 0) {
        // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
        listContainer.innerHTML = `
            <div class="mcp-empty-state">
                <p>暂无 MCP 服务器</p>
                <p class="text-muted">点击上方"添加服务器"按钮开始配置</p>
            </div>
        `;
        return;
    }

    // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
    listContainer.innerHTML = state.mcpServers.map((server) => createServerCard(server)).join('');

    // 绑定服务器卡片事件
    bindServerCardEvents(modal);
}

/**
 * 创建服务器卡片 HTML
 * @param {Object} server - 服务器配置对象
 * @returns {string} 卡片 HTML
 */
function createServerCard(server) {
    const status = mcpClient.isConnected(server.id);
    const connecting = connectingIds.has(server.id);
    const tools = mcpClient.getToolsByServer(server.id);
    const toolCount = tools.length;
    const retryCount = server.retryCount || 0;
    const retryText = retryCount > 0 ? `重试${retryCount > 1 ? ` (${retryCount})` : ''}` : '连接';

    let actionButton;
    if (connecting) {
        actionButton = `<button class="btn btn-sm btn-success mcp-connect-btn loading" data-server-id="${escapeHtml(server.id)}" disabled>连接中...</button>`;
    } else if (status) {
        actionButton = `<button class="btn btn-sm btn-warning mcp-disconnect-btn" data-server-id="${escapeHtml(server.id)}">断开</button>`;
    } else {
        actionButton = `<button class="btn btn-sm btn-success mcp-connect-btn ${retryCount > 0 ? 'retry-btn' : ''}" data-server-id="${escapeHtml(server.id)}">${retryText}</button>`;
    }

    return `
        <div class="mcp-server-card" data-server-id="${escapeHtml(server.id)}">
            <div class="mcp-server-header">
                <div class="mcp-server-title">
                    <h4>${escapeHtml(server.name)}</h4>
                    <span class="mcp-server-type-badge ${server.type}">${server.type === 'local' ? '本地' : '远程'}</span>
                </div>
                <div class="mcp-server-actions">
                    ${actionButton}
                    <button class="btn btn-sm btn-danger mcp-delete-btn" data-server-id="${escapeHtml(server.id)}"${connecting ? ' disabled' : ''}>删除</button>
                </div>
            </div>

            <div class="mcp-server-status">
                <span class="status-indicator ${status ? 'connected' : 'disconnected'}"></span>
                <span>${status ? '已连接' : '未连接'}</span>
                ${status ? `<span class="mcp-tool-count">(${toolCount} 个工具)</span>` : ''}
            </div>

            ${
                server.type === 'remote'
                    ? `
                <div class="mcp-server-details">
                    <div><strong>URL:</strong> ${escapeHtml(server.url)}</div>
                    ${server.apiKey ? '<div><strong>API Key:</strong> ••••••••</div>' : ''}
                </div>
            `
                    : `
                <div class="mcp-server-details">
                    <div><strong>命令:</strong> ${escapeHtml(server.command)} ${escapeHtml((server.args || []).join(' '))}</div>
                    ${server.cwd ? `<div><strong>工作目录:</strong> ${escapeHtml(server.cwd)}</div>` : ''}
                </div>
            `
            }

            ${
                status && toolCount > 0
                    ? `
                <div class="mcp-tools-list">
                    <strong>可用工具:</strong>
                    <ul>
                        ${tools.map((tool) => `<li>${escapeHtml(tool.name)} - ${escapeHtml(tool.description || '无描述')}</li>`).join('')}
                    </ul>
                </div>
            `
                    : ''
            }
        </div>
    `;
}

/**
 * 绑定服务器卡片上的按钮事件
 * @param {HTMLElement} modal - MCP 设置模态框
 */
function bindServerCardEvents(modal) {
    modal.querySelectorAll('.mcp-connect-btn').forEach((btn) => {
        btn.addEventListener('click', async (e) => {
            const serverId = e.target.dataset.serverId;
            await connectToServer(modal, serverId);
        });
    });

    modal.querySelectorAll('.mcp-disconnect-btn').forEach((btn) => {
        btn.addEventListener('click', async (e) => {
            const serverId = e.target.dataset.serverId;
            await disconnectFromServer(modal, serverId);
        });
    });

    modal.querySelectorAll('.mcp-delete-btn').forEach((btn) => {
        btn.addEventListener('click', async (e) => {
            const serverId = e.target.dataset.serverId;
            await deleteServer(modal, serverId);
        });
    });
}

/**
 * 连接到指定服务器
 * @param {HTMLElement} modal - 模态框引用
 * @param {string} serverId - 服务器 ID
 */
export async function connectToServer(modal, serverId) {
    const server = state.mcpServers.find((s) => s.id === serverId);
    if (!server) {
        logger.error(`[MCP Settings] 服务器不存在: ${serverId}`);
        return;
    }

    if (connectingIds.has(serverId)) return;
    connectingIds.add(serverId);

    if (!server.retryCount) {
        server.retryCount = 0;
    }

    renderServerList(modal);

    const retryHandler = (data) => {
        if (data.serverId !== serverId) return;
        // 重渲染会替换按钮实例，必须实时查询而非闭包持有
        const liveBtn = modal.querySelector(`.mcp-connect-btn[data-server-id="${serverId}"]`);
        if (liveBtn) liveBtn.textContent = `重试中 (${data.attempt}/${data.maxRetries})`;
    };
    eventBus.on('mcp:retry-attempt', retryHandler);

    let result;
    try {
        result = await mcpClient.connect(server);
    } finally {
        eventBus.off('mcp:retry-attempt', retryHandler);
        connectingIds.delete(serverId);
    }

    // 连接期间服务器可能已被删除，继续写状态会让僵尸配置复活进 IndexedDB。
    // disconnect 必须非 silent：manager.clearMCPTools 仅由 mcp:disconnected 事件触发，
    // silent 会让已删除服务器的工具残留在注册表持续注入 API 请求
    if (!state.mcpServers.some((s) => s.id === serverId)) {
        logger.debug(`[MCP Settings] 服务器已在连接期间删除，丢弃连接: ${serverId}`);
        if (result.success) {
            await mcpClient.disconnect(serverId);
        }
        renderServerList(modal);
        return;
    }

    if (result.success) {
        logger.debug(`[MCP Settings] 已连接: ${server.name}`);
        showNotification(`已连接到 ${server.name}`, 'success');
        server.retryCount = 0;
        server.enabled = true;
    } else {
        logger.error(`[MCP Settings] 连接失败: ${result.error}`);
        server.retryCount = (server.retryCount || 0) + 1;

        const friendlyError = getErrorMessage(result.errorType, result.error);
        const errorMsg = result.retriesExhausted
            ? `${friendlyError}（已自动重试 ${result.attempts || 0} 次）`
            : friendlyError;

        showNotification(errorMsg, 'error');
    }

    try {
        await saveMCPServer(server);
    } catch (error) {
        logger.error('[MCP Settings] 保存服务器状态失败:', error);
        showNotification('保存服务器状态失败', 'error');
    }

    renderServerList(modal);
}

/**
 * 断开服务器连接
 * @param {HTMLElement} modal - 模态框引用
 * @param {string} serverId - 服务器 ID
 */
async function disconnectFromServer(modal, serverId) {
    await mcpClient.disconnect(serverId);

    const server = state.mcpServers.find((s) => s.id === serverId);
    if (server) {
        server.enabled = false;
        try {
            await saveMCPServer(server);
        } catch (error) {
            logger.error('[MCP Settings] 保存断开状态失败:', error);
            showNotification('保存状态失败', 'error');
        }
    }

    renderServerList(modal);
}

/**
 * 删除服务器
 * @param {HTMLElement} modal - 模态框引用
 * @param {string} serverId - 服务器 ID
 */
async function deleteServer(modal, serverId) {
    const server = state.mcpServers.find((s) => s.id === serverId);
    if (!server) return;

    const confirmed = await showConfirmDialog(
        `确定要删除服务器 "${server.name}" 吗？`,
        '删除服务器'
    );

    if (!confirmed) return;

    if (mcpClient.hasConnection(serverId)) {
        try {
            await mcpClient.disconnect(serverId);
        } catch (error) {
            logger.error('[MCP Settings] 断开连接失败:', error);
            showNotification('断开连接失败', 'error');
        }
    }

    // 先删持久层再删内存：DB 失败时三态保持一致，重试入口仍可用
    try {
        await deleteMCPServer(serverId);
    } catch (error) {
        logger.error('[MCP Settings] 删除服务器失败:', error);
        showNotification('删除失败，请重试', 'error');
        return;
    }

    state.mcpServers = state.mcpServers.filter((s) => s.id !== serverId);
    clearToolCache(serverId);

    renderServerList(modal);
    showNotification(`已删除服务器: ${server.name}`, 'info');
}

/**
 * 渲染平台信息
 * @param {HTMLElement} modal - 模态框引用
 */
export function renderPlatformInfo(modal) {
    const badge = modal.querySelector('#mcp-platform-badge');
    const warning = modal.querySelector('#mcp-platform-warning');

    if (badge) {
        badge.textContent = getPlatformLabel(platform);
        badge.className = `platform-badge platform-${platform}`;
    }

    if (warning) {
        // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
        warning.innerHTML = getPlatformWarning(platform);
    }
}

/**
 * 获取平台标签
 * @param {string} plat - 平台标识
 * @returns {string}
 */
function getPlatformLabel(plat) {
    const labels = {
        electron: 'Electron 桌面版',
        web: 'Web 浏览器',
        android: 'Android'
    };
    return labels[plat] || plat;
}

/**
 * 获取平台警告信息
 * @param {string} plat - 平台标识
 * @returns {string}
 */
function getPlatformWarning(plat) {
    if (plat === 'web') {
        return `
            <div class="platform-warning web-warning">
                ${getIcon('alertCircle', { size: 14 })} Web 版本仅支持远程 MCP 服务器。如需使用本地 MCP，请下载 Electron 桌面版。
            </div>
        `;
    } else if (plat === 'android') {
        return `
            <div class="platform-warning android-warning">
                ${getIcon('alertCircle', { size: 14 })} Android 版本仅支持远程 MCP 服务器。如需使用本地 MCP，请使用 Electron 桌面版。
            </div>
        `;
    }
    return '';
}

/**
 * 获取友好的错误消息
 *
 * 返回值进 showNotification → textContent 纯文本渲染，禁止拼接 getIcon 等 HTML 字符串
 * （SVG 源码会被原样显示成文字）；通知类型图标由 notifications.js 按 type 自带
 *
 * @param {string} errorType - 错误类型
 * @param {string} rawError - 原始错误
 * @returns {string}
 */
function getErrorMessage(errorType, rawError) {
    const errorMessages = {
        platform_unsupported: '当前平台不支持本地 MCP 服务器，请使用 Electron 桌面版',
        invalid_config: '配置错误：请检查 URL 或命令参数是否正确',
        auth_failed: '认证失败：请检查 API Key 是否正确',
        timeout: '连接超时：服务器可能未响应，请稍后重试',
        network_error: '网络错误：请检查网络连接或服务器地址',
        server_error: '服务器错误：MCP 服务器可能暂时不可用',
        unknown_error: `未知错误：${rawError}`
    };

    return errorMessages[errorType] || errorMessages['unknown_error'];
}
