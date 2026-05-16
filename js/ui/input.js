/**
 * 输入处理模块
 * 核心输入逻辑：发送、键盘、自动调整高度、编辑、初始化
 * 附件和引用逻辑分别委托给 attachment-handler.js 和 quote-handler.js
 */

import { state, elements } from '../core/state.js';
import { eventBus } from '../core/events.js';
import { requestStateMachine } from '../core/request-state-machine.js';
import { createMessageElement } from '../messages/renderer.js';
import { removeMessagesAfterAll, updateMessageContentWithImages } from '../messages/editor.js';
import { showNotification } from './notifications.js';
import {
    pushMessage,
    updateMessageAt,
    setUploadedImages,
    setEditingIndex,
    setEditingElement,
    setLastUserMessage
} from '../core/state-mutations.js';
import { categorizeFile } from '../utils/file-helpers.js';
import {
    createMessage,
    Role,
    textPart,
    mediaPart,
    filePart,
    MediaKind
} from '../messages/schema.js';
import {
    MAX_ATTACHMENTS,
    IMAGE_COMPRESSION_TIMEOUT,
    AUTO_DOCUMENT_TOKEN_THRESHOLD
} from '../utils/constants.js';
import { estimateTokenCount } from '../stream/stats.js';
import { handleAttachFile, updateImagePreview, handlePaste } from './attachment-handler.js';
import {
    getQuotedMessage,
    setQuotedMessage,
    clearQuotedMessage,
    updateQuotePreviewStyle
} from './quote-handler.js';
import { logger } from '../utils/logger.js';

// re-export 保持外部兼容
export { handleAttachFile, updateImagePreview } from './attachment-handler.js';

/**
 * 处理键盘事件
 * @param {KeyboardEvent} e - 键盘事件
 */
function handleKeyDown(e) {
    // 中日韩等 IME 合成期间的 Enter 不应触发发送
    // e.isComposing 标记合成中；keyCode 229 是部分浏览器/Electron 的旧式兜底
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
    }
}

/**
 * 自动调整文本框高度
 * 最大高度为视口高度的 50%，最小 168px，最大 500px
 */
export function autoResizeTextarea() {
    const textarea = elements.userInput;
    if (!textarea) return;

    const viewportHeight = window.innerHeight;
    const maxHeight = Math.max(168, Math.min(viewportHeight * 0.5, 500));

    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, maxHeight) + 'px';
}

/**
 * 更新用户消息 DOM
 * @param {HTMLElement} messageEl - 消息元素
 * @param {string} text - 文本内容
 * @param {Array} images - 图片数组
 */
function updateUserMessageDOM(messageEl, text, images = null) {
    const contentWrapper = messageEl.querySelector('.message-content-wrapper');
    const contentDiv = contentWrapper?.querySelector('.message-content');
    if (!contentDiv) return;

    contentDiv.textContent = text;

    const oldImages = contentDiv.querySelector('.message-images');
    if (oldImages) oldImages.remove();

    if (images && images.length > 0) {
        const imagesContainer = document.createElement('div');
        imagesContainer.className = 'message-images';
        images.forEach((img) => {
            const imgEl = document.createElement('img');
            imgEl.src = img.data;
            imgEl.alt = img.name;
            imgEl.title = '点击查看大图';
            imgEl.onclick = () => {
                eventBus.emit('ui:open-image-viewer', { url: img.data });
            };
            imagesContainer.appendChild(imgEl);
        });
        contentDiv.appendChild(imagesContainer);
    }
}

/**
 * 更新编辑按钮的显示状态（保存和取消）
 */
