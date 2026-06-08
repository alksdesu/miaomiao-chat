/**
 * mcp-auto-connect.js 自动连接测试
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../js/core/state.js', () => ({
    state: {
        mcpServers: []
    }
}));

vi.mock('../../js/tools/mcp/client.js', () => ({
    mcpClient: {
        connect: vi.fn(() => Promise.resolve({ success: true })),
        getToolsByServer: vi.fn(() => [])
    }
}));

vi.mock('../../js/ui/notifications.js', () => ({
    showNotification: vi.fn()
}));

vi.mock('../../js/utils/logger.js', () => ({
    logger: { warn: vi.fn(), debug: vi.fn(), error: vi.fn(), info: vi.fn() }
}));

vi.mock('../../js/tools/manager.js', () => ({
    loadToolStates: vi.fn(() => Promise.resolve())
}));

import { state } from '../../js/core/state.js';
import { mcpClient } from '../../js/tools/mcp/client.js';
import { showNotification } from '../../js/ui/notifications.js';
import { autoConnectMCPServers } from '../../js/ui/mcp-auto-connect.js';

describe('mcp-auto-connect', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        state.mcpServers = [];
    });

    it('无服务器返回 0', async () => {
        const result = await autoConnectMCPServers({
            showNotifications: false,
            delayBetweenConnections: 0
        });
        expect(result.total).toBe(0);
        expect(result.connected).toBe(0);
    });

    it('连接成功', async () => {
        state.mcpServers = [{ id: 's1', name: 'Server 1', type: 'sse' }];
        mcpClient.connect.mockResolvedValue({ success: true });
        mcpClient.getToolsByServer.mockReturnValue([{ name: 'tool1' }]);

        const result = await autoConnectMCPServers({
            showNotifications: false,
            delayBetweenConnections: 0
        });
        expect(result.connected).toBe(1);
        expect(result.failed).toBe(0);
    });

    it('连接失败', async () => {
        state.mcpServers = [{ id: 's1', name: 'Server 1', type: 'sse' }];
        mcpClient.connect.mockResolvedValue({ success: false, error: 'timeout' });

        const result = await autoConnectMCPServers({
            showNotifications: false,
            delayBetweenConnections: 0
        });
        expect(result.connected).toBe(0);
        expect(result.failed).toBe(1);
        expect(result.errors).toHaveLength(1);
    });

    it('连接异常', async () => {
        state.mcpServers = [{ id: 's1', name: 'Server 1', type: 'sse' }];
        mcpClient.connect.mockRejectedValue(new Error('network error'));

        const result = await autoConnectMCPServers({
            showNotifications: false,
            delayBetweenConnections: 0
        });
        expect(result.failed).toBe(1);
    });

    it('跳过禁用的服务器', async () => {
        state.mcpServers = [
            { id: 's1', name: 'Disabled', type: 'sse', enabled: false },
            { id: 's2', name: 'Active', type: 'sse' }
        ];
        mcpClient.connect.mockResolvedValue({ success: true });

        const result = await autoConnectMCPServers({
            showNotifications: false,
            delayBetweenConnections: 0
        });
        expect(mcpClient.connect).toHaveBeenCalledTimes(1);
        expect(result.connected).toBe(1);
    });

    it('全部成功显示成功通知', async () => {
        state.mcpServers = [{ id: 's1', name: 'Server', type: 'sse' }];
        mcpClient.connect.mockResolvedValue({ success: true });

        await autoConnectMCPServers({ showNotifications: true, delayBetweenConnections: 0 });
        expect(showNotification).toHaveBeenCalledWith(expect.stringContaining('成功'), 'success');
    });

    it('部分失败显示警告通知', async () => {
        state.mcpServers = [
            { id: 's1', name: 'OK', type: 'sse' },
            { id: 's2', name: 'Fail', type: 'sse' }
        ];
        mcpClient.connect
            .mockResolvedValueOnce({ success: true })
            .mockResolvedValueOnce({ success: false, error: 'err' });

        await autoConnectMCPServers({ showNotifications: true, delayBetweenConnections: 0 });
        expect(showNotification).toHaveBeenCalledWith(expect.stringContaining('1/2'), 'warning');
    });

    it('全部失败显示错误通知', async () => {
        state.mcpServers = [{ id: 's1', name: 'Fail', type: 'sse' }];
        mcpClient.connect.mockResolvedValue({ success: false, error: 'err' });

        await autoConnectMCPServers({ showNotifications: true, delayBetweenConnections: 0 });
        expect(showNotification).toHaveBeenCalledWith(expect.stringContaining('无法'), 'error');
    });

    it('无通知模式不显示通知', async () => {
        state.mcpServers = [{ id: 's1', name: 'Server', type: 'sse' }];
        mcpClient.connect.mockResolvedValue({ success: true });

        await autoConnectMCPServers({ showNotifications: false, delayBetweenConnections: 0 });
        expect(showNotification).not.toHaveBeenCalled();
    });

    it('多服务器按顺序连接', async () => {
        state.mcpServers = [
            { id: 's1', name: 'First', type: 'sse' },
            { id: 's2', name: 'Second', type: 'sse' },
            { id: 's3', name: 'Third', type: 'sse' }
        ];
        mcpClient.connect.mockResolvedValue({ success: true });

        const result = await autoConnectMCPServers({
            showNotifications: false,
            delayBetweenConnections: 0
        });
        expect(result.total).toBe(3);
        expect(result.connected).toBe(3);
        expect(mcpClient.connect).toHaveBeenCalledTimes(3);
    });
});
