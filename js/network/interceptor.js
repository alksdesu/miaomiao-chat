/**
 * Network 全局 fetch 代理
 * 通过包装 window.fetch 自动捕获所有请求/响应，包括流式 SSE
 */

import { createRecord, updateRecord, appendSSEChunk, getRecords } from './store.js';
import { logger } from '../utils/logger.js';

let enabled = true;
const originalFetch = window.fetch.bind(window);

export function enableCapture() {
    enabled = true;
}
export function disableCapture() {
    enabled = false;
}
export function isCapturing() {
    return enabled;
}

/**
 * 安装全局 fetch 代理
 */
export function installFetchProxy() {
    window.fetch = async function proxiedFetch(input, init = {}) {
        if (!enabled) return originalFetch(input, init);

        const url = typeof input === 'string' ? input : input?.url || '';
        const method = (
            init.method ||
            (typeof input !== 'string' && input?.method) ||
            'GET'
        ).toUpperCase();

        // 提取请求头
        const reqHeaders = {};
        const headerSource = init.headers || (typeof input !== 'string' && input?.headers);
        if (headerSource) {
            if (headerSource instanceof Headers) {
                headerSource.forEach((v, k) => {
                    reqHeaders[k] = v;
                });
            } else if (typeof headerSource === 'object') {
                Object.entries(headerSource).forEach(([k, v]) => {
                    reqHeaders[k] = v;
                });
            }
        }

        // 提取请求体
        let requestBody = null;
        const rawBody = init.body || (typeof input !== 'string' && input?.body);
        if (rawBody) {
            if (typeof rawBody === 'string') {
                requestBody = rawBody;
            } else if (rawBody instanceof FormData) {
                requestBody = '[FormData]';
            } else if (rawBody instanceof URLSearchParams) {
                requestBody = rawBody.toString();
            } else if (rawBody instanceof ArrayBuffer || rawBody instanceof Uint8Array) {
                requestBody = `[Binary ${rawBody.byteLength} bytes]`;
            } else if (typeof ReadableStream !== 'undefined' && rawBody instanceof ReadableStream) {
                requestBody = '[ReadableStream]';
            } else {
                try {
                    requestBody = JSON.stringify(rawBody);
                } catch {
                    requestBody = '[Unserializable]';
                }
            }
        }

        let isSSE = Object.entries(reqHeaders).some(
            ([k, v]) => k.toLowerCase() === 'accept' && v === 'text/event-stream'
        );

        if (!isSSE && requestBody && typeof requestBody === 'string') {
            try {
                const parsed = JSON.parse(requestBody);
                if (parsed.stream === true) isSSE = true;
            } catch {
                /* not JSON, skip */
            }
        }

        const record = createRecord({
            method,
            url,
            requestHeaders: reqHeaders,
            requestBody,
            isStream: isSSE
        });

        try {
            const response = await originalFetch(input, init);

            // 记录响应头和状态
            const respHeaders = {};
            response.headers.forEach((v, k) => {
                respHeaders[k] = v;
            });
            updateRecord(record.id, {
                status: response.status,
                responseHeaders: respHeaders
            });

            const contentType = response.headers.get('content-type') || '';
            const isStreamResponse =
                contentType.includes('text/event-stream') ||
                (contentType.includes('text/plain') && isSSE);

            if (response.body && isStreamResponse) {
                // 流式响应：tee() 分叉
                return teeStreamResponse(response, record.id);
            }

            // 非流式响应：clone 后台读取
            captureResponseBody(response.clone(), record.id);
            return response;
        } catch (error) {
            const endTime = performance.now();
            updateRecord(record.id, {
                state: 'error',
                error: error.name === 'AbortError' ? 'Cancelled' : error.message,
                endTime,
                duration: record.startTime ? endTime - record.startTime : null
            });
            throw error;
        }
    };

    logger.debug('[Network] fetch 代理已安装');
}

/**
 * 卸载代理，恢复原始 fetch
 */
export function uninstallFetchProxy() {
    window.fetch = originalFetch;
    logger.debug('[Network] fetch 代理已卸载');
}

/**
 * 流式响应 tee() 分叉
 */
function teeStreamResponse(response, recordId) {
    const [stream1, stream2] = response.body.tee();

    updateRecord(recordId, { state: 'streaming' });
    readStreamInBackground(stream2, recordId);

    return new Response(stream1, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers
    });
}

/**
 * 后台读取流，逐行记录 SSE 数据
 */
async function readStreamInBackground(stream, recordId) {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let totalSize = 0;
    let lineBuffer = '';

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const text = decoder.decode(value, { stream: true });
            totalSize += value.byteLength;

            lineBuffer += text;
            const lines = lineBuffer.split('\n');
            // 最后一段可能不完整，留到下次
            lineBuffer = lines.pop();
            for (const line of lines) {
                if (line.trim()) {
                    appendSSEChunk(recordId, line);
                }
            }
        }
        // flush 剩余
        if (lineBuffer.trim()) {
            appendSSEChunk(recordId, lineBuffer);
        }

        const record = getRecords().find((r) => r.id === recordId);
        const endTime = performance.now();
        updateRecord(recordId, {
            state: 'done',
            size: totalSize,
            endTime,
            duration: record?.startTime ? endTime - record.startTime : null
        });
    } catch (error) {
        if (error.name === 'AbortError') return;
        const record = getRecords().find((r) => r.id === recordId);
        const endTime = performance.now();
        updateRecord(recordId, {
            state: 'error',
            error: error.message,
            size: totalSize,
            endTime,
            duration: record?.startTime ? endTime - record.startTime : null
        });
    }
}

/**
 * 非流式响应体捕获
 */
async function captureResponseBody(response, recordId) {
    try {
        const text = await response.text();
        const record = getRecords().find((r) => r.id === recordId);
        const endTime = performance.now();
        updateRecord(recordId, {
            responseBody: text,
            size: text.length,
            state: 'done',
            endTime,
            duration: record?.startTime ? endTime - record.startTime : null
        });
    } catch (error) {
        logger.warn('[Network] 响应捕获失败:', error);
    }
}
