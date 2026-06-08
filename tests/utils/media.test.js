/**
 * media.js 媒体工具函数测试
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../js/utils/logger.js', () => ({
    logger: { warn: vi.fn(), debug: vi.fn(), error: vi.fn(), info: vi.fn() }
}));

import {
    isDataUrl,
    extractDataUrlMimeType,
    isVideoMimeType,
    isImageMimeType,
    isAudioMimeType,
    isVideoDataUrl,
    getExtensionFromMimeType,
    getMediaExtension,
    isVideoUrl,
    downloadMedia
} from '../../js/utils/media.js';

// ========== isDataUrl ==========

describe('isDataUrl', () => {
    it('data URL 返回 true', () => {
        expect(isDataUrl('data:image/png;base64,abc')).toBe(true);
    });

    it('http URL 返回 false', () => {
        expect(isDataUrl('https://example.com/img.png')).toBe(false);
    });

    it('空字符串返回 false', () => {
        expect(isDataUrl('')).toBe(false);
    });

    it('null 返回 false', () => {
        expect(isDataUrl(null)).toBe(false);
    });

    it('数字返回 false', () => {
        expect(isDataUrl(123)).toBe(false);
    });
});

// ========== extractDataUrlMimeType ==========

describe('extractDataUrlMimeType', () => {
    it('提取 image/png', () => {
        expect(extractDataUrlMimeType('data:image/png;base64,abc')).toBe('image/png');
    });

    it('提取 video/mp4', () => {
        expect(extractDataUrlMimeType('data:video/mp4;base64,abc')).toBe('video/mp4');
    });

    it('非 data URL 返回空字符串', () => {
        expect(extractDataUrlMimeType('https://example.com')).toBe('');
    });

    it('null 返回空字符串', () => {
        expect(extractDataUrlMimeType(null)).toBe('');
    });

    it('大小写不敏感', () => {
        expect(extractDataUrlMimeType('data:IMAGE/PNG;base64,abc')).toBe('image/png');
    });
});

// ========== isVideoMimeType ==========

describe('isVideoMimeType', () => {
    it('video/mp4 返回 true', () => {
        expect(isVideoMimeType('video/mp4')).toBe(true);
    });

    it('video/webm 返回 true', () => {
        expect(isVideoMimeType('video/webm')).toBe(true);
    });

    it('image/png 返回 false', () => {
        expect(isVideoMimeType('image/png')).toBe(false);
    });

    it('null 返回 false', () => {
        expect(isVideoMimeType(null)).toBe(false);
    });

    it('大小写不敏感', () => {
        expect(isVideoMimeType('Video/MP4')).toBe(true);
    });
});

// ========== isImageMimeType ==========

describe('isImageMimeType', () => {
    it('image/png 返回 true', () => {
        expect(isImageMimeType('image/png')).toBe(true);
    });

    it('video/mp4 返回 false', () => {
        expect(isImageMimeType('video/mp4')).toBe(false);
    });

    it('null 返回 false', () => {
        expect(isImageMimeType(null)).toBe(false);
    });
});

// ========== isAudioMimeType ==========

describe('isAudioMimeType', () => {
    it('audio/mp3 返回 true', () => {
        expect(isAudioMimeType('audio/mp3')).toBe(true);
    });

    it('video/mp4 返回 false', () => {
        expect(isAudioMimeType('video/mp4')).toBe(false);
    });

    it('null 返回 false', () => {
        expect(isAudioMimeType(null)).toBe(false);
    });
});

// ========== isVideoDataUrl ==========

describe('isVideoDataUrl', () => {
    it('视频 data URL 返回 true', () => {
        expect(isVideoDataUrl('data:video/mp4;base64,abc')).toBe(true);
    });

    it('图片 data URL 返回 false', () => {
        expect(isVideoDataUrl('data:image/png;base64,abc')).toBe(false);
    });

    it('非 data URL 返回 false', () => {
        expect(isVideoDataUrl('https://example.com/video.mp4')).toBe(false);
    });
});

// ========== getExtensionFromMimeType ==========

describe('getExtensionFromMimeType', () => {
    it('video/mp4 返回 mp4', () => {
        expect(getExtensionFromMimeType('video/mp4')).toBe('mp4');
    });

    it('image/png 返回 png', () => {
        expect(getExtensionFromMimeType('image/png')).toBe('png');
    });

    it('image/jpeg 返回 jpg', () => {
        expect(getExtensionFromMimeType('image/jpeg')).toBe('jpg');
    });

    it('未知 MIME 使用通用提取', () => {
        expect(getExtensionFromMimeType('application/pdf')).toBe('pdf');
    });

    it('null 返回 fallback', () => {
        expect(getExtensionFromMimeType(null)).toBe('bin');
    });

    it('自定义 fallback', () => {
        expect(getExtensionFromMimeType(null, 'dat')).toBe('dat');
    });

    it('空字符串返回 fallback', () => {
        expect(getExtensionFromMimeType('')).toBe('bin');
    });

    it('video/webm 返回 webm', () => {
        expect(getExtensionFromMimeType('video/webm')).toBe('webm');
    });
});

// ========== getMediaExtension ==========

describe('getMediaExtension', () => {
    it('优先使用 mimeType', () => {
        expect(getMediaExtension('https://example.com/video.webm', 'video/mp4')).toBe('mp4');
    });

    it('data URL 提取 MIME', () => {
        expect(getMediaExtension('data:image/png;base64,abc')).toBe('png');
    });

    it('无 mimeType 使用 fallback', () => {
        expect(getMediaExtension('blob:xxx', '', 'dat')).toBe('dat');
    });
});

// ========== isVideoUrl ==========

describe('isVideoUrl', () => {
    it('mimeType 为视频时返回 true', () => {
        expect(isVideoUrl('https://example.com/file', 'video/mp4')).toBe(true);
    });

    it('data URL 为视频时返回 true', () => {
        expect(isVideoUrl('data:video/webm;base64,abc')).toBe(true);
    });

    it('data URL 为图片时返回 false', () => {
        expect(isVideoUrl('data:image/png;base64,abc')).toBe(false);
    });

    it('非视频 MIME 返回 false', () => {
        expect(isVideoUrl('https://example.com/file', 'image/png')).toBe(false);
    });

    it('mp4 扩展名返回 true', () => {
        expect(isVideoUrl('https://example.com/video.mp4')).toBe(true);
    });

    it('webm 扩展名返回 true', () => {
        expect(isVideoUrl('https://example.com/video.webm')).toBe(true);
    });

    it('mov 扩展名返回 true', () => {
        expect(isVideoUrl('https://example.com/video.mov')).toBe(true);
    });

    it('jpg 扩展名返回 false', () => {
        expect(isVideoUrl('https://example.com/photo.jpg')).toBe(false);
    });

    it('无扩展名无 MIME 返回 false', () => {
        expect(isVideoUrl('https://example.com/file')).toBe(false);
    });
});

// ========== downloadMedia ==========

describe('downloadMedia', () => {
    let clickSpy;
    let createObjectURLSpy;
    let revokeObjectURLSpy;

    beforeEach(() => {
        clickSpy = vi.fn();
        createObjectURLSpy = vi.fn(() => 'blob:test');
        revokeObjectURLSpy = vi.fn();
        globalThis.URL.createObjectURL = createObjectURLSpy;
        globalThis.URL.revokeObjectURL = revokeObjectURLSpy;

        const origCreateElement = document.createElement.bind(document);
        vi.spyOn(document, 'createElement').mockImplementation((tag) => {
            const el = origCreateElement(tag);
            if (tag === 'a') {
                el.click = clickSpy;
            }
            return el;
        });
        vi.spyOn(document.body, 'appendChild').mockImplementation(() => {});
        vi.spyOn(document.body, 'removeChild').mockImplementation(() => {});
    });

    it('data URL 下载触发 click', async () => {
        await downloadMedia('data:image/png;base64,iVBORw0KGgo=', 'test.png');
        expect(clickSpy).toHaveBeenCalled();
        expect(revokeObjectURLSpy).toHaveBeenCalled();
    });

    it('空 URL 走错误路径', async () => {
        const openSpy = vi.spyOn(window, 'open').mockImplementation(() => {});
        await downloadMedia('');
        expect(openSpy).toHaveBeenCalled();
        openSpy.mockRestore();
    });

    it('null URL 走错误路径', async () => {
        const openSpy = vi.spyOn(window, 'open').mockImplementation(() => {});
        await downloadMedia(null);
        expect(openSpy).toHaveBeenCalled();
        openSpy.mockRestore();
    });

    it('HTTP URL 不抛错', async () => {
        // HTTP URL 走链接下载路径
        await expect(
            downloadMedia('https://example.com/video.mp4', 'video.mp4')
        ).resolves.not.toThrow();
    });
});
