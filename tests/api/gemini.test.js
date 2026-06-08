/**
 * gemini.js API 请求测试
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
        geminiApiKeyInHeader: false,
        geminiSystemPartsEnabled: false,
        geminiSystemParts: [],
        thinkingEnabled: false,
        customHeaders: []
    },
    elements: { imageSizeSelect: null }
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

vi.mock('../../js/utils/images.js', () => ({
    compressImage: vi.fn((data, mime) =>
        Promise.resolve({ data, mimeType: mime, originalSize: 100, compressedSize: 80 })
    )
}));

vi.mock('../../js/utils/message-filter.js', () => ({
    filterMessagesByCapabilities: vi.fn((msgs) => msgs)
}));

vi.mock('../../js/providers/manager.js', () => ({
    getCurrentModelCapabilities: vi.fn(() => null),
    getCurrentProvider: vi.fn(() => ({ apiFormat: 'gemini' }))
}));

vi.mock('../../js/tools/manager.js', () => ({
    getToolsForAPI: vi.fn(() => [])
}));

vi.mock('../../js/tools/tool-injection.js', () => ({
    injectToolsToGemini: vi.fn(),
    getXMLInjectionStats: vi.fn(() => ({ estimatedTokens: 0 }))
}));

import { state, elements } from '../../js/core/state.js';
import { sendGeminiRequest } from '../../js/api/gemini.js';

describe('gemini API', () => {
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
        state.geminiApiKeyInHeader = false;
        state.geminiSystemPartsEnabled = false;
        state.geminiSystemParts = [];
        elements.imageSizeSelect = null;

        fetchSpy = vi.fn(() => Promise.resolve(new Response('{}', { status: 200 })));
        globalThis.fetch = fetchSpy;
    });

    it('发送基本请求', async () => {
        await sendGeminiRequest(
            'https://generativelanguage.googleapis.com',
            'key-test',
            'gemini-pro'
        );

        expect(fetchSpy).toHaveBeenCalledTimes(1);
        const [url, options] = fetchSpy.mock.calls[0];
        expect(url).toContain('gemini-pro');
        expect(url).toContain('streamGenerateContent');
        expect(options.method).toBe('POST');
    });

    it('非流式用 generateContent', async () => {
        state.streamEnabled = false;
        await sendGeminiRequest(
            'https://generativelanguage.googleapis.com',
            'key-test',
            'gemini-pro'
        );

        const [url] = fetchSpy.mock.calls[0];
        expect(url).toContain('generateContent');
        expect(url).not.toContain('stream');
    });

    it('API key 在 URL 参数中', async () => {
        state.geminiApiKeyInHeader = false;
        await sendGeminiRequest(
            'https://generativelanguage.googleapis.com',
            'key-abc',
            'gemini-pro'
        );

        const [url] = fetchSpy.mock.calls[0];
        expect(url).toContain('key=key-abc');
    });

    it('API key 在 header 中', async () => {
        state.geminiApiKeyInHeader = true;
        await sendGeminiRequest(
            'https://generativelanguage.googleapis.com',
            'key-abc',
            'gemini-pro'
        );

        const [url, options] = fetchSpy.mock.calls[0];
        expect(options.headers['x-goog-api-key']).toBe('key-abc');
        expect(url).not.toContain('key=key-abc');
    });

    it('system prompt 设为 systemInstruction', async () => {
        state.systemPrompt = 'Be creative';
        await sendGeminiRequest('https://generativelanguage.googleapis.com', 'key', 'gemini-pro');

        const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
        expect(body.systemInstruction).toBeDefined();
        expect(body.systemInstruction.parts[0].text).toBe('Be creative');
    });

    it('包含 safetySettings', async () => {
        await sendGeminiRequest('https://generativelanguage.googleapis.com', 'key', 'gemini-pro');

        const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
        expect(body.safetySettings).toBeDefined();
        expect(body.safetySettings.length).toBeGreaterThan(0);
    });

    it('Vertex AI 使用 OFF threshold', async () => {
        await sendGeminiRequest(
            'https://us-central1-aiplatform.googleapis.com',
            'key',
            'gemini-pro'
        );

        const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
        expect(body.safetySettings[0].threshold).toBe('OFF');
    });

    it('AI Studio 使用 BLOCK_NONE threshold', async () => {
        await sendGeminiRequest('https://generativelanguage.googleapis.com', 'key', 'gemini-pro');

        const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
        expect(body.safetySettings[0].threshold).toBe('BLOCK_NONE');
    });

    it('web search 启用', async () => {
        state.webSearchEnabled = true;
        await sendGeminiRequest('https://generativelanguage.googleapis.com', 'key', 'gemini-pro');

        const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
        expect(body.tools).toBeDefined();
        expect(body.tools.some((t) => t.googleSearch !== undefined)).toBe(true);
    });

    it('code execution 启用', async () => {
        state.codeExecutionEnabled = true;
        await sendGeminiRequest('https://generativelanguage.googleapis.com', 'key', 'gemini-pro');

        const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
        expect(body.tools).toBeDefined();
        expect(body.tools.some((t) => t.codeExecution !== undefined)).toBe(true);
    });

    it('空消息抛错', async () => {
        state.messages = [];
        await expect(
            sendGeminiRequest('https://generativelanguage.googleapis.com', 'key', 'gemini-pro')
        ).rejects.toThrow('所有消息都被过滤');
    });

    it('传递 signal', async () => {
        const controller = new AbortController();
        await sendGeminiRequest(
            'https://generativelanguage.googleapis.com',
            'key',
            'gemini-pro',
            controller.signal
        );

        const [, options] = fetchSpy.mock.calls[0];
        expect(options.signal).toBe(controller.signal);
    });

    it('包含 generationConfig', async () => {
        await sendGeminiRequest('https://generativelanguage.googleapis.com', 'key', 'gemini-pro');

        const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
        expect(body.generationConfig).toBeDefined();
        expect(body.generationConfig.temperature).toBe(0.7);
    });

    it('geminiSystemParts 多段系统提示', async () => {
        state.geminiSystemPartsEnabled = true;
        state.geminiSystemParts = [{ text: 'Part 1' }, { text: 'Part 2' }];
        await sendGeminiRequest('https://generativelanguage.googleapis.com', 'key', 'gemini-pro');

        const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
        expect(body.systemInstruction.parts.length).toBe(2);
    });

    it('统一代理模式保持原始端点', async () => {
        const { getCurrentProvider } = await import('../../js/providers/manager.js');
        getCurrentProvider.mockReturnValue({ apiFormat: 'openai' });
        await sendGeminiRequest('https://my-proxy.com/v1/chat/completions', 'key', 'gemini-pro');

        const [url] = fetchSpy.mock.calls[0];
        expect(url).toContain('my-proxy.com');
    });
});
