/**
 * MCP 工具执行与发现模块
 * 处理 callTool、listTools、工具发现和注册
 */

import { eventBus } from '../../core/events.js';
import { cacheTools } from './tool-cache.js';
import { nextWsRequestId, sendSSERequest, parseSSE } from './connection.js';
import { logger } from '../../utils/logger.js';

/**
 * 从不同 MCP 响应结构中提取 tools 列表
 * @param {Object} payload - 响应数据
 * @returns {Array}
 */
export function extractToolsFromPayload(payload) {
    const asArray = (value) => {
        if (Array.isArray(value)) return value;
        if (value && typeof value === 'object') {
            const toolEntries = Object.entries(value).filter(
                ([, tool]) => tool && typeof tool === 'object' && !Array.isArray(tool)
            );
            if (toolEntries.length === 0) return [];
            return toolEntries.map(([name, tool]) => ({
                name,
                ...(tool || {})
            }));
        }
        return [];
    };

    const candidates = [
        payload,
        payload?.tools,
        payload?.result,
        payload?.result?.tools,
        payload?.data,
        payload?.data?.tools
    ];

    for (const candidate of candidates) {
        const tools = asArray(candidate);
        if (tools.length > 0) return tools;
    }

    return [];
}

/**
 * 归一化工具定义（兼容 inputSchema/input_schema 等命名）
 * @param {Object} tool - 原始工具定义
 * @returns {Object|null}
 */
export function normalizeToolDefinition(tool) {
    if (!tool || typeof tool !== 'object') return null;
    const normalizedName = tool.name || tool.id || '';
    if (!normalizedName || typeof normalizedName !== 'string') return null;

    return {
        ...tool,
        name: normalizedName,
        inputSchema: tool.inputSchema ||
            tool.input_schema ||
            tool.parameters || { type: 'object', properties: {} }
    };
}

/**
 * 发现 MCP 工具并注册到工具 Map 中
 * @param {string} serverId - 服务器 ID
 * @param {Object} connection - 连接对象
 * @param {Map} toolsMap - 工具注册表
 * @param {string} platform - 当前平台
 */
export async function discoverTools(serverId, connection, toolsMap, platform) {
    logger.debug(`[MCP] 发现工具: ${serverId}`);

    // 检查服务器是否声明支持 tools
    if (
        connection.serverCapabilities &&
        Object.keys(connection.serverCapabilities).length > 0 &&
        !connection.serverCapabilities.tools
    ) {
        logger.debug(`[MCP] 服务器 ${serverId} 未声明 tools 能力，跳过工具发现`);
        return;
    }

    try {
        let toolsList;

        if (connection.type === 'local' && platform === 'electron') {
            const result = await window.electron.ipcRenderer.invoke('mcp:list-tools', { serverId });
            if (!result?.success) {
                throw new Error(result?.error || 'MCP tools/list failed');
            }
            toolsList = extractToolsFromPayload(result);
        } else {
            toolsList = await listRemoteTools(connection);
        }

        // 注册工具
        for (const tool of toolsList) {
            const normalizedTool = normalizeToolDefinition(tool);
            if (!normalizedTool) continue;
            const toolId = `${serverId}__${normalizedTool.name}`;

            toolsMap.set(toolId, {
                id: toolId,
                serverId,
                name: normalizedTool.name,
                description: normalizedTool.description || '',
                inputSchema: normalizedTool.inputSchema,
                mcpDefinition: normalizedTool
            });
        }

        logger.debug(`[MCP] 发现 ${toolsList.length} 个工具: ${serverId}`);

        cacheTools(serverId, toolsList);

        eventBus.emit('mcp:tools-discovered', {
            serverId,
            tools: toolsList
        });
    } catch (error) {
        logger.error(`[MCP] 工具发现失败: ${serverId}`, error);
        throw error;
    }
}

/**
 * 远程获取工具列表
 * @param {Object} connection - 连接对象
 * @returns {Promise<Array>}
 */
