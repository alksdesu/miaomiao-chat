/**
 * api/image-retry.js 图片压缩重试测试
 * 新签名：attemptImageCompressionRetry(input, assistantMessageEl, sessionId) 强制必传 sessionId
 *         resetAllImageRetryState(sessionId) 强制必传
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../js/core/state.js', () => ({
    state: {
        _imageCompressionRetriedSessions: new Set(),
        fastImageCompression: false,
        messages: [],
        currentAssistantMessage: null,
        currentSessionId: 'test-session',
        sessions: [],
        backgroundTasks: new Map()
    }
}));

vi.mock('../../js/providers/manager.js', () => ({
    getCurrentProvider: vi.fn(() => ({ apiFormat: 'openai' }))
}));

vi.mock('../../js/core/state-mutations.js', () => ({
    rebuildMessageIdMap: vi.fn(),
    replaceAllMessages: vi.fn(),
    setImageRetry: vi.fn(),
    clearImageRetry: vi.fn()
}));

vi.mock('../../js/utils/images.js', () => ({
    isImageSizeError: vi.fn(() => false),
    compressImagesInMessages: vi.fn(async (msgs) => msgs)
}));

import {
    attemptImageCompressionRetry,
    resetAllImageRetryState,
    normalizeImageRetryInput
} from '../../js/api/image-retry.js';
import { state } from '../../js/core/state.js';
import {
    setImageRetry,
    clearImageRetry,
    rebuildMessageIdMap,
    replaceAllMessages
} from '../../js/core/state-mutations.js';
import { requestTaskRegistry } from '../../js/core/request-task-registry.js';

let isImageSizeError, compressImagesInMessages;

beforeEach(async () => {
    vi.clearAllMocks();
    state._imageCompressionRetriedSessions = new Set();
    state.fastImageCompression = false;
    state.messages = [];
    state.currentAssistantMessage = null;
    state.currentSessionId = 'test-session';
    requestTaskRegistry.clearForTests();

    const images = await import('../../js/utils/images.js');
    isImageSizeError = images.isImageSizeError;
    compressImagesInMessages = images.compressImagesInMessages;
});

describe('attemptImageCompressionRetry', () => {
    it('非图片大小错误时返回 false', async () => {
        isImageSizeError.mockReturnValue(false);
        const result = await attemptImageCompressionRetry({ code: 400 }, null, 'test-session');
        expect(result).toBe(false);
    });

    it('已重试过时返回 false（防无限循环）', async () => {
        isImageSizeError.mockReturnValue(true);
        state._imageCompressionRetriedSessions.add('test-session');

        const result = await attemptImageCompressionRetry({ code: 413 }, null, 'test-session');
        expect(result).toBe(false);
    });

    it('检测图片大小错误时触发压缩重试', async () => {
        isImageSizeError.mockReturnValue(true);
        state.messages = [{ role: 'user', content: 'test' }];
        compressImagesInMessages.mockResolvedValue([{ role: 'user', content: 'compressed' }]);

        const mockEl = document.createElement('div');
        const result = await attemptImageCompressionRetry({ code: 413 }, mockEl, 'test-session');

        expect(result).toBe(true);
        expect(state._imageCompressionRetriedSessions.has('test-session')).toBe(true);
        expect(compressImagesInMessages).toHaveBeenCalled();
        // replaceAllMessages 统一入口（内部封装 rebuildMessageIdMap + emit）
        expect(replaceAllMessages).toHaveBeenCalled();
        expect(setImageRetry).toHaveBeenCalledWith(mockEl, 'test-session');
    });

    it('无消息时跳过压缩', async () => {
        isImageSizeError.mockReturnValue(true);
        state.messages = [];

        const result = await attemptImageCompressionRetry({ code: 413 }, null, 'test-session');

        expect(result).toBe(true);
        expect(compressImagesInMessages).not.toHaveBeenCalled();
    });

    it('显示加载提示（DOM 工厂构造，无裸 innerHTML）', async () => {
        isImageSizeError.mockReturnValue(true);
        state.messages = [{ role: 'user', content: 'x' }];
        const msgEl = document.createElement('div');
        state.currentAssistantMessage = msgEl;

        await attemptImageCompressionRetry({ code: 413 }, null, 'test-session');

        // 文案与 dots 结构均通过 textContent / createElement 注入
        expect(msgEl.textContent).toContain('图片过大');
        expect(msgEl.querySelector('.thinking-dots.retry-loading')).toBeTruthy();
        expect(msgEl.querySelectorAll('.thinking-dots.retry-loading > span').length).toBe(3);
    });

    it('缺 sessionId 拒绝执行（强制必传）', async () => {
        isImageSizeError.mockReturnValue(true);
        const result = await attemptImageCompressionRetry({ code: 413 }, null);
        expect(result).toBe(false);
        expect(compressImagesInMessages).not.toHaveBeenCalled();
    });

    it('跨会话 sessionId 不等于 currentSessionId 时跳过 retry + 锁源会话', async () => {
        isImageSizeError.mockReturnValue(true);
        state.currentSessionId = 'session-current';

        const result = await attemptImageCompressionRetry(
            { code: 413 },
            null,
            'session-source-other'
        );
        expect(result).toBe(false);
        // 源会话仍上锁防 backgroundTask 再次触发
        expect(state._imageCompressionRetriedSessions.has('session-source-other')).toBe(true);
        expect(compressImagesInMessages).not.toHaveBeenCalled();
    });

    it('压缩期间切换会话只更新源任务快照，不替换新会话消息', async () => {
        isImageSizeError.mockReturnValue(true);
        let resolveCompression;
        compressImagesInMessages.mockImplementation(
            () => new Promise((resolve) => (resolveCompression = resolve))
        );
        const task = requestTaskRegistry.create({
            sessionId: 'test-session',
            abortController: new AbortController()
        });
        task.requestProfile = {
            providerApiFormat: 'openai',
            state: { fastImageCompression: false }
        };
        task.requestContext = { sourceMessages: [{ role: 'user', content: 'image' }] };

        const retryPromise = attemptImageCompressionRetry(
            { code: 413 },
            document.createElement('div'),
            'test-session',
            task
        );
        await vi.waitFor(() => expect(resolveCompression).toBeTypeOf('function'));
        state.currentSessionId = 'other-session';
        resolveCompression([{ role: 'user', content: 'compressed' }]);

        await expect(retryPromise).resolves.toBe(true);
        expect(task.retryMessages).toEqual([{ role: 'user', content: 'compressed' }]);
        expect(replaceAllMessages).not.toHaveBeenCalled();
        expect(setImageRetry).not.toHaveBeenCalled();
    });
});

describe('resetAllImageRetryState', () => {
    it('显式 sessionId 清指定会话的锁', () => {
        state._imageCompressionRetriedSessions.add('session-a');
        state._imageCompressionRetriedSessions.add('session-b');
        resetAllImageRetryState('session-a');

        expect(state._imageCompressionRetriedSessions.has('session-a')).toBe(false);
        expect(state._imageCompressionRetriedSessions.has('session-b')).toBe(true);
        expect(clearImageRetry).toHaveBeenCalled();
    });

    it('缺 sessionId 拒绝执行（强制必传）', () => {
        state._imageCompressionRetriedSessions.add('test-session');
        resetAllImageRetryState();

        // 锁未被清，clearImageRetry 未被调
        expect(state._imageCompressionRetriedSessions.has('test-session')).toBe(true);
        expect(clearImageRetry).not.toHaveBeenCalled();
    });
});

describe('normalizeImageRetryInput', () => {
    it('已经是 {error:{message}} 结构直接返回', () => {
        const input = { error: { type: 'x', message: 'y' } };
        expect(normalizeImageRetryInput(input)).toBe(input);
    });

    it('Error 实例归一为 {error:{type,message,status}}', () => {
        const err = new TypeError('boom');
        err.status = 500;
        const out = normalizeImageRetryInput(err);
        expect(out).toEqual({ error: { type: 'TypeError', message: 'boom', status: 500 } });
    });

    it('字符串归一为 unknown type', () => {
        expect(normalizeImageRetryInput('hi')).toEqual({
            error: { type: 'unknown', message: 'hi' }
        });
    });

    it('null/undefined 归一为 Unknown error', () => {
        expect(normalizeImageRetryInput(null).error.message).toBe('Unknown error');
        expect(normalizeImageRetryInput(undefined).error.message).toBe('Unknown error');
    });
});

describe('Stage 5a image-retry replaceAllMessages integration', () => {
    it('调 replaceAllMessages 而非裸 state.messages 赋值', async () => {
        isImageSizeError.mockReturnValue(true);
        state.messages = [{ role: 'user', content: 'orig-msg' }];

        const compressedOut = [{ role: 'user', content: 'compressed-msg' }];
        compressImagesInMessages.mockResolvedValue(compressedOut);

        await attemptImageCompressionRetry(
            { code: 413 },
            document.createElement('div'),
            'test-session'
        );

        expect(replaceAllMessages).toHaveBeenCalledTimes(1);
        expect(replaceAllMessages).toHaveBeenCalledWith(compressedOut);
    });

    it('rebuildMessageIdMap 不再被直接调用（replaceAllMessages 内部承担）', async () => {
        isImageSizeError.mockReturnValue(true);
        state.messages = [{ role: 'user', content: 'x' }];
        compressImagesInMessages.mockResolvedValue([{ role: 'user', content: 'y' }]);

        await attemptImageCompressionRetry({ code: 413 }, null, 'test-session');

        expect(rebuildMessageIdMap).not.toHaveBeenCalled();
        expect(replaceAllMessages).toHaveBeenCalled();
    });
});
