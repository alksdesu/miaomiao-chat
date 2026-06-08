/**
 * stream/helpers.js 流式渲染辅助函数测试
 * 测试 handleContentArray 和 cleanupAllIncompleteImages
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

// mock 依赖
vi.mock('../../js/core/state.js', () => ({
    state: {
        currentAssistantMessage: null,
        imageBuffers: new Map()
    },
    elements: {
        messagesArea: {
            scrollTo: vi.fn(),
            scrollHeight: 1000
        }
    }
}));

vi.mock('../../js/utils/markdown.js', () => ({
    safeMarkedParse: vi.fn((text) => `<p>${text}</p>`)
}));

vi.mock('../../js/utils/helpers.js', () => ({
    escapeHtml: vi.fn((s) => s)
}));

vi.mock('../../js/messages/renderer.js', () => ({
    renderThinkingBlock: vi.fn((text) => `<div class="thinking-block">${text}</div>`),
    enhanceCodeBlocks: vi.fn(),
    enhanceThinkingBlocks: vi.fn()
}));

vi.mock('../../js/utils/media.js', () => ({
    isVideoUrl: vi.fn(() => false)
}));

vi.mock('../../js/ui/media-cards.js', () => ({
    renderMediaCard: vi.fn(() => '<div class="media-card"></div>')
}));

import { handleContentArray, cleanupAllIncompleteImages } from '../../js/stream/helpers.js';
import { state } from '../../js/core/state.js';

beforeEach(() => {
    vi.clearAllMocks();
    state.imageBuffers = new Map();
});

// ========== handleContentArray ==========

describe('handleContentArray', () => {
    it('处理文本类型 part', async () => {
        const contentParts = [];
        const added = await handleContentArray(
            [{ type: 'text', text: 'Hello world' }],
            contentParts
        );

        expect(contentParts).toHaveLength(1);
        expect(contentParts[0]).toEqual({ type: 'text', text: 'Hello world' });
        expect(added).toBe(11);
    });

    it('合并到已有的文本 part', async () => {
        const contentParts = [{ type: 'text', text: 'Hello' }];
        const added = await handleContentArray([{ type: 'text', text: ' World' }], contentParts);

        expect(contentParts).toHaveLength(1);
        expect(contentParts[0].text).toBe('Hello World');
        expect(added).toBe(6);
    });

    it('处理完整图片 URL', async () => {
        const contentParts = [];
        await handleContentArray(
            [{ type: 'image_url', image_url: { url: 'http://img.com/1.png' } }],
            contentParts
        );

        expect(contentParts).toHaveLength(1);
        expect(contentParts[0].type).toBe('image_url');
        expect(contentParts[0].complete).toBe(true);
    });

    it('跳过 partial 图片', async () => {
        const contentParts = [];
        await handleContentArray(
            [{ type: 'image_url', image_url: { url: 'partial', partial: true } }],
            contentParts
        );

        expect(contentParts).toHaveLength(0);
    });

    it('处理 base64 图片计数长度', async () => {
        const b64 = 'AAAA'.repeat(100);
        const contentParts = [];
        const added = await handleContentArray(
            [{ type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } }],
            contentParts
        );

        expect(added).toBe(b64.length);
    });

    it('处理视频 URL', async () => {
        const contentParts = [];
        await handleContentArray(
            [{ type: 'video_url', video_url: { url: 'http://vid.com/1.mp4' } }],
            contentParts
        );

        expect(contentParts).toHaveLength(1);
        expect(contentParts[0].type).toBe('video_url');
        expect(contentParts[0].complete).toBe(true);
    });

    it('跳过 partial 视频', async () => {
        const contentParts = [];
        await handleContentArray(
            [{ type: 'video_url', video_url: { url: 'http://vid.com/1.mp4', partial: true } }],
            contentParts
        );

        expect(contentParts).toHaveLength(0);
    });

    it('处理混合内容数组', async () => {
        const contentParts = [];
        await handleContentArray(
            [
                { type: 'text', text: 'Caption: ' },
                { type: 'image_url', image_url: { url: 'http://img.com/2.png' } },
                { type: 'text', text: 'More text' }
            ],
            contentParts
        );

        expect(contentParts.length).toBeGreaterThanOrEqual(2);
    });

    it('处理空数组', async () => {
        const contentParts = [];
        const added = await handleContentArray([], contentParts);

        expect(added).toBe(0);
        expect(contentParts).toHaveLength(0);
    });

    it('处理无 URL 图片', async () => {
        const contentParts = [];
        await handleContentArray([{ type: 'image_url', image_url: { url: '' } }], contentParts);

        expect(contentParts).toHaveLength(0);
    });
});

// ========== cleanupAllIncompleteImages ==========

describe('cleanupAllIncompleteImages', () => {
    it('清理 imageBuffers', () => {
        state.imageBuffers = new Map([['buf1', 'data']]);
        cleanupAllIncompleteImages([]);
        expect(state.imageBuffers.size).toBe(0);
    });

    it('处理 null imageBuffers', () => {
        state.imageBuffers = null;
        expect(() => cleanupAllIncompleteImages([])).not.toThrow();
    });
});