export async function listRemoteTools(connection) {
    const { protocol, url, ws, headers } = connection;

    if (protocol === 'sse') {
        const result = await sendSSERequest(
            connection,
            'tools/list',
            {},
            {
                connectionTimeout: 10000
            }
        );
        return extractToolsFromPayload(result);
    }

    if (protocol === 'websocket') {
        return new Promise((resolve, reject) => {
            const requestId = nextWsRequestId();
            const TIMEOUT = 10000;

            const timeout = setTimeout(() => {
                ws.removeEventListener('message', handler);
                reject(new Error(`WebSocket 列表工具超时 (${TIMEOUT}ms)`));
            }, TIMEOUT);

            const handler = (event) => {
                let response;
                try {
                    response = JSON.parse(event.data);
                } catch {
                    return;
                }
                if (response.id === requestId) {
                    clearTimeout(timeout);
                    ws.removeEventListener('message', handler);
                    resolve(extractToolsFromPayload(response.result));
                }
            };

            ws.addEventListener('message', handler);
            ws.send(
                JSON.stringify({
                    jsonrpc: '2.0',
                    id: requestId,
                    method: 'tools/list'
                })
            );
        });
    }

    // HTTP
    const requestBody = {
        jsonrpc: '2.0',
        id: Date.now(),
        method: 'tools/list',
        params: {}
    };

    logger.debug(`[MCP] 发送请求到 ${url}:`, requestBody);

    const abortController = new AbortController();
    const TIMEOUT = 10000;
    const timeoutId = setTimeout(() => abortController.abort(), TIMEOUT);

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json, text/event-stream',
                ...headers
            },
            body: JSON.stringify(requestBody),
            signal: abortController.signal
        });

        clearTimeout(timeoutId);
        logger.debug(`[MCP] 收到响应: ${response.status} ${response.statusText}`);

        if (!response.ok) {
            const errorText = await response.text();
            logger.error(`[MCP] HTTP 错误响应:`, errorText);
            throw new Error(`HTTP 请求失败: ${response.status} ${response.statusText}`);
        }

        const contentType = response.headers.get('content-type');
        let data;
        if (contentType && contentType.includes('text/event-stream')) {
            logger.debug('[MCP] 解析 SSE 格式响应');
            const text = await response.text();
            data = parseSSE(text);
        } else {
            data = await response.json();
        }

        logger.debug(`[MCP] 响应数据:`, data);

        if (data.error) {
            throw new Error(
                `MCP 错误 [${data.error.code}]: ${data.error.message || JSON.stringify(data.error)}`
            );
        }

        return extractToolsFromPayload(data.result);
    } catch (error) {
        clearTimeout(timeoutId);
        if (error.name === 'AbortError') {
            throw new Error(`HTTP 列表工具超时 (${TIMEOUT}ms)`);
        }
        throw error;
    }
}

/**
 * 远程调用工具
 * @param {Object} connection - 连接对象
 * @param {string} toolName - 工具名称
 * @param {Object} args - 工具参数
 * @param {Object} retryConfig - 超时配置
 * @param {Object} [options] - 可选配置（signal 等）
 * @returns {Promise<Object>}
 */
export async function callRemoteTool(connection, toolName, args, retryConfig, options = {}) {
    const { protocol, url, ws, headers } = connection;

    if (protocol === 'sse') {
        return await sendSSERequest(
            connection,
            'tools/call',
            {
                name: toolName,
                arguments: args
            },
            retryConfig,
            options
        );
    }

    if (protocol === 'websocket') {
        return new Promise((resolve, reject) => {
            const requestId = nextWsRequestId();

            const timeout = setTimeout(() => {
                ws.removeEventListener('message', handler);
                reject(new Error(`WebSocket 工具调用超时 (${retryConfig.toolCallTimeout}ms)`));
            }, retryConfig.toolCallTimeout);

            const handler = (event) => {
                let response;
                try {
                    response = JSON.parse(event.data);
                } catch {
                    return;
                }
                if (response.id === requestId) {
                    clearTimeout(timeout);
                    ws.removeEventListener('message', handler);
                    if (response.error) {
                        reject(new Error(response.error.message));
                    } else {
                        resolve(response.result);
                    }
                }
            };

            if (options.signal) {
                options.signal.addEventListener(
                    'abort',
                    () => {
                        clearTimeout(timeout);
                        ws.removeEventListener('message', handler);
                        reject(new Error('工具执行已取消'));
                    },
                    { once: true }
                );
            }

            ws.addEventListener('message', handler);
            ws.send(
                JSON.stringify({
                    jsonrpc: '2.0',
                    id: requestId,
                    method: 'tools/call',
                    params: { name: toolName, arguments: args }
                })
            );
        });
    }

    // HTTP
    const abortController = new AbortController();
    const timeoutId = setTimeout(() => abortController.abort(), retryConfig.toolCallTimeout);

    if (options.signal) {
        options.signal.addEventListener(
            'abort',
            () => {
                clearTimeout(timeoutId);
                abortController.abort();
            },
            { once: true }
        );
    }

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json, text/event-stream',
                ...headers
            },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: Date.now(),
                method: 'tools/call',
                params: { name: toolName, arguments: args }
            }),
            signal: abortController.signal
        });

        clearTimeout(timeoutId);

        if (response.status === 404) {
            if (connection.headers) {
                delete connection.headers['Mcp-Session-Id'];
            }
            connection.sessionId = null;
            throw new Error('MCP session 已过期 (404)，需要重新连接');
        }

        if (!response.ok) {
            throw new Error(`HTTP 请求失败: ${response.status}`);
        }

        const newSessionId = response.headers.get('mcp-session-id');
        if (newSessionId && connection.headers) {
            connection.headers['Mcp-Session-Id'] = newSessionId;
        }

        const contentType = response.headers.get('content-type');
        let data;
        if (contentType && contentType.includes('text/event-stream')) {
            logger.debug('[MCP] 解析 SSE 格式响应 (tools/call)');
            const text = await response.text();
            data = parseSSE(text);
        } else {
            data = await response.json();
        }

        if (data.error) {
            throw new Error(`MCP 错误: ${data.error.message || JSON.stringify(data.error)}`);
        }

        return data.result;
    } catch (error) {
        clearTimeout(timeoutId);
        if (error.name === 'AbortError') {
            throw new Error(`HTTP 工具调用超时 (${retryConfig.toolCallTimeout}ms)`);
        }
        throw error;
    }
}
