/**
 * 消息编辑模块
 * 处理消息的编辑、删除、重试功能
 * 监听来自 renderer.js 的事件，避免循环依赖
 */

import { state } from '../core/state.js';
import { elements } from '../core/elements.js';
import { eventBus } from '../core/events.js';
import {
    removeMessagesAfter,
    popLastAssistantMessage,
    updateMessageAt
} from '../core/state-mutations.js';
// 不直接导入 input.js 的函数，通过 eventBus 解耦（避免循环依赖）
import { showConfirmDialog } from '../utils/dialogs.js';
import { canEditMessage, safeDeleteMessage } from '../tools/message-compat.js';
import { clearThoughtSignatures, hasThoughtSignatures } from '../api/format-converter.js'; // thoughtSignature 清理
import { categorizeFile } from '../utils/file-helpers.js';
import { escapeHtml } from '../utils/helpers.js';
import { rerenderMessageContent } from './renderer.js';
import { PartType, MediaKind, textPart, mediaPart, filePart } from './schema.js';
import { MAX_FILE_SIZE } from '../utils/constants.js';
import { logger } from '../utils/logger.js';
import {
    materializeCurrentSessionMessages,
    isLazyMessage
} from '../state/session-message-repository.js';
import { resolveMessagesMediaForApi } from '../state/media-blob-store.js';

async function resolveMessageForEditing(message) {
    if (isLazyMessage(message)) {
        await materializeCurrentSessionMessages();
        message = state.messageStore.findById(message.id) || message;
    }
    const [resolved] = await resolveMessagesMediaForApi([message]);
    return resolved;
}

/**
 * 自动调整文本框高度（通用函数）
 * @param {HTMLTextAreaElement} textarea - 文本框元素
 * @param {number} minHeight - 最小高度（默认 60px）
 * @param {number} maxHeight - 最大高度（默认 400px）
 */
function autoResizeGeneric(textarea, minHeight = 60, maxHeight = 400) {
    if (!textarea) return;
    textarea.style.height = 'auto';
    const newHeight = Math.max(minHeight, Math.min(textarea.scrollHeight, maxHeight));
    textarea.style.height = newHeight + 'px';
}

/**
 * 进入编辑模式（将消息加载到输入框）
 * @param {HTMLElement} messageEl - 消息元素
 */
export async function enterEditMode(messageEl) {
    // 流式响应中禁止编辑
    if (state.isLoading) {
        eventBus.emit('ui:notification', { message: '请等待回复完成后再编辑', type: 'warning' });
        return;
    }

    logger.debug('[editor.js] enterEditMode 被调用', { messageEl });
    const hit = resolveMessageHit(messageEl);
    logger.debug('[editor.js] targetIndex =', hit?.index ?? -1);
    if (!hit) {
        logger.error('[ERROR] 无效的 targetIndex');
        return;
    }

    const targetIndex = hit.index;
    let message = hit.msg;
    if (!message || message.role !== 'user') return;

    try {
        message = await resolveMessageForEditing(message);
    } catch (error) {
        logger.error('[Editor] 加载附件失败:', error);
        eventBus.emit('ui:notification', { message: '附件加载失败，无法编辑', type: 'error' });
        return;
    }

    if (state.editingIndex !== null) {
        // 此时输入框内容是另一条消息未保存的编辑稿，无法暂存恢复，只能确认丢弃
        const confirmed = await showConfirmDialog(
            '当前正在编辑另一条消息，切换将丢弃未保存的修改，确定切换？',
            '切换编辑'
        );
        if (!confirmed) return;
    } else {
        stashInputDraft();
    }

    let text = '';
    const attachments = [];
    for (const part of message.parts) {
        if (part.type === PartType.TEXT) text += part.text;
        else if (part.type === PartType.MEDIA && part.media === MediaKind.IMAGE) {
            attachments.push({
                name: '已上传图片',
                type: part.mime || 'image/*',
                category: 'image',
                data: part.url,
                mediaId: part.mediaId
            });
        } else if (part.type === PartType.FILE) {
            attachments.push({
                name: part.name,
                type: part.mime,
                category: categorizeFile(part.mime),
                data: part.url,
                mediaId: part.mediaId
            });
        }
    }
    elements.userInput.value = text;
    state.uploadedImages = attachments;

    // 更新编辑状态
    if (state.editingElement) {
        state.editingElement.classList.remove('editing');
    }
    state.editingIndex = targetIndex;
    editingMessageId = message.id || null;
    state.editingElement = messageEl;
    messageEl.classList.add('editing');
    logger.debug('[editor.js] 编辑状态已更新, state.editingIndex =', state.editingIndex);

    // 通过 eventBus 通知 input.js 更新图片预览（避免循环依赖）
    eventBus.emit('editor:refresh-attachments');
    logger.debug('[editor.js] editor:refresh-attachments 已发出');

    // 自动调整输入框高度以适应加载的内容
    eventBus.emit('editor:resize-textarea');

    // 聚焦输入框
    elements.userInput?.focus();

    // 通知 UI 更新按钮状态
    logger.debug('[editor.js] 发出 editor:mode-changed 事件');
    eventBus.emit('editor:mode-changed', {
        isEditing: true,
        index: targetIndex
    });
}

