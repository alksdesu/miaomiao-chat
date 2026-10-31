/**
 * 页面展示用 blob: URL 的创建与释放，同时记住 URL 对应的原始 Blob：
 * CSP 的 connect-src 不放行 blob:，下载时无法 fetch，只能从这里拿回数据
 */

const blobsByUrl = new Map();

/**
 * @param {Blob} blob
 * @returns {string} blob: URL
 */
export function createTrackedObjectUrl(blob) {
    const url = URL.createObjectURL(blob);
    blobsByUrl.set(url, blob);
    return url;
}

/**
 * @param {string} url - createTrackedObjectUrl 返回的 URL
 */
export function revokeTrackedObjectUrl(url) {
    blobsByUrl.delete(url);
    URL.revokeObjectURL(url);
}

/**
 * @param {string} url
 * @returns {Blob|null} 未登记或已释放时为 null
 */
export function findTrackedBlob(url) {
    return blobsByUrl.get(url) || null;
}
