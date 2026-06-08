/**
 * video-persistence.js 视频持久化测试
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../js/utils/platform.js', () => ({
    isElectron: vi.fn(() => false),
    isAndroid: vi.fn(() => false),
    getIpcRenderer: vi.fn(() => null)
}));

vi.mock('../../js/utils/logger.js', () => ({
    logger: { warn: vi.fn(), debug: vi.fn(), error: vi.fn(), info: vi.fn() }
}));

import { isElectron, isAndroid, getIpcRenderer } from '../../js/utils/platform.js';
import {
    replaceVideoDataUrlsDeep,
    VIDEO_DATA_URL_PATTERN,
    isElectronIpcAvailable,
    isAndroidFilesystemAvailable
} from '../../js/state/video-persistence.js';

describe('video-persistence', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    // ========== VIDEO_DATA_URL_PATTERN ==========
    describe('VIDEO_DATA_URL_PATTERN', () => {
        it('匹配 video/mp4', () => {
            expect(VIDEO_DATA_URL_PATTERN.test('data:video/mp4;base64,abc')).toBe(true);
        });

        it('匹配 video/webm', () => {
            expect(VIDEO_DATA_URL_PATTERN.test('data:video/webm;base64,def')).toBe(true);
        });

        it('不匹配 image', () => {
            expect(VIDEO_DATA_URL_PATTERN.test('data:image/png;base64,abc')).toBe(false);
        });

        it('不匹配普通字符串', () => {
            expect(VIDEO_DATA_URL_PATTERN.test('hello world')).toBe(false);
        });
    });

    // ========== isElectronIpcAvailable ==========
    describe('isElectronIpcAvailable', () => {
        it('非 Electron 返回 false', () => {
            isElectron.mockReturnValue(false);
            expect(isElectronIpcAvailable()).toBe(false);
        });

        it('Electron 无 ipcRenderer 返回 false', () => {
            isElectron.mockReturnValue(true);
            getIpcRenderer.mockReturnValue(null);
            expect(isElectronIpcAvailable()).toBe(false);
        });

        it('Electron 有 ipcRenderer.invoke 返回 true', () => {
            isElectron.mockReturnValue(true);
            getIpcRenderer.mockReturnValue({ invoke: vi.fn() });
            expect(isElectronIpcAvailable()).toBe(true);
        });
    });

    // ========== isAndroidFilesystemAvailable ==========
    describe('isAndroidFilesystemAvailable', () => {
        it('非 Android 返回 false', () => {
            isAndroid.mockReturnValue(false);
            expect(isAndroidFilesystemAvailable()).toBe(false);
        });

        it('Android 无 Capacitor 返回 false', () => {
            isAndroid.mockReturnValue(true);
            expect(isAndroidFilesystemAvailable()).toBe(false);
        });
    });

    // ========== replaceVideoDataUrlsDeep ==========
    describe('replaceVideoDataUrlsDeep', () => {
        it('非视频字符串直接返回', async () => {
            const cache = new Map();
            const result = await replaceVideoDataUrlsDeep('hello', cache);
            expect(result).toBe('hello');
        });

        it('null 直接返回', async () => {
            const cache = new Map();
            const result = await replaceVideoDataUrlsDeep(null, cache);
            expect(result).toBeNull();
        });

        it('数字直接返回', async () => {
            const cache = new Map();
            const result = await replaceVideoDataUrlsDeep(42, cache);
            expect(result).toBe(42);
        });

        it('数组递归处理', async () => {
            const cache = new Map();
            const result = await replaceVideoDataUrlsDeep(['hello', 'world'], cache);
            expect(result).toEqual(['hello', 'world']);
        });

        it('对象递归处理', async () => {
            const cache = new Map();
            const result = await replaceVideoDataUrlsDeep({ a: 'hello', b: 123 }, cache);
            expect(result).toEqual({ a: 'hello', b: 123 });
        });

        it('跳过 inlineData 键', async () => {
            const cache = new Map();
            const obj = { inlineData: 'data:video/mp4;base64,abc', other: 'hello' };
            const result = await replaceVideoDataUrlsDeep(obj, cache);
            expect(result.inlineData).toBe('data:video/mp4;base64,abc');
        });

        it('跳过 inline_data 键', async () => {
            const cache = new Map();
            const obj = { inline_data: 'data:video/mp4;base64,abc' };
            const result = await replaceVideoDataUrlsDeep(obj, cache);
            expect(result.inline_data).toBe('data:video/mp4;base64,abc');
        });

        it('非 Electron/Android 环境缓存并返回原始 URL', async () => {
            isElectron.mockReturnValue(false);
            isAndroid.mockReturnValue(false);
            const cache = new Map();
            const dataUrl = 'data:video/mp4;base64,AAAA';
            const result = await replaceVideoDataUrlsDeep(dataUrl, cache);
            // 非平台环境下，persistVideoDataUrl 最终缓存 dataUrl -> dataUrl
            expect(result).toBe(dataUrl);
            expect(cache.has(dataUrl)).toBe(true);
        });

        it('缓存命中直接返回', async () => {
            const cache = new Map();
            const dataUrl = 'data:video/mp4;base64,AAAA';
            cache.set(dataUrl, 'file:///cached.mp4');
            const result = await replaceVideoDataUrlsDeep(dataUrl, cache);
            expect(result).toBe('file:///cached.mp4');
        });

        it('深层嵌套处理', async () => {
            const cache = new Map();
            const obj = {
                messages: [{ content: 'hello' }, { nested: { url: 'not-video' } }]
            };
            const result = await replaceVideoDataUrlsDeep(obj, cache);
            expect(result.messages[0].content).toBe('hello');
            expect(result.messages[1].nested.url).toBe('not-video');
        });
    });
});
