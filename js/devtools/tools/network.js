/**
 * DevTools 网络工具 — 读取网络请求记录
 */

import { buildToolFromLegacy } from '../../tools/build-tool.js';

export const readNetworkTool = {
    name: 'devtools_read_network',
    description:
        'Read captured network request records. Without recordId returns a summary list; with recordId returns full details including headers and body.',
    parameters: {
        type: 'object',
        properties: {
            recordId: {
                type: 'number',
                description: 'Specific record ID to get full details'
            }
        }
    }
};

export async function readNetworkHandler(args) {
    const { state } = await import('../../core/state.js');
    const sessionId = state.currentSessionId;

    const { getRecords, sanitizeHeaderValue } = await import('../../network/store.js');
    const records = getRecords();

    if (args.recordId != null) {
        const record = records.find((r) => r.id === args.recordId);
        if (!record) {
            return { error: `Record ${args.recordId} not found` };
        }
        // 脱敏 headers
        const result = { ...record };
        if (result.requestHeaders) {
            result.requestHeaders = Object.fromEntries(
                Object.entries(result.requestHeaders).map(([k, v]) => [
                    k,
                    sanitizeHeaderValue(k, v)
                ])
            );
        }
        if (result.responseHeaders) {
            result.responseHeaders = Object.fromEntries(
                Object.entries(result.responseHeaders).map(([k, v]) => [
                    k,
                    sanitizeHeaderValue(k, v)
                ])
            );
        }

        if (state.currentSessionId !== sessionId) {
            return { error: 'Session switched during operation' };
        }
        return result;
    }

    // 返回摘要列表
    const summary = records.map((r) => ({
        id: r.id,
        method: r.method,
        url: r.url,
        status: r.status,
        duration: r.duration,
        state: r.state,
        size: r.size,
        isStream: r.isStream
    }));

    if (state.currentSessionId !== sessionId) {
        return { error: 'Session switched during operation' };
    }
    return { records: summary, count: summary.length };
}

// ========== 标准化工具对象 ==========

export const readNetwork = buildToolFromLegacy(
    'devtools_read_network',
    readNetworkTool,
    readNetworkHandler,
    {
        isReadOnly: () => true
    }
);
