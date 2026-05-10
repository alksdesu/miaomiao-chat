/**
 * DevTools 控制台工具 — 读取/清除控制台日志
 */

import { buildToolFromLegacy } from '../../tools/build-tool.js';

// ========== devtools_read_console ==========

export const readConsoleTool = {
    name: 'devtools_read_console',
    description:
        'Read console log entries from the browser DevTools console. Returns all captured log entries with timestamps and levels.',
    parameters: {
        type: 'object',
        properties: {
            level: {
                type: 'string',
                enum: ['all', 'debug', 'info', 'log', 'warn', 'error'],
                description: 'Filter by log level. Default: all'
            }
        }
    }
};

export async function readConsoleHandler(args) {
    const { state } = await import('../../core/state.js');
    const sessionId = state.currentSessionId;

    const { getConsoleEntries } = await import('../console-interceptor.js');
    const filter = args.level && args.level !== 'all' ? { level: args.level } : undefined;
    const entries = getConsoleEntries(filter);

    if (state.currentSessionId !== sessionId) {
        return { error: 'Session switched during operation' };
    }
    return { entries, count: entries.length };
}

// ========== devtools_clear_console ==========

export const clearConsoleTool = {
    name: 'devtools_clear_console',
    description: 'Clear all captured console log entries from the DevTools console buffer.',
    parameters: {
        type: 'object',
        properties: {}
    }
};

export async function clearConsoleHandler() {
    const { state } = await import('../../core/state.js');
    const sessionId = state.currentSessionId;

    const { clearConsoleEntries } = await import('../console-interceptor.js');
    const cleared = clearConsoleEntries();

    if (state.currentSessionId !== sessionId) {
        return { error: 'Session switched during operation' };
    }
    return { success: true, cleared };
}

// ========== 标准化工具对象 ==========

export const readConsole = buildToolFromLegacy(
    'devtools_read_console',
    readConsoleTool,
    readConsoleHandler,
    {
        isReadOnly: () => true
    }
);

export const clearConsole = buildToolFromLegacy(
    'devtools_clear_console',
    clearConsoleTool,
    clearConsoleHandler,
    {
        isReadOnly: () => false
    }
);
