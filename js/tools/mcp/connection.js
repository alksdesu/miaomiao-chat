/**
 * MCP 连接管理模块
 * 处理 WebSocket / SSE / HTTP 三种传输协议的连接建立、心跳、重连
 */

import { state } from '../../core/state.js';
import { eventBus } from '../../core/events.js';
import { logger } from '../../utils/logger.js';

let wsRequestCounter = 0;

/** 递增 WS 请求计数器 */
export function nextWsRequestId() {
    return 'ws_' + ++wsRequestCounter;
}

/**
 * Electron: 通过 IPC 连接到本地 MCP
 * @param {Object} config - 服务器配置
 * @returns {Promise<Object>} 连接对象
 */
export async function connectLocalElectron(config) {
    const { id, command, args, env, cwd } = config;

    const result = await window.electron.ipcRenderer.invoke('mcp:connect', {
        serverId: id,
        command,
        args,
        env,
        cwd
    });

    if (!result.success) {
        throw new Error(result.error);
    }

    return {
        type: 'local',
        serverId: id
    };
}

/**
 * 连接到远程 MCP 服务器
 * 根据 URL 和 transportType 自动选择 WebSocket / SSE / HTTP 协议
 * @param {Object} config - 服务器配置
 * @param {Object} retryConfig - 重试配置
 * @param {Object} context - 上下文 { onNotification, onConnectionLost, connectFn }
 * @returns {Promise<Object>} 连接对象
 */
export async function connectRemote(config, retryConfig, context) {
    const { url, apiKey, headers = {}, customHeaders = {}, transportType } = config;

    if (!url) {
        throw new Error('远程 MCP 需要提供 url 参数');
    }

    const mergedHeaders = {
        ...customHeaders,
        ...headers
    };

    if (
        apiKey &&
        !Object.keys(mergedHeaders).some((key) => key.toLowerCase() === 'authorization')
    ) {
        mergedHeaders['Authorization'] = `Bearer ${apiKey}`;
    }

    // 判断传输类型
    let isWebSocket = false;
    let protocol = 'http';

    if (transportType) {
        if (transportType === 'websocket') {
            isWebSocket = true;
            protocol = 'websocket';
        } else if (transportType === 'streamable-http') {
            isWebSocket = false;
            protocol = 'streamable-http';
        } else if (transportType === 'sse') {
            isWebSocket = false;
            protocol = 'sse';
        } else if (transportType === 'http') {
            isWebSocket = false;
            protocol = 'http';
        } else {
            logger.warn(`[MCP] 未知的传输类型: ${transportType}，将根据 URL 自动检测`);
            isWebSocket = url.startsWith('ws://') || url.startsWith('wss://');

            if (isWebSocket) {
                protocol = 'websocket';
            } else {
                try {
                    const urlObj = new URL(url, window.location.href);
                    protocol = urlObj.pathname.toLowerCase().endsWith('/sse') ? 'sse' : 'http';
                } catch {
                    protocol = 'http';
                }
            }
        }
    } else {
        isWebSocket = url.startsWith('ws://') || url.startsWith('wss://');

        if (isWebSocket) {
            protocol = 'websocket';
        } else {
            try {
                const urlObj = new URL(url, window.location.href);
                protocol = urlObj.pathname.toLowerCase().endsWith('/sse') ? 'sse' : 'http';
            } catch {
                protocol = 'http';
            }
        }
    }

    if (isWebSocket) {
        return _connectWebSocket(config, mergedHeaders, retryConfig, context);
    } else if (protocol === 'sse') {
        return _connectSSE(config, mergedHeaders, retryConfig, context);
    } else {
        return _connectHTTP(config, mergedHeaders, retryConfig, protocol);
    }
}

// ========== WebSocket 连接 ==========

