/**
 * Per-session 监控状态管理
 */

import { state } from '../core/state.js';
import { eventBus } from '../core/events.js';
import { setDevToolsToolsEnabled } from './tools/index.js';

// state.monitorEnabled 顶层赋值由 state.js Proxy 自动派发 state:monitorEnabled 事件
const _setMonitorEnabledState = (v) => {
    state.monitorEnabled = !!v;
};

export function isMonitorEnabled() {
    return !!state.monitorEnabled;
}

export function setMonitorEnabled(enabled) {
    _setMonitorEnabledState(!!enabled);
    setDevToolsToolsEnabled(enabled);
}

export function syncMonitorOnSessionSwitch(session) {
    const enabled = !!session?.monitorEnabled;
    _setMonitorEnabledState(enabled);
    setDevToolsToolsEnabled(enabled);
}

// 监听 monitor 专用事件（与 UI session:switched 解耦，避免 listener 跑两次）
// 用反向 eventBus 拓扑替代直接 import，避免 state/sessions.js → devtools 静态边把 tools 链拖进来
eventBus.on('session:monitor-ready', ({ session }) => {
    syncMonitorOnSessionSwitch(session);
});
