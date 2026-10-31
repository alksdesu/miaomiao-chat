/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../js/utils/markdown.js', () => ({
    safeMarkedParse: (text) => `<p>${text}</p>`
}));

vi.mock('../../js/messages/render-thinking.js', () => ({
    renderThinkingBlock: (text) => `<aside>${text}</aside>`,
    clearThinkingCache: vi.fn(),
    enhanceThinkingBlocks: vi.fn(),
    purgeThinkingCacheInElement: vi.fn(),
    captureExpandedThinkingState: vi.fn(() => []),
    restoreExpandedThinkingState: vi.fn()
}));

import { createMessageElement, renderCanonicalParts } from '../../js/messages/renderer.js';
import { LAZY_IMAGE_PLACEHOLDER } from '../../js/utils/lazy-image.js';
import {
    MediaKind,
    filePart,
    mediaPart,
    textPart,
    thinkingPart
} from '../../js/messages/schema.js';

describe('canonical message rendering', () => {
    it('统一渲染思维、文本、媒体和文件 part', () => {
        const html = renderCanonicalParts([
            thinkingPart('reasoning'),
            textPart('answer'),
            mediaPart(MediaKind.VIDEO, 'https://example.com/video.mp4', 'video/mp4'),
            filePart('notes.txt', 'text/plain', 'data:text/plain;base64,bm90ZXM=')
        ]);

        expect(html).toContain('<aside>reasoning</aside>');
        expect(html).toContain('<p>answer</p>');
        expect(html).toContain('<video');
        expect(html).toContain('notes.txt');
        expect(html).toContain('message-file-item txt');
    });

    it('恢复长会话时只对图片生成懒加载占位', () => {
        const html = renderCanonicalParts(
            [
                mediaPart(MediaKind.IMAGE, 'https://example.com/image.png', 'image/png'),
                mediaPart(MediaKind.AUDIO, 'https://example.com/audio.mp3', 'audio/mpeg')
            ],
            'assistant',
            { lazyImages: true }
        );

        expect(html).toContain('class="lazy-image"');
        expect(html).toContain('data-src="https://example.com/image.png"');
        expect(html).toContain('<audio');
    });

    it('懒加载占位图完整写进 src 属性，后面的属性不被截断', () => {
        const html = renderCanonicalParts(
            [mediaPart(MediaKind.IMAGE, 'https://example.com/image.png', 'image/png')],
            'assistant',
            { lazyImages: true }
        );
        const img = new window.DOMParser().parseFromString(html, 'text/html').querySelector('img');

        expect(img.getAttribute('src')).toBe(LAZY_IMAGE_PLACEHOLDER);
        expect(img.dataset.src).toBe('https://example.com/image.png');
        expect(img.getAttributeNames().sort()).toEqual([
            'alt',
            'class',
            'data-src',
            'decoding',
            'loading',
            'src',
            'style'
        ]);
    });

    it('用户附件图片使用同一份懒加载占位图', () => {
        vi.stubGlobal('requestIdleCallback', vi.fn());
        const dataUrl = 'data:image/png;base64,iVBORw0KGgo=';

        const messageEl = createMessageElement('user', 'hi', [
            { type: 'image/png', name: 'photo.png', data: dataUrl }
        ]);
        vi.unstubAllGlobals();

        const img = messageEl.querySelector('.message-images img.lazy-image');
        expect(img.getAttribute('src')).toBe(LAZY_IMAGE_PLACEHOLDER);
        expect(img.dataset.src).toBe(dataUrl);
    });
});
