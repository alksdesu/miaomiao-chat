/**
 * openai.js API 请求测试
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
        xmlToolCallingEnabled: false,
        thinkingEnabled: false,
        customHeaders: []
    }
}));

vi.mock('../../js/utils/logger.js', () => ({
    logger: { warn: vi.fn(), debug: vi.fn(), error: vi.fn(), info: vi.fn() }
}));

vi.mock('../../js/api/params.js', () => ({
    buildModelParams: vi.fn(() => ({ temperature: 0.7 })),
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
    getCurrentModelCapabilities: vi.fn(() => null),
    getCurrentProvider: vi.fn(() => ({ apiFormat: 'openai' }))
}));

vi.mock('../../js/tools/manager.js', () => ({
    getToolsForAPI: vi.fn(() => [])
}));

vi.mock('../../js/tools/tool-injection.js', () => ({
    injectToolsToOpenAI: vi.fn(),
    getXMLInjectionStats: vi.fn(() => ({ estimatedTokens: 0 }))
}));

import { state } from '../../js/core/state.js';
import { sendOpenAIRequest } from '../../js/api/openai.js';

describe('openai API', () => {
    let fetchSpy;

    beforeEach(() => {
        vi.clearAllMocks();
        state.messages = [{ role: 'user', content: 'Hello' }];
        state.systemPrompt = '';
        state.prefillEnabled = false;
        state.streamEnabled = true;
        state.codeExecutionEnabled = false;
        state.webSearchEnabled = false;
        state.xmlToolCallingEnabled = false;

        fetchSpy = vi.fn(() => Promise.resolve(new Response('{}', { status: 200 })));
        globalThis.fetch = fetchSpy;
    });

    it('发送基本请求', async () => {
        await sendOpenAIRequest('https://api.openai.com/v1/chat/completions', 'sk-test', 'gpt-4');

        expect(fetchSpy).toHaveBeenCalledTimes(1);
        const [url, options] = fetchSpy.mock.calls[0];
        expect(url).toBe('https://api.openai.com/v1/chat/completions');
        expect(options.method).toBe('POST');

        const body = JSON.parse(options.body);
        expect(body.model).toBe('gpt-4');
        expect(body.stream).toBe(true);
        expect(body.messages).toBeDefined();
    });

    it('包含 Authorization header', async () => {
        await sendOpenAIRequest('https://api.openai.com/v1/chat/completions', 'sk-abc123', 'gpt-4');

        const [, options] = fetchSpy.mock.calls[0];
        expect(options.headers.Authorization).toBe('Bearer sk-abc123');
        expect(options.headers['Content-Type']).toBe('application/json');
    });

    it('system prompt 注入到 messages', async () => {
        state.systemPrompt = 'You are helpful';
        await sendOpenAIRequest('https://api.openai.com/v1/chat/completions', 'sk-test', 'gpt-4');

        const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
        expect(body.messages[0].role).toBe('system');
        expect(body.messages[0].content).toBe('You are helpful');
    });

    it('stream false', async () => {
        state.streamEnabled = false;
        await sendOpenAIRequest('https://api.openai.com/v1/chat/completions', 'sk-test', 'gpt-4');

        const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
        expect(body.stream).toBe(false);
    });

    it('包含 temperature 参数', async () => {
        await sendOpenAIRequest('https://api.openai.com/v1/chat/completions', 'sk-test', 'gpt-4');

        const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
        expect(body.temperature).toBe(0.7);
    });

    it('传递 signal', async () => {
        const controller = new AbortController();
        await sendOpenAIRequest(
            'https://api.openai.com/v1/chat/completions',
            'sk-test',
            'gpt-4',
            controller.signal
        );

        const [, options] = fetchSpy.mock.calls[0];
        expect(options.signal).toBe(controller.signal);
    });

    it('code execution 启用时添加 code_interpreter 工具', async () => {
        state.codeExecutionEnabled = true;
        await sendOpenAIRequest('https://api.openai.com/v1/chat/completions', 'sk-test', 'gpt-4');

        const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
        expect(body.tools).toBeDefined();
        expect(body.tools.some((t) => t.type === 'code_interpreter')).toBe(true);
    });

    it('web search 启用时添加搜索工具', async () => {
        state.webSearchEnabled = true;
        await sendOpenAIRequest('https://api.openai.com/v1/chat/completions', 'sk-test', 'gpt-4');

        const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
        expect(body.tools).toBeDefined();
        expect(body.tools.some((t) => t.function?.name === 'web_search')).toBe(true);
    });

    it('过滤错误消息', async () => {
        state.messages = [
            { role: 'user', content: 'Hello' },
            { role: 'assistant', content: 'err', isError: true },
            { role: 'user', content: 'Retry' }
        ];
        await sendOpenAIRequest('https://api.openai.com/v1/chat/completions', 'sk-test', 'gpt-4');

        // 验证错误消息被过滤：requestBody.messages 只含 2 条非错误消息（无 system 注入）
        const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
        expect(body.messages.length).toBe(2);
        expect(body.messages.every((m) => m.content !== 'err')).toBe(true);
    });

    it('responses 格式端点替换', async () => {
        const { getCurrentProvider } = await import('../../js/providers/manager.js');
        getCurrentProvider.mockReturnValue({ apiFormat: 'openai-responses' });

        await sendOpenAIRequest('https://api.openai.com/v1/chat/completions', 'sk-test', 'gpt-4');

        const [url] = fetchSpy.mock.calls[0];
        expect(url).toContain('/responses');
    });
});
