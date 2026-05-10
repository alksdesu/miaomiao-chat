/**
 * 快捷消息 UI 控制模块
 * 处理模态框显示、列表渲染和用户交互
 */

import { state } from '../core/state.js';
import { elements } from '../core/elements.js';
import { eventBus } from '../core/events.js';
import {
    createQuickMessage,
    updateQuickMessage,
    deleteQuickMessage,
    sendQuickMessage
} from '../state/quick-messages.js';
import { escapeHtml } from '../utils/helpers.js';
import { showNotification } from './notifications.js';
import { showConfirmDialog } from '../utils/dialogs.js';
import { bindTopmostEscape, setupModalFocus } from '../utils/modal-stack.js';
import { logger } from '../utils/logger.js';

// 模块状态
let currentEditingId = null;
let removeMainModalFocus = null;
let removeEditModalFocus = null;
let removeMainModalEscape = null;
let removeEditModalEscape = null;

/**
 * 初始化快捷消息 UI
 */
export function initQuickMessagesUI() {
    bindEvents();
    logger.debug('Quick Messages UI initialized');
}

/**
 * 绑定事件
 */
function bindEvents() {
    // 打开主模态框
    elements.quickMessagesToggle?.addEventListener('click', openQuickMessagesModal);

    // 关闭主模态框
    elements.closeQuickMessagesModal?.addEventListener('click', closeQuickMessagesModal);
    elements.quickMessagesModal
        ?.querySelector('.modal-overlay')
        ?.addEventListener('click', closeQuickMessagesModal);

    // 新建按钮
    elements.addQuickMessageBtn?.addEventListener('click', () => openEditModal());

    // 列表项点击（事件委托）
    elements.quickMessagesList?.addEventListener('click', handleListClick);

    // 列表项键盘支持（Enter/Space）
    elements.quickMessagesList?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            const messageItem = e.target.closest('.quick-message-item');
            if (messageItem && !e.target.classList.contains('qm-action-btn')) {
                e.preventDefault();
                const id = messageItem.dataset.id;
                sendQuickMessage(id);
            }
        }
    });

    // 保存/取消编辑
    elements.saveQmBtn?.addEventListener('click', saveQuickMessageHandler);
    elements.cancelEditQmBtn?.addEventListener('click', closeEditModal);

    // 关闭编辑模态框
    elements.closeEditQmModal?.addEventListener('click', closeEditModal);
    elements.editQuickMessageModal
        ?.querySelector('.modal-overlay')
        ?.addEventListener('click', closeEditModal);

    // Enter 快捷键保存（在输入框按 Ctrl+Enter）
    elements.qmContentInput?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && e.ctrlKey) {
            e.preventDefault();
            saveQuickMessageHandler();
        }
    });

    // 监听快捷消息更新事件
    eventBus.on('quickmsg:updated', renderQuickMessagesList);
    eventBus.on('quickmsg:modal-close-requested', closeQuickMessagesModal);
}

/**
 * 打开快捷消息模态框
 */
function openQuickMessagesModal() {
    const modal = elements.quickMessagesModal;
    if (!modal) return;

    modal.classList.add('active');
    renderQuickMessagesList();

    removeMainModalFocus?.();
    removeMainModalFocus = setupModalFocus(modal, {
        labelledBy: 'quick-messages-modal-title'
    });

    // 顶层弹层优先消费 Escape，避免继续传到底层弹层
    removeMainModalEscape?.();
    removeMainModalEscape = bindTopmostEscape(modal, closeQuickMessagesModal);
}

/**
 * 关闭快捷消息模态框
 */
function closeQuickMessagesModal() {
    elements.quickMessagesModal?.classList.remove('active');

    // 清理焦点约束
    if (removeMainModalFocus) {
        removeMainModalFocus();
        removeMainModalFocus = null;
    }

    removeMainModalEscape?.();
    removeMainModalEscape = null;
}

/**
 * 渲染快捷消息列表
 */
