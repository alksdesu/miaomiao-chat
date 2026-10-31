/**
 * errors.js 错误处理模块测试
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../js/utils/helpers.js', () => ({
    escapeHtml: (s) =>
        String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
}));

import { getHumanizedError, renderHumanizedError, readErrorBody } from '../../js/utils/errors.js';

// ========== getHumanizedError ==========

describe('getHumanizedError', () => {
    it('HTTP 401', () => {
        const result = getHumanizedError({}, 401);
        expect(result.title).toContain('认证');
    });

    it('HTTP 429', () => {
        const result = getHumanizedError({}, 429);
        expect(result.title).toContain('频繁');
    });

    it('HTTP 500', () => {
        const result = getHumanizedError({}, 500);
        expect(result.title).toContain('服务器');
    });

    it('HTTP 502', () => {
        const result = getHumanizedError({}, 502);
        expect(result.title).toContain('网关');
    });

    it('HTTP 503', () => {
        const result = getHumanizedError({}, 503);
        expect(result.title).toContain('不可用');
    });

    it('HTTP 504', () => {
        const result = getHumanizedError({}, 504);
        expect(result.title).toContain('超时');
    });

    it('错误类型 invalid_api_key', () => {
        const result = getHumanizedError({ error: { type: 'invalid_api_key' } });
        expect(result.title).toContain('API Key');
    });

    it('错误类型 insufficient_quota', () => {
        const result = getHumanizedError({ error: { type: 'insufficient_quota' } });
        expect(result.title).toContain('配额');
    });

    it('错误类型 rate_limit_exceeded', () => {
        const result = getHumanizedError({ type: 'rate_limit_exceeded' });
        expect(result.title).toContain('速率');
    });

    it('错误类型 context_length_exceeded', () => {
        const result = getHumanizedError({ type: 'context_length_exceeded' });
        expect(result.title).toContain('过长');
    });

    it('错误类型 model_not_found', () => {
        const result = getHumanizedError({ type: 'model_not_found' });
        expect(result.title).toContain('不存在');
    });

    it('错误类型 overloaded', () => {
        const result = getHumanizedError({ type: 'overloaded' });
        expect(result.title).toContain('繁忙');
    });

    it('错误类型 NetworkError', () => {
        const result = getHumanizedError({ name: 'NetworkError' });
        expect(result.title).toContain('网络');
    });

    it('错误类型 AbortError', () => {
        const result = getHumanizedError({ name: 'AbortError' });
        expect(result.title).toContain('取消');
    });

    it('Gemini SAFETY', () => {
        const result = getHumanizedError({ type: 'SAFETY' });
        expect(result.title).toContain('安全');
    });

    it('从 error.error.status 匹配', () => {
        const result = getHumanizedError({ error: { status: 403 } });
        expect(result.title).toContain('拒绝');
    });

    it('消息包含 api key', () => {
        const result = getHumanizedError({ message: 'Invalid API key provided' });
        expect(result.title).toContain('API Key');
    });

    it('消息包含 quota', () => {
        const result = getHumanizedError({ message: 'You have exceeded your quota' });
        expect(result.title).toContain('配额');
    });

    it('消息包含 rate limit', () => {
        const result = getHumanizedError({ message: 'Rate limit reached' });
        expect(result.title).toContain('速率');
    });

    it('消息包含 context_length', () => {
        const result = getHumanizedError({ message: 'context_length exceeded' });
        expect(result.title).toContain('过长');
    });

    it('消息包含 too long', () => {
        const result = getHumanizedError({ message: 'The message is too long' });
        expect(result.title).toContain('过长');
    });

    it('消息包含 not found', () => {
        const result = getHumanizedError({ message: 'Model not found' });
        expect(result.title).toContain('不存在');
    });

    it('消息包含 overloaded', () => {
        const result = getHumanizedError({ message: 'Server overloaded' });
        expect(result.title).toContain('繁忙');
    });

    it('未知错误返回默认', () => {
        const result = getHumanizedError({});
        expect(result.title).toBe('请求失败');
    });

    it('未知错误包含原始消息', () => {
        const result = getHumanizedError({ message: 'something weird' });
        expect(result.hint).toContain('something weird');
    });

    it('嵌套 error.error.message', () => {
        const result = getHumanizedError({ error: { message: 'billing issue' } });
        expect(result.title).toContain('配额');
    });

    it('HTTP 状态码优先', () => {
        const result = getHumanizedError({ type: 'NetworkError' }, 401);
        expect(result.title).toContain('认证');
    });

    it.each([
        ['empty_reply', '没有返回内容'],
        ['max_tokens', '最大输出长度'],
        ['context_overflow', '上下文窗口'],
        ['safety', '回复被安全策略拦截'],
        ['prompt_blocked', '请求被安全策略拦截'],
        ['refusal', '拒绝回答'],
        ['recitation', '引用受限'],
        ['malformed_tool_call', '工具调用不合法'],
        ['continuation', '单次输出上限'],
        ['other', '生成中断']
    ])('结束原因 %s 的标题固定，提示语取错误消息', (code, title) => {
        const message = `原因说明（${code}）`;
        expect(getHumanizedError({ code, message, type: code }, code)).toEqual({
            title: expect.stringContaining(title),
            hint: message
        });
        expect(getHumanizedError({ error: { type: code, message } })).toEqual({
            title: expect.stringContaining(title),
            hint: message
        });
    });

    it('结束原因缺少消息时提示语回落默认值', () => {
        expect(getHumanizedError({ error: { type: 'refusal' } }).hint).toBe('发生未知错误');
    });

    it('带固定提示语的错误类型先给出原因再附指引', () => {
        expect(getHumanizedError({ error: { type: 'overloaded', message: 'raw' } }).hint).toBe(
            'raw\n当前请求量大，请稍后再试'
        );
    });

    it('400 显示服务端返回的原因并附上指引', () => {
        const result = getHumanizedError(
            { error: { message: 'max_tokens: 64000 > 32000, which is the maximum allowed' } },
            400
        );
        expect(result.title).toBe('请求格式错误');
        expect(result.hint.split('\n')).toEqual([
            'max_tokens: 64000 > 32000, which is the maximum allowed',
            '请检查消息内容与请求参数是否符合要求'
        ]);
    });

    it('按消息关键字归类时同样保留原因', () => {
        const result = getHumanizedError({ error: { message: 'Rate limit reached for tpm' } });
        expect(result.title).toBe('速率限制');
        expect(result.hint).toBe('Rate limit reached for tpm\n请求太频繁，请稍等片刻');
    });

    it('兼容 error 为字符串与 detail 字段的响应体', () => {
        expect(getHumanizedError({ error: 'Invalid model name' }, 400).hint).toContain(
            'Invalid model name'
        );
        expect(getHumanizedError({ detail: 'Not authenticated' }, 401).hint).toContain(
            'Not authenticated'
        );
    });

    it('原因与标题重复时不再重复显示', () => {
        expect(getHumanizedError({ code: 'user_cancelled', message: '请求已取消' }).hint).toBe(
            '已保留取消前接收的内容'
        );
    });

    it('过长的原因截断显示', () => {
        const hint = getHumanizedError({ error: { message: 'x'.repeat(1000) } }, 400).hint;
        const [reason] = hint.split('\n');
        expect(reason.length).toBeLessThan(400);
        expect(reason.endsWith('…')).toBe(true);
    });

    it('没有原因时只显示指引', () => {
        expect(getHumanizedError({}, 400).hint).toBe('请检查消息内容与请求参数是否符合要求');
    });
});

// ========== renderHumanizedError ==========

describe('renderHumanizedError', () => {
    it('生成 HTML', () => {
        const html = renderHumanizedError({ error: { type: 'invalid_api_key' } });
        expect(html).toContain('error-humanized');
        expect(html).toContain('API Key');
    });

    it('null error 使用默认值', () => {
        const html = renderHumanizedError(null);
        expect(html).toContain('error-humanized');
    });

    it('包含技术详情', () => {
        const html = renderHumanizedError({ error: { message: 'test' } }, 500, true);
        expect(html).toContain('error-technical');
        expect(html).toContain('技术详情');
    });

    it('不显示技术详情', () => {
        const html = renderHumanizedError({ error: { message: 'test' } }, 500, false);
        expect(html).not.toContain('error-technical');
    });

    it('包含 allErrors', () => {
        const error = {
            error: {
                type: 'server_error',
                message: 'multi error',
                allErrors: [
                    {
                        request: 1,
                        status: 500,
                        type: 'server_error',
                        code: 'ERR',
                        message: 'fail 1'
                    },
                    { stream: 2, status: 502, type: 'gateway', code: 'GW', message: 'fail 2' }
                ]
            }
        };
        const html = renderHumanizedError(error, 500);
        expect(html).toContain('所有错误详情');
        expect(html).toContain('请求 #1');
        expect(html).toContain('流 #2');
    });

    it('allErrors 中 fullError 字段', () => {
        const error = {
            allErrors: [
                {
                    status: 500,
                    type: 'err',
                    code: '500',
                    message: 'oops',
                    fullError: { detail: 'inner' }
                }
            ]
        };
        const html = renderHumanizedError(error, 500);
        expect(html).toContain('完整错误');
    });

    it('HTTP 状态码传递', () => {
        const html = renderHumanizedError({}, 404);
        expect(html).toContain('未找到');
    });

    it('Error 实例序列化', () => {
        const error = new Error('test error');
        const html = renderHumanizedError(error);
        expect(html).toContain('test error');
    });

    it('字符串 error 序列化', () => {
        const html = renderHumanizedError('raw string error');
        expect(html).toContain('raw string error');
    });
});

// ========== readErrorBody ==========

function bodyResponse(status, text) {
    return { status, text: async () => text };
}

describe('readErrorBody', () => {
    it('JSON 错误体原样返回', async () => {
        const body = { error: { message: 'max_tokens too large', type: 'invalid_request_error' } };
        expect(await readErrorBody(bodyResponse(400, JSON.stringify(body)))).toEqual(body);
    });

    it('纯文本错误体作为原因保留', async () => {
        expect(await readErrorBody(bodyResponse(400, '  Bad Request: model not found\n'))).toEqual({
            error: { message: 'Bad Request: model not found' }
        });
    });

    it('HTML 错误页只保留状态码', async () => {
        expect(
            await readErrorBody(bodyResponse(502, '<html><body>Bad gateway</body></html>'))
        ).toEqual({
            error: { message: 'HTTP 502' }
        });
    });

    it('空响应体只保留状态码', async () => {
        expect(await readErrorBody(bodyResponse(500, ''))).toEqual({
            error: { message: 'HTTP 500' }
        });
    });

    it('JSON 原始值按纯文本处理', async () => {
        expect(await readErrorBody(bodyResponse(500, 'null'))).toEqual({
            error: { message: 'null' }
        });
    });

    it('超长纯文本截断', async () => {
        const result = await readErrorBody(bodyResponse(500, 'x'.repeat(5000)));
        expect(result.error.message.length).toBe(2000);
    });

    it('读取响应体失败时按状态码描述', async () => {
        const response = {
            status: 503,
            text: async () => {
                throw new TypeError('body used already');
            }
        };
        expect(await readErrorBody(response)).toEqual({ error: { message: 'HTTP 503' } });
    });
});