/**
 * 原地编辑消息（内联编辑）
 * 保留图片数据，避免编辑后图片丢失
 * @param {HTMLElement} messageEl - 消息元素
 */
export async function editMessageInPlace(messageEl) {
    // 流式响应中禁止编辑
    if (state.isLoading) {
        eventBus.emit('ui:notification', { message: '请等待回复完成后再编辑', type: 'warning' });
        return;
    }

    const hit = resolveMessageHit(messageEl);
    if (!hit) return;
    const index = hit.index;
    let message = hit.msg;

    try {
        message = await resolveMessageForEditing(message);
    } catch (error) {
        logger.error('[Editor] 加载附件失败:', error);
        eventBus.emit('ui:notification', { message: '附件加载失败，无法编辑', type: 'error' });
        return;
    }

    // 避免重复进入编辑模式
    if (messageEl.classList.contains('editing')) return;

    const role = messageEl.classList.contains('user') ? 'user' : 'assistant';

    // 获取当前内容和图片（统一从 state.messages 读取）
    let textContent = '';
    const images = [];
    let thinkingContent = ''; // 运行时局部变量，非旧格式字段
    if (!message) return;

    for (const part of message.parts) {
        if (part.type === PartType.THINKING) thinkingContent += part.text;
        else if (part.type === PartType.TEXT) textContent += part.text;
        else if (part.type === PartType.MEDIA && part.media === MediaKind.IMAGE) {
            images.push({
                type: 'image_url',
                image_url: { url: part.url },
                mediaId: part.mediaId,
                mime: part.mime
            });
        }
    }

    const contentDiv = messageEl.querySelector('.message-content');
    if (!contentDiv) return;

    // 编辑前 detach 工具调用节点（保留事件监听器，编辑期间作为只读预览显示在底部）
    const toolCallNodes = Array.from(contentDiv.querySelectorAll('.tool-calls-group'));
    toolCallNodes.forEach((n) => n.remove());

    // 检测多 text 合并场景（AI 在工具调用前后都说话时，多段 text 会被合并为一段）
    const toolCallCount = Array.isArray(message.parts)
        ? message.parts.filter((p) => p.type === PartType.TOOL_CALL).length
        : 0;
    const textPartCount = Array.isArray(message.parts)
        ? message.parts.filter((p) => p.type === PartType.TEXT).length
        : 0;

    // 创建编辑界面
    // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
    contentDiv.innerHTML = '';

    // 图片管理区域（现有图片 + 添加按钮）
    const imageManager = document.createElement('div');
    imageManager.className = 'edit-image-manager';

    // 创建可编辑的图片数组副本
    const editableImages = [...images];

    // 渲染图片预览
    const renderImagePreviews = () => {
        const container =
            imageManager.querySelector('.edit-images-container') || document.createElement('div');
        container.className = 'edit-images-container';
        // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
        container.innerHTML = '';

        editableImages.forEach((img, idx) => {
            const imgPreview = document.createElement('div');
            imgPreview.className = 'edit-image-item';

            // 提取图片 URL（使用 normalizeImage 统一处理所有格式）
            let imgUrl = '';
            const norm = normalizeImage(img);
            if (norm) {
                imgUrl = norm.dataUrl;
            }

            // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
            imgPreview.innerHTML = `
                <img src="${escapeHtml(imgUrl)}" alt="图片 ${idx + 1}" title="点击查看大图">
                <button class="edit-image-remove" data-index="${idx}" title="删除图片">×</button>
            `;

            // 点击图片放大
            imgPreview.querySelector('img').onclick = () => {
                eventBus.emit('ui:open-image-viewer', { url: imgUrl });
            };

            // 删除图片
            imgPreview.querySelector('.edit-image-remove').onclick = () => {
                editableImages.splice(idx, 1);
                renderImagePreviews();
            };

            container.appendChild(imgPreview);
        });

        // 添加新图片按钮
        const addBtn = document.createElement('button');
        addBtn.className = 'edit-image-add';
        addBtn.title = '添加图片';
        // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
        addBtn.innerHTML = `
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                <circle cx="8.5" cy="8.5" r="1.5"></circle>
                <polyline points="21 15 16 10 5 21"></polyline>
            </svg>
            <span>添加图片</span>
        `;
        addBtn.onclick = () => addNewImage(editableImages, renderImagePreviews);
        container.appendChild(addBtn);

        if (imageManager.querySelector('.edit-images-container')) {
            imageManager.replaceChild(
                container,
                imageManager.querySelector('.edit-images-container')
            );
        } else {
            imageManager.appendChild(container);
        }
    };

    renderImagePreviews();

    // 思维链编辑区域（仅AI消息显示）
    let thinkingTextarea = null;
    if (role === 'assistant') {
        const thinkingSection = document.createElement('div');
        thinkingSection.className = 'edit-thinking-section';

        const thinkingLabel = document.createElement('label');
        const thinkingIcon =
            '<svg class="edit-label-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/></svg>';
        // eslint-disable-next-line no-restricted-syntax -- 已审计：静态 SVG + 静态文本
        thinkingLabel.innerHTML = `${thinkingIcon} 思维链内容 <span class="hint">留空则删除思维链</span>`;

        thinkingTextarea = document.createElement('textarea');
        thinkingTextarea.className = 'edit-thinking-textarea';
        thinkingTextarea.value = thinkingContent;
        thinkingTextarea.rows = 5;
        thinkingTextarea.placeholder = '留空则删除思维链';

        // 初始化时自动调整高度
        setTimeout(() => autoResizeGeneric(thinkingTextarea, 80, 400), 0);
        thinkingTextarea.addEventListener('input', () =>
            autoResizeGeneric(thinkingTextarea, 80, 400)
        );

        thinkingSection.appendChild(thinkingLabel);
        thinkingSection.appendChild(thinkingTextarea);
        contentDiv.appendChild(thinkingSection);
    }

    // 文本编辑区域
    const textarea = document.createElement('textarea');
    textarea.className = 'edit-textarea';
    textarea.value = textContent;
    textarea.rows = 3;

    // 初始化时自动调整高度
    setTimeout(() => autoResizeGeneric(textarea, 60, 400), 0);
    textarea.addEventListener('input', () => autoResizeGeneric(textarea, 60, 400));

    // 操作按钮
    const editActions = document.createElement('div');
    editActions.className = 'edit-actions';

    const saveBtn = document.createElement('button');
    saveBtn.className = 'btn-primary';
    saveBtn.textContent = '保存';
    saveBtn.onclick = async () => {
        const newContent = textarea.value.trim();
        const newThinking = thinkingTextarea?.value.trim() || null; // 获取思维链

        // 验证：防止保存空消息
        if (!newContent && editableImages.length === 0) {
            eventBus.emit('ui:notification', {
                message: '消息不能为空（至少需要文本或图片）',
                type: 'warning'
            });
            return;
        }

        // 根据是否有思维链选择不同的更新函数
        if (role === 'assistant' && thinkingTextarea) {
            updateMessageWithThinking(index, newContent, newThinking, editableImages, role);
        } else {
            updateMessageContentWithImages(index, newContent, editableImages, role);
        }
        const [messageOverride] = await resolveMessagesMediaForApi([state.messages[index]]);
        if (rerenderMessageContent(messageEl, index, role, messageOverride)) {
            eventBus.emit('ui:notification', { message: '消息已保存', type: 'success' });
        }
    };

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn-secondary';
    cancelBtn.textContent = '取消';
    cancelBtn.onclick = () => {
        rerenderMessageContent(messageEl, index, role, message);
    };

    editActions.appendChild(saveBtn);
    editActions.appendChild(cancelBtn);

    // 组装编辑界面
    if (editableImages.length > 0 || role === 'user') {
        contentDiv.appendChild(imageManager);
    }
    contentDiv.appendChild(textarea);
    contentDiv.appendChild(editActions);

    // 含工具调用 / 多段文本时的提示条
    if (toolCallCount > 0 || textPartCount > 1) {
        const notice = document.createElement('div');
        notice.className = 'edit-tool-calls-notice';
        const segments = [];
        if (toolCallCount > 0) segments.push(`含 ${toolCallCount} 个工具调用，保存时原样保留`);
        if (textPartCount > 1) segments.push('多段文本将合并为一段');
        notice.textContent = segments.join(' · ');
        contentDiv.appendChild(notice);
    }

    // 工具调用节点只读预览（detach 后挂回底部，保留原事件监听器）
    if (toolCallNodes.length > 0) {
        const preview = document.createElement('div');
        preview.className = 'edit-tool-calls-preview';
        toolCallNodes.forEach((n) => preview.appendChild(n));
        contentDiv.appendChild(preview);
    }

    messageEl.classList.add('editing');
    textarea.focus();
}

