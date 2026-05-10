/**
 * MCP (Model Context Protocol) 客户端
 * 统一的 MCP 客户端，支持远程和本地连接
 *
 * 平台支持：
 * - Web: 仅远程 MCP（HTTP/WebSocket）
 * - Electron: 远程 + 本地 MCP（IPC → 主进程 → stdio）
 * - Android: 仅远程 MCP（HTTP/WebSocket）
 */

import { eventBus } from '../../core/events.js';
import { getCachedTools } from './tool-cache.js';
import { detectPlatform } from '../../utils/platform.js';
import { connectLocalElectron, connectRemote, classifyError } from './connection.js';
import { discoverTools, normalizeToolDefinition, callRemoteTool } from './tool-executor.js';
import { logger } from '../../utils/logger.js';

// 向后兼容：re-export detectPlatform
export { detectPlatform };

/**
 * MCP 客户端类
 */
export class MCPClient {
    constructor() {
        this.platform = detectPlatform();
        this.connections = new Map(); // serverId -> connection
        this.tools = new Map(); // toolId -> tool definition

        // 重试配置
        this.retryConfig = {
            maxRetries: 3,
            initialDelay: 1000,
            maxDelay: 10000,
            backoffFactor: 2,
            connectionTimeout: 10000,
            toolCallTimeout: 180000
        };

        logger.debug(`[MCP] 平台检测: ${this.platform}`);
    }

    /**
     * 连接到 MCP 服务器
     * @param {Object} config - MCP 服务器配置
     * @returns {Promise<Object>} 连接结果 { success, error }
     */
    async connect(config) {
        const { type } = config;

        if (type === 'local' && this.platform !== 'electron') {
            const error = `本地 MCP 仅在 Electron 版本中支持，当前平台: ${this.platform}`;
            logger.error(`[MCP] ${error}`);
            return {
                success: false,
                error,
                errorType: 'platform_unsupported',
                retryable: false,
                platform: this.platform
            };
        }

        return await this._connectWithRetry(config);
    }

    /**
     * 断开 MCP 服务器连接
     * @param {string} serverId - 服务器 ID
     */
    async disconnect(serverId, options = {}) {
        const { silent = false } = options;

        const connection = this.connections.get(serverId);
        if (!connection) {
            logger.warn(`[MCP] 服务器未连接: ${serverId}`);
            return;
        }

        try {
            if (connection.shouldReconnect !== undefined) {
                connection.shouldReconnect = false;
            }

            if (connection.type === 'local' && this.platform === 'electron') {
                await window.electron.ipcRenderer.invoke('mcp:disconnect', { serverId });
            } else {
                if (connection.pingTimer) clearInterval(connection.pingTimer);
                if (connection.healthCheckTimer) clearInterval(connection.healthCheckTimer);

                if (connection.ws) {
                    connection.ws.close();
                }

                if (connection.sseAbortController) {
                    connection.sseAbortController.abort();
                }

                if (connection.sseReader) {
                    try {
                        await connection.sseReader.cancel();
                    } catch {
                        /* ignore */
                    }
                }

                if (
                    connection.pendingRequests &&
                    typeof connection.pendingRequests.clear === 'function'
                ) {
                    for (const pending of connection.pendingRequests.values()) {
                        if (pending?.timeoutId) clearTimeout(pending.timeoutId);
                        if (pending?.reject) pending.reject(new Error('Disconnected'));
                    }
                    connection.pendingRequests.clear();
                }
            }

            this._clearToolsForServer(serverId);
            this.connections.delete(serverId);

            try {
                sessionStorage.removeItem(`mcp-session-${serverId}`);
            } catch {
                /* ignore */
            }

            logger.debug(`[MCP] 已断开 MCP 服务器: ${serverId}`);

            if (!silent) {
                eventBus.emit('mcp:disconnected', { serverId });
            }
        } catch (error) {
            logger.error(`[MCP] 断开连接失败:`, error);
        }
    }

    /**
     * 是否存在连接对象（包括已断开/重连中的连接）
     */
    hasConnection(serverId) {
        return this.connections.has(serverId);
    }

