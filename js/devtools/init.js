/**
 * DevTools 模块初始化入口
 */

import { state } from '../core/state.js';
import { setMonitorEnabled } from '../core/state-mutations.js';
import { logger } from '../utils/logger.js';

/**
 * 恢复当前会话的 monitor 状态（在 tools/init.js 注册完工具后调用）
 */
export async function restoreMonitorState() {
    const session = state.sessions.find((s) => s.id === state.currentSessionId);
    if (session?.monitorEnabled) {
        const { setDevToolsToolsEnabled } = await import('./tools/index.js');
        setDevToolsToolsEnabled(true);
        setMonitorEnabled(true);
    }
    logger.debug('[DevTools] Monitor 状态已恢复');
}