/**
 * 更新消息内容（同步更新三种格式）
 * @param {number} index - 消息索引
 * @param {string} newContent - 新内容
 * @param {string} role - 角色
 */
export function updateMessageContent(index, newContent, _role) {
    if (!state.messages[index]) return;

    const msg = state.messages[index];
    const updates = {};

    updates.parts = preserveStructuralParts(msg.parts, {
        newText: newContent,
        newImages: null
    });

    updateCanonicalMessage(index, updates);
    clearSubsequentSignatures(index);
    runPostEditValidation();

    eventBus.emit('messages:changed', { action: 'updated', index });
}

/**
 * 清除编辑消息后续的 thoughtSignature
 */
function clearSubsequentSignatures(index) {
    if (index >= state.messages.length - 1) return;
    if (!hasThoughtSignatures(state.messages, index + 1)) return;

    const clearedCount = clearThoughtSignatures(state.messages, index + 1);

    eventBus.emit('ui:notification', {
        message: `编辑消息会影响思维链，已清除 ${clearedCount} 个签名。下次对话将重新生成思维链。`,
        type: 'warning',
        duration: 5000
    });
}

/**
 * 更新消息内容并保留图片（同步更新三种格式）
 * 编辑消息时不会丢失图片数据
 * @param {number} index - 消息索引
 * @param {string} newText - 新文本内容
 * @param {Array} images - 图片数组
 * @param {string} role - 角色
 */