async function _connectWebSocket(config, mergedHeaders, retryConfig, context) {
    const { id, url } = config;
    const ws = new WebSocket(url);

    await new Promise((resolve, reject) => {
        let initHandler = null;

        const timeout = setTimeout(() => {
            if (initHandler) {
                ws.removeEventListener('message', initHandler);
            }
            try {
                ws.close();
            } catch {
                /* ignore */
            }
            reject(new Error(`WebSocket 连接超时 (${retryConfig.connectionTimeout}ms)`));
        }, retryConfig.connectionTimeout);

        ws.onopen = async () => {
            logger.debug(`[MCP] WebSocket 已连接，发送初始化请求`);

            const initRequest = {
                jsonrpc: '2.0',
                id: 1,
                method: 'initialize',
                params: {
                    protocolVersion: '2024-11-05',
                    capabilities: {},
                    clientInfo: { name: 'webchat', version: '1.1.4' }
                }
            };

            initHandler = (event) => {
                const response = JSON.parse(event.data);
                if (response.id === 1) {
                    ws.removeEventListener('message', initHandler);
                    clearTimeout(timeout);

                    ws._serverCapabilities = response.result?.capabilities || {};
                    ws._serverInfo = response.result?.serverInfo || {};

                    ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'initialized' }));
                    resolve();
                }
            };

            ws.addEventListener('message', initHandler);
            ws.send(JSON.stringify(initRequest));
        };

        ws.onerror = (error) => {
            if (initHandler) ws.removeEventListener('message', initHandler);
            clearTimeout(timeout);
            try {
                ws.close();
            } catch {
                /* ignore */
            }
            reject(error);
        };
    });

    const instanceId = `ws_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

    // 心跳保活（30 秒）
    const pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'ping' }));
        }
    }, 30000);

    // 监听服务器 notification
    ws.addEventListener('message', (event) => {
        try {
            const data = JSON.parse(event.data);
            if (!data.id && data.method) {
                context.onNotification(id, data);
            }
        } catch {
            /* 忽略非 JSON 消息 */
        }
    });

    // 异常断开时自动重连
    ws.onclose = (event) => {
        clearInterval(pingTimer);
        if (!event.wasClean && context.hasConnection(id)) {
            const current = context.getConnection(id);
            if (!current || current.instanceId !== instanceId) return;

            current.connected = false;
            context.clearToolsForServer(id);
            eventBus.emit('mcp:disconnected', { serverId: id, reason: 'connection-lost' });

            logger.warn(`[MCP] WebSocket 异常断开: ${config.name} (code: ${event.code})`);
            eventBus.emit('mcp:connection-lost', {
                serverId: id,
                serverName: config.name,
                reason: event.reason || '连接断开'
            });

            const MAX_RECONNECT_ATTEMPTS = 5;
            const conn = context.getConnection(id);
            const reconnectAttempt = (conn?.reconnectAttempts || 0) + 1;
            if (reconnectAttempt > MAX_RECONNECT_ATTEMPTS) {
                logger.warn(
                    `[MCP] WebSocket 重连次数已达上限 (${MAX_RECONNECT_ATTEMPTS})，停止重连: ${config.name}`
                );
                eventBus.emit('mcp:reconnect-failed', {
                    serverId: id,
                    serverName: config.name,
                    error: `超过最大重连次数 (${MAX_RECONNECT_ATTEMPTS})`
                });
                return;
            }
            if (conn) conn.reconnectAttempts = reconnectAttempt;

            const delay = Math.min(5000 * Math.pow(2, reconnectAttempt - 1), 60000);

            setTimeout(async () => {
                const connection = context.getConnection(id);
                if (!connection || connection.instanceId !== instanceId) return;
                if (connection.connected) return;

                if (connection.shouldReconnect && context.hasConnection(id)) {
                    const server = state.mcpServers.find((s) => s.id === id);

                    if (server) {
                        logger.debug(
                            `[MCP] 尝试自动重连: ${config.name} (${reconnectAttempt}/${MAX_RECONNECT_ATTEMPTS})`
                        );
                        const result = await context.connectFn(server);
                        if (result.success) {
                            logger.debug(`[MCP] 自动重连成功: ${config.name}`);
                            const c = context.getConnection(id);
                            if (c) c.reconnectAttempts = 0;
                        } else {
                            logger.error(`[MCP] 自动重连失败: ${config.name}`);
                            eventBus.emit('mcp:reconnect-failed', {
                                serverId: id,
                                serverName: config.name,
                                error: result.error
                            });
                        }
                    } else {
                        logger.debug(`[MCP] 服务器配置已删除，取消重连: ${id}`);
                    }
                } else {
                    logger.debug(`[MCP] 连接已手动断开或删除，取消重连: ${id}`);
                }
            }, delay);
        }
    };

    return {
        type: 'remote',
        protocol: 'websocket',
        url,
        ws,
        apiKey: config.apiKey,
        headers: mergedHeaders,
        instanceId,
        pingTimer,
        serverCapabilities: ws._serverCapabilities || {},
        serverInfo: ws._serverInfo || {},
        shouldReconnect: true
    };
}

// ========== SSE 连接 ==========

async function _connectSSE(config, requestHeaders, retryConfig, context) {
    const { id, url } = config;
    const instanceId = `sse_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

    const sseAbortController = new AbortController();
    const connectTimeoutId = setTimeout(() => {
        sseAbortController.abort();
    }, retryConfig.connectionTimeout);

    let response;
    try {
        response = await fetch(url, {
            method: 'GET',
            headers: { Accept: 'text/event-stream', ...requestHeaders },
            signal: sseAbortController.signal
        });
    } catch (error) {
        if (error.name === 'AbortError') {
            throw new Error(`SSE 连接超时 (${retryConfig.connectionTimeout}ms)`);
        }
        throw error;
    } finally {
        clearTimeout(connectTimeoutId);
    }

    if (!response.ok) {
        let bodyText = '';
        try {
            bodyText = await response.text();
        } catch {
            /* ignore */
        }
        throw new Error(
            `SSE 连接失败: ${response.status} ${response.statusText}${bodyText ? ` - ${bodyText}` : ''}`
        );
    }

    if (!response.body) {
        throw new Error('SSE 响应不支持流式读取（response.body 为空）');
    }

    const sseReader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    const pendingRequests = new Map();
    let endpointResolved = false;
    let endpointResolve;
    let endpointReject;

    const endpointPromise = new Promise((resolve, reject) => {
        endpointResolve = resolve;
        endpointReject = reject;
    });

    const connection = {
        type: 'remote',
        protocol: 'sse',
        sseUrl: url,
        url: null,
        headers: requestHeaders,
        pendingRequests,
        requestIdCounter: 0,
        sseAbortController,
        sseReader,
        sseLoop: null,
        instanceId,
        lastEventTime: Date.now(),
        shouldReconnect: true,
        healthCheckTimer: null
    };

    const rejectPendingRequests = (error) => {
        for (const pending of pendingRequests.values()) {
            clearTimeout(pending.timeoutId);
            pending.reject(error);
        }
        pendingRequests.clear();
    };

    const parseEvent = (rawEvent) => {
        const lines = rawEvent.split(/\r?\n/);
        let eventName = 'message';
        const dataLines = [];

        for (const line of lines) {
            if (!line) continue;
            if (line.startsWith(':')) continue;
            if (line.startsWith('event:')) {
                eventName = line.slice(6).trim() || 'message';
                continue;
            }
            if (line.startsWith('data:')) {
                dataLines.push(line.slice(5).trimStart());
            }
        }

        return { eventName, data: dataLines.join('\n') };
    };

    const handleJsonRpcMessage = (json) => {
        if (!json) return;

        if (json.id && pendingRequests.has(json.id)) {
            const pending = pendingRequests.get(json.id);
            clearTimeout(pending.timeoutId);
            pendingRequests.delete(json.id);

            if (json.error) {
                pending.reject(new Error(json.error.message || JSON.stringify(json.error)));
            } else {
                pending.resolve(json.result);
            }
            return;
        }

        if (json.method) {
            context.onNotification(id, json);
        }
    };

    const handleSseEvent = (eventName, data) => {
        if (!data) return;
        connection.lastEventTime = Date.now();

        if (eventName === 'endpoint') {
            let endpoint = data.trim();

            if (endpoint.startsWith('{')) {
                try {
                    const parsed = JSON.parse(endpoint);
                    if (parsed && typeof parsed === 'object' && parsed.endpoint) {
                        endpoint = String(parsed.endpoint);
                    }
                } catch {
                    /* ignore */
                }
            }

            let messageUrl;
            try {
                messageUrl = new URL(endpoint, url).toString();
            } catch {
                messageUrl = endpoint;
            }

            endpointResolved = true;
            endpointResolve(messageUrl);
            return;
        }

        try {
            const json = JSON.parse(data);
            handleJsonRpcMessage(json);
        } catch {
            /* ignore non-JSON payloads */
        }
    };

    const readLoop = (async () => {
        try {
            while (true) {
                const { value, done } = await sseReader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });

                let separatorMatch;
                while ((separatorMatch = buffer.match(/\r?\n\r?\n/))) {
                    const separatorIndex = separatorMatch.index ?? -1;
                    if (separatorIndex < 0) break;

                    const separatorLength = separatorMatch[0].length;
                    const rawEvent = buffer.slice(0, separatorIndex);
                    buffer = buffer.slice(separatorIndex + separatorLength);

                    const { eventName, data } = parseEvent(rawEvent);
                    handleSseEvent(eventName, data);
                }
            }
        } catch (error) {
            if (error.name !== 'AbortError') {
                logger.warn('[MCP] SSE 读取异常:', error);
            }
        }

        if (connection.healthCheckTimer) {
            clearInterval(connection.healthCheckTimer);
            connection.healthCheckTimer = null;
        }

        if (!endpointResolved) {
            endpointReject(new Error('SSE 连接已关闭（未收到 endpoint 事件）'));
        }

        rejectPendingRequests(new Error('SSE 连接已关闭'));

        const current = context.getConnection(id);
        const canReconnect =
            !sseAbortController.signal.aborted &&
            current &&
            current.protocol === 'sse' &&
            current.shouldReconnect &&
            current.instanceId === instanceId;

        if (!canReconnect) return;

        current.connected = false;
        context.clearToolsForServer(id);
        eventBus.emit('mcp:disconnected', { serverId: id, reason: 'connection-lost' });

        const maxReconnectAttempts = 5;
        const reconnectAttempt = (current.reconnectAttempts || 0) + 1;
        if (reconnectAttempt > maxReconnectAttempts) {
            logger.warn(
                `[MCP] SSE 重连次数已达上限 (${maxReconnectAttempts})，停止重连: ${config.name || id}`
            );
            eventBus.emit('mcp:reconnect-failed', {
                serverId: id,
                serverName: config.name || id,
                error: `超过最大重连次数 (${maxReconnectAttempts})`
            });
            return;
        }

        current.reconnectAttempts = reconnectAttempt;
        const delay = Math.min(5000 * Math.pow(2, reconnectAttempt - 1), 60000);
        logger.warn(
            `[MCP] SSE 异常断开: ${config.name || id}，${delay / 1000}s 后重连 (${reconnectAttempt}/${maxReconnectAttempts})`
        );

        eventBus.emit('mcp:connection-lost', {
            serverId: id,
            serverName: config.name || id,
            protocol: 'sse'
        });

        setTimeout(async () => {
            const stillThere = context.getConnection(id);
            if (!stillThere || stillThere.instanceId !== instanceId) return;
            if (!stillThere.shouldReconnect || stillThere.connected) return;

            const server = state.mcpServers.find((item) => item.id === id);
            if (!server) return;

            const result = await context.connectFn(server);
            if (result.success) {
                const conn = context.getConnection(id);
                if (conn) conn.reconnectAttempts = 0;
                return;
            }

            eventBus.emit('mcp:reconnect-failed', {
                serverId: id,
                serverName: config.name || id,
                error: result.error
            });
        }, delay);
    })();

    connection.sseLoop = readLoop;

    let endpointUrl;
    try {
        endpointUrl = await Promise.race([
            endpointPromise,
            new Promise((_, reject) =>
                setTimeout(
                    () =>
                        reject(new Error(`SSE endpoint 超时 (${retryConfig.connectionTimeout}ms)`)),
                    retryConfig.connectionTimeout
                )
            )
        ]);
        connection.url = endpointUrl;
    } catch (error) {
        sseAbortController.abort();
        try {
            await sseReader.cancel();
        } catch {
            /* ignore */
        }
        throw error;
    }

    connection.healthCheckTimer = setInterval(() => {
        if (Date.now() - connection.lastEventTime > 60000) {
            logger.warn(`[MCP] SSE 连接可能已断开（60s 无事件），触发重连: ${id}`);
            clearInterval(connection.healthCheckTimer);
            connection.healthCheckTimer = null;
            sseAbortController.abort();
        }
    }, 30000);

    try {
        const initResult = await sendSSERequest(
            connection,
            'initialize',
            {
                protocolVersion: '2024-11-05',
                capabilities: {},
                clientInfo: { name: 'webchat', version: '1.1.4' }
            },
            retryConfig
        );

        connection.serverCapabilities = initResult?.capabilities || {};
        connection.serverInfo = initResult?.serverInfo || {};
        sendSSENotification(connection, 'initialized');
    } catch (error) {
        sseAbortController.abort();
        try {
            await sseReader.cancel();
        } catch {
            /* ignore */
        }
        rejectPendingRequests(error);
        throw error;
    }

    return connection;
}