export function renderQuickMessagesList() {
    if (!elements.quickMessagesList) return;

    if (state.quickMessages.length === 0) {
        // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
        elements.quickMessagesList.innerHTML = `
            <div class="empty-quick-messages">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                    <path d="M8 10h8M8 14h4"/>
                </svg>
                <p>还没有快捷消息</p>
                <p class="empty-hint">点击上方 + 按钮创建第一个快捷消息</p>
            </div>
        `;
        return;
    }

    // 按分类分组
    const grouped = {};
    for (const msg of state.quickMessages) {
        const category = msg.category || '常用';
        if (!grouped[category]) {
            grouped[category] = [];
        }
        grouped[category].push(msg);
    }

    let html = '';

    for (const [category, messages] of Object.entries(grouped)) {
        html += `<div class="quick-message-category">
            <div class="category-header">${escapeHtml(category)}</div>`;

        for (const msg of messages) {
            html += `
                <div class="quick-message-item" data-id="${escapeHtml(msg.id)}" tabindex="0" role="button" aria-label="发送快捷消息: ${escapeHtml(msg.name)}">
                    <div class="qm-item-content">
                        <div class="qm-item-name">${escapeHtml(msg.name)}</div>
                        <div class="qm-item-preview">${escapeHtml(msg.content.slice(0, 50))}${msg.content.length > 50 ? '...' : ''}</div>
                    </div>
                    <div class="qm-item-actions">
                        <button class="qm-action-btn edit" data-id="${escapeHtml(msg.id)}" title="编辑" aria-label="编辑 ${escapeHtml(msg.name)}">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                            </svg>
                        </button>
                        <button class="qm-action-btn delete" data-id="${escapeHtml(msg.id)}" title="删除" aria-label="删除 ${escapeHtml(msg.name)}">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/>
                            </svg>
                        </button>
                    </div>
                </div>
            `;
        }

        html += `</div>`;
    }

    // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
    elements.quickMessagesList.innerHTML = html;
}

/**
 * 删除快捷消息（带确认）
 * @param {string} id - 消息ID
 * @param {string} name - 消息名称
 */
async function handleDeleteQuickMessage(id, name) {
    const confirmed = await showConfirmDialog(`确定要删除快捷消息 "${name}" 吗？`, '确认删除');
    if (confirmed) {
        deleteQuickMessage(id);
    }
}

/**
 * 处理列表项点击（事件委托）
 * @param {Event} e - 点击事件
 */
function handleListClick(e) {
    const target = e.target;

    // 编辑按钮
    const editBtn = target.closest('.qm-action-btn.edit');
    if (editBtn) {
        e.stopPropagation();
        const id = editBtn.dataset.id;
        openEditModal(id);
        return;
    }

    // 删除按钮
    const deleteBtn = target.closest('.qm-action-btn.delete');
    if (deleteBtn) {
        e.stopPropagation();
        const id = deleteBtn.dataset.id;
        const message = state.quickMessages.find((m) => m.id === id);
        if (message) {
            handleDeleteQuickMessage(id, message.name);
        }
        return;
    }

    // 点击消息项本身 - 发送
    const messageItem = target.closest('.quick-message-item');
    if (messageItem) {
        const id = messageItem.dataset.id;
        sendQuickMessage(id);
    }
}

/**
 * 打开编辑模态框
 * @param {string|null} id - 消息 ID（null 表示新建）
 */
function openEditModal(id = null) {
    currentEditingId = id;

    if (id) {
        // 编辑模式
        const message = state.quickMessages.find((m) => m.id === id);
        if (!message) return;

        document.getElementById('edit-qm-modal-title').textContent = '编辑快捷消息';
        elements.qmNameInput.value = message.name;
        elements.qmContentInput.value = message.content;
        elements.qmCategoryInput.value = message.category || '常用';
    } else {
        // 新建模式
        document.getElementById('edit-qm-modal-title').textContent = '新建快捷消息';
        elements.qmNameInput.value = '';
        elements.qmContentInput.value = '';
        elements.qmCategoryInput.value = '常用';
    }

    const modal = elements.editQuickMessageModal;
    if (!modal) return;

    modal.classList.add('active');

    removeEditModalFocus?.();
    removeEditModalFocus = setupModalFocus(modal, {
        labelledBy: 'edit-qm-modal-title',
        initialFocus: '#qm-name-input'
    });

    // 顶层弹层优先消费 Escape，避免一次按键关闭到底层主弹层
    removeEditModalEscape?.();
    removeEditModalEscape = bindTopmostEscape(modal, closeEditModal);
}

/**
 * 关闭编辑模态框
 */
function closeEditModal() {
    elements.editQuickMessageModal?.classList.remove('active');
    currentEditingId = null;

    // 清理焦点约束
    if (removeEditModalFocus) {
        removeEditModalFocus();
        removeEditModalFocus = null;
    }

    removeEditModalEscape?.();
    removeEditModalEscape = null;
}

/**
 * 保存快捷消息（新建或更新）
 */
function saveQuickMessageHandler() {
    const name = elements.qmNameInput.value.trim();
    const content = elements.qmContentInput.value.trim();
    const category = elements.qmCategoryInput.value;

    // 验证
    if (!name) {
        showNotification('请输入消息名称', 'error');
        elements.qmNameInput.focus();
        return;
    }

    if (!content) {
        showNotification('请输入消息内容', 'error');
        elements.qmContentInput.focus();
        return;
    }

    if (currentEditingId) {
        // 更新
        updateQuickMessage(currentEditingId, { name, content, category });
    } else {
        // 新建
        createQuickMessage(name, content, category);
    }

    closeEditModal();
}