function updateCancelEditButton() {
    logger.debug(
        '[input.js] updateCancelEditButton 被调用, state.editingIndex =',
        state.editingIndex
    );

    const cancelBtn = document.getElementById('cancel-edit');
    const saveBtn = document.getElementById('save-edit');
    const sendBtn = document.getElementById('send-button');

    if (!cancelBtn || !saveBtn || !sendBtn) {
        logger.error('[ERROR] 编辑按钮未找到:', {
            cancelBtn: !!cancelBtn,
            saveBtn: !!saveBtn,
            sendBtn: !!sendBtn
        });
        return;
    }

    if (state.editingIndex !== null) {
        logger.debug('[input.js] 进入编辑模式，显示保存和取消按钮');
        cancelBtn.classList.add('show');
        saveBtn.classList.add('show');

        logger.debug('[input.js] 按钮 class 列表:', {
            cancelBtn: cancelBtn.className,
            saveBtn: saveBtn.className
        });

        sendBtn.title = '重新发送（将删除后续消息）';
        sendBtn.setAttribute('aria-label', '重新发送消息');
    } else {
        logger.debug('[input.js] 退出编辑模式，隐藏保存和取消按钮');
        cancelBtn.classList.remove('show');
        saveBtn.classList.remove('show');

        sendBtn.title = '发送';
        sendBtn.setAttribute('aria-label', '发送消息');
    }
}

// 附件预览更新时同步引用样式的回调
function _doUpdateImagePreview() {
    updateImagePreview(updateQuotePreviewStyle);
}

/**
 * 取消编辑
 */
function cancelEdit() {
    if (state.editingIndex === null) return;

    elements.userInput.value = '';
    autoResizeTextarea();
    setUploadedImages([]);
    _doUpdateImagePreview();

    if (state.editingElement) {
        state.editingElement.classList.remove('editing');
        setEditingElement(null);
    }
    setEditingIndex(null);
    updateCancelEditButton();

    showNotification('已取消编辑', 'info');
}

/**
 * 保存编辑（不删除后续消息）
 */
function saveEdit() {
    if (state.editingIndex === null) return;

    const textContent = elements.userInput.value.trim();
    const hasAttachments = state.uploadedImages.length > 0;

    if (!textContent && !hasAttachments) {
        showNotification('消息不能为空（至少需要文本或附件）', 'warning');
        return;
    }

    const attachmentDataUrls = hasAttachments ? state.uploadedImages.map((file) => file.data) : [];
    let messageAttachments = [];

    if (hasAttachments) {
        messageAttachments = attachmentDataUrls;
    }

    updateMessageContentWithImages(state.editingIndex, textContent, messageAttachments, 'user');

    if (state.editingElement) {
        eventBus.emit('message:content-updated', {
            messageEl: state.editingElement,
            index: state.editingIndex,
            newContent: textContent,
            role: 'user'
        });
    }

    elements.userInput.value = '';
    autoResizeTextarea();
    setUploadedImages([]);
    _doUpdateImagePreview();

    if (state.editingElement) {
        state.editingElement.classList.remove('editing');
        setEditingElement(null);
    }
    setEditingIndex(null);
    updateCancelEditButton();

    showNotification('消息已保存', 'success');
}

/**
 * 处理消息发送
 */
