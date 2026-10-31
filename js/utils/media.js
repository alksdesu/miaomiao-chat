import { logger } from './logger.js';
import { eventBus } from '../core/events.js';
import { EVENTS } from '../core/events-registry.js';
import { detectImageFormat } from './helpers.js';
import { isAndroid } from './platform.js';
import { downloadBlob } from './download.js';
import { findTrackedBlob } from './object-urls.js';

/**
 * 媒体工具函数
 * 统一处理图片/视频类型判断与下载逻辑
 */

/**
 * 常见视频 MIME 类型与扩展名映射
 */
const VIDEO_MIME_TO_EXT = {
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'video/ogg': 'ogv',
    'video/quicktime': 'mov',
    'video/x-matroska': 'mkv',
    'video/x-msvideo': 'avi',
    'video/mpeg': 'mpeg'
};

/**
 * 常见图片 MIME 类型与扩展名映射
 */
const IMAGE_MIME_TO_EXT = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/bmp': 'bmp',
    'image/svg+xml': 'svg'
};

/**
 * 判断是否为 Data URL
 * @param {string} url - URL
 * @returns {boolean}
 */
export function isDataUrl(url) {
    return typeof url === 'string' && url.startsWith('data:');
}

/**
 * 提取 Data URL 的 MIME 类型
 * @param {string} dataUrl - Data URL
 * @returns {string}
 */
export function extractDataUrlMimeType(dataUrl) {
    if (!isDataUrl(dataUrl)) return '';

    const match = dataUrl.match(/^data:([^;,]+)[;,]/i);
    return (match?.[1] || '').toLowerCase();
}

/**
 * 判断是否为视频 MIME 类型
 * @param {string} mimeType - MIME 类型
 * @returns {boolean}
 */
export function isVideoMimeType(mimeType) {
    return typeof mimeType === 'string' && mimeType.toLowerCase().startsWith('video/');
}

/**
 * 判断是否为图片 MIME 类型
 * @param {string} mimeType - MIME 类型
 * @returns {boolean}
 */
export function isImageMimeType(mimeType) {
    return typeof mimeType === 'string' && mimeType.toLowerCase().startsWith('image/');
}

/**
 * 判断是否为音频 MIME 类型
 * @param {string} mimeType - MIME 类型
 * @returns {boolean}
 */
export function isAudioMimeType(mimeType) {
    return typeof mimeType === 'string' && mimeType.toLowerCase().startsWith('audio/');
}

/**
 * 判断 Data URL 是否为视频
 * @param {string} dataUrl - Data URL
 * @returns {boolean}
 */
export function isVideoDataUrl(dataUrl) {
    return isVideoMimeType(extractDataUrlMimeType(dataUrl));
}

/**
 * 获取 URL 的扩展名（忽略 query/hash）
 * @param {string} url - URL
 * @returns {string}
 */
function getExtensionFromUrl(url) {
    if (!url || typeof url !== 'string') return '';

    try {
        const parsed = new URL(url, window.location.href);
        const pathname = parsed.pathname || '';
        const dotIndex = pathname.lastIndexOf('.');
        if (dotIndex === -1) return '';
        return pathname.slice(dotIndex + 1).toLowerCase();
    } catch {
        // 非标准 URL（如裸路径）
        const sanitized = url.split('?')[0].split('#')[0];
        const dotIndex = sanitized.lastIndexOf('.');
        if (dotIndex === -1) return '';
        return sanitized.slice(dotIndex + 1).toLowerCase();
    }
}

/**
 * 判断是否为 Capacitor 本地文件映射 URL
 * @param {string} url - URL
 * @returns {boolean}
 */
function isCapacitorLocalMediaUrl(url) {
    if (!url || typeof url !== 'string') return false;
    return url.includes('/_capacitor_file_/');
}

/**
 * 根据 MIME 类型获取扩展名
 * @param {string} mimeType - MIME 类型
 * @param {string} fallback - 兜底扩展名
 * @returns {string}
 */
export function getExtensionFromMimeType(mimeType, fallback = 'bin') {
    if (!mimeType || typeof mimeType !== 'string') return fallback;

    const normalized = mimeType.toLowerCase();
    if (VIDEO_MIME_TO_EXT[normalized]) return VIDEO_MIME_TO_EXT[normalized];
    if (IMAGE_MIME_TO_EXT[normalized]) return IMAGE_MIME_TO_EXT[normalized];

    const simple = normalized.split('/')[1] || '';
    if (!simple) return fallback;

    // 统一 jpeg 扩展名
    if (simple === 'jpeg') return 'jpg';
    return simple;
}

/**
 * 根据 URL/MIME 推断扩展名
 * @param {string} url - 媒体 URL
 * @param {string} mimeType - MIME 类型（可选）
 * @param {string} fallback - 兜底扩展名
 * @returns {string}
 */
export function getMediaExtension(url, mimeType = '', fallback = 'bin') {
    if (mimeType) {
        return getExtensionFromMimeType(mimeType, fallback);
    }

    if (isDataUrl(url)) {
        return getExtensionFromMimeType(extractDataUrlMimeType(url), fallback);
    }

    const ext = getExtensionFromUrl(url);
    return ext || fallback;
}

/**
 * 判断 URL 是否应按视频处理
 * @param {string} url - 媒体 URL
 * @param {string} mimeType - MIME 类型提示
 * @returns {boolean}
 */