export function updateMessageContentWithImages(index, newText, images, _role) {
    const normalized = images.map(normalizeImage).filter(Boolean);
    const hasImages = normalized.length > 0;

    if (!state.messages[index]) return;

    const msg = state.messages[index];
    const updates = {};

    updates.parts = preserveStructuralParts(msg.parts, {
        newText,
        newImages: hasImages ? normalized : null
    });

    updateCanonicalMessage(index, updates);
    clearSubsequentSignatures(index);
    runPostEditValidation();

    eventBus.emit('messages:changed', { action: 'updated', index });
}

/**
 * 附件对象数组 → parts[]，发送与编辑保存共用同一构造逻辑
 * @param {Array} files - {name, type, category, data} 附件对象数组
 * @returns {Array} parts 数组
 */
export function buildAttachmentParts(files) {
    const parts = [];
    for (const file of files || []) {
        const cat = file.category || categorizeFile(file.type);
        if (cat === 'image') {
            parts.push(
                mediaPart(MediaKind.IMAGE, file.mediaId ? null : file.data, file.type, {
                    mediaId: file.mediaId
                })
            );
        } else if (cat === 'video') {
            parts.push(
                mediaPart(MediaKind.VIDEO, file.mediaId ? null : file.data, file.type, {
                    mediaId: file.mediaId
                })
            );
        } else if (cat === 'pdf') {
            parts.push(
                filePart(file.name, file.type, file.mediaId ? null : file.data, {
                    mediaId: file.mediaId
                })
            );
        } else if (cat === 'text') {
            parts.push(
                filePart(file.name, file.type || 'text/plain', file.mediaId ? null : file.data, {
                    encoding: 'text',
                    mediaId: file.mediaId
                })
            );
        }
    }
    return parts;
}

/**
 * 用输入框草稿（文本 + 完整附件对象）重建用户消息 parts
 * 附件按 category 分派 media/file part；非图片 MEDIA 与 TOOL_CALL 等结构 part 原样保留
 * @param {number} index - 消息索引
 * @param {string} newText - 新文本内容
 * @param {Array} attachments - 完整附件对象数组
 */
export function updateUserMessageFromDraft(index, newText, attachments) {
    if (!state.messages[index]) return;

    const msg = state.messages[index];
    const parts = [];
    if (newText) parts.push(textPart(newText));
    parts.push(...buildAttachmentParts(attachments));

    if (Array.isArray(msg.parts)) {
        for (const p of msg.parts) {
            if (p.type === PartType.TEXT || p.type === PartType.FILE) continue;
            if (p.type === PartType.MEDIA && (!p.media || p.media === MediaKind.IMAGE)) continue;
            parts.push(p);
        }
    }

    updateCanonicalMessage(index, { parts });
    clearSubsequentSignatures(index);
    runPostEditValidation();

    eventBus.emit('messages:changed', { action: 'updated', index });
}

/**
 * 删除消息
 * @param {HTMLElement} messageEl - 消息元素
 */