export async function handleSend() {
    logger.debug('[input.js] handleSend 被调用, 状态机:', requestStateMachine.getState());

    let textContent = elements.userInput.value.trim();
    let hasAttachments = state.uploadedImages.length > 0;
    const isEditing = state.editingIndex !== null;

    if (!textContent && !hasAttachments) {
        logger.debug('[input.js] handleSend 被阻止: 没有文本或附件');
        return;
    }

    if (requestStateMachine.isBusy()) {
        logger.debug(
            '[input.js] handleSend 被阻止: 请求正在进行中, 当前状态:',
            requestStateMachine.getState()
        );
        return;
    }

    // 如果有引用消息，添加引用上下文
    const quoted = getQuotedMessage();
    if (quoted && !isEditing) {
        const roleLabel = quoted.role === 'user' ? '用户' : 'AI';
        const quotedText = quoted.content;
        const quotePrefix = `> **@${roleLabel}**: ${quotedText}\n\n`;
        textContent = quotePrefix + textContent;
    }

    // 超长文本通过下面的 AUTO_DOCUMENT_TOKEN_THRESHOLD 自动转文档附件处理，
    // 不再设硬字符上限，避免长粘贴被拦截在发送之前
    if (textContent) {
        const tokenCount = estimateTokenCount(textContent);
        logger.debug(`[input.js] 消息 token 数: ${tokenCount}`);

        if (tokenCount > AUTO_DOCUMENT_TOKEN_THRESHOLD) {
            logger.debug(
                `[input.js] Token 数超过 ${AUTO_DOCUMENT_TOKEN_THRESHOLD}，自动转换为文档附件`
            );

            if (state.uploadedImages.length >= MAX_ATTACHMENTS) {
                showNotification(
                    `文本过长（约 ${tokenCount} tokens），但已达到最大附件数量限制`,
                    'error'
                );
                return;
            }

            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const fileName = `auto-document-${timestamp}.txt`;

            state.uploadedImages.push({
                name: fileName,
                type: 'text/plain',
                category: 'text',
                data: textContent,
                size: new Blob([textContent]).size,
                isAutoConverted: true
            });

            textContent = '';
            elements.userInput.value = '';
            autoResizeTextarea();
            hasAttachments = true;

            _doUpdateImagePreview();

            showNotification(`文本过长（约 ${tokenCount} tokens），已自动转换为文档附件`, 'info');
        }
    }

    // 构建新格式用户消息
    const parts = [];
    if (textContent) {
        parts.push(textPart(textContent));
    }
    if (hasAttachments) {
        for (const file of state.uploadedImages) {
            const cat = file.category || categorizeFile(file.type);
            if (cat === 'image') {
                parts.push(mediaPart(MediaKind.IMAGE, file.data, file.type));
            } else if (cat === 'video') {
                parts.push(mediaPart(MediaKind.VIDEO, file.data, file.type));
            } else if (cat === 'pdf') {
                parts.push(filePart(file.name, file.type, file.data));
            } else if (cat === 'text') {
                parts.push(filePart(file.name, file.type || 'text/plain', file.data, 'text'));
            }
        }
    }

    const userMessage = createMessage(Role.USER, parts);

    setLastUserMessage(userMessage);
    state.messageHistory.push({ message: userMessage, timestamp: Date.now() });
    if (state.messageHistory.length > state.maxHistorySize) {
        state.messageHistory.shift();
    }

    if (isEditing) {
        const targetIndex = state.editingIndex;
        updateMessageAt(targetIndex, userMessage, true);

        if (state.editingElement) {
            updateUserMessageDOM(
                state.editingElement,
                textContent,
                hasAttachments ? state.uploadedImages : null
            );
        }

        removeMessagesAfterAll(targetIndex);
    } else {
        pushMessage(userMessage);

        const messageIndex = state.messages.length - 1;
        const messageEl = createMessageElement(
            'user',
            textContent,
            hasAttachments ? state.uploadedImages : null,
            userMessage.id
        );
        elements.messagesArea.appendChild(messageEl);
        if (messageEl) {
            messageEl.dataset.messageIndex = messageIndex;
        }
    }

    // 清空输入
    elements.userInput.value = '';
    autoResizeTextarea();
    setUploadedImages([]);
    _doUpdateImagePreview();

    clearQuotedMessage();

    setEditingIndex(null);
    if (state.editingElement) {
        state.editingElement.classList.remove('editing');
        setEditingElement(null);
    }
    updateCancelEditButton();

    eventBus.emit('ui:scroll-to-bottom');

    eventBus.emit('messages:changed', {
        action: 'user_sent',
        index: state.messages.length - 1
    });

    eventBus.emit('api:send-requested');
}

/**
 * 初始化输入处理器
 */
