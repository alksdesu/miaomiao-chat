/**
 * 媒体卡片渲染函数（图片/视频/音频）
 * 统一 renderer.js / stream/helpers.js / reply-selector.js 三处重复实现
 */

import { getMediaExtension } from '../utils/media.js';
import { escapeHtml } from '../utils/helpers.js';

export function renderDownloadIcon() {
    return `
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/>
        </svg>
    `;
}

function encodeInlineUrl(url) {
    return encodeURIComponent(url || '');
}

/**
 * 渲染图片卡片
 * @param {string} url - 图片 URL
 * @returns {string}
 */
export function renderImageCard(url) {
    const encodedUrl = encodeInlineUrl(url);
    const safeUrl = escapeHtml(url);
    const ext = getMediaExtension(url, '', 'png');

    return `<div class="image-wrapper">
        <img src="${safeUrl}" alt="Generated image" title="点击查看大图" onclick="openImageViewer(decodeURIComponent('${encodedUrl}'))" style="cursor:pointer;">
        <button type="button" class="download-image-btn" onclick="event.stopPropagation();downloadImage(decodeURIComponent('${encodedUrl}'), 'image-${Date.now()}.${ext}')" title="下载原图">
            ${renderDownloadIcon()}
        </button>
    </div>`;
}

/**
 * 渲染视频卡片
 * @param {string} url - 视频 URL
 * @param {string} mimeType - MIME 类型（可选）
 * @returns {string}
 */
export function renderVideoCard(url, mimeType = '') {
    const encodedUrl = encodeInlineUrl(url);
    const safeUrl = escapeHtml(url);
    const ext = getMediaExtension(url, mimeType, 'mp4');

    return `<div class="image-wrapper video-wrapper">
        <video src="${safeUrl}" controls playsinline muted preload="metadata" title="AI 生成视频"></video>
        <button type="button" class="download-image-btn" onclick="event.stopPropagation();downloadMedia(decodeURIComponent('${encodedUrl}'), 'video-${Date.now()}.${ext}')" title="下载视频">
            ${renderDownloadIcon()}
        </button>
    </div>`;
}

/**
 * 渲染音频卡片
 * @param {string} url - 音频 URL
 * @param {string} mimeType - MIME 类型（可选）
 * @returns {string}
 */
export function renderAudioCard(url, mimeType = '') {
    const encodedUrl = encodeInlineUrl(url);
    const safeUrl = escapeHtml(url);
    const ext = getMediaExtension(url, mimeType, 'mp3');

    return `<div class="audio-wrapper">
        <audio src="${safeUrl}" controls preload="metadata" title="AI 生成音频"></audio>
        <button type="button" class="download-image-btn" onclick="event.stopPropagation();downloadMedia(decodeURIComponent('${encodedUrl}'), 'audio-${Date.now()}.${ext}')" title="下载音频">
            ${renderDownloadIcon()}
        </button>
    </div>`;
}

/**
 * 根据媒体类型渲染对应卡片
 * @param {string} url - 媒体 URL
 * @param {'image'|'video'|'audio'} mediaType - 媒体类型
 * @param {string} mimeType - MIME 类型（可选）
 * @returns {string}
 */
export function renderMediaCard(url, mediaType, mimeType = '') {
    if (!url) return '';
    if (mediaType === 'video') return renderVideoCard(url, mimeType);
    if (mediaType === 'audio') return renderAudioCard(url, mimeType);
    return renderImageCard(url);
}
