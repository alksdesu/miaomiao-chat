/**
 * 视频 Data URL 持久化
 * 处理 Electron 和 Android 平台的视频落盘
 */

import { isElectron, isAndroid, getIpcRenderer } from '../utils/platform.js';
import { logger } from '../utils/logger.js';

const VIDEO_DATA_URL_PATTERN = /^data:(video\/[^;]+);base64,/i;

const VIDEO_MIME_TO_EXTENSION = {
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'video/ogg': 'ogv',
    'video/quicktime': 'mov',
    'video/x-matroska': 'mkv',
    'video/x-msvideo': 'avi',
    'video/mpeg': 'mpeg'
};

const ANDROID_VIDEO_DIRECTORY = 'DATA';
const ANDROID_VIDEO_FOLDER = 'message-videos';

function isElectronIpcAvailable() {
    return isElectron() && !!getIpcRenderer()?.invoke;
}

function getCapacitorFilesystem() {
    return window?.Capacitor?.Plugins?.Filesystem || null;
}

function isAndroidFilesystemAvailable() {
    return isAndroid() && !!getCapacitorFilesystem();
}

function getVideoExtensionByMimeType(mimeType) {
    if (!mimeType || typeof mimeType !== 'string') return 'mp4';
    return VIDEO_MIME_TO_EXTENSION[mimeType.toLowerCase()] || 'mp4';
}

async function ensureAndroidVideoFolder(filesystem) {
    try {
        await filesystem.mkdir({
            path: ANDROID_VIDEO_FOLDER,
            directory: ANDROID_VIDEO_DIRECTORY,
            recursive: true
        });
    } catch (error) {
        const errorMessage = String(error?.message || '');
        if (/exist|already/i.test(errorMessage)) {
            return;
        }
        throw error;
    }
}

async function persistVideoDataUrlOnAndroid(dataUrl, cache) {
    const matched = dataUrl.match(VIDEO_DATA_URL_PATTERN);
    if (!matched) return dataUrl;

    const filesystem = getCapacitorFilesystem();
    if (!filesystem) return dataUrl;

    const mimeType = matched[1]?.toLowerCase() || 'video/mp4';
    const base64 = dataUrl.slice(matched[0].length);

    await ensureAndroidVideoFolder(filesystem);

    const extension = getVideoExtensionByMimeType(mimeType);
    const fileName = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${extension}`;
    const filePath = `${ANDROID_VIDEO_FOLDER}/${fileName}`;

    const writeResult = await filesystem.writeFile({
        path: filePath,
        data: base64,
        directory: ANDROID_VIDEO_DIRECTORY,
        recursive: true
    });

    let playableUrl = writeResult?.uri || '';
    if (window.Capacitor?.convertFileSrc && playableUrl) {
        playableUrl = window.Capacitor.convertFileSrc(playableUrl);
    }

    if (playableUrl) {
        cache.set(dataUrl, playableUrl);
        return playableUrl;
    }

    return dataUrl;
}

async function persistVideoDataUrl(dataUrl, cache) {
    if (!VIDEO_DATA_URL_PATTERN.test(dataUrl)) return dataUrl;

    if (cache.has(dataUrl)) {
        return cache.get(dataUrl);
    }

    const mimeMatch = dataUrl.match(/^data:(video\/[^;]+);base64,/i);
    const mimeType = (mimeMatch?.[1] || '').toLowerCase();

    if (isElectronIpcAvailable()) {
        try {
            const result = await window.electron.ipcRenderer.invoke('mcp:store-video', {
                dataUrl,
                mimeType
            });

            if (result?.success && result.fileUrl) {
                cache.set(dataUrl, result.fileUrl);
                return result.fileUrl;
            }
        } catch (error) {
            logger.error('[Session] Electron 视频持久化失败:', error);
        }
    }

    if (isAndroidFilesystemAvailable()) {
        try {
            const androidUrl = await persistVideoDataUrlOnAndroid(dataUrl, cache);
            if (androidUrl !== dataUrl) {
                return androidUrl;
            }
        } catch (error) {
            logger.error('[Session] Android 视频持久化失败:', error);
        }
    }

    cache.set(dataUrl, dataUrl);
    return dataUrl;
}

/**
 * 递归替换对象中所有视频 data URL 为持久化 URL
 */
export async function replaceVideoDataUrlsDeep(value, cache) {
    if (typeof value === 'string') {
        if (!VIDEO_DATA_URL_PATTERN.test(value)) return value;
        return await persistVideoDataUrl(value, cache);
    }

    if (Array.isArray(value)) {
        for (let index = 0; index < value.length; index++) {
            value[index] = await replaceVideoDataUrlsDeep(value[index], cache);
        }
        return value;
    }

    if (!value || typeof value !== 'object') {
        return value;
    }

    for (const [key, nestedValue] of Object.entries(value)) {
        // 保持原始 inlineData（主要用于 Gemini 历史兼容）
        if (key === 'inlineData' || key === 'inline_data') continue;
        value[key] = await replaceVideoDataUrlsDeep(nestedValue, cache);
    }
    return value;
}

export { VIDEO_DATA_URL_PATTERN, isElectronIpcAvailable, isAndroidFilesystemAvailable };
