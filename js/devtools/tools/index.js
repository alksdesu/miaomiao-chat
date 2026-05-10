/**
 * DevTools 工具注册入口 — 聚合所有 DevTools 工具并提供启用/禁用控制
 */

import { registerTool, setToolEnabled } from '../../tools/manager.js';
import { readConsole, clearConsole } from './console.js';
import { readNetwork } from './network.js';
import { sendRequest } from './builder.js';
import { queryDom } from './dom.js';
import { readStorage, writeStorage } from './storage.js';

const DEVTOOLS_TOOL_IDS = [
    'devtools_read_console',
    'devtools_clear_console',
    'devtools_read_network',
    'devtools_send_request',
    'devtools_query_dom',
    'devtools_read_storage',
    'devtools_write_storage'
];

export function registerDevToolsTools() {
    registerTool(readConsole);
    registerTool(clearConsole);
    registerTool(readNetwork);
    registerTool(sendRequest);
    registerTool(queryDom);
    registerTool(readStorage);
    registerTool(writeStorage);
    // 默认禁用
    DEVTOOLS_TOOL_IDS.forEach((id) => setToolEnabled(id, false));
}

export function setDevToolsToolsEnabled(enabled) {
    DEVTOOLS_TOOL_IDS.forEach((id) => setToolEnabled(id, enabled));
}

export { DEVTOOLS_TOOL_IDS };
