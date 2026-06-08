/**
 * stream/multi-stream.js 多回复流测试
 * 测试 buildGeminiReplyParts 内部逻辑（通过集成测试覆盖）
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

// mock 依赖
vi.mock('../../js/core/state.js', () => ({
    state: {
        replyCount: 2,
        currentAssistantMessage: {
            innerHTML: '',
            querySelector: vi.fn(() => null),
            appendChild: vi.fn()
        },
        apiFormat: 'openai',
        currentReplies: [],
        selectedReplyIndex: 0
    }
}));

vi.mock('../../js/stream/stats.js', () => ({
    recordFirstToken: vi.fn(),
    recordTokens: vi.fn(),
    finalizeStreamStats: vi.fn(),
    getCurrentStreamStatsData: vi.fn(() => ({})),
    appendStreamStats: vi.fn()
}));

vi.mock('../../js/stream/helpers.js', () => ({
    updateStreamingMessage: vi.fn()
}));

vi.mock('../../js/messages/sync.js', () => ({
    saveAssistantMessage: vi.fn(() => 0),
    saveErrorMessage: vi.fn()
}));

vi.mock('../../js/messages/dom-sync.js', () => ({
    setCurrentMessageIndex: vi.fn()
}));

vi.mock('../../js/messages/renderer.js', () => ({
    renderReplyWithSelector: vi.fn()
}));

vi.mock('../../js/utils/errors.js', () => ({
    renderHumanizedError: vi.fn(() => '<div>error</div>')
}));

vi.mock('../../js/api/factory.js', () => ({
    getSendFunction: vi.fn(() =>
        vi.fn(async () => ({
            ok: true,
            body: { getReader: () => createSimpleMockReader() }
        }))
    )
}));

// Stage 5 后 multi-stream 调 getAdapter 拿 streamParser，需要 mock 返回模拟 adapter
vi.mock('../../js/api/adapters/index.js', () => ({
    getAdapter: vi.fn(() => ({
        name: 'OpenAI Chat',
        streamParser: vi.fn(async (_reader, _sessionId, _sink, _signal) => ({
            collectReply: () => ({
                content: 'Hello',
                thinkingContent: null,
                contentParts: null,
                stats: { syncToGlobal: vi.fn(), getData: () => ({}) }
            })
        }))
    }))
}));

vi.mock('../../js/providers/manager.js', () => ({
    getCurrentProvider: vi.fn(() => ({ apiFormat: 'openai', name: 'OpenAI' })),
    getModelDisplayName: vi.fn(() => 'gpt-test')
}));

vi.mock('../../js/api/current.js', () => ({
    getCurrentProvider: vi.fn(() => ({ apiFormat: 'openai', name: 'OpenAI' })),
    getModelDisplayName: vi.fn(() => 'gpt-test'),
    getCurrentEndpoint: vi.fn(() => 'http://api.test'),
    getCurrentApiKey: vi.fn(() => 'key'),
    getCurrentModel: vi.fn(() => 'model'),
    getCurrentModelCapabilities: vi.fn(() => null),
    getCurrentActiveApiKey: vi.fn(() => 'key')
}));

vi.mock('../../js/api/request-pipeline.js', () => ({
    executeRequest: vi.fn()
}));

vi.mock('../../js/messages/parts-builder.js', () => ({
    buildPartsFromStreamingState: vi.fn(() => []),
    buildMetaFromStreamingState: vi.fn(() => ({}))
}));

vi.mock('../../js/stream/sink.js', () => ({
    BufferedSink: vi.fn().mockImplementation(() => ({
        errorInfo: null,
        skippedToolCalls: null,
        commit: vi.fn()
    }))
}));

vi.mock('../../js/utils/media.js', () => ({
    isVideoMimeType: vi.fn(() => false),
    isAudioMimeType: vi.fn(() => false)
}));

function createSimpleMockReader() {
    const encoder = new TextEncoder();
    const lines = ['data: {"choices":[{"delta":{"content":"Hello"}}]}\n', 'data: [DONE]\n'];
    let idx = 0;
    return {
        read: vi.fn(async () => {
            if (idx >= lines.length) return { done: true, value: undefined };
            return { done: false, value: encoder.encode(lines[idx++]) };
        }),
        cancel: vi.fn(),
        releaseLock: vi.fn()
    };
}

import { handleMultiStreamResponses } from '../../js/stream/multi-stream.js';
import { state } from '../../js/core/state.js';
import { saveAssistantMessage, saveErrorMessage } from '../../js/messages/sync.js';
import { renderReplyWithSelector } from '../../js/messages/renderer.js';
import { renderHumanizedError } from '../../js/utils/errors.js';
import { appendStreamStats } from '../../js/stream/stats.js';
import { executeRequest } from '../../js/api/request-pipeline.js';

beforeEach(() => {
    vi.clearAllMocks();
    state.replyCount = 2;
    state.currentAssistantMessage = {
        innerHTML: '',
        querySelector: vi.fn(() => null),
        appendChild: vi.fn()
    };
    state.currentReplies = [];
    state.selectedReplyIndex = 0;
});

describe('handleMultiStreamResponses - 成功流', () => {
    it('并行处理多个回复', async () => {
        executeRequest.mockImplementation(async () => ({
            ok: true,
            body: { getReader: () => createSimpleMockReader() }
        }));

        await handleMultiStreamResponses(
            'http://api.test',
            'key',
            'model',
            new AbortController(),
            document.createElement('div'),
            'session-1'
        );

        expect(executeRequest).toHaveBeenCalledTimes(2);
        expect(appendStreamStats).toHaveBeenCalled();
        expect(state.currentReplies.length).toBeGreaterThan(0);
        expect(state.selectedReplyIndex).toBe(0);
        expect(saveAssistantMessage).toHaveBeenCalled();
        expect(renderReplyWithSelector).toHaveBeenCalled();
    });

    it('单回复模式', async () => {
        state.replyCount = 1;
        executeRequest.mockImplementation(async () => ({
            ok: true,
            body: { getReader: () => createSimpleMockReader() }
        }));

        await handleMultiStreamResponses(
            'http://api.test',
            'key',
            'model',
            new AbortController(),
            document.createElement('div'),
            'session-1'
        );

        expect(executeRequest).toHaveBeenCalledTimes(1);
        expect(saveAssistantMessage).toHaveBeenCalled();
    });
});

describe('handleMultiStreamResponses - 所有请求失败', () => {
    it('所有请求 HTTP 错误', async () => {
        executeRequest.mockImplementation(async () => ({
            ok: false,
            status: 429,
            clone: () => ({
                json: async () => ({ error: { message: 'Rate limit' } })
            })
        }));

        await handleMultiStreamResponses(
            'http://api.test',
            'key',
            'model',
            new AbortController(),
            document.createElement('div'),
            'session-1'
        );

        expect(renderHumanizedError).toHaveBeenCalled();
        expect(saveErrorMessage).toHaveBeenCalled();
    });

    it('所有请求网络错误', async () => {
        executeRequest.mockImplementation(async () => {
            throw new Error('Network error');
        });

        await handleMultiStreamResponses(
            'http://api.test',
            'key',
            'model',
            new AbortController(),
            document.createElement('div'),
            'session-1'
        );

        expect(renderHumanizedError).toHaveBeenCalled();
    });
});

describe('handleMultiStreamResponses - 部分成功', () => {
    it('一个成功一个失败', async () => {
        let callCount = 0;
        executeRequest.mockImplementation(async () => {
            callCount++;
            if (callCount === 1) {
                return {
                    ok: true,
                    body: { getReader: () => createSimpleMockReader() }
                };
            }
            return {
                ok: false,
                status: 500,
                clone: () => ({
                    json: async () => ({ error: { message: 'Server error' } })
                })
            };
        });

        await handleMultiStreamResponses(
            'http://api.test',
            'key',
            'model',
            new AbortController(),
            document.createElement('div'),
            'session-1'
        );

        // 仍然应保存成功的回复
        expect(saveAssistantMessage).toHaveBeenCalled();
    });
});
