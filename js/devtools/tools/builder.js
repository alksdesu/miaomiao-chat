/**
 * DevTools 请求构建器工具 — 发送 HTTP 请求
 */

import { buildToolFromLegacy } from '../../tools/build-tool.js';

export const sendRequestTool = {
    name: 'devtools_send_request',
    description:
        'Send an HTTP request using the DevTools request builder. Opens the network panel, populates the builder form, and executes the request.',
    parameters: {
        type: 'object',
        properties: {
            method: {
                type: 'string',
                enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'],
                description: 'HTTP method'
            },
            url: {
                type: 'string',
                description: 'Full URL'
            },
            headers: {
                type: 'object',
                description: 'Request headers as key-value pairs'
            },
            body: {
                type: 'string',
                description: 'Request body content'
            },
            bodyFormat: {
                type: 'string',
                enum: ['json', 'text', 'form-data', 'x-www-form-urlencoded', 'xml'],
                description: 'Body content format'
            }
        },
        required: ['method', 'url']
    }
};

export async function sendRequestHandler(args) {
    const { state } = await import('../../core/state.js');
    const sessionId = state.currentSessionId;

    try {
        const { openNetworkPanel, switchTab } = await import('../../network/panel.js');
        openNetworkPanel();
        switchTab('builder');

        const { importToBuilder, programmaticSend } = await import('../../network/builder-view.js');
        const record = {
            method: args.method,
            url: args.url,
            requestHeaders: args.headers || {},
            requestBody: args.body || ''
        };
        importToBuilder(record);

        // 等待 UI 渲染完成
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

        const result = await programmaticSend();

        if (state.currentSessionId !== sessionId) {
            return { error: 'Session switched during operation' };
        }
        return result;
    } catch (error) {
        return { error: error.message };
    }
}

// ========== 标准化工具对象 ==========

export const sendRequest = buildToolFromLegacy(
    'devtools_send_request',
    sendRequestTool,
    sendRequestHandler,
    {
        isReadOnly: () => false
    }
);
