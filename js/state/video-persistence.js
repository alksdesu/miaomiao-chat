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

// IPC hang 兜底超时（30s），防止主进程死锁让上层 persist 永挂
const VIDEO_IPC_TIMEOUT_MS = 30000;

// 短期失败 TTL：避免高频重试时同一 dataUrl 每次都触发 IPC；30 秒后允许重试
const VIDEO_PERSIST_FAILURE_TTL_MS = 30000;
const failurePersistTimestamps = new Map();
function shouldSkipDueToRecentFailure(dataUrl) {
    const ts = failurePersistTimestamps.get(dataUrl);
    if (!ts) return false;
    if (performance.now() - ts < VIDEO_PERSIST_FAILURE_TTL_MS) return true;
    failurePersistTimestamps.delete(dataUrl);
    return false;
}
function markRecentFailure(dataUrl) {
    failurePersistTimestamps.set(dataUrl, performance.now());
    // 防止 failure map 无限增长（大量失败的极端场景）
    if (failurePersistTimestamps.size > 1000) {
        const oldest = failurePersistTimestamps.keys().next().value;
        if (oldest !== undefined) failurePersistTimestamps.delete(oldest);
    }
}

async function withIpcTimeout(promise, label) {
    return Promise.race([
        promise,
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`${label} IPC 超时`)), VIDEO_IPC_TIMEOUT_MS)
        )
    ]);
}

async function persistVideoDataUrl(dataUrl, cache) {
    if (!VIDEO_DATA_URL_PATTERN.test(dataUrl)) return dataUrl;

    if (cache.has(dataUrl)) {
        return cache.get(dataUrl);
    }

    // 失败后 30s 内不重试，直接返回原 dataUrl（不污染 cache）
    if (shouldSkipDueToRecentFailure(dataUrl)) {
        return dataUrl;
    }

    const mimeMatch = dataUrl.match(/^data:(video\/[^;]+);base64,/i);
    const mimeType = (mimeMatch?.[1] || '').toLowerCase();

    if (isElectronIpcAvailable()) {
        try {
            const result = await withIpcTimeout(
                window.electron.ipcRenderer.invoke('mcp:store-video', {
                    dataUrl,
                    mimeType
                }),
                'Electron 视频持久化'
            );

            if (result?.success && result.fileUrl) {
                cache.set(dataUrl, result.fileUrl);
                return result.fileUrl;
            }
            // IPC 返回但无 fileUrl 也视为失败
            markRecentFailure(dataUrl);
        } catch (error) {
            logger.error('[Session] Electron 视频持久化失败:', error);
            markRecentFailure(dataUrl);
        }
    }

    if (isAndroidFilesystemAvailable()) {
        try {
            const androidUrl = await withIpcTimeout(
                persistVideoDataUrlOnAndroid(dataUrl, cache),
                'Android 视频持久化'
            );
            if (androidUrl !== dataUrl) {
                return androidUrl;
            }
            markRecentFailure(dataUrl);
        } catch (error) {
            logger.error('[Session] Android 视频持久化失败:', error);
            markRecentFailure(dataUrl);
        }
    }

    // 关键修复：失败不写 cache，避免下次 saveCurrentSessionMessages 把 base64 直接写入 IDB 触发 quota
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
