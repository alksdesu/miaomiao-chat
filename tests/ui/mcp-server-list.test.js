/**
 * mcp-server-list.js 测试
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../js/core/state.js', () => ({
    state: {
        mcpServers: []
    }
}));

vi.mock('../../js/core/events.js', () => ({
    eventBus: { emit: vi.fn(), on: vi.fn(), off: vi.fn() }
}));

vi.mock('../../js/tools/mcp/client.js', () => ({
    mcpClient: {
        isConnected: vi.fn(() => false),
        getToolsByServer: vi.fn(() => []),
        connect: vi.fn(() => Promise.resolve({ success: true })),
        disconnect: vi.fn(() => Promise.resolve()),
        hasConnection: vi.fn(() => false)
    }
}));

vi.mock('../../js/state/storage.js', () => ({
    saveMCPServer: vi.fn(() => Promise.resolve()),
    deleteMCPServer: vi.fn(() => Promise.resolve())
}));

vi.mock('../../js/ui/notifications.js', () => ({
    showNotification: vi.fn()
}));

vi.mock('../../js/utils/dialogs.js', () => ({
    showConfirmDialog: vi.fn(() => Promise.resolve(true))
}));

vi.mock('../../js/utils/helpers.js', () => ({
    escapeHtml: vi.fn((s) => s)
}));

vi.mock('../../js/utils/icons.js', () => ({
    getIcon: vi.fn(() => '<svg></svg>')
}));

vi.mock('../../js/utils/platform.js', () => ({
    detectPlatform: vi.fn(() => 'web')
}));

vi.mock('../../js/utils/logger.js', () => ({
    logger: { warn: vi.fn(), debug: vi.fn(), error: vi.fn(), info: vi.fn() }
}));

import { state } from '../../js/core/state.js';
import { mcpClient } from '../../js/tools/mcp/client.js';
import { showNotification } from '../../js/ui/notifications.js';
import {
    renderServerList,
    connectToServer,
    renderPlatformInfo
} from '../../js/ui/mcp-server-list.js';

describe('mcp-server-list', () => {
    let modal;

    beforeEach(() => {
        vi.clearAllMocks();
        state.mcpServers = [];
        modal = document.createElement('div');
        modal.innerHTML = `
            <div id="mcp-server-list"></div>
            <span id="mcp-platform-badge"></span>
            <div id="mcp-platform-warning"></div>
        `;
        document.body.appendChild(modal);
    });

    afterEach(() => {
        document.body.innerHTML = '';
    });

    // ========== renderServerList ==========
    describe('renderServerList', () => {
        it('null modal 不抛错', () => {
            expect(() => renderServerList(null)).not.toThrow();
        });

        it('无 listContainer 不抛错', () => {
            const emptyModal = document.createElement('div');
            expect(() => renderServerList(emptyModal)).not.toThrow();
        });

        it('无服务器显示空状态', () => {
            state.mcpServers = [];
            renderServerList(modal);
            const list = modal.querySelector('#mcp-server-list');
            expect(list.innerHTML).toContain('暂无 MCP 服务器');
        });

        it('渲染服务器卡片', () => {
            state.mcpServers = [
                { id: 'srv1', name: 'Test Server', type: 'remote', url: 'https://test.com' }
            ];
            renderServerList(modal);
            const card = modal.querySelector('.mcp-server-card');
            expect(card).toBeTruthy();
            expect(card.dataset.serverId).toBe('srv1');
        });

        it('已连接服务器显示断开按钮', () => {
            state.mcpServers = [
                { id: 'srv1', name: 'Connected', type: 'remote', url: 'https://test.com' }
            ];
            mcpClient.isConnected.mockReturnValue(true);
            mcpClient.getToolsByServer.mockReturnValue([{ name: 'tool1', description: 'desc' }]);

            renderServerList(modal);
            const disconnectBtn = modal.querySelector('.mcp-disconnect-btn');
            expect(disconnectBtn).toBeTruthy();
        });

        it('未连接服务器显示连接按钮', () => {
            state.mcpServers = [
                { id: 'srv1', name: 'Disconnected', type: 'remote', url: 'https://test.com' }
            ];
            mcpClient.isConnected.mockReturnValue(false);

            renderServerList(modal);
            const connectBtn = modal.querySelector('.mcp-connect-btn');
            expect(connectBtn).toBeTruthy();
        });

        it('重试计数 > 0 显示重试按钮', () => {
            state.mcpServers = [
                {
                    id: 'srv1',
                    name: 'Retry',
                    type: 'remote',
                    url: 'https://test.com',
                    retryCount: 2
                }
            ];
            mcpClient.isConnected.mockReturnValue(false);

            renderServerList(modal);
            const connectBtn = modal.querySelector('.mcp-connect-btn');
            expect(connectBtn.classList.contains('retry-btn')).toBe(true);
        });

        it('本地服务器显示命令信息', () => {
            state.mcpServers = [
                {
                    id: 'srv1',
                    name: 'Local',
                    type: 'local',
                    command: 'npx',
                    args: ['-y', '@mcp/fs']
                }
            ];
            renderServerList(modal);
            const details = modal.querySelector('.mcp-server-details');
            expect(details.innerHTML).toContain('npx');
        });

        it('多个服务器渲染多个卡片', () => {
            state.mcpServers = [
                { id: 'srv1', name: 'Server A', type: 'remote', url: 'https://a.com' },
                { id: 'srv2', name: 'Server B', type: 'remote', url: 'https://b.com' }
            ];
            renderServerList(modal);
            const cards = modal.querySelectorAll('.mcp-server-card');
            expect(cards.length).toBe(2);
        });
    });

    // ========== connectToServer ==========
    describe('connectToServer', () => {
        it('服务器不存在静默返回', async () => {
            state.mcpServers = [];
            await connectToServer(modal, 'nonexistent');
            expect(mcpClient.connect).not.toHaveBeenCalled();
        });

        it('连接成功显示通知', async () => {
            state.mcpServers = [
                { id: 'srv1', name: 'My Server', type: 'remote', url: 'https://test.com' }
            ];
            mcpClient.connect.mockResolvedValue({ success: true });

            // 渲染以便查找连接按钮
            renderServerList(modal);
            await connectToServer(modal, 'srv1');

            expect(mcpClient.connect).toHaveBeenCalled();
            expect(showNotification).toHaveBeenCalledWith(
                expect.stringContaining('My Server'),
                'success'
            );
        });

        it('连接失败显示错误', async () => {
            state.mcpServers = [
                { id: 'srv1', name: 'Fail Server', type: 'remote', url: 'https://test.com' }
            ];
            mcpClient.connect.mockResolvedValue({
                success: false,
                error: 'timeout',
                errorType: 'timeout'
            });

            renderServerList(modal);
            await connectToServer(modal, 'srv1');

            expect(showNotification).toHaveBeenCalledWith(expect.any(String), 'error');
        });
    });

    // ========== renderPlatformInfo ==========
    describe('renderPlatformInfo', () => {
        it('设置平台 badge', () => {
            renderPlatformInfo(modal);
            const badge = modal.querySelector('#mcp-platform-badge');
            expect(badge.textContent).toBeTruthy();
        });

        it('Web 平台显示警告', () => {
            renderPlatformInfo(modal);
            const warning = modal.querySelector('#mcp-platform-warning');
            expect(warning.innerHTML).toContain('Web');
        });

        it('badge 不存在不抛错', () => {
            const emptyModal = document.createElement('div');
            expect(() => renderPlatformInfo(emptyModal)).not.toThrow();
        });
    });
});
