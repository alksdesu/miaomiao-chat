/**
 * api/handler-context.js 请求快照测试：构造失败不抛错、工具续作只要一个回复
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
    state: {
        currentSessionId: 'session-1',
        requestTimeout: 30000,
        messages: [],
        messageStore: null
    },
    captureRequestProfile: vi.fn()
}));

vi.mock('../../js/core/state.js', () => ({ state: mocks.state }));
vi.mock('../../js/api/current.js', () => ({
    getCurrentEndpoint: vi.fn(() => 'https://api.example.com'),
    getCurrentApiKey: vi.fn(() => 'key'),
    getCurrentModel: vi.fn(() => 'gpt-image-2'),
    getCurrentProvider: vi.fn(() => ({ apiFormat: 'openai-image', name: '生图' }))
}));
vi.mock('../../js/api/adapters/index.js', () => ({
    getAdapter: vi.fn((format) => ({ apiFormat: format, name: format }))
}));
vi.mock('../../js/api/request-pipeline.js', () => ({
    captureRequestProfile: mocks.captureRequestProfile
}));
vi.mock('../../js/messages/tool-results.js', () => ({
    applyToolResultsToMessages: vi.fn((messages) => ({ messages }))
}));

import { createHandlerContext } from '../../js/api/handler-context.js';

function createProfile(overrides = {}) {
    return {
        state: { requestTimeout: 60000 },
        streamEnabled: true,
        replyCount: 3,
        modelDisplayName: 'model',
        providerName: 'Provider',
        ...overrides
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    mocks.captureRequestProfile.mockReturnValue(createProfile());
});

describe('createHandlerContext', () => {
    it('正常构造时没有 setupError，回复数取自快照', () => {
        const ctx = createHandlerContext();
        expect(ctx.setupError).toBeNull();
        expect(ctx.replyCount).toBe(3);
        expect(ctx.timeoutMs).toBe(60000);
        expect(ctx.sessionId).toBe('session-1');
    });

    it('快照构造抛错时不再向外抛，带上原因与可供错误处理使用的字段', () => {
        const error = new Error('尺寸不能小于 655,360 像素（如 1024×640）');
        mocks.captureRequestProfile.mockImplementation(() => {
            throw error;
        });

        const ctx = createHandlerContext();

        expect(ctx.setupError).toBe(error);
        expect(ctx.sessionId).toBe('session-1');
        expect(ctx.abortController).toBeInstanceOf(AbortController);
        expect(ctx.timeoutMs).toBe(30000);
        expect(ctx.replyCount).toBe(1);
        expect(ctx.requestProfile).toEqual(
            expect.objectContaining({ modelDisplayName: 'gpt-image-2', providerName: '生图' })
        );
    });

    it('工具续作只要一个回复，图片重试保留原回复数', () => {
        const profile = createProfile();
        const continuation = createHandlerContext({
            sessionId: 'session-1',
            requestProfile: profile,
            isSavingContinuation: true
        });
        const imageRetry = createHandlerContext({
            sessionId: 'session-1',
            requestProfile: profile,
            isImageRetry: true
        });

        expect(continuation.replyCount).toBe(1);
        expect(imageRetry.replyCount).toBe(3);
        expect(mocks.captureRequestProfile).not.toHaveBeenCalled();
    });
});
