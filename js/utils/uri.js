/**
 * URI 协议白名单与安全 href 工具
 * 与 DOMPurify ALLOWED_URI_REGEXP 共享同一份正则，保证 sanitize 与运行时校验一致
 */

// 协议白名单：放行 http(s)/ftp(s)/mailto/tel/callto/相对路径，挡 javascript:/vbscript:/data:text 等危险协议
export const ALLOWED_URI_REGEXP = /^(?:(?:f|ht)tps?|mailto|tel|callto):|^[#./?]|^[^a-z]/i;

// javascript:/vbscript:/data:text/html 黑名单兜底，防 ALLOWED_URI_REGEXP 边界绕过
const DANGEROUS_PROTOCOL = /^\s*(?:javascript|vbscript|data\s*:\s*text\/html)/i;

/**
 * 判断 URL 是否安全可作为 href
 * @param {string} url - 原始 URL 字符串
 * @returns {boolean} 是否安全
 */
export function isSafeHref(url) {
    if (typeof url !== 'string') return false;
    const trimmed = url.trim();
    if (!trimmed) return false;
    if (DANGEROUS_PROTOCOL.test(trimmed)) return false;
    return ALLOWED_URI_REGEXP.test(trimmed);
}

/**
 * 返回安全的 href；不安全时回退到指定值（默认 '#'）
 * @param {string} url - 原始 URL 字符串
 * @param {string} [fallback='#'] - 不安全时的回退值
 * @returns {string} 安全的 href
 */
export function safeHref(url, fallback = '#') {
    return isSafeHref(url) ? url : fallback;
}
