/**
 * Per-session 监控状态管理
 */

import { state } from '../core/state.js';
import { setMonitorEnabled as _setMonitorEnabledState } from '../core/state-mutations.js';

export function isMonitorEnabled() {
    return !!state.monitorEnabled;
}

export async function setMonitorEnabled(enabled) {
    _setMonitorEnabledState(!!enabled);
    const { setDevToolsToolsEnabled } = await import('./tools/index.js');
    setDevToolsToolsEnabled(enabled);
}

export async function syncMonitorOnSessionSwitch(session) {
    const enabled = !!session?.monitorEnabled;
    _setMonitorEnabledState(enabled);
    const { setDevToolsToolsEnabled } = await import('./tools/index.js');
    setDevToolsToolsEnabled(enabled);
}