export async function deleteMessage(messageEl) {
    const hit = resolveMessageHit(messageEl);
    if (!hit) return;
    let index = hit.index;
    const messageId = hit.msg?.id || null;

    // 流式响应中禁止删除：消息 DOM 被 remove 后 state.currentAssistantMessage 指向 detached
    // node，后续 rAF 持续往 detached tree 写 innerHTML；finalRender 时 saveAssistantMessage
    // 通过 .closest('.message').dataset.messageIndex 取索引会取到 -1 落到错误位置。
    // 编辑/清空路径已有 isLoading 守卫，删除路径之前漏了
    if (state.isLoading) {
        eventBus.emit('ui:notification', { message: '请等待回复完成后再删除', type: 'warning' });
        return;
    }

    // 使用自定义确认对话框
    const confirmed = await showConfirmDialog('确定要删除这条消息吗？', '确认删除');
    if (!confirmed) {
        return;
    }

    await materializeCurrentSessionMessages();
    if (messageId) {
        index = state.messageStore.findIndexById(messageId);
        if (index < 0) return;
    }

    // 删除目标是正在编辑的消息时先退出编辑模式，避免保存时写入错误消息
    if (state.editingIndex !== null && resolveEditingIndex() === index) {
        exitInputEditMode();
    }

    // 使用工具调用兼容的安全删除（自动处理关联的工具结果消息）
    const result = safeDeleteMessage(index);

    if (!result.success) {
        eventBus.emit('ui:notification', {
            message: result.error || '删除失败',
            type: 'error'
        });
        return;
    }

    // 关联删除（工具结果消息等）可能波及编辑目标，删除后按 id 兜底检测
    if (state.editingIndex !== null && resolveEditingIndex() < 0) {
        exitInputEditMode();
    }

    // 发出事件通知
    eventBus.emit('messages:changed', {
        action: 'deleted',
        index,
        deletedCount: result.deletedIndices.length
    });

    // 显示删除通知
    const message =
        result.deletedIndices.length > 1
            ? `已删除 ${result.deletedIndices.length} 条消息`
            : '消息已删除';
    eventBus.emit('ui:notification', { message, type: 'info' });
}

/**
 * 删除指定索引后的所有消息
 * @param {number} index - 起始索引
 */
export function removeMessagesAfterAll(index) {
    // 使用安全的状态更新函数
    removeMessagesAfter(index);

    state.currentAssistantMessage = null;

    // 通知会话保存
    eventBus.emit('messages:changed', {
        action: 'removed_after',
        index
    });
}

/**
 * 重试功能（重新生成助手消息）
 * @param {HTMLElement} [messageEl] - 目标助手消息元素，省略时重发最后一条
 */
export async function handleRetry(messageEl = null) {
    if (state.isLoading) return;

    // 清空当前的多回复状态
    state.currentReplies = [];
    state.selectedReplyIndex = 0;

    // 检查是否有内容可以重试
    if (state.messages.length === 0) return;

    // 重发目标之后的消息都基于旧回复产生，必须一并移除；
    // 定位失败或目标位于首条（无输入可重发）时回退到"重发最后一条"
    const hit = messageEl ? resolveMessageHit(messageEl) : null;
    if (hit && hit.index > 0 && hit.msg?.role === 'assistant') {
        removeMessagesAfter(hit.index - 1);
    } else {
        popLastAssistantMessage();
    }

    // 通知会话保存
    eventBus.emit('messages:changed', {
        action: 'retry',
        index: state.messages.length
    });

    // 请求重新发送（由 API 层处理）
    eventBus.emit('api:resend-requested');
}

/**
 * 解析消息元素到 {msg, index}，统一委托 store.findByEl
 * @param {HTMLElement} messageEl - 消息元素
 * @returns {{msg: Object, index: number} | null}
 */
function resolveMessageHit(messageEl) {
    return state.messageStore.findByEl(messageEl, { messagesArea: elements.messagesArea });
}

// ========== 编辑目标与输入框草稿 ==========

let editingMessageId = null;
let stashedDraft = null;

/**
 * 解析当前编辑目标的实时索引
 * 编辑期间删除/重排其他消息后 state.editingIndex 会错位，按 id 重新定位
 * @returns {number} -1 表示目标消息已不存在
 */
export function resolveEditingIndex() {
    if (editingMessageId) return state.messageStore.findIndexById(editingMessageId);
    // 无 id 的旧数据回落到进入编辑时记录的索引
    return typeof state.editingIndex === 'number' ? state.editingIndex : -1;
}

/**
 * 结束一次输入框编辑：清除编辑目标 id 并恢复进入编辑前暂存的草稿
 */
