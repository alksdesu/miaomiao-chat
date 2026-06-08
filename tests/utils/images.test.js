/**
 * images.js 测试
 */
// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../js/utils/logger.js', () => ({
    logger: { warn: vi.fn(), debug: vi.fn(), error: vi.fn(), info: vi.fn() }
}));

vi.mock('../../js/utils/helpers.js', () => ({
    detectImageFormat: vi.fn((bytes) => {
        // 简单 mock: 总是返回 png
        return { mime: 'image/png', ext: 'png' };
    })
}));

vi.mock('../../js/utils/constants.js', () => ({
    API_FILE_SIZE_LIMITS: {
        gemini: 20 * 1024 * 1024,
        openai: 20 * 1024 * 1024
    }
}));

vi.mock('../../js/messages/schema.js', () => ({
    PartType: { MEDIA: 'media' },
    MediaKind: { IMAGE: 'image', VIDEO: 'video', AUDIO: 'audio' }
}));

import { isImageSizeError, downloadImage } from '../../js/utils/images.js';

describe('images', () => {
    // ========== isImageSizeError ==========
    describe('isImageSizeError', () => {
        // OpenAI 模式
        it('检测 OpenAI image exceeds error', () => {
            expect(isImageSizeError({ message: 'Image exceeds size limit' })).toBe(true);
        });

        it('检测 OpenAI image too large', () => {
            expect(isImageSizeError({ message: 'The image is too large' })).toBe(true);
        });

        it('检测 OpenAI 20971520 字节限制', () => {
            expect(isImageSizeError({ message: 'Image size 20971520 exceeded' })).toBe(true);
        });

        it('检测 OpenAI image size limit', () => {
            expect(isImageSizeError({ message: 'Image size limit reached' })).toBe(true);
        });

        // Gemini 模式
        it('检测 Gemini 413', () => {
            expect(isImageSizeError({ message: 'Error 413 from server' })).toBe(true);
        });

        it('检测 Gemini request entity too large', () => {
            expect(isImageSizeError({ message: 'Request entity too large' })).toBe(true);
        });

        it('检测 Gemini request size exceeds', () => {
            expect(isImageSizeError({ message: 'Request size exceeds limit' })).toBe(true);
        });

        it('检测 Gemini payload 20', () => {
            expect(isImageSizeError({ message: 'Payload exceeds 20 MB' })).toBe(true);
        });

        // Claude 模式
        it('检测 Claude image 5 mb', () => {
            expect(isImageSizeError({ message: 'Image size exceeds 5 MB limit' })).toBe(true);
        });

        it('检测 Claude 5242880 字节', () => {
            expect(isImageSizeError({ message: 'Image 5242880 bytes exceeded' })).toBe(true);
        });

        it('检测 Claude image exceeds the limit', () => {
            expect(isImageSizeError({ message: 'Image exceeds the limit' })).toBe(true);
        });

        // 非图片错误
        it('非图片错误返回 false', () => {
            expect(isImageSizeError({ message: 'Rate limit exceeded' })).toBe(false);
        });

        it('null 错误返回 false', () => {
            expect(isImageSizeError(null)).toBe(false);
        });

        it('嵌套 error.message 也能检测', () => {
            expect(isImageSizeError({ error: { message: 'Image exceeds size limit' } })).toBe(true);
        });

        it('普通对象 JSON 序列化后检测', () => {
            expect(isImageSizeError({ code: 413 })).toBe(true);
        });
    });

    // ========== downloadImage ==========
    describe('downloadImage', () => {
        it('处理 base64 data URL', () => {
            // 创建一个最小的白色 1x1 PNG
            const dataUrl =
                'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMBAQApDs4AAAAASUVORK5CYII=';

            const createObjectURLMock = vi.fn(() => 'blob:mock');
            const revokeObjectURLMock = vi.fn();
            const clickMock = vi.fn();

            globalThis.URL.createObjectURL = createObjectURLMock;
            globalThis.URL.revokeObjectURL = revokeObjectURLMock;

            // mock createElement 只对 'a' 标签生效
            const origCreateElement = document.createElement.bind(document);
            vi.spyOn(document, 'createElement').mockImplementation((tag) => {
                const el = origCreateElement(tag);
                if (tag === 'a') {
                    el.click = clickMock;
                }
                return el;
            });

            downloadImage(dataUrl, 'test.png');

            expect(createObjectURLMock).toHaveBeenCalled();
            expect(clickMock).toHaveBeenCalled();
            expect(revokeObjectURLMock).toHaveBeenCalled();

            document.createElement.mockRestore?.();
        });

        it('下载失败时 fallback 到 window.open', () => {
            const openMock = vi.fn();
            const origOpen = window.open;
            window.open = openMock;

            // 一个无效的 data url（base64 解码会失败）
            downloadImage('data:image/png;base64,!!!invalid!!!', 'test.png');

            expect(openMock).toHaveBeenCalledWith('data:image/png;base64,!!!invalid!!!', '_blank');
            window.open = origOpen;
        });
    });
});
