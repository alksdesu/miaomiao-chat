/**
 * 消息引用处理模块
 * 处理引用预览的渲染、样式更新、清除
 */

import { elements } from '../core/state.js';
import { escapeHtml } from '../utils/helpers.js';

// 引用消息状态
let quotedMessage = null;

/**
 * 获取当前引用消息
 * @returns {Object|null}
 */
export function getQuotedMessage() {
    return quotedMessage;
}

/**
 * 设置引用消息
 * @param {string} role - 消息角色（user/assistant）
 * @param {string} content - 消息内容（纯文本）
 */
export function setQuotedMessage(role, content) {
    const preview = content.length > 100 ? content.substring(0, 100) + '...' : content;

    quotedMessage = {
        role,
        content,
        preview
    };

    renderQuotePreview();
}

/**
 * 清除引用消息
 */
export function clearQuotedMessage() {
    quotedMessage = null;
    removeQuotePreview();
}

/**
 * 渲染引用预览 UI
 */
function renderQuotePreview() {
    if (!quotedMessage) return;

    let quotePreview = document.getElementById('quote-preview');

    if (!quotePreview) {
        quotePreview = document.createElement('div');
        quotePreview.id = 'quote-preview';
        quotePreview.className = 'quote-preview';

        const inputBar = document.querySelector('.input-bar');
        const resizeHandle = document.getElementById('input-resize-handle');
        if (inputBar && resizeHandle) {
            inputBar.insertBefore(quotePreview, resizeHandle);
        }
    }

    const roleLabel = quotedMessage.role === 'user' ? '用户' : 'AI';
    // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
    quotePreview.innerHTML = `
        <div class="quote-preview-content">
            <svg class="quote-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M3 21c3 0 7-1 7-8V5c0-1.25-.756-2.017-2-2H4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .008-1 1.031V20c0 1 0 1 1 1z"/>
                <path d="M15 21c3 0 7-1 7-8V5c0-1.25-.757-2.017-2-2h-4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2h.75c0 2.25.25 4-2.75 4v3c0 1 0 1 1 1z"/>
            </svg>
            <div class="quote-preview-text">
                <span class="quote-preview-label">回复 <strong>${roleLabel}</strong>:</span>
                <span class="quote-preview-message">${escapeHtml(quotedMessage.preview)}</span>
            </div>
        </div>
        <button class="quote-preview-close" aria-label="取消引用" title="取消引用">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="18" y1="6" x2="6" y2="18"/>
                <line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
        </button>
    `;

    const closeBtn = quotePreview.querySelector('.quote-preview-close');
    closeBtn.onclick = clearQuotedMessage;

    updateQuotePreviewStyle();

    elements.userInput?.focus();
}

/**
 * 更新引用预览样式（根据是否有图片预览）
 */
export function updateQuotePreviewStyle() {
    const quotePreview = document.getElementById('quote-preview');
    const imagePreview = document.getElementById('image-preview-container');

    if (quotePreview) {
        const hasImages = imagePreview?.classList.contains('has-images');
        if (hasImages) {
            quotePreview.classList.remove('standalone');
        } else {
            quotePreview.classList.add('standalone');
        }
    }
}

/**
 * 移除引用预览 UI
 */
function removeQuotePreview() {
    const quotePreview = document.getElementById('quote-preview');
    if (quotePreview) {
        quotePreview.remove();
    }
}
