/**
 * 文件附件处理模块
 * 支持图片、PDF、TXT 文件的上传、预览、粘贴
 */

import { state, elements } from '../core/state.js';
import { eventBus } from '../core/events.js';
import { showNotification } from './notifications.js';
import { truncateFileName } from '../utils/file-helpers.js';
import { escapeHtml } from '../utils/helpers.js';
import {
    MAX_ATTACHMENTS,
    MAX_FILE_SIZE,
    AUTO_DOCUMENT_TOKEN_THRESHOLD
} from '../utils/constants.js';
import { estimateTokenCount } from '../stream/stats.js';
import {
    estimateTokensInWorker,
    LONG_CHAT_WORKER_TEXT_THRESHOLD
} from '../utils/long-chat-worker-client.js';
import { renderPdfToImages } from '../utils/pdf.js';
import { logger } from '../utils/logger.js';

// 支持的文件类型
const SUPPORTED_TYPES = {
    image: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'],
    pdf: ['application/pdf'],
    text: [
        'text/plain',
        'text/markdown',
        'application/json',
        'text/csv',
        'text/html',
        'text/css',
        'text/javascript',
        'application/xml',
        'text/xml',
        'application/x-yaml'
    ]
};

const TEXT_FILE_EXTENSIONS = new Set([
    'txt',
    'md',
    'json',
    'csv',
    'xml',
    'yaml',
    'yml',
    'toml',
    'js',
    'ts',
    'jsx',
    'tsx',
    'py',
    'java',
    'c',
    'cpp',
    'h',
    'hpp',
    'cs',
    'go',
    'rs',
    'rb',
    'php',
    'swift',
    'kt',
    'scala',
    'lua',
    'sh',
    'bash',
    'zsh',
    'ps1',
    'bat',
    'cmd',
    'html',
    'htm',
    'css',
    'scss',
    'less',
    'sass',
    'sql',
    'r',
    'matlab',
    'vue',
    'svelte',
    'ini',
    'cfg',
    'conf',
    'env',
    'properties',
    'log',
    'gitignore',
    'dockerfile',
    'makefile'
]);

function captureAttachmentContext() {
    return {
        sessionId: state.currentSessionId,
        draft: state.uploadedImages
    };
}

function isAttachmentContextActive(context) {
    return (
        context.sessionId === state.currentSessionId &&
        context.draft === state.uploadedImages &&
        !state.isSwitchingSession
    );
}

/**
 * 获取文件类别
 * @param {string} mimeType - MIME 类型
 * @returns {'image'|'pdf'|'text'|'unknown'}
 */
export function getFileCategory(mimeType) {
    if (SUPPORTED_TYPES.image.includes(mimeType)) return 'image';
    if (SUPPORTED_TYPES.pdf.includes(mimeType)) return 'pdf';
    if (SUPPORTED_TYPES.text.includes(mimeType)) return 'text';
    return 'unknown';
}

/**
 * 将文件转换为 base64
 * @param {File} file - 文件对象
 * @returns {Promise<string>} Base64 数据 URL
 */
export function fileToBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

/**
 * 读取文本文件内容
 * @param {File} file - 文件对象
 * @returns {Promise<string>} 文本内容
 */
export function fileToText(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsText(file, 'UTF-8');
    });
}

/**
 * 处理文件附件
 * 支持图片、PDF、TXT 文件
 */
