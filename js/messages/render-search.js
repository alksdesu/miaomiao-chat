/**
 * 搜索引用渲染模块
 * 负责 Gemini 搜索引用（grounding）的 HTML 渲染
 */

import { escapeHtml } from '../utils/helpers.js';
import { getIcon } from '../utils/icons.js';

/**
 * 渲染搜索引用
 * @param {Object} groundingMetadata - Gemini 搜索引用元数据
 * @returns {string} HTML 字符串
 */
export function renderSearchGrounding(groundingMetadata) {
    if (!groundingMetadata?.groundingChunks && !groundingMetadata?.webSearchQueries) return '';

    const chunks = groundingMetadata.groundingChunks || [];
    const sources = chunks
        .filter((chunk) => chunk.web)
        .map(
            (chunk) =>
                `<li><a href="${escapeHtml(chunk.web.uri)}" target="_blank" rel="noopener noreferrer">${escapeHtml(chunk.web.title || chunk.web.uri)}</a></li>`
        )
        .join('');

    if (!sources) return '';

    return `
        <div class="search-grounding">
            <div class="grounding-header">${getIcon('search', { size: 14 })} 搜索引用</div>
            <ul class="grounding-sources">${sources}</ul>
        </div>
    `;
}