export function endEditingState() {
    editingMessageId = null;
    void restoreInputDraft();
}

/**
 * 进入编辑模式前暂存输入框中未发送的草稿（文本 + 附件引用）
 */
function stashInputDraft() {
    if (stashedDraft) return;
    const text = elements.userInput?.value ?? '';
    const attachments = Array.isArray(state.uploadedImages) ? [...state.uploadedImages] : [];
    if (!text.trim() && attachments.length === 0) return;
    stashedDraft = { text, attachments, sessionId: state.currentSessionId ?? null };
}

async function restoreInputDraft() {
    if (!stashedDraft) return;
    const draft = stashedDraft;
    stashedDraft = null;
    // 会话已切换时不跨会话恢复，与切换会话清空输入框的既有行为一致
    if (draft.sessionId !== (state.currentSessionId ?? null)) return;
    if (!elements.userInput) return;
    const hasCurrent =
        elements.userInput.value.trim() ||
        (Array.isArray(state.uploadedImages) && state.uploadedImages.length > 0);
    if (hasCurrent) {
        const confirmed = await showConfirmDialog(
            '恢复编辑前未发送的草稿将覆盖当前输入内容，确定恢复？',
            '恢复草稿'
        );
        if (!confirmed) return;
    }
    elements.userInput.value = draft.text;
    state.uploadedImages = draft.attachments;
    eventBus.emit('editor:refresh-attachments');
    eventBus.emit('editor:resize-textarea');
}

/**
 * 退出输入框编辑模式（删除编辑目标等 editor 侧触发的场景）
 * emit editor:mode-changed 让 input.js 同步按钮状态、本模块收尾草稿恢复
 */
function exitInputEditMode() {
    if (state.editingIndex === null) return;
    if (elements.userInput) elements.userInput.value = '';
    state.uploadedImages = [];
    if (state.editingElement) {
        state.editingElement.classList.remove('editing');
        state.editingElement = null;
    }
    state.editingIndex = null;
    eventBus.emit('editor:refresh-attachments');
    eventBus.emit('editor:resize-textarea');
    eventBus.emit('editor:mode-changed', { isEditing: false });
}

// ========== 事件监听 ==========

// Esc / 会话切换等路径只 emit 事件不经过 input.js 的退出函数，在此统一收尾
eventBus.on('editor:mode-changed', ({ isEditing }) => {
    if (!isEditing) endEditingState();
});

// 监听编辑请求
eventBus.on('message:edit-requested', ({ messageEl }) => {
    // 工具调用兼容性检查
    const hit = resolveMessageHit(messageEl);
    if (hit) {
        const checkResult = canEditMessage(hit.index);
        if (!checkResult.canEdit) {
            // 不可编辑，已由 message-compat.js 发出通知
            return;
        }
    }

    // 根据消息角色选择编辑方式
    const isUser = messageEl.classList.contains('user');
    if (isUser) {
        enterEditMode(messageEl); // 用户消息：在输入框编辑
    } else {
        void editMessageInPlace(messageEl); // AI消息：原地编辑
    }
});

// 监听删除请求
eventBus.on('message:delete-requested', ({ messageEl }) => {
    deleteMessage(messageEl);
});

// 监听重试请求
eventBus.on('message:retry-requested', ({ messageEl } = {}) => {
    handleRetry(messageEl);
});

// 监听复制全文请求：用 getTextContent 抽出新格式 parts 的 TEXT 合并文本（旧格式有兜底）
eventBus.on('message:copy-requested', async ({ messageEl }) => {
    const hit = resolveMessageHit(messageEl);
    if (!hit) {
        eventBus.emit('ui:notification', { message: '消息不存在', type: 'error' });
        return;
    }
    const msg = hit.msg;
    if (!msg) return;
    const { getTextContent } = await import('./schema.js');
    const text = getTextContent(msg);
    if (!text) {
        eventBus.emit('ui:notification', { message: '消息无可复制的文本内容', type: 'warning' });
        return;
    }
    try {
        await navigator.clipboard.writeText(text);
        eventBus.emit('ui:notification', { message: '已复制全文', type: 'success' });
    } catch (err) {
        logger.error('[Editor] 复制失败:', err);
        eventBus.emit('ui:notification', { message: '复制失败，请手动选中', type: 'error' });
    }
});

/**
 * 按 thinking/text/media/tool_call/file 原相对位置重建 parts，保留 tool_call/file 原顺序
 * 不再把保留 part 一律塞末尾（避免破坏 Claude/OpenAI Responses 重发顺序）
 *
 * @param {Array} oldParts - 原 parts 数组
 * @param {Object} replacement - { newThinking?, newText, newImages? }
 * @returns {Array} 重建后的 parts 数组
 * @internal 仅供测试 import；运行时使用方仍在本模块内
 */