    /**
     * 当前是否处于可用连接状态
     */
    isConnected(serverId) {
        const connection = this.connections.get(serverId);
        if (!connection) return false;
        return connection.connected !== false;
    }

    /** @private */
    _clearToolsForServer(serverId) {
        for (const [toolId, tool] of this.tools.entries()) {
            if (tool.serverId === serverId) {
                this.tools.delete(toolId);
            }
        }
    }

    /**
     * 获取所有可用工具
     */
    getAllTools() {
        return Array.from(this.tools.values());
    }

    /**
     * 获取指定服务器的工具
     */
    getToolsByServer(serverId) {
        return Array.from(this.tools.values()).filter((tool) => tool.serverId === serverId);
    }

    /**
     * 调用 MCP 工具
     * @param {string} toolId - 工具 ID（格式: serverId__toolName 或 serverId/toolName）
     * @param {Object} args - 工具参数
     * @param {Object} [options] - 可选配置
     * @returns {Promise<Object>} 工具执行结果
     */
    async callTool(toolId, args, options = {}) {
        let normalizedToolId = toolId;
        let serverId, toolName;

        if (toolId.includes('/')) {
            const parts = toolId.split('/');
            serverId = parts[0];
            toolName = parts[1];
            normalizedToolId = `${serverId}__${toolName}`;
        } else if (toolId.includes('__')) {
            const parts = toolId.split('__');
            serverId = parts[0];
            toolName = parts[1];
            normalizedToolId = toolId;
        } else {
            throw new Error(`无效的工具ID格式: ${toolId}`);
        }

        const tool = this.tools.get(normalizedToolId);
        if (!tool) {
            const altToolId = `${serverId}__${toolName}`;
            const altTool = this.tools.get(altToolId);
            if (altTool) {
                serverId = altTool.serverId;
                toolName = altTool.name;
            } else {
                throw new Error(`工具不存在: ${toolId}`);
            }
        } else {
            serverId = tool.serverId;
            toolName = tool.name;
        }

        const connection = this.connections.get(serverId);

        if (!connection) {
            throw new Error(`MCP 服务器未连接: ${serverId}`);
        }

        if (connection.connected === false) {
            throw new Error(`MCP 服务器连接已断开: ${serverId}`);
        }

        logger.debug(`[MCP] 调用工具: ${normalizedToolId}`, args);

        if (options.signal?.aborted) {
            throw new Error('工具执行已取消');
        }

        try {
            let result;

            if (connection.type === 'local' && this.platform === 'electron') {
                result = await window.electron.ipcRenderer.invoke('mcp:call-tool', {
                    serverId,
                    toolName: toolName,
                    arguments: args
                });
            } else {
                result = await callRemoteTool(
                    connection,
                    toolName,
                    args,
                    this.retryConfig,
                    options
                );
            }

            if (options.signal?.aborted) {
                throw new Error('工具执行已取消');
            }

            logger.debug(`[MCP] 工具执行成功: ${normalizedToolId}`);

            return {
                success: true,
                result,
                output: result?.content || result
            };
        } catch (error) {
            logger.error(`[MCP] 工具执行失败: ${normalizedToolId}`, error);
            throw error;
        }
    }

    /**
     * 获取连接状态
     */
    getStatus() {
        const servers = [];
        for (const [serverId, connection] of this.connections.entries()) {
            servers.push({
                id: serverId,
                type: connection.type,
                protocol: connection.protocol || 'ipc',
                toolCount: this.getToolsByServer(serverId).length
            });
        }

        return {
            platform: this.platform,
            connected: this.connections.size,
            servers,
            totalTools: this.tools.size
        };
    }

    // ========== 私有方法 ==========