export function initInputHandlers() {
    elements.sendButton?.addEventListener('click', handleSend);
    elements.userInput?.addEventListener('keydown', handleKeyDown);
    elements.userInput?.addEventListener('input', autoResizeTextarea);
    elements.attachFile?.addEventListener('click', handleAttachFile);

    // 粘贴图片
    elements.userInput?.addEventListener('paste', (e) => {
        handlePaste(e, _doUpdateImagePreview);
    });

    // 取消请求
    elements.cancelRequestButton?.addEventListener('click', () => {
        eventBus.emit('api:cancel-requested');
    });

    // 取消编辑按钮
    const cancelBtn = document.getElementById('cancel-edit');
    if (cancelBtn) {
        cancelBtn.addEventListener('click', cancelEdit);
    }

    // 字数统计、token 计算和 typing 效果
    let tokenCountTimeout = null;
    elements.userInput?.addEventListener('input', (e) => {
        const text = e.target.value;
        const length = text.length;

        if (elements.charCounter) {
            if (length > 0) {
                elements.charCounter.textContent = `${length}`;

                clearTimeout(tokenCountTimeout);
                tokenCountTimeout = setTimeout(() => {
                    const tokenCount = estimateTokenCount(text);
                    elements.charCounter.textContent = `${length} 字符 / ${tokenCount} tokens`;

                    if (tokenCount > AUTO_DOCUMENT_TOKEN_THRESHOLD * 0.9) {
                        elements.charCounter.style.color = 'var(--md-warning)';
                        elements.charCounter.title = `接近自动转换阈值 (${AUTO_DOCUMENT_TOKEN_THRESHOLD} tokens)`;
                    } else {
                        elements.charCounter.style.color = '';
                        elements.charCounter.title = '';
                    }
                }, 300);
            } else {
                elements.charCounter.textContent = '';
                elements.charCounter.style.color = '';
                elements.charCounter.title = '';
            }
        }

        if (length > 0) {
            elements.inputBarInner?.classList.add('typing');
        } else {
            elements.inputBarInner?.classList.remove('typing');
        }
    });

    // 监听编辑模式变化
    eventBus.on('editor:mode-changed', () => {
        updateCancelEditButton();
    });

    // 监听引用消息请求
    eventBus.on('message:quote-requested', ({ messageEl, role }) => {
        const contentDiv = messageEl.querySelector('.message-content');
        if (!contentDiv) return;

        let textContent = contentDiv.textContent || contentDiv.innerText || '';
        textContent = textContent.trim();

        if (!textContent) {
            showNotification('无法引用空消息', 'warning');
            return;
        }

        const MAX_QUOTE_LENGTH = 500;
        if (textContent.length > MAX_QUOTE_LENGTH) {
            textContent = textContent.substring(0, MAX_QUOTE_LENGTH) + '...';
        }

        setQuotedMessage(role, textContent);

        showNotification('已添加引用', 'success');
    });

    // 会话切换时的按钮重置
    eventBus.on('ui:reset-input-buttons', () => {
        logger.debug('[input.js] 收到 ui:reset-input-buttons 事件');
        if (requestStateMachine.isBusy()) {
            logger.warn('[input.js] 状态机显示正忙，强制重置');
            requestStateMachine.forceReset();
        } else {
            if (elements.sendButton) {
                elements.sendButton.disabled = false;
                elements.sendButton.style.display = 'inline-flex';
            }
            if (elements.cancelRequestButton) {
                elements.cancelRequestButton.style.display = 'none';
            }
        }
    });

    // 显示取消按钮（恢复后台任务时）
    eventBus.on('ui:show-cancel-button', () => {
        if (elements.sendButton) {
            elements.sendButton.style.display = 'none';
        }
        if (elements.cancelRequestButton) {
            elements.cancelRequestButton.style.display = 'inline-flex';
        }
    });

    // 更新图片预览（切换会话时清空）
    eventBus.on('ui:update-image-preview', () => {
        _doUpdateImagePreview();
        clearQuotedMessage();
    });

    // 编辑模式刷新
    eventBus.on('editor:refresh-attachments', () => _doUpdateImagePreview());
    eventBus.on('editor:resize-textarea', () => autoResizeTextarea());

    // 暴露到全局作用域（用于 HTML onclick）
    window.cancelEdit = cancelEdit;
    window.saveEdit = saveEdit;

    // 全局按钮状态检测器
    setInterval(() => {
        const isBusy = requestStateMachine.isBusy();
        const sendButtonDisabled = elements.sendButton?.disabled;
        const cancelButtonVisible = elements.cancelRequestButton?.style.display === 'inline-flex';

        if (!isBusy && (sendButtonDisabled || cancelButtonVisible)) {
            logger.warn('[按钮状态修复] 检测到状态不一致，强制修复');
            logger.warn('[按钮状态修复] 状态机:', requestStateMachine.getState());
            logger.warn('[按钮状态修复] UI:', { sendButtonDisabled, cancelButtonVisible });

            requestStateMachine.forceReset();
        }
    }, IMAGE_COMPRESSION_TIMEOUT);

    logger.debug('Input handlers initialized');
}
