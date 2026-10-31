/**
 * 文件下载：Web / Electron 用临时链接交给浏览器下载，
 * Android WebView 不处理 a[download]，改为写入本地目录并返回保存位置
 */

import { isAndroid } from './platform.js';
import { logger } from './logger.js';

// 没有下载完成事件，点击只是把下载排进队列，立即释放会让 Safari / Firefox 取消下载
const OBJECT_URL_REVOKE_DELAY_MS = 40_000;
const ANDROID_DOWNLOAD_FOLDER = 'WebChat';
// 分块经原生桥写入，整份 base64 一次传过去会让大文件撑爆 WebView 内存
const ANDROID_WRITE_CHUNK_BYTES = 3 * 1024 * 1024;
const ANDROID_MAX_NAME_ATTEMPTS = 50;
// 公共 Documents 用户找得到；Android 10 与拒绝授权的 Android 9 及以下写不进去时退到应用专属目录
const ANDROID_SAVE_DIRECTORIES = ['DOCUMENTS', 'EXTERNAL'];
const ANDROID_STORAGE_ROOT = '/storage/emulated/0/';
const UNSAFE_FILE_NAME_CHARS = /[\\/:*?"<>|]/g;
const FIRST_PRINTABLE_CHAR_CODE = 0x20;

/**
 * @typedef {Object} DownloadResult
 * @property {string|null} savedTo - Android 上文件的保存位置；浏览器下载由浏览器自己展示，为 null
 */

/**
 * 下载 Blob
 * @param {Blob} blob - 文件内容
 * @param {string} [filename] - 文件名，缺省按时间戳生成
 * @returns {Promise<DownloadResult>} Android 写入失败时 reject
 */
export async function downloadBlob(blob, filename) {
    const name = filename || `download-${Date.now()}`;
    const filesystem = isAndroid() ? getCapacitorFilesystem() : null;
    if (filesystem) return saveBlobOnAndroid(filesystem, blob, name);
    triggerBrowserDownload(blob, name);
    return { savedTo: null };
}

/**
 * 把数据格式化为 JSON 文件下载
 * @param {Object} data - 要导出的数据
 * @param {string} filename - 文件名
 * @returns {Promise<DownloadResult>}
 */
export function downloadJSON(data, filename) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    return downloadBlob(blob, filename);
}

/**
 * 成功提示附上保存位置；浏览器下载没有位置可说，原样返回
 * @param {string} message
 * @param {DownloadResult|null} result
 * @returns {string}
 */
export function describeSavedLocation(message, result) {
    return result?.savedTo ? `${message}（已保存到 ${result.savedTo}）` : message;
}

function getCapacitorFilesystem() {
    return window?.Capacitor?.Plugins?.Filesystem || null;
}

function triggerBrowserDownload(blob, filename) {
    const blobUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = blobUrl;
    link.download = filename;
    // 旧版 Firefox 只认挂在文档上的链接点击
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(blobUrl), OBJECT_URL_REVOKE_DELAY_MS);
}

async function saveBlobOnAndroid(filesystem, blob, filename) {
    await requestLegacyStorageAccess(filesystem);
    const fileName = sanitizeFileName(filename);
    let lastError = null;
    for (const directory of ANDROID_SAVE_DIRECTORIES) {
        try {
            const uri = await writeToDirectory(filesystem, directory, fileName, blob);
            return { savedTo: describeAndroidLocation(uri, directory) };
        } catch (error) {
            lastError = error;
            logger.warn(`[Download] 写入 ${directory} 失败:`, error);
        }
    }
    throw lastError || new Error('文件保存失败');
}

// Android 9 及以下写公共目录要运行时授权；更高版本插件直接报告已授权
async function requestLegacyStorageAccess(filesystem) {
    try {
        const status = await filesystem.checkPermissions?.();
        if (status?.publicStorage === 'granted') return;
        await filesystem.requestPermissions?.();
    } catch (error) {
        logger.debug('[Download] 存储权限检查失败，按未授权继续:', error);
    }
}

// 路径分隔符会把文件写出下载目录（主题名由用户填写），控制字符与保留字符在 Android 上同样非法
function sanitizeFileName(filename) {
    const cleaned = Array.from(String(filename), (char) =>
        char.charCodeAt(0) < FIRST_PRINTABLE_CHAR_CODE ? '_' : char
    )
        .join('')
        .replace(UNSAFE_FILE_NAME_CHARS, '_')
        .trim();
    return cleaned && !/^\.+$/.test(cleaned) ? cleaned : `download-${Date.now()}`;
}

function splitFileName(fileName) {
    const dotIndex = fileName.lastIndexOf('.');
    return dotIndex > 0
        ? { base: fileName.slice(0, dotIndex), ext: fileName.slice(dotIndex) }
        : { base: fileName, ext: '' };
}

/**
 * 同名文件已存在时另起名字；Android 11 起看不到旧安装创建的同名文件，写入失败时再换一次带时间戳的名字
 */
async function writeToDirectory(filesystem, directory, fileName, blob) {
    const { base, ext } = splitFileName(fileName);
    const paths = [
        await findAvailablePath(filesystem, directory, base, ext),
        `${ANDROID_DOWNLOAD_FOLDER}/${base}-${Date.now()}${ext}`
    ];
    let lastError = null;
    for (const path of paths) {
        try {
            return await writeBlobInChunks(filesystem, directory, path, blob);
        } catch (error) {
            lastError = error;
            await filesystem.deleteFile({ path, directory }).catch(() => {});
        }
    }
    throw lastError;
}

async function findAvailablePath(filesystem, directory, base, ext) {
    for (let attempt = 0; attempt < ANDROID_MAX_NAME_ATTEMPTS; attempt += 1) {
        const name = attempt === 0 ? `${base}${ext}` : `${base} (${attempt})${ext}`;
        const path = `${ANDROID_DOWNLOAD_FOLDER}/${name}`;
        if (!(await pathExists(filesystem, directory, path))) return path;
    }
    return `${ANDROID_DOWNLOAD_FOLDER}/${base}-${Date.now()}${ext}`;
}

async function pathExists(filesystem, directory, path) {
    try {
        await filesystem.stat({ path, directory });
        return true;
    } catch {
        return false;
    }
}

async function writeBlobInChunks(filesystem, directory, path, blob) {
    let uri = '';
    let offset = 0;
    do {
        const data = await blobToBase64(blob.slice(offset, offset + ANDROID_WRITE_CHUNK_BYTES));
        if (offset === 0) {
            const result = await filesystem.writeFile({ path, directory, data, recursive: true });
            uri = result?.uri || '';
        } else {
            await filesystem.appendFile({ path, directory, data });
        }
        offset += ANDROID_WRITE_CHUNK_BYTES;
    } while (offset < blob.size);
    return uri || `${directory}/${path}`;
}

function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
        reader.onerror = () => reject(reader.error || new Error('读取文件内容失败'));
        reader.readAsDataURL(blob);
    });
}

function describeAndroidLocation(uri, directory) {
    const path = decodeURIComponent(String(uri).replace(/^file:\/\//, ''));
    if (path.startsWith(ANDROID_STORAGE_ROOT)) return path.slice(ANDROID_STORAGE_ROOT.length);
    return path || directory;
}