    /**
     * 使用重试机制连接（指数退避）
     * @private
     */
    async _connectWithRetry(config) {
        const { id, name, type } = config;
        const { maxRetries, initialDelay, backoffFactor, maxDelay } = this.retryConfig;

        let lastError = null;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                if (attempt > 1) {
                    eventBus.emit('mcp:retry-attempt', {
                        serverId: id,
                        serverName: name,
                        attempt,
                        maxRetries
                    });
                    logger.debug(`[MCP] 重试连接 (${attempt}/${maxRetries}): ${name}`);
                }

                let connection;
                if (type === 'local') {
                    connection = await this._connectWithTimeout(
                        () => connectLocalElectron(config),
                        this.retryConfig.connectionTimeout
                    );
                } else {
                    connection = await this._connectWithTimeout(
                        () =>
                            connectRemote(config, this.retryConfig, this._makeConnectionContext()),
                        this.retryConfig.connectionTimeout
                    );
                }

                connection.connected = true;
                this.connections.set(id, connection);

                // 有缓存时先用缓存，后台刷新
                const cached = getCachedTools(id);
                if (cached && cached.length > 0) {
                    for (const tool of cached) {
                        const normalizedTool = normalizeToolDefinition(tool);
                        if (!normalizedTool) continue;
                        const toolId = `${id}__${normalizedTool.name}`;
                        this.tools.set(toolId, {
                            id: toolId,
                            serverId: id,
                            name: normalizedTool.name,
                            description: normalizedTool.description || '',
                            inputSchema: normalizedTool.inputSchema,
                            mcpDefinition: normalizedTool,
                            _cached: true
                        });
                    }
                    eventBus.emit('mcp:tools-discovered', {
                        serverId: id,
                        tools: cached,
                        cached: true
                    });

                    discoverTools(id, connection, this.tools, this.platform).catch((e) =>
                        logger.warn(`[MCP] 后台工具刷新失败: ${name}`, e.message)
                    );
                } else {
                    await discoverTools(id, connection, this.tools, this.platform);
                }

                logger.debug(`[MCP] 已连接到 MCP 服务器: ${name} (${type})`);
                eventBus.emit('mcp:connected', { serverId: id, config });

                return { success: true };
            } catch (error) {
                lastError = error;

                try {
                    await this.disconnect(id);
                } catch {
                    /* ignore */
                }

                const errorInfo = classifyError(error);

                logger.error(`[MCP] 连接失败 (尝试 ${attempt}/${maxRetries}):`, error.message);

                if (!errorInfo.retryable) {
                    return {
                        success: false,
                        error: error.message,
                        errorType: errorInfo.type,
                        retryable: false
                    };
                }

                if (attempt < maxRetries) {
                    const delay = Math.min(
                        initialDelay * Math.pow(backoffFactor, attempt - 1),
                        maxDelay
                    );
                    logger.debug(`[MCP] 等待 ${delay}ms 后重试...`);
                    await new Promise((resolve) => setTimeout(resolve, delay));
                }
            }
        }

        return {
            success: false,
            error: lastError.message,
            errorType: classifyError(lastError).type,
            retriesExhausted: true,
            retryable: false
        };
    }

    /** @private */
    async _connectWithTimeout(connectFn, timeout) {
        return Promise.race([
            connectFn(),
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error(`连接超时 (${timeout}ms)`)), timeout)
            )
        ]);
    }

    /**
     * 构建连接上下文，供 connection.js 回调使用
     * @private
     */
    _makeConnectionContext() {
        return {
            onNotification: (serverId, message) => this._handleNotification(serverId, message),
            hasConnection: (serverId) => this.connections.has(serverId),
            getConnection: (serverId) => this.connections.get(serverId),
            clearToolsForServer: (serverId) => this._clearToolsForServer(serverId),
            connectFn: (server) => this.connect(server)
        };
    }

    /**
     * 处理服务器 notification
     * @private
     */
    _handleNotification(serverId, message) {
        if (message.method === 'notifications/tools/list_changed') {
            logger.debug(`[MCP] 收到工具列表变更通知: ${serverId}`);
            const conn = this.connections.get(serverId);
            if (conn) {
                discoverTools(serverId, conn, this.tools, this.platform).catch((e) =>
                    logger.error('[MCP] 工具刷新失败:', e)
                );
            }
        }
    }
}

// ========== 向后兼容的导出 ==========

export const mcpClient = new MCPClient();

/**
 * 调用 MCP 工具（向后兼容）
 */
export async function callMCPTool(serverId, toolName, args, options = {}) {
    const toolId = `${serverId}__${toolName}`;
    return await mcpClient.callTool(toolId, args, options);
}

logger.debug('[MCP] MCP 客户端已加载');
logger.debug(`[MCP] 当前平台: ${mcpClient.platform}`);