export function handleAttachFile() {
    if (state.uploadedImages.length >= MAX_ATTACHMENTS) {
        showNotification(`最多只能添加 ${MAX_ATTACHMENTS} 个附件`, 'error');
        return;
    }

    const context = captureAttachmentContext();
    if (!isAttachmentContextActive(context)) return;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept =
        'image/*,.pdf,.txt,.md,.json,.csv,.xml,.yaml,.yml,.js,.ts,.py,.java,.c,.cpp,.go,.rs,.html,.css,.sql,.sh,.toml,.ini,.log,text/*,application/json,application/pdf';
    input.multiple = true;

    input.onchange = async (e) => {
        if (!isAttachmentContextActive(context)) return;
        const files = Array.from(e.target.files);
        const remaining = MAX_ATTACHMENTS - state.uploadedImages.length;

        if (files.length > remaining) {
            showNotification(`只能再添加 ${remaining} 个附件`, 'warning');
        }

        const filesToProcess = files.slice(0, remaining);

        for (const file of filesToProcess) {
            if (!isAttachmentContextActive(context)) return;
            if (state.uploadedImages.length >= MAX_ATTACHMENTS) {
                showNotification(`已达到附件上限 ${MAX_ATTACHMENTS}，跳过剩余文件`, 'warning');
                break;
            }

            if (file.size > MAX_FILE_SIZE) {
                showNotification(`文件 "${file.name}" 超过 20MB 限制`, 'error');
                continue;
            }

            let fileType = file.type;
            const category = getFileCategory(fileType);
            if (category === 'unknown') {
                const ext = file.name.split('.').pop()?.toLowerCase();
                if (ext === 'pdf') {
                    fileType = 'application/pdf';
                } else if (TEXT_FILE_EXTENSIONS.has(ext)) {
                    fileType = 'text/plain';
                } else {
                    showNotification(`不支持的文件类型: ${file.name}`, 'error');
                    continue;
                }
            }

            const fileCategory = getFileCategory(fileType);

            // 单文件读取失败不中断后续文件的处理
            try {
                if (fileCategory === 'text') {
                    const textContent = await fileToText(file);
                    if (!isAttachmentContextActive(context)) return;
                    state.uploadedImages.push({
                        name: file.name,
                        type: fileType,
                        category: 'text',
                        data: textContent,
                        size: file.size
                    });
                    logger.debug(
                        `已添加文本文件: ${file.name} (${(file.size / 1024).toFixed(2)} KB)`
                    );
                } else {
                    const base64 = await fileToBase64(file);
                    if (!isAttachmentContextActive(context)) return;

                    if (fileCategory === 'image') {
                        state.uploadedImages.push({
                            name: file.name,
                            type: fileType,
                            category: 'image',
                            data: base64,
                            size: file.size
                        });
                        logger.debug(
                            `已添加图片: ${file.name} (${(file.size / 1024 / 1024).toFixed(2)} MB)`
                        );
                    } else if (fileCategory === 'pdf') {
                        if (state.pdfMode === 'render') {
                            try {
                                const canAdd = MAX_ATTACHMENTS - state.uploadedImages.length;
                                if (canAdd <= 0) {
                                    showNotification(
                                        `已达到附件上限，无法添加 PDF 渲染的图片`,
                                        'warning'
                                    );
                                    break;
                                }

                                showNotification(`正在渲染 PDF: ${file.name}...`, 'info');
                                const renderedImages = await renderPdfToImages(base64, {
                                    scale: 1.5,
                                    format: 'image/jpeg',
                                    quality: 0.85,
                                    maxPages: Math.min(20, canAdd)
                                });
                                if (!isAttachmentContextActive(context)) return;

                                for (const img of renderedImages) {
                                    state.uploadedImages.push(img);
                                }

                                if (renderedImages.length === 0) {
                                    showNotification(`PDF 渲染未产生有效图片`, 'warning');
                                } else {
                                    showNotification(
                                        `PDF 已渲染为 ${renderedImages.length} 张图片`,
                                        'success'
                                    );
                                }
                                logger.debug(
                                    `已渲染 PDF: ${file.name} → ${renderedImages.length} 张图片`
                                );
                            } catch (err) {
                                logger.error('[PDF 渲染失败]', err);
                                showNotification(`PDF 渲染失败: ${err.message}`, 'error');
                            }
                        } else {
                            state.uploadedImages.push({
                                name: file.name,
                                type: fileType,
                                category: 'pdf',
                                data: base64,
                                size: file.size
                            });
                            logger.debug(
                                `已添加 PDF: ${file.name} (${(file.size / 1024 / 1024).toFixed(2)} MB)`
                            );
                        }
                    }
                }
            } catch (err) {
                if (!isAttachmentContextActive(context)) return;
                logger.error(`[Attachment] 读取文件失败: ${file.name}`, err);
                showNotification(`读取文件 "${file.name}" 失败`, 'error');
            }
        }
        if (isAttachmentContextActive(context)) updateImagePreview();
    };

    input.click();
}

/**
 * 更新附件预览栏
 * 支持图片、PDF、TXT 文件的预览
 * @param {Function} [onQuoteStyleUpdate] - 引用样式更新回调
 */
