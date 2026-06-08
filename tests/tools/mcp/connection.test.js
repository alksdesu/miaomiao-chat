/**
 * MCP connection.js 测试
 * 测试纯函数: nextWsRequestId, parseSSE, classifyError
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../js/core/state.js', () => ({
    state: {}
}));

vi.mock('../../../js/core/events.js', () => ({
    eventBus: { emit: vi.fn(), on: vi.fn(), off: vi.fn() }
}));

vi.mock('../../../js/utils/logger.js', () => ({
    logger: { warn: vi.fn(), debug: vi.fn(), error: vi.fn(), info: vi.fn() }
}));

import { nextWsRequestId, parseSSE, classifyError } from '../../../js/tools/mcp/connection.js';

describe('connection', () => {
    // ========== nextWsRequestId ==========
    describe('nextWsRequestId', () => {
        it('返回以 ws_ 开头的字符串', () => {
            const id = nextWsRequestId();
            expect(id).toMatch(/^ws_\d+$/);
        });

        it('每次调用返回不同值', () => {
            const id1 = nextWsRequestId();
            const id2 = nextWsRequestId();
            expect(id1).not.toBe(id2);
        });

        it('递增', () => {
            const id1 = parseInt(nextWsRequestId().replace('ws_', ''));
            const id2 = parseInt(nextWsRequestId().replace('ws_', ''));
            expect(id2).toBe(id1 + 1);
        });
    });

    // ========== parseSSE ==========
    describe('parseSSE', () => {
        it('解析简单 SSE 数据', () => {
            const text = 'data: {"jsonrpc":"2.0","result":{"tools":[]}}\n\n';
            const result = parseSSE(text);
            expect(result.jsonrpc).toBe('2.0');
            expect(result.result.tools).toEqual([]);
        });

        it('解析多行 data', () => {
            const text = 'data: {"key":\n' + 'data: "value"}\n\n';
            const result = parseSSE(text);
            expect(result.key).toBe('value');
        });

        it('解析多个事件取最后一个', () => {
            const text = 'data: {"id":1}\n\ndata: {"id":2}\n\n';
            const result = parseSSE(text);
            expect(result.id).toBe(2);
        });

        it('data: 后无空格也能解析', () => {
            const text = 'data:{"key":"value"}\n\n';
            const result = parseSSE(text);
            expect(result.key).toBe('value');
        });

        it('忽略非 data 行', () => {
            const text = 'event: message\nid: 123\ndata: {"ok":true}\n\n';
            const result = parseSSE(text);
            expect(result.ok).toBe(true);
        });

        it('空文本抛错', () => {
            expect(() => parseSSE('')).toThrow('SSE 解析失败');
        });

        it('无有效 JSON 抛错', () => {
            expect(() => parseSSE('data: not-json\n\n')).toThrow('SSE 解析失败');
        });

        it('只有注释的 SSE 抛错', () => {
            expect(() => parseSSE(': comment\n\n')).toThrow('SSE 解析失败');
        });

        it('混合有效和无效事件，返回最后一个有效的', () => {
            const text = 'data: invalid\n\ndata: {"valid":true}\n\n';
            const result = parseSSE(text);
            expect(result.valid).toBe(true);
        });

        it('处理 \\r\\n 换行', () => {
            const text = 'data: {"ok":true}\r\n\r\n';
            const result = parseSSE(text);
            expect(result.ok).toBe(true);
        });
    });

    // ========== classifyError ==========
    describe('classifyError', () => {
        it('平台不支持', () => {
            const r = classifyError(new Error('platform not supported'));
            expect(r.type).toBe('platform_unsupported');
            expect(r.retryable).toBe(false);
        });

        it('中文平台提示', () => {
            const r = classifyError(new Error('当前平台不支持'));
            expect(r.type).toBe('platform_unsupported');
            expect(r.retryable).toBe(false);
        });

        it('无效配置 - 客户端自产固定文案', () => {
            const r = classifyError(new Error('远程 MCP 需要提供 url 参数'));
            expect(r.type).toBe('invalid_config');
            expect(r.retryable).toBe(false);
        });

        it('无效配置 - WebSocket 构造器非法 URL', () => {
            const r = classifyError(
                new Error("Failed to construct 'WebSocket': The URL 'ws://x y' is invalid.")
            );
            expect(r.type).toBe('invalid_config');
            expect(r.retryable).toBe(false);
        });

        it('服务器响应体含 invalid/url 不误判为不可重试', () => {
            const r = classifyError(new Error('SSE 连接失败: 500 - {"error":"invalid session"}'));
            expect(r.retryable).toBe(true);
        });

        it('非 Error 入参不抛 TypeError', () => {
            const r = classifyError(new Event('error'));
            expect(r.type).toBe('unknown_error');
            expect(r.retryable).toBe(true);
        });

        it('认证失败 - 401', () => {
            const r = classifyError(new Error('HTTP 401 Unauthorized'));
            expect(r.type).toBe('auth_failed');
            expect(r.retryable).toBe(false);
        });

        it('认证失败 - 403', () => {
            const r = classifyError(new Error('403 Forbidden'));
            expect(r.type).toBe('auth_failed');
        });

        it('认证失败 - unauthorized', () => {
            const r = classifyError(new Error('Unauthorized access'));
            expect(r.type).toBe('auth_failed');
        });

        it('超时 - timeout', () => {
            const r = classifyError(new Error('connection timeout'));
            expect(r.type).toBe('timeout');
            expect(r.retryable).toBe(true);
        });

        it('超时 - 中文', () => {
            const r = classifyError(new Error('连接超时'));
            expect(r.type).toBe('timeout');
            expect(r.retryable).toBe(true);
        });

        it('网络错误 - network', () => {
            const r = classifyError(new Error('network error'));
            expect(r.type).toBe('network_error');
            expect(r.retryable).toBe(true);
        });

        it('网络错误 - fetch', () => {
            const r = classifyError(new Error('fetch failed'));
            expect(r.type).toBe('network_error');
        });

        it('网络错误 - websocket', () => {
            const r = classifyError(new Error('WebSocket connection failed'));
            expect(r.type).toBe('network_error');
        });

        it('服务器错误 - 500', () => {
            const r = classifyError(new Error('Internal Server Error 500'));
            expect(r.type).toBe('server_error');
            expect(r.retryable).toBe(true);
        });

        it('服务器错误 - 502', () => {
            const r = classifyError(new Error('Bad Gateway 502'));
            expect(r.type).toBe('server_error');
        });

        it('服务器错误 - 503', () => {
            const r = classifyError(new Error('Service Unavailable 503'));
            expect(r.type).toBe('server_error');
        });

        it('服务器错误 - 504', () => {
            // "Gateway Timeout 504" 包含 timeout 所以分类为 timeout
            const r = classifyError(new Error('Gateway Timeout 504'));
            expect(r.type).toBe('timeout');
            expect(r.retryable).toBe(true);
        });

        it('未知错误', () => {
            const r = classifyError(new Error('something went wrong'));
            expect(r.type).toBe('unknown_error');
            expect(r.retryable).toBe(true);
        });
    });
});
