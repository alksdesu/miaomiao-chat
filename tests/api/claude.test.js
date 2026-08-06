/**
 * claude.js API 请求测试
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../js/core/state.js', () => ({
    state: {
        messages: [],
        systemPrompt: '',
        prefillEnabled: false,
        streamEnabled: true,
        codeExecutionEnabled: false,
        webSearchEnabled: false,
        computerUseEnabled: false,
        xmlToolCallingEnabled: false,
        thinkingEnabled: false,
        customHeaders: [],
        computerUsePermissions: {}
    }
}));

vi.mock('../../js/utils/logger.js', () => ({
    logger: { warn: vi.fn(), debug: vi.fn(), error: vi.fn(), info: vi.fn() }
}));

vi.mock('../../js/api/params.js', () => ({
    buildModelParams: vi.fn(() => ({ max_tokens: 4096 })),
    buildThinkingConfig: vi.fn(() => null),
    buildVerbosityConfig: vi.fn(() => null),
    getCustomHeadersObject: vi.fn(() => ({}))
}));

vi.mock('../../js/utils/prefill.js', () => ({
    getPrefillMessages: vi.fn(() => []),
    getOpeningMessages: vi.fn(() => [])
}));

vi.mock('../../js/utils/variables.js', () => ({
    processVariables: vi.fn((s) => s)
}));

vi.mock('../../js/utils/message-filter.js', () => ({
    filterMessagesByCapabilities: vi.fn((msgs) => msgs)
}));

vi.mock('../../js/providers/manager.js', () => ({
    getCurrentModelCapabilities: vi.fn(() => null)
}));

vi.mock('../../js/tools/manager.js', () => ({
    getToolsForAPI: vi.fn(() => [])
}));

vi.mock('../../js/tools/tool-injection.js', () => ({
    injectToolsToClaude: vi.fn(),
    getXMLInjectionStats: vi.fn(() => ({ estimatedTokens: 0 }))
}));

vi.mock('../../js/utils/platform.js', () => ({
    isElectron: vi.fn(() => false)
}));

import { state } from '../../js/core/state.js';
import { sendClaudeRequest } from '../../js/api/claude.js';

describe('claude API', () => {
    let fetchSpy;

    beforeEach(() => {
        vi.clearAllMocks();
        state.messages = [{ role: 'user', content: 'Hello' }];
        state.systemPrompt = '';
        state.prefillEnabled = false;
        state.streamEnabled = true;
        state.codeExecutionEnabled = false;
        state.webSearchEnabled = false;
        state.computerUseEnabled = false;
        state.xmlToolCallingEnabled = false;

        fetchSpy = vi.fn(() => Promise.resolve(new Response('{}', { status: 200 })));
        globalThis.fetch = fetchSpy;
    });

    it('发送基本请求', async () => {
        await sendClaudeRequest(
            'https://api.anthropic.com/v1/messages',
            'sk-ant-test',
            'claude-3-opus'
        );

        expect(fetchSpy).toHaveBeenCalledTimes(1);
        const [url, options] = fetchSpy.mock.calls[0];
        expect(url).toBe('https://api.anthropic.com/v1/messages');
        expect(options.method).toBe('POST');

        const body = JSON.parse(options.body);
        expect(body.model).toBe('claude-3-opus');
        expect(body.stream).toBe(true);
        expect(body.messages).toBeDefined();
        expect(body.max_tokens).toBe(4096);
    });

    it('包含 x-api-key header', async () => {
        await sendClaudeRequest('https://api.anthropic.com/v1/messages', 'sk-ant-abc', 'claude-3');

        const [, options] = fetchSpy.mock.calls[0];
        expect(options.headers['x-api-key']).toBe('sk-ant-abc');
        expect(options.headers['anthropic-version']).toBe('2023-06-01');
        expect(options.headers['anthropic-dangerous-direct-browser-access']).toBe('true');
    });

    it('system prompt 设为顶层参数', async () => {
        state.systemPrompt = 'Be helpful';
        await sendClaudeRequest('https://api.anthropic.com/v1/messages', 'sk-test', 'claude-3');

        const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
        expect(body.system).toBe('Be helpful');
    });

    it('web search 启用', async () => {
        state.webSearchEnabled = true;
        await sendClaudeRequest('https://api.anthropic.com/v1/messages', 'sk-test', 'claude-3');

        const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
        expect(body.tools).toBeDefined();
        expect(body.tools.some((t) => t.name === 'web_search')).toBe(true);
    });

    it('code execution 启用添加 beta header', async () => {
        state.codeExecutionEnabled = true;
        await sendClaudeRequest('https://api.anthropic.com/v1/messages', 'sk-test', 'claude-3');

        const [, options] = fetchSpy.mock.calls[0];
        expect(options.headers['anthropic-beta']).toContain('code-execution');
    });

    it('传递 signal', async () => {
        const controller = new AbortController();
        await sendClaudeRequest(
            'https://api.anthropic.com/v1/messages',
            'sk-test',
            'claude-3',
            controller.signal
        );

        const [, options] = fetchSpy.mock.calls[0];
        expect(options.signal).toBe(controller.signal);
    });

    it('过滤错误消息', async () => {
        state.messages = [
            { role: 'user', parts: [{ type: 'text', text: 'Hello' }], error: null },
            {
                role: 'assistant',
                parts: [{ type: 'text', text: 'err' }],
                error: { type: 'api', message: 'failed' }
            }
        ];
        await sendClaudeRequest('https://api.anthropic.com/v1/messages', 'sk-test', 'claude-3');

        // 验证错误消息被过滤：Claude 顶层 messages 只含 1 条 user 消息（无 system 注入到 messages）
        const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
        expect(body.messages.length).toBe(1);
        expect(body.messages[0].role).toBe('user');
    });

    it('prefill 开启插入消息', async () => {
        state.prefillEnabled = true;
        const { getOpeningMessages, getPrefillMessages } =
            await import('../../js/utils/prefill.js');
        getOpeningMessages.mockReturnValue([{ role: 'user', content: 'Hi' }]);
        getPrefillMessages.mockReturnValue([{ role: 'assistant', content: 'Sure' }]);

        await sendClaudeRequest('https://api.anthropic.com/v1/messages', 'sk-test', 'claude-3');

        const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
        expect(body.messages.length).toBeGreaterThan(1);
    });
});