export function preserveStructuralParts(oldParts, replacement) {
    const { newThinking, newText, newImages } = replacement;
    const out = [];
    let thinkingInserted = false;
    let textInserted = false;
    let imagesInserted = false;
    const appendImages = (target) => {
        for (const image of newImages || []) {
            target.push(
                mediaPart(MediaKind.IMAGE, image.mediaId ? null : image.dataUrl, image.mimeType, {
                    mediaId: image.mediaId
                })
            );
        }
    };

    for (const p of oldParts) {
        if (p.type === PartType.THINKING) {
            if (!thinkingInserted && newThinking) {
                out.push({ type: PartType.THINKING, text: newThinking, _edited: true });
                thinkingInserted = true;
            }
            continue;
        }
        if (p.type === PartType.TEXT) {
            if (!textInserted) {
                out.push({ type: PartType.TEXT, text: newText });
                textInserted = true;
            }
            continue;
        }
        if (p.type === PartType.MEDIA) {
            // 编辑器只管理图片，video/audio 等其他媒体子类型原样保留
            if (p.media && p.media !== MediaKind.IMAGE) {
                out.push(p);
                continue;
            }
            if (!imagesInserted && newImages && newImages.length > 0) {
                appendImages(out);
                imagesInserted = true;
            }
            continue;
        }
        out.push(p);
    }

    const prefix = [];
    if (!thinkingInserted && newThinking) {
        prefix.push({ type: PartType.THINKING, text: newThinking, _edited: true });
    }
    if (!textInserted) {
        prefix.push({ type: PartType.TEXT, text: newText });
    }
    if (!imagesInserted && newImages && newImages.length > 0) {
        appendImages(prefix);
    }
    return prefix.length > 0 ? [...prefix, ...out] : out;
}

/**
 * 跨 family 编辑守卫：Claude/openclaw 清 _turn 防 'thinking blocks must match' 400
 * OpenAI Responses 不清（reasoningItems 与 _turn 一一对应）但发出 warning 提示风险
 * @returns {{ok:boolean, warning?:string}}
 * @internal 仅供测试 import；运行时使用方仍在本模块内
 */
export function ensureTurnConsistency(msg, currentFormat) {
    const parts = msg.parts || [];
    const hasMultiTurn = parts.some((p) => p._turn !== undefined && p._turn > 0);
    if (!hasMultiTurn) return { ok: true };

    const isClaudeFamily = currentFormat === 'claude' || currentFormat === 'openclaw';
    const isResponses = currentFormat === 'openai-responses';

    if (isClaudeFamily) {
        for (const p of parts) {
            if (p._turn !== undefined) delete p._turn;
        }
        if (msg.meta?.raw?.openai?.reasoningItems) {
            for (const item of msg.meta.raw.openai.reasoningItems) {
                if (item && typeof item === 'object' && item._turn !== undefined) {
                    delete item._turn;
                }
            }
        }
        return { ok: true };
    }

    if (isResponses) {
        return { ok: true, warning: 'reasoning_chain_at_risk' };
    }

    return { ok: true };
}

/**
 * 从任意格式的图片对象中提取 {mimeType, data} 结构
 * 避免 data URL 字符串的往返拼接/解析
 */
function normalizeImage(img) {
    // OpenAI 格式
    const url = img.image_url?.url || img.url || (typeof img === 'string' ? img : '');
    if (url) {
        const match = url.match(/^data:([^;]+);base64,(.+)$/);
        if (match) {
            return {
                mimeType: match[1],
                data: match[2],
                dataUrl: url,
                mediaId: img.mediaId || null
            };
        }
        return {
            mimeType: img.mime || '',
            data: '',
            dataUrl: url,
            mediaId: img.mediaId || null
        }; // 远程 URL
    }
    // Gemini 格式（直接取结构，无需拼字符串）
    const inlineData = img.inlineData || img.inline_data;
    if (inlineData) {
        const mime = inlineData.mimeType || inlineData.mime_type;
        return {
            mimeType: mime,
            data: inlineData.data,
            dataUrl: `data:${mime};base64,${inlineData.data}`
        };
    }
    // Claude 格式
    if (img.source?.data) {
        const mime = img.source.media_type;
        return {
            mimeType: mime,
            data: img.source.data,
            dataUrl: `data:${mime};base64,${img.source.data}`
        };
    }
    return null;
}