// ========== HTTP 连接 ==========

async function _connectHTTP(config, requestHeaders, retryConfig, protocol) {
    const { id, url } = config;
    const fullHeaders = {
        Accept: 'application/json, text/event-stream',
        ...requestHeaders
    };

    logger.debug(`[MCP] 建立 HTTP 连接并初始化: ${url}`);

    try {
        const abortController = new AbortController();
        const timeoutId = setTimeout(() => abortController.abort(), retryConfig.connectionTimeout);

        let initResponse;
        try {
            initResponse = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json, text/event-stream',
                    ...fullHeaders
                },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'initialize',
                    params: {
                        protocolVersion: '2024-11-05',
                        capabilities: {},
                        clientInfo: { name: 'webchat', version: '1.1.4' }
                    }
                }),
                signal: abortController.signal
            });
        } finally {
            clearTimeout(timeoutId);
        }

        if (!initResponse.ok) {
            throw new Error(`初始化失败: ${initResponse.status}`);
        }

        const contentType = initResponse.headers.get('content-type') || '';
        let initData;

        if (contentType.includes('text/event-stream')) {
            logger.debug('[MCP] 收到 SSE 格式响应');
            const text = await initResponse.text();
            initData = parseSSE(text);
        } else {
            initData = await initResponse.json();
        }

        logger.debug(`[MCP] 初始化成功:`, initData);

        const serverCapabilities = initData?.result?.capabilities || {};
        const serverInfo = initData?.result?.serverInfo || {};

        const sessionId = initResponse.headers.get('mcp-session-id');
        if (sessionId) {
            logger.debug(`[MCP] 获取到 Session ID: ${sessionId}`);
            fullHeaders['Mcp-Session-Id'] = sessionId;
            try {
                sessionStorage.setItem(`mcp-session-${id}`, sessionId);
            } catch {
                /* ignore */
            }
        }

        fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json, text/event-stream',
                ...fullHeaders
            },
            body: JSON.stringify({ jsonrpc: '2.0', method: 'initialized' })
        }).catch((err) => logger.warn('[MCP] initialized 通知失败:', err));

        return {
            type: 'remote',
            protocol: protocol,
            url,
            apiKey: config.apiKey,
            headers: fullHeaders,
            serverCapabilities,
            serverInfo,
            sessionId: sessionId || null
        };
    } catch (error) {
        logger.error(`[MCP] 初始化失败:`, error);
        if (error.name === 'AbortError') {
            throw new Error(`HTTP 初始化超时 (${retryConfig.connectionTimeout}ms)`);
        }
        throw error;
    }
}

