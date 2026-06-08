/**
 * DevTools 模块初始化入口
 */

import { state } from '../core/state.js';
import { setDevToolsToolsEnabled } from './tools/index.js';
// side-effect import：让 monitor-state 注册 session:switched 事件 listener
import './monitor-state.js';
import { setMonitorEnabled } from './monitor-state.js';
import { logger } from '../utils/logger.js';

/**
 * 恢复当前会话的 monitor 状态（在 tools/init.js 注册完工具后调用）
 */
export function restoreMonitorState() {
    const session = state.sessions.find((s) => s.id === state.currentSessionId);
    if (session?.monitorEnabled) {
        setDevToolsToolsEnabled(true);
        setMonitorEnabled(true);
    }
    logger.debug('[DevTools] Monitor 状态已恢复');
}
