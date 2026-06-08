/**
 * parser-gemini.js 流解析器测试
 * 测试 Gemini SSE 流式解析
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// mock 依赖
// vi.mock 被 hoist 到文件顶，class 必须定义在 factory 内部
vi.mock('../../js/stream/stats.js', () => {
    class MockStreamStats {
        constructor() {
            this.requestStartTime = 0;
            this.firstTokenTime = 0;
            this.endTime = 0;
            this.tokenCount = 0;
            this.isFirstToken = true;
        }
        recordFirstToken() {}
        recordTokens() {}
        finalize() {}
        recalculateTokenCount() {
            return 0;
        }
        getData() {
            return {};
        }
        getPartialData() {
            return {};
        }
        syncToGlobal() {}
    }
    return {
        StreamStats: MockStreamStats,
        estimateTokenCount: vi.fn(() => 0),
        recordFirstToken: vi.fn(),
        recordTokens: vi.fn(),
        finalizeStreamStats: vi.fn(),
        resetStreamStats: vi.fn(),
        recalculateStreamTokenCount: vi.fn(),
        getCurrentStreamStatsData: vi.fn(() => ({})),
        getPartialStreamStatsData: vi.fn(() => ({})),
        getStreamStatsHTML: vi.fn(() => ''),
        renderStreamStatsFromData: vi.fn(() => ''),
        appendStreamStats: vi.fn()
    };
});

vi.mock('../../js/stream/helpers.js', () => ({
    updateStreamingMessage: vi.fn(),
    renderFinalTextWithThinking: vi.fn(),
    renderFinalContentWithThinking: vi.fn(),
    cleanupAllIncompleteImages: vi.fn()
}));

vi.mock('../../js/messages/sync.js', () => ({
    saveAssistantMessage: vi.fn(() => 0)
}));

vi.mock('../../js/api/current.js', () => ({
    getCurrentProvider: vi.fn(() => ({ name: 'test-provider', apiFormat: 'gemini' })),
    getModelDisplayName: vi.fn((modelId) => modelId || 'test-model'),
    getCurrentEndpoint: vi.fn(() => ''),
    getCurrentApiKey: vi.fn(() => ''),
    getCurrentModel: vi.fn(() => 'test-model')
}));

vi.mock('../../js/messages/dom-sync.js', () => ({
    setCurrentMessageIndex: vi.fn()
}));

vi.mock('../../js/core/events.js', () => ({
    eventBus: { emit: vi.fn(), on: vi.fn() }
}));

vi.mock('../../js/core/state.js', () => ({
    state: {
        xmlToolCallingEnabled: false,
        currentSessionId: 'test-session',
        isToolCallPending: false,
        currentAssistantMessage: null
    }
}));

vi.mock('../../js/core/request-state-machine.js', () => ({
    requestStateMachine: { transition: vi.fn(), forceReset: vi.fn() },
    RequestState: { TOOL_CALLING: 'TOOL_CALLING' }
}));

vi.mock('../../js/utils/errors.js', () => ({
    renderHumanizedError: vi.fn(() => '<div>error</div>')
}));

vi.mock('../../js/utils/markdown-image-parser.js', () => ({
    parseStreamingMarkdownImages: vi.fn((text, buffer) => ({
        parts: text ? [{ type: 'text', text }] : [],
        newBuffer: buffer || ''
    }))
}));

vi.mock('../../js/tools/orchestrator.js', () => ({
    handleToolCallStream: vi.fn()
}));

vi.mock('../../js/stream/think-tag-parser.js', () => {
    class MockThinkTagParser {
        processDelta(text) {
            return { displayText: text, thinkingDelta: '' };
        }
        flush() {
            return { displayText: '', thinkingDelta: '' };
        }
    }
    return { ThinkTagParser: MockThinkTagParser };
});

vi.mock('../../js/tools/xml-formatter.js', () => {
    class MockXMLStreamAccumulator {
        processDelta(delta) {
            return { hasToolCalls: false, displayText: delta, error: null };
        }
        getCompletedCalls() {
            return [];
        }
    }
    return { XMLStreamAccumulator: MockXMLStreamAccumulator };
});

vi.mock('../../js/utils/media.js', () => ({
    isVideoMimeType: (mime) => mime?.startsWith('video/'),
    isAudioMimeType: (mime) => mime?.startsWith('audio/'),
    isVideoUrl: () => false
}));

import { parseGeminiStream } from '../../js/stream/parser-gemini.js';
import { state } from '../../js/core/state.js';
import { recordFirstToken, recordTokens } from '../../js/stream/stats.js';
import { updateStreamingMessage } from '../../js/stream/helpers.js';
import { eventBus } from '../../js/core/events.js';
import { saveAssistantMessage } from '../../js/messages/sync.js';

function createMockReader(lines) {
    const encoder = new TextEncoder();
    let idx = 0;
    return {
        read: vi.fn(async () => {
            if (idx >= lines.length) return { done: true, value: undefined };
            const line = lines[idx++];
            return { done: false, value: encoder.encode(line + '\n') };
        }),
        cancel: vi.fn(async () => {}),
        releaseLock: vi.fn()
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    state.xmlToolCallingEnabled = false;
    state.currentSessionId = 'test-session';
});

describe('parseGeminiStream - 文本内容', () => {
    it('解析普通文本 part', async () => {
        const reader = createMockReader([
            'data: {"candidates":[{"content":{"parts":[{"text":"Hello"}]}}]}',
            'data: {"candidates":[{"content":{"parts":[{"text":" Gemini"}]}}]}',
            '' // 空行结束
        ]);

        await parseGeminiStream(reader);

        expect(recordFirstToken).toHaveBeenCalled();
        expect(recordTokens).toHaveBeenCalledWith('Hello');
        expect(recordTokens).toHaveBeenCalledWith(' Gemini');
        expect(saveAssistantMessage).toHaveBeenCalled();
    });

    it('忽略空行和注释行', async () => {
        const reader = createMockReader([
            '',
            ':comment',
            'data: {"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}'
        ]);

        await parseGeminiStream(reader);

        expect(recordTokens).toHaveBeenCalledWith('ok');
    });

    it('处理 data: [DONE] 信号', async () => {
        const reader = createMockReader([
            'data: {"candidates":[{"content":{"parts":[{"text":"test"}]}}]}',
            'data: [DONE]'
        ]);

        await parseGeminiStream(reader);

        expect(saveAssistantMessage).toHaveBeenCalled();
    });

    it('处理裸 JSON（无 data: 前缀）', async () => {
        const reader = createMockReader([
            '{"candidates":[{"content":{"parts":[{"text":"bare json"}]}}]}'
        ]);

        await parseGeminiStream(reader);

        expect(recordTokens).toHaveBeenCalledWith('bare json');
    });
});

describe('parseGeminiStream - 思维链', () => {
    it('解析 thought=true 的部分', async () => {
        const reader = createMockReader([
            'data: {"candidates":[{"content":{"parts":[{"text":"thinking...","thought":true}]}}]}',
            'data: {"candidates":[{"content":{"parts":[{"text":"answer"}]}}]}'
        ]);

        await parseGeminiStream(reader);

        expect(recordTokens).toHaveBeenCalledWith('thinking...');
        expect(recordTokens).toHaveBeenCalledWith('answer');
    });

    it('处理 thoughtSignature', async () => {
        const reader = createMockReader([
            'data: {"candidates":[{"content":{"parts":[{"thoughtSignature":"sig123","text":"thought","thought":true}]}}]}',
            'data: {"candidates":[{"content":{"parts":[{"text":"result"}]}}]}'
        ]);

        await parseGeminiStream(reader);

        expect(saveAssistantMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                thoughtSignature: 'sig123'
            })
        );
    });

    it('处理顶层 reasoning', async () => {
        const reader = createMockReader([
            'data: {"candidates":[{"content":{"parts":[{"text":"ans"}]}}],"reasoning":"deep thought"}'
        ]);

        await parseGeminiStream(reader);

        expect(recordTokens).toHaveBeenCalledWith('deep thought');
    });

    it('处理 metadata.gemini.reasoning', async () => {
        const reader = createMockReader([
            'data: {"candidates":[{"content":{"parts":[{"text":"ans"}]}}],"metadata":{"gemini":{"reasoning":"meta reasoning"}}}'
        ]);

        await parseGeminiStream(reader);

        expect(recordTokens).toHaveBeenCalledWith('meta reasoning');
    });
});

describe('parseGeminiStream - 多媒体', () => {
    it('解析 inlineData 图片（长 base64 数据）', async () => {
        // base64 数据需要足够长（>200 字符）且包含 / 才不会被当作文件名
        const longBase64 = 'iVBOR/' + 'A'.repeat(300);
        const reader = createMockReader([
            `data: {"candidates":[{"content":{"parts":[{"inlineData":{"mimeType":"image/png","data":"${longBase64}"}}]}}]}`
        ]);

        await parseGeminiStream(reader);

        expect(saveAssistantMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                contentParts: expect.arrayContaining([
                    expect.objectContaining({ type: 'image_url' })
                ])
            })
        );
    });

    it('解析 inline_data (snake_case) 视频', async () => {
        const longBase64 = 'AAAAAA/' + 'B'.repeat(300);
        const reader = createMockReader([
            `data: {"candidates":[{"content":{"parts":[{"inline_data":{"mime_type":"video/mp4","data":"${longBase64}"}}]}}]}`
        ]);

        await parseGeminiStream(reader);

        expect(saveAssistantMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                contentParts: expect.arrayContaining([
                    expect.objectContaining({ type: 'video_url' })
                ])
            })
        );
    });

    it('检测代码执行返回文件名而非 base64', async () => {
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const reader = createMockReader([
            'data: {"candidates":[{"content":{"parts":[{"inlineData":{"mimeType":"image/png","data":"output.png"}}]}}]}'
        ]);

        await parseGeminiStream(reader);

        expect(consoleSpy).toHaveBeenCalled();
        consoleSpy.mockRestore();
    });
});

describe('parseGeminiStream - 工具调用', () => {
    it('解析 functionCall', async () => {
        const reader = createMockReader([
            'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"search","args":{"q":"test"}}}]}}]}'
        ]);

        await parseGeminiStream(reader);
        // 工具调用在 onStreamEnd 处理
    });
});

describe('parseGeminiStream - 搜索引用', () => {
    it('处理 groundingMetadata', async () => {
        const reader = createMockReader([
            'data: {"candidates":[{"content":{"parts":[{"text":"搜索结果"}]},"groundingMetadata":{"groundingChunks":[{"web":{"uri":"http://example.com","title":"Example"}}]}}]}'
        ]);

        await parseGeminiStream(reader);

        expect(saveAssistantMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                groundingMetadata: expect.objectContaining({
                    groundingChunks: expect.any(Array)
                })
            })
        );
    });
});

describe('parseGeminiStream - 错误处理', () => {
    it('处理 429 错误', async () => {
        const reader = createMockReader([
            'data: {"error":{"code":429,"message":"Resource exhausted"}}'
        ]);

        await parseGeminiStream(reader);

        expect(eventBus.emit).toHaveBeenCalledWith(
            'ui:notification',
            expect.objectContaining({
                message: expect.stringContaining('429')
            })
        );
    });

    it('处理 503 错误', async () => {
        const reader = createMockReader([
            'data: {"error":{"code":503,"message":"Service unavailable"}}'
        ]);

        await parseGeminiStream(reader);

        expect(eventBus.emit).toHaveBeenCalledWith(
            'ui:notification',
            expect.objectContaining({
                message: expect.stringContaining('503')
            })
        );
    });

    it('处理 500 错误', async () => {
        const reader = createMockReader([
            'data: {"error":{"code":500,"message":"Internal error"}}'
        ]);

        await parseGeminiStream(reader);

        expect(eventBus.emit).toHaveBeenCalledWith(
            'ui:notification',
            expect.objectContaining({
                message: expect.stringContaining('500')
            })
        );
    });

    it('处理 JSON 解析错误', async () => {
        const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const reader = createMockReader([
            'data: broken-json',
            'data: {"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}'
        ]);

        await parseGeminiStream(reader);

        expect(consoleSpy).toHaveBeenCalled();
        consoleSpy.mockRestore();
    });
});