export function isVideoUrl(url, mimeType = '') {
    if (isVideoMimeType(mimeType)) return true;

    if (isDataUrl(url)) {
        return isVideoDataUrl(url);
    }

    const ext = getExtensionFromUrl(url);
    return ['mp4', 'webm', 'ogv', 'mov', 'mkv', 'avi', 'mpeg', 'mpg', 'm4v'].includes(ext);
}

/**
 * 将 base64 转换为 Blob
 * @param {string} base64Data - base64 数据
 * @param {string} mimeType - MIME 类型
 * @returns {Blob}
 */
function base64ToBlob(base64Data, mimeType) {
    const binaryString = atob(base64Data);
    const bytes = new Uint8Array(binaryString.length);

    for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }

    return new Blob([bytes], { type: mimeType || 'application/octet-stream' });
}

// 覆盖 PNG / JPEG / GIF / WebP 的文件头魔数
const IMAGE_SIGNATURE_BYTES = 16;

function defaultMediaName(mimeType) {
    return `media-${Date.now()}.${getExtensionFromMimeType(mimeType, 'bin')}`;
}

/**
 * 把媒体 URL 读成 Blob；读不了的（http(s)、未登记的 blob: 等）返回 null，交给链接下载
 * @param {string} mediaUrl
 * @returns {Promise<{blob: Blob, defaultName: string}|null>}
 */
async function readMediaBlob(mediaUrl) {
    if (isDataUrl(mediaUrl)) {
        const mimeType = extractDataUrlMimeType(mediaUrl) || 'application/octet-stream';
        const blob = base64ToBlob(mediaUrl.split(',')[1] || '', mimeType);
        return { blob, defaultName: defaultMediaName(mimeType) };
    }

    if (mediaUrl.startsWith('blob:')) {
        const blob = findTrackedBlob(mediaUrl);
        return blob ? { blob, defaultName: defaultMediaName(blob.type) } : null;
    }

    // file:// URL：Electron 下通过主进程读取，保证下载可靠
    if (mediaUrl.startsWith('file://') && window.electron?.ipcRenderer) {
        const readResult = await window.electron.ipcRenderer.invoke('mcp:read-media-file', {
            fileUrl: mediaUrl
        });
        if (!readResult?.success || !readResult.base64) return null;
        const mimeType = readResult.mimeType || 'application/octet-stream';
        return {
            blob: base64ToBlob(readResult.base64, mimeType),
            defaultName: readResult.fileName || defaultMediaName(mimeType)
        };
    }

    // Capacitor 本地文件 URL（Android）
    if (isCapacitorLocalMediaUrl(mediaUrl)) {
        const response = await fetch(mediaUrl);
        if (!response.ok) {
            throw new Error(`读取本地媒体失败: ${response.status}`);
        }
        const blob = await response.blob();
        return {
            blob,
            defaultName: `media-${Date.now()}.${getMediaExtension(mediaUrl, blob.type, 'bin')}`
        };
    }

    return null;
}

/**
 * 图片按文件头识别真实格式并修正扩展名：声明的 MIME 与文件名常与内容不符；识别不出的格式（如 SVG）原样保留
 */
async function withDetectedImageFormat(blob, filename) {
    if (blob.type && blob.type !== 'application/octet-stream' && !isImageMimeType(blob.type)) {
        return { blob, filename };
    }
    const header = new Uint8Array(await blob.slice(0, IMAGE_SIGNATURE_BYTES).arrayBuffer());
    const detected = detectImageFormat(header, { fallback: null });
    if (!detected) return { blob, filename };
    return {
        blob: blob.type === detected.mime ? blob : new Blob([blob], { type: detected.mime }),
        filename: `${filename.replace(/\.[^.]+$/, '')}.${detected.ext}`
    };
}

function openLinkDownload(mediaUrl, filename) {
    const link = document.createElement('a');
    link.href = mediaUrl;
    if (filename) {
        link.download = filename;
    }
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    document.body.appendChild(link);
    link.click();
    link.remove();
}

/**
 * 下载媒体（图片/视频/音频）：能读成 Blob 的来源统一走 downloadBlob（Android 写入本地目录），
 * http(s) 等其余 URL 用新窗口链接下载
 * @param {string} mediaUrl - 媒体 URL
 * @param {string} [filename] - 建议文件名
 * @returns {Promise<import('./download.js').DownloadResult|null>} 失败时为 null
 */
export async function downloadMedia(mediaUrl, filename = '') {
    try {
        if (!mediaUrl || typeof mediaUrl !== 'string') {
            throw new Error('无效的媒体 URL');
        }
        const source = await readMediaBlob(mediaUrl);
        if (!source) {
            openLinkDownload(mediaUrl, filename);
            return { savedTo: null };
        }
        const prepared = await withDetectedImageFormat(source.blob, filename || source.defaultName);
        const result = await downloadBlob(prepared.blob, prepared.filename);
        if (result.savedTo) {
            eventBus.emit(EVENTS.UI_NOTIFICATION, {
                message: `已保存到 ${result.savedTo}`,
                type: 'success'
            });
        }
        return result;
    } catch (error) {
        logger.error('[Media] 下载失败:', error);
        // Android WebView 打不开 data: / blob: 新窗口，只能如实提示
        if (isAndroid()) {
            eventBus.emit(EVENTS.UI_NOTIFICATION, {
                message: `下载失败：${error?.message || error}`,
                type: 'error'
            });
        } else {
            try {
                window.open(mediaUrl, '_blank');
            } catch {
                // 弹窗被拦截时没有更多退路，错误已记录
            }
        }
        return null;
    }
}