function updateCanonicalMessage(index, updates) {
    updateMessageAt(index, updates);
    const msg = state.messages[index];
    if (msg) syncPartsToSelectedReply(msg);
}

/**
 * 编辑结果写回 replies.all[selected]，保持多回复分支与顶层 parts 一致
 * structuredClone 防止 reply.parts 与 msg.parts 共享引用后被二次编辑污染
 */
function syncPartsToSelectedReply(msg) {
    const all = msg.replies?.all;
    if (!Array.isArray(all) || all.length === 0) return;
    const sel = msg.replies.selected;
    if (!Number.isInteger(sel) || sel < 0 || sel >= all.length) return;
    const reply = all[sel];
    if (!reply || typeof reply !== 'object') return;
    all[sel] = { ...reply, parts: structuredClone(msg.parts) };
}

/**
 * 编辑后异步校验跨消息 tool_call 配对（fire-and-forget，不阻塞主流程）
 */
function runPostEditValidation() {
    import('./schema.js')
        .then(({ validateToolPairings }) => {
            const v = validateToolPairings(state.messages);
            if (!v.valid) {
                logger.warn('[editor] 编辑后检测到 tool_call 孤儿:', v.orphans);
            }
        })
        .catch((e) => {
            logger.warn('[editor] validateToolPairings 调用失败:', e);
        });
}

/**
 * 添加新图片到编辑中的消息
 * 完整的图片管理功能
 * @param {Array} editableImages - 可编辑的图片数组
 * @param {Function} renderCallback - 渲染回调函数
 */
async function addNewImage(editableImages, renderCallback) {
    // 检查图片数量限制
    const MAX_IMAGES = 10;
    if (editableImages.length >= MAX_IMAGES) {
        eventBus.emit('ui:notification', {
            message: `最多只能添加 ${MAX_IMAGES} 张图片`,
            type: 'error'
        });
        return;
    }

    // 创建文件选择器
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.multiple = false;

    input.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file || !file.type.startsWith('image/')) {
            eventBus.emit('ui:notification', {
                message: '请选择有效的图片文件',
                type: 'error'
            });
            return;
        }

        if (file.size > MAX_FILE_SIZE) {
            eventBus.emit('ui:notification', {
                message: `文件 "${file.name}" 超过 20MB 限制`,
                type: 'error'
            });
            return;
        }

        try {
            // 读取文件为 base64
            const base64 = await fileToBase64(file);

            // 统一使用 OpenAI 格式（updateMessageContentWithImages 会处理转换）
            const imageObj = {
                type: 'image_url',
                image_url: { url: base64 }
            };

            editableImages.push(imageObj);
            renderCallback();

            eventBus.emit('ui:notification', {
                message: '图片已添加',
                type: 'success'
            });
        } catch (error) {
            logger.error('添加图片失败:', error);
            eventBus.emit('ui:notification', {
                message: '添加图片失败',
                type: 'error'
            });
        }
    };

    input.click();
}

/**
 * 将文件转换为 base64
 * @param {File} file - 文件对象
 * @returns {Promise<string>} Base64 数据 URL
 */
function fileToBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

/**
 * 更新消息内容（支持思维链编辑）
 * 同步更新三种格式，并清除签名
 * @param {number} index - 消息索引
 * @param {string} newText - 新文本内容
 * @param {string|null} newThinking - 新思维链内容
 * @param {Array} images - 图片数组
 * @param {string} role - 角色
 */
export function updateMessageWithThinking(index, newText, newThinking, images, _role) {
    const normalized = images.map(normalizeImage).filter(Boolean);
    const hasImages = normalized.length > 0;

    if (!state.messages[index]) return;

    const msg = state.messages[index];

    // 构建新格式 parts
    const updates = {};

    // 跨 family 编辑守卫：Claude/openclaw 走严格 'thinking blocks must match' 校验需清 _turn；
    // OpenAI Responses 依赖 _turn 配对 reasoningItems，清掉会触发 reasoning_id_not_found，仅警告
    const turnCheck = ensureTurnConsistency(msg, state.apiFormat || '');
    if (turnCheck.warning === 'reasoning_chain_at_risk') {
        eventBus.emit('ui:notification', {
            message: '当前消息含多轮 reasoning 链，编辑后下次重发可能触发 reasoning_id_not_found',
            type: 'warning',
            duration: 5000
        });
    }
    updates.parts = preserveStructuralParts(msg.parts, {
        newThinking,
        newText,
        newImages: hasImages ? normalized : null
    });

    updateCanonicalMessage(index, updates);
    clearSubsequentSignatures(index);
    runPostEditValidation();

    eventBus.emit('messages:changed', { action: 'updated', index });
}
