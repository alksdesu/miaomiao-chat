/**
 * 构建 DevTools 上下文注入到系统提示词
 */

import { getRecords, sanitizeHeaderValue } from '../network/store.js';
import { getConsoleEntries } from './console-interceptor.js';
import { isMonitorEnabled } from './monitor-state.js';

function formatConsoleLogs(entries) {
    const lines = entries.map((e) => {
        const time = new Date(e.timestamp).toISOString();
        return `[${time}] [${e.level.toUpperCase()}] ${e.message}`;
    });
    return `<console_logs count="${entries.length}">\n${lines.join('\n')}\n</console_logs>`;
}

function formatHeaders(headers, sanitize) {
    return Object.entries(headers || {})
        .map(([k, v]) => `      ${k}: ${sanitize ? sanitizeHeaderValue(k, v) : v}`)
        .join('\n');
}

function formatRequest(record) {
    const attrs = `id="${record.id}" method="${record.method}" url="${record.url}" status="${record.status ?? ''}" duration="${record.duration != null ? record.duration + 'ms' : ''}" state="${record.state}"`;
    const parts = [`    <request ${attrs}>`];

    parts.push(
        `    <request_headers>\n${formatHeaders(record.requestHeaders, true)}\n    </request_headers>`
    );
    parts.push(`    <request_body>\n      ${record.requestBody ?? ''}\n    </request_body>`);
    parts.push(
        `    <response_headers>\n${formatHeaders(record.responseHeaders, true)}\n    </response_headers>`
    );

    if (record.isStream && record.sseChunks?.length > 0) {
        parts.push(
            `    <sse_stream chunks="${record.sseChunks.length}">\n      ${record.sseChunks.join('\n      ')}\n    </sse_stream>`
        );
    } else {
        parts.push(`    <response_body>\n      ${record.responseBody ?? ''}\n    </response_body>`);
    }

    parts.push('    </request>');
    return parts.join('\n');
}

function formatNetworkRequests(records) {
    const items = records.map(formatRequest);
    return `<network_requests count="${records.length}">\n${items.join('\n')}\n</network_requests>`;
}

export function buildDevToolsContext() {
    if (!isMonitorEnabled()) return null;

    const consoleEntries = getConsoleEntries();
    const networkRecords = getRecords();

    return `<devtools_context>\n${formatConsoleLogs(consoleEntries)}\n${formatNetworkRequests(networkRecords)}\n</devtools_context>`;
}
