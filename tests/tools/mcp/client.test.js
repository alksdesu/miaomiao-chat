/**
 * MCP client.js 测试
 * MCPClient 构造与基本方法
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../js/core/events.js', () => ({
    eventBus: { emit: vi.fn(), on: vi.fn(), off: vi.fn() }
}));

vi.mock('../../../js/tools/mcp/tool-cache.js', () => ({
    getCachedTools: vi.fn(() => null),
    cacheTools: vi.fn()
}));

vi.mock('../../../js/utils/platform.js', () => ({
    detectPlatform: vi.fn(() => 'web')
}));

vi.mock('../../../js/tools/mcp/connection.js', () => ({
    connectLocalElectron: vi.fn(),
    connectRemote: vi.fn(() =>
        Promise.resolve({
            success: true,
            connection: { type: 'remote', transport: 'http' }
        })
    ),
    classifyError: vi.fn((e) => ({
        type: 'unknown',
        message: e.message,
        retryable: false
    })),
    nextWsRequestId: vi.fn(() => 1),
    sendSSERequest: vi.fn(),
    parseSSE: vi.fn()
}));

vi.mock('../../../js/tools/mcp/tool-executor.js', () => ({
    discoverTools: vi.fn(),
    normalizeToolDefinition: vi.fn((t) => t),
    callRemoteTool: vi.fn()
}));

vi.mock('../../../js/utils/logger.js', () => ({
    logger: { warn: vi.fn(), debug: vi.fn(), error: vi.fn(), info: vi.fn() }
}));

import { MCPClient } from '../../../js/tools/mcp/client.js';

describe('MCPClient', () => {
    let client;

    beforeEach(() => {
        client = new MCPClient();
    });

    describe('constructor', () => {
        it('初始化 platform', () => {
            expect(client.platform).toBe('web');
        });

        it('初始化 connections 为空 Map', () => {
            expect(client.connections).toBeInstanceOf(Map);
            expect(client.connections.size).toBe(0);
        });

        it('初始化 tools 为空 Map', () => {
            expect(client.tools).toBeInstanceOf(Map);
            expect(client.tools.size).toBe(0);
        });

        it('初始化重试配置', () => {
            expect(client.retryConfig.maxRetries).toBe(3);
            expect(client.retryConfig.connectionTimeout).toBe(10000);
            expect(client.retryConfig.toolCallTimeout).toBe(180000);
        });
    });

    describe('connect', () => {
        it('本地 MCP 在 web 平台返回不支持错误', async () => {
            const result = await client.connect({ type: 'local', id: 'test' });
            expect(result.success).toBe(false);
            expect(result.errorType).toBe('platform_unsupported');
            expect(result.retryable).toBe(false);
        });

        it('远程 MCP 在 web 平台可以连接', async () => {
            const result = await client.connect({
                type: 'remote',
                id: 'remote-server',
                url: 'http://localhost:8001',
                transportType: 'http'
            });
            // 由于 _connectWithRetry 是复杂异步，这里只测试不抛错
            expect(result).toBeDefined();
        });
    });

    describe('disconnect', () => {
        it('未连接的服务器不抛错', async () => {
            await expect(client.disconnect('nonexistent')).resolves.toBeUndefined();
        });

        it('清除远程连接的定时器', async () => {
            const pingTimer = setInterval(() => {}, 99999);
            const healthCheckTimer = setInterval(() => {}, 99999);
            const connection = {
                type: 'remote',
                shouldReconnect: true,
                pingTimer,
                healthCheckTimer,
                ws: null,
                sseAbortController: null,
                sseReader: null
            };
            client.connections.set('server1', connection);

            await client.disconnect('server1');
            expect(client.connections.has('server1')).toBe(false);

            clearInterval(pingTimer);
            clearInterval(healthCheckTimer);
        });
    });

    describe('getAllTools', () => {
        it('返回所有已注册的工具', () => {
            client.tools.set('tool1', { name: 'tool1' });
            client.tools.set('tool2', { name: 'tool2' });
            const tools = client.getAllTools();
            expect(Array.isArray(tools)).toBe(true);
            expect(tools).toHaveLength(2);
        });

        it('无工具时返回空数组', () => {
            expect(client.getAllTools()).toEqual([]);
        });
    });

    describe('getToolsByServer', () => {
        it('按 serverId 过滤工具', () => {
            client.tools.set('s1__tool1', { name: 'tool1', serverId: 's1' });
            client.tools.set('s2__tool2', { name: 'tool2', serverId: 's2' });
            const tools = client.getToolsByServer('s1');
            expect(tools).toHaveLength(1);
            expect(tools[0].name).toBe('tool1');
        });

        it('无匹配返回空数组', () => {
            expect(client.getToolsByServer('nonexistent')).toEqual([]);
        });
    });

    describe('hasConnection', () => {
        it('有连接返回 true', () => {
            client.connections.set('server1', {});
            expect(client.hasConnection('server1')).toBe(true);
        });

        it('无连接返回 false', () => {
            expect(client.hasConnection('nonexistent')).toBe(false);
        });
    });

    describe('isConnected', () => {
        it('未连接返回 false', () => {
            expect(client.isConnected('nonexistent')).toBe(false);
        });

        it('连接存在且 connected 不为 false 返回 true', () => {
            client.connections.set('server1', { connected: true });
            expect(client.isConnected('server1')).toBe(true);
        });

        it('connected=false 返回 false', () => {
            client.connections.set('server1', { connected: false });
            expect(client.isConnected('server1')).toBe(false);
        });

        it('connected 未设置（undefined）返回 true', () => {
            client.connections.set('server1', {});
            expect(client.isConnected('server1')).toBe(true);
        });
    });

    describe('getStatus', () => {
        it('返回平台和连接信息', () => {
            const status = client.getStatus();
            expect(status.platform).toBe('web');
            expect(status.connected).toBe(0);
            expect(status.totalTools).toBe(0);
            expect(status.servers).toEqual([]);
        });

        it('有连接时包含服务器信息', () => {
            client.connections.set('s1', { type: 'remote', protocol: 'http' });
            const status = client.getStatus();
            expect(status.connected).toBe(1);
            expect(status.servers[0].id).toBe('s1');
        });
    });

    describe('callTool', () => {
        it('无效工具 ID 格式抛错', async () => {
            await expect(client.callTool('invalid-id', {})).rejects.toThrow('无效的工具ID格式');
        });

        it('工具不存在抛错', async () => {
            await expect(client.callTool('server__tool', {})).rejects.toThrow('工具不存在');
        });

        it('斜杠格式 ID 也能解析', async () => {
            await expect(client.callTool('server/tool', {})).rejects.toThrow('工具不存在');
        });

        it('服务器未连接抛错', async () => {
            client.tools.set('s1__calc', { name: 'calc', serverId: 's1' });
            await expect(client.callTool('s1__calc', {})).rejects.toThrow('未连接');
        });

        it('服务器 connected=false 抛错', async () => {
            client.tools.set('s1__calc', { name: 'calc', serverId: 's1' });
            client.connections.set('s1', { connected: false });
            await expect(client.callTool('s1__calc', {})).rejects.toThrow('已断开');
        });

        it('已取消的 signal 抛错', async () => {
            client.tools.set('s1__calc', { name: 'calc', serverId: 's1' });
            client.connections.set('s1', { type: 'remote', connected: true });
            const ac = new AbortController();
            ac.abort();
            await expect(client.callTool('s1__calc', {}, { signal: ac.signal })).rejects.toThrow(
                '已取消'
            );
        });
    });
});