export function updateImagePreview(onQuoteStyleUpdate) {
    const previewContainer = document.getElementById('image-preview-container');
    if (!previewContainer) return;

    // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
    previewContainer.innerHTML = '';

    if (state.uploadedImages.length === 0) {
        previewContainer.classList.remove('has-images');
        if (onQuoteStyleUpdate) onQuoteStyleUpdate();
        return;
    }

    previewContainer.classList.add('has-images');

    state.uploadedImages.forEach((file, index) => {
        const previewItem = document.createElement('div');
        previewItem.className = 'image-preview-item';

        const category = file.category || getFileCategory(file.type);

        if (category === 'image') {
            const displayUrl = file.compressed || file.data;
            // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
            previewItem.innerHTML = `
                <img src="${escapeHtml(displayUrl)}" alt="${escapeHtml(file.name)}" title="点击查看大图">
                <button class="remove-image" data-index="${index}" title="移除">×</button>
            `;
            previewItem.querySelector('img').onclick = () =>
                eventBus.emit('ui:open-image-viewer', { url: file.data });
        } else if (category === 'pdf') {
            const sizeStr = file.size ? `${(file.size / 1024 / 1024).toFixed(2)} MB` : '';
            previewItem.className = 'image-preview-item file-preview-item';
            // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
            previewItem.innerHTML = `
                <div class="file-preview-icon pdf-icon">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                        <polyline points="14 2 14 8 20 8"/>
                        <path d="M10 12h4"/>
                        <path d="M10 16h4"/>
                    </svg>
                </div>
                <div class="file-preview-info">
                    <span class="file-name" title="${escapeHtml(file.name)}">${escapeHtml(truncateFileName(file.name, 15))}</span>
                    <span class="file-size">${sizeStr}</span>
                </div>
                <button class="remove-image" data-index="${index}" title="移除">×</button>
            `;
        } else if (category === 'text') {
            const sizeStr = file.size ? `${(file.size / 1024).toFixed(2)} KB` : '';
            const isMarkdown = file.type === 'text/markdown' || file.name.endsWith('.md');
            const iconClass = isMarkdown ? 'md-icon' : 'txt-icon';
            const isAutoConverted = file.isAutoConverted || false;
            previewItem.className = 'image-preview-item file-preview-item';
            // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
            previewItem.innerHTML = `
                <div class="file-preview-icon ${iconClass}">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                        <polyline points="14 2 14 8 20 8"/>
                        <line x1="16" y1="13" x2="8" y2="13"/>
                        <line x1="16" y1="17" x2="8" y2="17"/>
                        <polyline points="10 9 9 9 8 9"/>
                    </svg>
                    ${isAutoConverted ? '<span class="auto-convert-badge" title="超长文本已自动转换为文档">自动</span>' : ''}
                </div>
                <div class="file-preview-info">
                    <span class="file-name" title="${escapeHtml(file.name)}">${escapeHtml(truncateFileName(file.name, 15))}</span>
                    <span class="file-size">${sizeStr}${isAutoConverted ? ' (自动转换)' : ''}</span>
                </div>
                <button class="remove-image" data-index="${index}" title="移除">×</button>
            `;
        }

        previewItem.querySelector('.remove-image').onclick = (e) => {
            e.stopPropagation();
            state.uploadedImages.splice(index, 1);
            updateImagePreview(onQuoteStyleUpdate);
        };

        previewContainer.appendChild(previewItem);
    });

    if (onQuoteStyleUpdate) onQuoteStyleUpdate();
}

/**
 * 处理粘贴事件（支持粘贴图片和检测超长文本）
 * @param {ClipboardEvent} e - 粘贴事件
 * @param {Function} [onPreviewUpdate] - 预览更新回调
 */
export async function handlePaste(e, onPreviewUpdate) {
    const clipboardData = e.clipboardData;
    if (!clipboardData) return;
    const context = captureAttachmentContext();
    if (!isAttachmentContextActive(context)) return;

    const items = Array.from(clipboardData.items);
    const imageItems = items.filter((item) => item.type.startsWith('image/'));

    if (imageItems.length === 0) {
        const pastedText = clipboardData.getData('text/plain');
        if (pastedText) {
            setTimeout(async () => {
                if (!isAttachmentContextActive(context)) return;
                const fullText = elements.userInput.value;
                const tokenCount =
                    fullText.length >= LONG_CHAT_WORKER_TEXT_THRESHOLD
                        ? await estimateTokensInWorker(fullText)
                        : estimateTokenCount(fullText);

                if (!isAttachmentContextActive(context) || elements.userInput.value !== fullText) {
                    return;
                }

                if (tokenCount > AUTO_DOCUMENT_TOKEN_THRESHOLD) {
                    showNotification(
                        `粘贴的内容过长（约 ${tokenCount} tokens），发送时将自动转换为文档附件`,
                        'info'
                    );
                }
            }, 0);
        }
        return;
    }

    e.preventDefault();

    if (state.uploadedImages.length >= MAX_ATTACHMENTS) {
        showNotification(`最多只能添加 ${MAX_ATTACHMENTS} 个附件`, 'error');
        return;
    }

    const remaining = MAX_ATTACHMENTS - state.uploadedImages.length;
    const itemsToProcess = imageItems.slice(0, remaining);

    if (imageItems.length > remaining) {
        showNotification(`只能再添加 ${remaining} 个附件`, 'warning');
    }

    let pastedCount = 0;
    for (const item of itemsToProcess) {
        const file = item.getAsFile();
        if (!file) continue;

        if (file.size > MAX_FILE_SIZE) {
            showNotification('粘贴的图片超过 20MB 限制', 'error');
            continue;
        }

        try {
            const base64 = await fileToBase64(file);
            if (!isAttachmentContextActive(context)) return;

            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const fileName = `pasted-image-${timestamp}.${file.type.split('/')[1] || 'png'}`;

            state.uploadedImages.push({
                name: fileName,
                type: file.type,
                category: 'image',
                data: base64,
                size: file.size
            });
            pastedCount++;

            logger.debug(
                `[Input] 已粘贴图片: ${fileName} (${(file.size / 1024 / 1024).toFixed(2)} MB)`
            );
        } catch (error) {
            if (!isAttachmentContextActive(context)) return;
            logger.error('[Input] 处理粘贴图片失败:', error);
            showNotification('粘贴图片失败', 'error');
        }
    }

    if (!isAttachmentContextActive(context)) return;
    if (onPreviewUpdate) onPreviewUpdate();
    if (pastedCount > 0) {
        showNotification(`已粘贴 ${pastedCount} 张图片`, 'success');
    }
}