// ========== SSE 请求/通知 ==========

/**
 * SSE: 发送 JSON-RPC 通知（无 id，无响应）
 */
export function sendSSENotification(connection, method, params) {
    const body = { jsonrpc: '2.0', method };
    if (params !== undefined) body.params = params;

    fetch(connection.url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            ...connection.headers
        },
        body: JSON.stringify(body)
    }).catch((err) => logger.warn('[MCP] SSE 通知发送失败:', err));
}

/**
 * SSE: 发送 JSON-RPC 请求并等待 SSE 流中的响应
 */
export async function sendSSERequest(
    connection,
    method,
    params = {},
    retryConfig = {},
    options = {}
) {
    const requestId = `sse_${Date.now()}_${++connection.requestIdCounter}`;
    const timeoutMs =
        method === 'tools/call'
            ? retryConfig.toolCallTimeout || 180000
            : retryConfig.connectionTimeout || 10000;

    if (options.signal?.aborted) {
        throw new Error('请求已取消');
    }

    const abortController = new AbortController();
    let onAbort = null;

    try {
        const resultPromise = new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                connection.pendingRequests.delete(requestId);
                reject(new Error(`SSE 请求超时 (${timeoutMs}ms): ${method}`));
                abortController.abort();
            }, timeoutMs);

            connection.pendingRequests.set(requestId, { resolve, reject, timeoutId });

            onAbort = () => {
                const pending = connection.pendingRequests.get(requestId);
                if (!pending) {
                    abortController.abort();
                    return;
                }
                clearTimeout(pending.timeoutId);
                connection.pendingRequests.delete(requestId);
                pending.reject(new Error('请求已取消'));
                abortController.abort();
            };

            if (options.signal) {
                options.signal.addEventListener('abort', onAbort, { once: true });
                if (options.signal.aborted) onAbort();
            }

            fetch(connection.url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json',
                    ...connection.headers
                },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: requestId,
                    method,
                    params
                }),
                signal: abortController.signal
            })
                .then(async (response) => {
                    if (!response.ok) {
                        const text = await response.text().catch(() => '');
                        throw new Error(
                            `HTTP 请求失败: ${response.status} ${response.statusText}${text ? ` - ${text}` : ''}`
                        );
                    }
                })
                .catch((error) => {
                    const pending = connection.pendingRequests.get(requestId);
                    if (!pending) return;
                    clearTimeout(pending.timeoutId);
                    connection.pendingRequests.delete(requestId);
                    if (error.name === 'AbortError') {
                        reject(new Error(`SSE 请求已取消/超时: ${method}`));
                    } else {
                        reject(error);
                    }
                });
        });

        return await resultPromise;
    } finally {
        if (options.signal && onAbort) {
            options.signal.removeEventListener('abort', onAbort);
        }
    }
}

