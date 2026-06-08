/**
 * 图片查看器模块
 * 处理图片的全屏查看、消息内媒体卡片的事件委托（data-action 派发）
 */

import { eventBus } from '../core/events.js';
import { elements } from '../core/state.js';
import { downloadImage } from '../utils/images.js';
import { downloadMedia } from '../utils/media.js';
import { bindTopmostEscape } from '../utils/modal-stack.js';
import { trapFocus, removeFocusTrap } from '../utils/focus-trap.js';
import { getMediaExtension } from '../utils/media.js';
import { logger } from '../utils/logger.js';

/**
 * 打开图片查看器
 * @param {string} src - 图片 URL
 */
export function openImageViewer(src) {
    const modal = document.getElementById('image-viewer-modal');
    const img = document.getElementById('image-viewer-img');
    if (modal && img) {
        img.src = src;
        modal.classList.add('open');
        document.body.style.overflow = 'hidden';

        // 启用焦点陷阱
        trapFocus(modal);

        // 禁用主内容交互
        document.querySelector('.app-container')?.setAttribute('inert', '');
    }
}

/**
 * 关闭图片查看器
 */
export function closeImageViewer() {
    const modal = document.getElementById('image-viewer-modal');
    if (modal) {
        modal.classList.remove('open');
        document.body.style.overflow = '';

        // 移除焦点陷阱
        removeFocusTrap(modal);

        // 恢复主内容交互
        document.querySelector('.app-container')?.removeAttribute('inert');
    }
}

/**
 * 消息区媒体卡片事件委托
 * 处理 data-action: open-viewer / download-media
 */
function handleMediaAreaClick(e) {
    const target = e.target.closest('[data-action]');
    if (!target) return;

    const action = target.dataset.action;
    const url = target.dataset.url;
    if (!url) return;

    if (action === 'open-viewer') {
        openImageViewer(url);
        return;
    }

    if (action === 'download-media') {
        // 下载按钮的祖先链上有 .image-wrapper（图片）/ .video-wrapper / .audio-wrapper
        // 当前 download-media 统一走 downloadMedia，仅图片走 downloadImage（保持原 inline 行为）
        e.stopPropagation();
        const mediaKind = target.dataset.mediaKind || 'image';
        const ext = target.dataset.ext || getMediaExtension(url, '', 'png');
        const filename = target.dataset.filename || `${mediaKind}-${Date.now()}.${ext}`;
        if (mediaKind === 'image') {
            downloadImage(url, filename);
        } else {
            downloadMedia(url, filename);
        }
    }
}

/**
 * 初始化图片查看器
 */
export function initImageViewer() {
    // 监听图片查看请求
    eventBus.on('ui:open-image-viewer', ({ url }) => {
        openImageViewer(url);
    });

    // 绑定关闭按钮
    const closeBtn = document.querySelector('#image-viewer-modal .image-viewer-close');
    if (closeBtn) {
        closeBtn.addEventListener('click', closeImageViewer);
    }

    // 点击背景关闭（仅命中 modal 自身时关闭，子元素 click 不冒泡触发）
    const modal = document.getElementById('image-viewer-modal');
    if (modal) {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) closeImageViewer();
        });
        // ESC 关闭（叠层场景仅响应最顶层；keyboard.js 全局调度器仍作为兜底）
        bindTopmostEscape(modal, closeImageViewer);
    }

    // 消息区媒体卡片统一事件委托（图片点击放大、下载按钮）
    // 委托到 #messages 容器，覆盖 renderer.js / stream/helpers.js / reply-selector.js 三处渲染
    elements.messagesArea?.addEventListener('click', handleMediaAreaClick);

    logger.debug('Image viewer initialized');
}
