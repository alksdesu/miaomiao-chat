/**
 * Electron IPC → eventBus 桥接
 * 将主进程转发的 MCP 事件接入 renderer 的 eventBus
 * 仅在 Electron 环境下生效
 */

import { eventBus } from '../../core/events.js';
import { getIpcRenderer } from '../../utils/platform.js';
import { logger } from '../../utils/logger.js';

const IPC_EVENTS = [
    'mcp:server-started',
    'mcp:server-stopped',
    'mcp:server-error',
    'mcp:server-exited',
    'mcp:server-restarting',
    'mcp:server-restarted',
    'mcp:server-restart-failed',
    'mcp:restart-limit-exceeded'
];

export function initElectronMCPBridge() {
    const ipcRenderer = getIpcRenderer();
    if (!ipcRenderer) return;

    for (const channel of IPC_EVENTS) {
        ipcRenderer.on(channel, (data) => {
            eventBus.emit(channel, data);
        });
    }

    logger.debug('[MCP] Electron IPC bridge initialized');
}
