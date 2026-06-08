/**
 * electron-bridge.js 测试
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../js/core/events.js', () => ({
    eventBus: { emit: vi.fn(), on: vi.fn() }
}));

vi.mock('../../../js/utils/platform.js', () => ({
    getIpcRenderer: vi.fn(() => null)
}));

vi.mock('../../../js/utils/logger.js', () => ({
    logger: { warn: vi.fn(), debug: vi.fn(), error: vi.fn(), info: vi.fn() }
}));

import { initElectronMCPBridge } from '../../../js/tools/mcp/electron-bridge.js';

describe('electron-bridge', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('无 ipcRenderer 静默返回', () => {
        expect(() => initElectronMCPBridge()).not.toThrow();
    });

    it('有 ipcRenderer 注册所有事件', async () => {
        const { getIpcRenderer } = await import('../../../js/utils/platform.js');
        const mockIpc = { on: vi.fn() };
        getIpcRenderer.mockReturnValue(mockIpc);

        initElectronMCPBridge();

        // 应该注册 8 个 IPC 事件
        expect(mockIpc.on).toHaveBeenCalledTimes(8);
        expect(mockIpc.on.mock.calls[0][0]).toBe('mcp:server-started');
    });

    it('IPC 事件转发到 eventBus', async () => {
        const { getIpcRenderer } = await import('../../../js/utils/platform.js');
        const { eventBus } = await import('../../../js/core/events.js');
        const handlers = {};
        const mockIpc = {
            on: vi.fn((channel, handler) => {
                handlers[channel] = handler;
            })
        };
        getIpcRenderer.mockReturnValue(mockIpc);

        initElectronMCPBridge();

        // 模拟事件触发
        handlers['mcp:server-started']({ serverId: 'test' });
        expect(eventBus.emit).toHaveBeenCalledWith('mcp:server-started', { serverId: 'test' });
    });
});