/**
 * 解析 Server-Sent Events (SSE) 格式的响应
 * @param {string} text - SSE 文本内容
 * @returns {Object} 解析后的 JSON-RPC 响应
 */
export function parseSSE(text) {
    try {
        const rawEvents = text.trim().split(/\r?\n\r?\n+/);
        let lastParsed = null;

        for (const rawEvent of rawEvents) {
            const lines = rawEvent.split(/\r?\n/);
            const dataLines = [];

            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    dataLines.push(line.substring(6));
                } else if (line.startsWith('data:')) {
                    dataLines.push(line.substring(5).trimStart());
                }
            }

            const jsonData = dataLines.join('\n').trim();
            if (!jsonData) continue;

            try {
                lastParsed = JSON.parse(jsonData);
            } catch {
                /* ignore malformed event data */
            }
        }

        if (!lastParsed) {
            throw new Error('SSE 响应中没有找到有效的 JSON data');
        }

        logger.debug('[MCP] SSE 解析结果:', lastParsed);
        return lastParsed;
    } catch (error) {
        logger.error('[MCP] SSE 解析失败:', error);
        logger.error('[MCP] 原始文本:', text);
        throw new Error(`SSE 解析失败: ${error.message}`);
    }
}

/**
 * 错误分类
 * @param {Error} error
 * @returns {{ type: string, retryable: boolean }}
 */
export function classifyError(error) {
    const message = error.message.toLowerCase();

    if (message.includes('platform') || message.includes('平台')) {
        return { type: 'platform_unsupported', retryable: false };
    }
    if (message.includes('url') || message.includes('参数') || message.includes('invalid')) {
        return { type: 'invalid_config', retryable: false };
    }
    if (
        message.includes('unauthorized') ||
        message.includes('forbidden') ||
        message.includes('401') ||
        message.includes('403')
    ) {
        return { type: 'auth_failed', retryable: false };
    }
    if (message.includes('timeout') || message.includes('超时')) {
        return { type: 'timeout', retryable: true };
    }
    if (message.includes('network') || message.includes('fetch') || message.includes('websocket')) {
        return { type: 'network_error', retryable: true };
    }
    if (
        message.includes('500') ||
        message.includes('502') ||
        message.includes('503') ||
        message.includes('504')
    ) {
        return { type: 'server_error', retryable: true };
    }
    return { type: 'unknown_error', retryable: true };
}
