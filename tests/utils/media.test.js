/**
 * media.js 媒体工具函数测试
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../js/utils/logger.js', () => ({
    logger: { warn: vi.fn(), debug: vi.fn(), error: vi.fn(), info: vi.fn() }
}));

vi.mock('../../js/utils/platform.js', () => ({
    isAndroid: vi.fn(() => false)
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
import { createTrackedObjectUrl, revokeTrackedObjectUrl } from '../../js/utils/object-urls.js';
import { isAndroid } from '../../js/utils/platform.js';
import { eventBus } from '../../js/core/events.js';

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
    let emitSpy;

    const lastDownloadedBlob = () => URL.createObjectURL.mock.calls.at(-1)[0];
    const lastLink = () => clickSpy.mock.contexts.at(-1);

    function installAndroidFilesystem(writeFile) {
        window.Capacitor = {
            Plugins: {
                Filesystem: {
                    checkPermissions: vi.fn(async () => ({ publicStorage: 'granted' })),
                    stat: vi.fn(async () => {
                        throw new Error('File does not exist');
                    }),
                    writeFile,
                    appendFile: vi.fn(),
                    deleteFile: vi.fn(async () => {})
                }
            }
        };
    }

    beforeEach(() => {
        isAndroid.mockReturnValue(false);
        URL.createObjectURL = vi.fn(() => 'blob:download');
        URL.revokeObjectURL = vi.fn();
        clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
        emitSpy = vi.spyOn(eventBus, 'emit');
    });

    afterEach(() => {
        clickSpy.mockRestore();
        emitSpy.mockRestore();
        delete window.Capacitor;
    });

    it('data URL 解码后下载', async () => {
        const result = await downloadMedia('data:image/png;base64,iVBORw0KGgo=', 'test.png');

        expect(result).toEqual({ savedTo: null });
        expect(clickSpy).toHaveBeenCalledTimes(1);
        expect(lastLink().download).toBe('test.png');
        expect(lastDownloadedBlob().type).toBe('image/png');
    });

    it('图片按文件头修正扩展名与类型：标成 PNG 的 JPEG 存为 .jpg', async () => {
        const jpegBase64 = btoa(String.fromCharCode(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10));

        await downloadMedia(`data:image/png;base64,${jpegBase64}`, 'tool-image-1.png');

        expect(lastLink().download).toBe('tool-image-1.jpg');
        expect(lastDownloadedBlob().type).toBe('image/jpeg');
    });

    it('识别不出的图片格式（SVG）保留原名与类型', async () => {
        const svgBase64 = btoa('<svg xmlns="http://www.w3.org/2000/svg"/>');

        await downloadMedia(`data:image/svg+xml;base64,${svgBase64}`, 'image-1.svg');

        expect(lastLink().download).toBe('image-1.svg');
        expect(lastDownloadedBlob().type).toBe('image/svg+xml');
    });

    it('视频不做图片格式修正', async () => {
        const videoBase64 = btoa(String.fromCharCode(0x89, 0x50, 0x4e, 0x47, 0x00, 0x00));

        await downloadMedia(`data:video/mp4;base64,${videoBase64}`, 'clip.mp4');

        expect(lastLink().download).toBe('clip.mp4');
        expect(lastDownloadedBlob().type).toBe('video/mp4');
    });

    it('未给文件名时按 MIME 生成', async () => {
        await downloadMedia('data:video/webm;base64,AAAA');
        expect(lastLink().download).toMatch(/^media-\d+\.webm$/);
    });

    it('页面登记过的 blob: URL 取回原始 Blob 下载', async () => {
        const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
        const original = new Blob([pngBytes], { type: 'image/png' });
        URL.createObjectURL = vi.fn(() => 'blob:tracked-image');
        const trackedUrl = createTrackedObjectUrl(original);
        URL.createObjectURL = vi.fn(() => 'blob:download');

        try {
            await downloadMedia(trackedUrl, 'image-1.png');

            expect(lastDownloadedBlob()).toBe(original);
            expect(lastLink().href).toBe('blob:download');
            expect(lastLink().target).toBe('');
        } finally {
            revokeTrackedObjectUrl(trackedUrl);
        }
    });

    it('http(s) 与未登记的 blob: URL 用新窗口链接下载，不让页面跳走', async () => {
        const result = await downloadMedia('https://example.com/a.png', 'a.png');

        expect(result).toEqual({ savedTo: null });
        expect(lastLink().href).toBe('https://example.com/a.png');
        expect(lastLink().target).toBe('_blank');
        expect(lastLink().rel).toBe('noopener noreferrer');
        expect(lastLink().download).toBe('a.png');

        await downloadMedia('blob:http://localhost/unknown', 'b.png');
        expect(lastLink().href).toBe('blob:http://localhost/unknown');
        expect(lastLink().target).toBe('_blank');
        expect(URL.createObjectURL).not.toHaveBeenCalled();
    });

    it('空 URL 走错误路径', async () => {
        const openSpy = vi.spyOn(window, 'open').mockImplementation(() => {});
        expect(await downloadMedia('')).toBeNull();
        expect(openSpy).toHaveBeenCalled();
        openSpy.mockRestore();
    });

    it('null URL 走错误路径', async () => {
        const openSpy = vi.spyOn(window, 'open').mockImplementation(() => {});
        expect(await downloadMedia(null)).toBeNull();
        expect(openSpy).toHaveBeenCalled();
        openSpy.mockRestore();
    });

    it('Android 写入本地目录后提示保存位置', async () => {
        isAndroid.mockReturnValue(true);
        installAndroidFilesystem(
            vi.fn(async ({ path }) => ({ uri: `file:///storage/emulated/0/Documents/${path}` }))
        );

        const result = await downloadMedia('data:image/png;base64,iVBORw0KGgo=', 'image-1.png');

        expect(result).toEqual({ savedTo: 'Documents/WebChat/image-1.png' });
        expect(emitSpy).toHaveBeenCalledWith('ui:notification', {
            message: '已保存到 Documents/WebChat/image-1.png',
            type: 'success'
        });
        expect(clickSpy).not.toHaveBeenCalled();
    });

    it('Android 保存失败时提示错误，不打开新窗口', async () => {
        isAndroid.mockReturnValue(true);
        installAndroidFilesystem(
            vi.fn(async () => {
                throw new Error('disk full');
            })
        );
        const openSpy = vi.spyOn(window, 'open').mockImplementation(() => {});

        try {
            const result = await downloadMedia('data:image/png;base64,iVBORw0KGgo=', 'a.png');

            expect(result).toBeNull();
            expect(openSpy).not.toHaveBeenCalled();
            expect(emitSpy).toHaveBeenCalledWith('ui:notification', {
                message: '下载失败：disk full',
                type: 'error'
            });
        } finally {
            openSpy.mockRestore();
        }
    });
});
