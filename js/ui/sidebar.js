/**
 * 侧边栏控制模块
 * 处理会话列表的显示和交互
 */

import { state, elements } from '../core/state.js';
import { eventBus } from '../core/events.js';
import {
    switchToSession,
    deleteSession,
    renameSession,
    createNewSession,
    reloadCurrentSessionMessages
} from '../state/sessions.js';
import { escapeHtml } from '../utils/helpers.js';
import { trapFocus, removeFocusTrap, acquireInert, releaseInert } from '../utils/focus-trap.js';
import { getSessionSearchState, highlightMatch } from './session-search.js';
import { sessionToMarkdown } from '../state/export-import.js';
import { getIcon } from '../utils/icons.js';
import { showNotification } from './notifications.js';
import { locateMessageByReference } from './message-location.js';
// 新增：IndexedDB 偏好设置 API
import { savePreference, loadSessionMessages } from '../state/storage.js';
// 新增：自定义对话框（替代 Electron 中不支持的 prompt/confirm）
import { showInputDialog, showConfirmDialog } from '../utils/dialogs.js';
import { logger } from '../utils/logger.js';
import { getCurrentSessionMessagesSnapshot } from '../state/session-message-repository.js';
import {
    loadFolders,
    createFolder,
    renameFolder as renameFolderAction,
    deleteFolder as deleteFolderAction,
    toggleFolderCollapse
} from '../state/folders.js';
import { initSidebarDragAndDrop } from './sidebar-dnd.js';
import { initFolderContextMenu } from './sidebar-folder-menu.js';

// 模块状态
let _initialized = false;
let _subscriptions = [];
let _lastSearchActive = false;

/**
 * 获取用于导出的完整会话数据
 * v4 之后 state.sessions 里通常只有元数据，需要按需加载 messages store
 * @param {Object} sessionMeta - 会话元数据
 * @returns {Promise<Object>} 包含完整消息的会话对象
 */
async function getSessionDataForExport(sessionMeta) {
    if (!sessionMeta) return null;

    // 兼容旧结构：session 对象本身已包含消息
    if (Array.isArray(sessionMeta.messages)) {
        return sessionMeta;
    }

    // 当前激活会话优先使用内存中的实时消息，避免导出到旧快照
    if (sessionMeta.id === state.currentSessionId) {
        return {
            ...sessionMeta,
            messages: await getCurrentSessionMessagesSnapshot()
        };
    }

    // v4 正常路径：从独立 messages store 读取
    const messageData = await loadSessionMessages(sessionMeta.id);
    if (messageData) {
        return { ...sessionMeta, ...messageData };
    }

    // 兼容未迁移的 v3 数据
    return {
        ...sessionMeta,
        messages: sessionMeta._pendingMessages || []
    };
}

/**
 * 切换侧边栏
 * @param {boolean} skipSave - 是否跳过保存状态
 */
export async function toggleSidebar(skipSave = false) {
    if (!elements.sidebar) return;

    const isOpening = !elements.sidebar.classList.contains('open');
    elements.sidebar.classList.toggle('open');

    // 同步控制 overlay 显示
    const overlay = document.querySelector('.sidebar-overlay');
    if (overlay) {
        if (isOpening) {
            overlay.style.visibility = 'visible';
            overlay.style.opacity = '1';
            overlay.style.pointerEvents = 'auto';
        } else {
            overlay.style.visibility = 'hidden';
            overlay.style.opacity = '0';
            overlay.style.pointerEvents = 'none';
        }
    }

    elements.sidebarToggle?.setAttribute('aria-expanded', isOpening ? 'true' : 'false');

    if (isOpening) {
        // 打开时启用焦点陷阱
        trapFocus(elements.sidebar);
        // 禁用主内容的交互
        acquireInert();
        // 等开合动画启动后再移焦点，避免聚焦尚不可见的元素失败
        setTimeout(() => {
            if (elements.sidebar?.classList.contains('open')) {
                elements.closeSidebar?.focus();
            }
        }, 100);
    } else {
        // 关闭时移除焦点陷阱
        removeFocusTrap(elements.sidebar);
        // 恢复主内容交互
        releaseInert();
        // 返回焦点到触发按钮
        elements.sidebarToggle?.focus();
    }

    // 保存侧边栏状态
    if (!skipSave) {
        try {
            if (state.storageMode !== 'localStorage') {
                await savePreference('sidebarOpen', isOpening);
            } else {
                localStorage.setItem('sidebarOpen', isOpening ? 'true' : 'false');
            }
        } catch (error) {
            logger.error('保存侧边栏状态失败:', error);
            localStorage.setItem('sidebarOpen', isOpening ? 'true' : 'false');
        }
    }
}

/**
 * 更新后台任务指示器
 */
export function updateBackgroundTasksIndicator() {
    if (!elements.backgroundTasksIndicator) return;

    const taskCount = state.backgroundTasks.size;
    if (taskCount > 0) {
        elements.backgroundTasksIndicator.style.display = 'flex';
        elements.backgroundTasksIndicator.textContent = `${taskCount} 个后台任务`;
    } else {
        elements.backgroundTasksIndicator.style.display = 'none';
    }
}

/**
 * 构建单个 session-item 元素
 */
function buildSessionElement(session, matchedMessages, currentQuery, isActive, hasBackgroundTask) {
    const sessionEl = document.createElement('div');
    sessionEl.className = `session-item${isActive ? ' active' : ''}`;
    sessionEl.dataset.sessionId = session.id;
    sessionEl.draggable = true;
    sessionEl.setAttribute('tabindex', '0');
    sessionEl.setAttribute('role', 'button');
    sessionEl.setAttribute('aria-label', `会话: ${session.name}`);

    const sessionNameHTML = currentQuery
        ? highlightMatch(session.name, currentQuery)
        : escapeHtml(session.name);

    // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
    sessionEl.innerHTML = `
        <div class="session-info">
            <span class="session-name" title="${escapeHtml(session.name)}">${sessionNameHTML}</span>
            ${hasBackgroundTask ? '<span class="session-generating">生成中...</span>' : ''}
        </div>
        <div class="session-actions">
            <button class="session-action-btn export-session-btn export" title="复制为 Markdown" aria-label="复制此会话为 Markdown">
                ${getIcon('copy', { size: 14 })}
            </button>
            <button class="session-action-btn rename-session-btn" title="重命名" aria-label="重命名会话">
                ${getIcon('edit', { size: 14 })}
            </button>
            <button class="session-action-btn delete-session-btn delete" title="删除" aria-label="删除会话">
                ${getIcon('trash', { size: 14 })}
            </button>
        </div>
    `;

    sessionEl.addEventListener('click', (e) => {
        const messagePreviewItem = e.target.closest('.matched-message-item');
        if (messagePreviewItem) {
            const fallbackIndex = Number.parseInt(
                messagePreviewItem.dataset.messageIndex || '',
                10
            );
            const messageId = messagePreviewItem.dataset.messageId || '';
            switchToSessionAndScrollToMessage(session.id, {
                messageId,
                fallbackIndex
            });
        } else if (session.id === state.currentSessionId) {
            // 点击当前激活的 session 走 reload 路径，覆盖多 tab 冲突 / 远端更新场景下用户的
            // "再次点击侧栏想看最新内容" 操作（switchToSession 对同 id 早期 return 不会刷新消息）
            reloadCurrentSessionMessages();
        } else {
            switchToSession(session.id);
        }
    });

    bindSessionEvents(sessionEl, session.id);

    sessionEl.addEventListener('keydown', (e) => {
        if (e.target !== sessionEl) return;
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            if (session.id === state.currentSessionId) {
                reloadCurrentSessionMessages();
            } else {
                switchToSession(session.id);
            }
        }
    });

    updateMatchedMessagesPreview(sessionEl, matchedMessages, currentQuery, session.name);
    return sessionEl;
}

/**
 * 构建文件夹 DOM
 */
function buildFolderGroup(folder, folderSessions, currentQuery) {
    const groupEl = document.createElement('div');
    groupEl.className = `folder-group${folder.collapsed ? ' collapsed' : ''}`;
    groupEl.dataset.folderId = folder.id;

    const headerEl = document.createElement('div');
    headerEl.className = 'folder-header';
    headerEl.setAttribute('tabindex', '0');
    headerEl.setAttribute('role', 'button');
    headerEl.setAttribute('aria-expanded', folder.collapsed ? 'false' : 'true');
    headerEl.setAttribute('aria-label', `文件夹: ${folder.name}`);
    // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
    headerEl.innerHTML = `
        <span class="folder-toggle">▶</span>
        <span class="folder-name">${escapeHtml(folder.name)}</span>
        <span class="folder-count">(${folderSessions.length})</span>
        <div class="folder-actions">
            <button class="folder-action-btn rename-folder-btn" title="重命名">
                ${getIcon('edit', { size: 14 })}
            </button>
            <button class="folder-action-btn delete-folder-btn" title="删除">
                ${getIcon('trash', { size: 14 })}
            </button>
        </div>
    `;

    headerEl.addEventListener('click', (e) => {
        if (e.target.closest('.folder-action-btn')) return;
        toggleFolderCollapse(folder.id);
    });

    headerEl.addEventListener('keydown', async (e) => {
        if (e.target !== headerEl) return;
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            await toggleFolderCollapse(folder.id);
            // 折叠切换触发列表全量重建，headerEl 已被替换，需重新定位归还焦点
            elements.sessionList
                ?.querySelector(`[data-folder-id="${CSS.escape(folder.id)}"] .folder-header`)
                ?.focus();
        }
    });

    headerEl.querySelector('.rename-folder-btn').addEventListener('click', async (e) => {
        e.stopPropagation();
        const newName = await showInputDialog('请输入新的文件夹名称:', folder.name, '重命名文件夹');
        if (newName && newName.trim()) {
            renameFolderAction(folder.id, newName.trim());
        }
    });

    headerEl.querySelector('.delete-folder-btn').addEventListener('click', async (e) => {
        e.stopPropagation();
        const confirmed = await showConfirmDialog(
            `确定要删除文件夹 "${folder.name}" 吗？其中的会话将移至未分组。`,
            '确认删除'
        );
        if (confirmed) {
            deleteFolderAction(folder.id);
        }
    });

    groupEl.appendChild(headerEl);

    const contentEl = document.createElement('div');
    contentEl.className = 'folder-content';

    folderSessions.forEach(({ session, matchedMessages }) => {
        const isActive = session.id === state.currentSessionId;
        const hasBackgroundTask = state.backgroundTasks.has(session.id);
        contentEl.appendChild(
            buildSessionElement(session, matchedMessages, currentQuery, isActive, hasBackgroundTask)
        );
    });

    groupEl.appendChild(contentEl);
    return groupEl;
}

/**
 * 绑定 session-item 事件
 */
function bindSessionEvents(element, sessionId) {
    if (element._eventsBound) return;

    const getLatestSessionMeta = (sid) => state.sessions.find((item) => item.id === sid) || null;

    const renameBtn = element.querySelector('.rename-session-btn');
    if (renameBtn) {
        renameBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const latestSession = getLatestSessionMeta(sessionId);
            if (!latestSession) return;
            const newName = await showInputDialog(
                '请输入新的会话名称:',
                latestSession.name,
                '重命名会话'
            );
            if (newName && newName.trim()) {
                renameSession(sessionId, newName);
            }
        });
    }

    const deleteBtn = element.querySelector('.delete-session-btn');
    if (deleteBtn) {
        deleteBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const latestSession = getLatestSessionMeta(sessionId);
            const sessionName = latestSession?.name || '未命名会话';
            const confirmed = await showConfirmDialog(
                `确定要删除会话 "${sessionName}" 吗？`,
                '确认删除'
            );
            if (confirmed) {
                try {
                    await deleteSession(sessionId);
                } catch (err) {
                    logger.error('删除会话失败:', err);
                    eventBus.emit('ui:notification', {
                        message: '删除会话失败',
                        type: 'error'
                    });
                }
            }
        });
    }

    const exportBtn = element.querySelector('.export-session-btn');
    if (exportBtn) {
        exportBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            try {
                const latestSession = getLatestSessionMeta(sessionId);
                if (!latestSession) throw new Error('会话不存在');
                const exportSession = await getSessionDataForExport(latestSession);
                const markdown = sessionToMarkdown(exportSession);
                if (!markdown.trim()) throw new Error('会话内容为空，无法复制');
                await navigator.clipboard.writeText(markdown);
                showNotification('会话已作为 Markdown 复制到剪切板', 'success');
            } catch (err) {
                logger.error('导出失败:', err);
                showNotification('导出失败: ' + err.message, 'error');
            }
        });
    }

    element._eventsBound = true;
}

/**
 * 更新会话列表 UI
 */
export function updateSessionList() {
    if (!elements.sessionList) return;

    const searchState = getSessionSearchState();
    const currentQuery = searchState.query;
    const sessionsData = searchState.isActive
        ? searchState.results || []
        : state.sessions.map((session) => ({ session, matchedMessages: [] }));
    _lastSearchActive = searchState.isActive;

    if (sessionsData.length === 0 && state.sessions.length === 0) {
        // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
        elements.sessionList.innerHTML = `
            <div class="session-list-empty">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M3 12h18M3 6h18M3 18h18"/>
                    <circle cx="12" cy="12" r="10"/>
                </svg>
                <div style="margin-top: 12px;">还没有会话</div>
                <div style="margin-top: 8px; font-size: 11px; opacity: 0.7;">
                    点击上方"新建"按钮开始
                </div>
            </div>
        `;
        return;
    }

    if (searchState.isActive && sessionsData.length === 0) {
        // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
        elements.sessionList.innerHTML = `
            <div class="session-list-empty">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="11" cy="11" r="8"/>
                    <path d="m21 21-4.35-4.35"/>
                </svg>
                <div style="margin-top: 12px;">未找到匹配的会话</div>
                <div style="margin-top: 8px; font-size: 11px; opacity: 0.7;">
                    尝试其他搜索关键词
                </div>
            </div>
        `;
        return;
    }

    const fragment = document.createDocumentFragment();

    if (searchState.isActive) {
        sessionsData.forEach(({ session, matchedMessages }) => {
            const isActive = session.id === state.currentSessionId;
            const hasBackgroundTask = state.backgroundTasks.has(session.id);
            fragment.appendChild(
                buildSessionElement(
                    session,
                    matchedMessages,
                    currentQuery,
                    isActive,
                    hasBackgroundTask
                )
            );
        });
    } else {
        const folders = [...state.folders].sort((a, b) => a.order - b.order);

        for (const folder of folders) {
            const folderSessions = sessionsData.filter(
                ({ session }) => session.folderId === folder.id
            );
            if (folderSessions.length === 0 && folders.length > 0) {
                fragment.appendChild(buildFolderGroup(folder, [], currentQuery));
                continue;
            }
            if (folderSessions.length > 0) {
                fragment.appendChild(buildFolderGroup(folder, folderSessions, currentQuery));
            }
        }

        const ungrouped = sessionsData.filter(({ session }) => !session.folderId);
        ungrouped.forEach(({ session, matchedMessages }) => {
            const isActive = session.id === state.currentSessionId;
            const hasBackgroundTask = state.backgroundTasks.has(session.id);
            fragment.appendChild(
                buildSessionElement(
                    session,
                    matchedMessages,
                    currentQuery,
                    isActive,
                    hasBackgroundTask
                )
            );
        });
    }

    elements.sessionList.replaceChildren(fragment);
}

/**
 * 获取搜索预览的角色元信息
 * @param {string} role - 消息角色
 * @returns {{ label: string, className: string }} 角色展示信息
 */
function getMatchedMessageRoleMeta(role) {
    switch (role) {
        case 'user':
            return { label: '用户', className: 'role-user' };
        case 'assistant':
            return { label: 'AI', className: 'role-assistant' };
        case 'system':
            return { label: '系统', className: 'role-other' };
        case 'tool':
            return { label: '工具', className: 'role-other' };
        default:
            return { label: role || '未知', className: 'role-other' };
    }
}

/**
 * 构建搜索预览项的可达性描述
 * @param {string} sessionName - 会话名称
 * @param {string} roleLabel - 角色文案
 * @param {string} previewText - 预览文本
 * @returns {string} 可达性标签
 */
function buildMatchedMessageAriaLabel(sessionName, roleLabel, previewText) {
    const compactPreview = (previewText || '')
        .replace(/\.\.\./g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    if (!compactPreview) {
        return `定位到会话“${sessionName}”中的${roleLabel}消息`;
    }

    return `定位到会话“${sessionName}”中的${roleLabel}消息：${compactPreview}`;
}

/**
 * 更新匹配消息预览
 * @param {HTMLElement} sessionEl - 会话元素
 * @param {Array} matchedMessages - 匹配的消息列表
 * @param {string} query - 搜索关键词
 * @param {string} sessionName - 会话名称
 */
function updateMatchedMessagesPreview(sessionEl, matchedMessages, query, sessionName) {
    const oldPreview = sessionEl.querySelector('.matched-messages-preview');
    if (oldPreview) {
        oldPreview.remove();
    }

    if (!matchedMessages || matchedMessages.length === 0 || !query) {
        return;
    }

    const previewContainer = document.createElement('div');
    previewContainer.className = 'matched-messages-preview';

    matchedMessages.forEach((msg) => {
        const roleMeta = getMatchedMessageRoleMeta(msg.role);
        const previewItem = document.createElement('button');
        previewItem.type = 'button';
        previewItem.className = 'matched-message-item';
        previewItem.dataset.messageIndex = String(msg.index);
        if (msg.messageId) {
            previewItem.dataset.messageId = msg.messageId;
        }
        previewItem.setAttribute(
            'aria-label',
            buildMatchedMessageAriaLabel(sessionName, roleMeta.label, msg.preview)
        );

        const metaRow = document.createElement('div');
        metaRow.className = 'matched-message-meta';

        const roleTag = document.createElement('span');
        roleTag.className = `message-role ${roleMeta.className}`;
        roleTag.textContent = roleMeta.label;

        const previewText = document.createElement('span');
        previewText.className = 'message-preview-text';
        // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
        previewText.innerHTML = highlightMatch(msg.preview, query);

        metaRow.appendChild(roleTag);
        previewItem.appendChild(metaRow);
        previewItem.appendChild(previewText);

        previewContainer.appendChild(previewItem);
    });

    sessionEl.appendChild(previewContainer);
}

/**
 * 切换会话并滚动到指定消息
 * @param {string} sessionId - 会话ID
 * @param {{ messageId?: string, fallbackIndex?: number }} messageRef - 消息引用
 */
async function switchToSessionAndScrollToMessage(sessionId, messageRef = {}) {
    const fallbackIndex = Number.isInteger(messageRef.fallbackIndex)
        ? messageRef.fallbackIndex
        : -1;
    const messageId = messageRef.messageId || '';

    if (!messageId && fallbackIndex < 0) {
        showNotification('未找到可定位的搜索结果', 'warning');
        return;
    }

    await switchToSession(sessionId);

    const located = await locateMessageByReference(
        {
            messageId,
            fallbackIndex
        },
        {
            behavior: 'smooth'
        }
    );

    if (!located) {
        showNotification('目标消息不存在或尚未渲染完成', 'warning');
    }
}

/**
 * 初始化侧边栏
 */
export async function initSidebar() {
    // 防止重复初始化
    if (_initialized) {
        logger.warn('Sidebar already initialized');
        return;
    }

    // 加载文件夹数据
    await loadFolders();

    // 初始化 overlay
    const sidebarOverlay = document.querySelector('.sidebar-overlay');
    if (sidebarOverlay) {
        // 设置初始样式
        sidebarOverlay.style.position = 'fixed';
        sidebarOverlay.style.inset = '0';
        sidebarOverlay.style.background = 'rgba(56, 56, 56, 0.6)';
        sidebarOverlay.style.visibility = 'hidden';
        sidebarOverlay.style.opacity = '0';
        sidebarOverlay.style.pointerEvents = 'none';
        sidebarOverlay.style.zIndex = '99';
        sidebarOverlay.style.cursor = 'pointer';
        sidebarOverlay.style.border = 'none';
        sidebarOverlay.style.padding = '0';
        sidebarOverlay.style.transition = 'opacity 0.2s ease-out, visibility 0.2s ease-out';

        // 点击 overlay 关闭侧边栏
        sidebarOverlay.addEventListener(
            'click',
            function (e) {
                e.stopPropagation();
                toggleSidebar();
            },
            true
        );
    }

    // 绑定侧边栏切换按钮
    if (elements.sidebarToggle) {
        elements.sidebarToggle.addEventListener('click', () => toggleSidebar());
    }

    // 绑定新建会话按钮（带防抖保护）
    if (elements.newSessionBtn) {
        let isCreating = false;
        elements.newSessionBtn.addEventListener('click', async () => {
            if (isCreating || state.isSwitchingSession) return;
            isCreating = true;
            elements.newSessionBtn.disabled = true;
            try {
                await createNewSession(true);
            } finally {
                isCreating = false;
                elements.newSessionBtn.disabled = false;
            }
        });
    }

    // 绑定新建文件夹按钮
    const newFolderBtn = document.getElementById('new-folder-btn');
    if (newFolderBtn) {
        newFolderBtn.addEventListener('click', async () => {
            const name = await showInputDialog('请输入文件夹名称:', '', '新建文件夹');
            if (name && name.trim()) {
                await createFolder(name.trim());
            }
        });
    }

    // 绑定关闭侧边栏按钮
    if (elements.closeSidebar) {
        elements.closeSidebar.addEventListener('click', () => toggleSidebar());
    }

    // 侧边栏状态恢复已移至 main.js（使用 IndexedDB 优先）
    // 删除此处的 localStorage 读取，避免重复恢复

    // 监听会话相关事件（保存 unsubscribe 函数）
    _subscriptions.push(
        eventBus.on('session:switched', () => {
            updateSessionList();
            updateBackgroundTasksIndicator();
        })
    );

    _subscriptions.push(
        eventBus.on('sessions:updated', () => {
            if (!getSessionSearchState().isActive) {
                updateSessionList();
            }
        })
    );

    _subscriptions.push(
        eventBus.on('sessions:loaded', () => {
            updateSessionList();
        })
    );

    _subscriptions.push(
        eventBus.on('sessions:search-state-changed', () => {
            const searchState = getSessionSearchState();
            if (searchState.isActive || _lastSearchActive !== searchState.isActive) {
                updateSessionList();
            }
        })
    );

    _subscriptions.push(
        eventBus.on('folders:changed', () => {
            updateSessionList();
        })
    );

    initSidebarDragAndDrop();
    initFolderContextMenu();

    _initialized = true;
    logger.debug('Sidebar initialized');

    // 修复竞态条件：手动触发一次会话列表更新
    // 因为 loadSessions() 可能在 initSidebar() 之前就触发了 sessions:loaded 事件
    updateSessionList();

    // 将函数暴露到全局作用域供 HTML onclick 使用
    window.switchToSession = switchToSession;
    window.deleteSession = async (sessionId) => {
        const confirmed = await showConfirmDialog('确定要删除此会话吗？', '确认删除');
        if (confirmed) {
            try {
                await deleteSession(sessionId);
            } catch (err) {
                logger.error('删除会话失败:', err);
                eventBus.emit('ui:notification', { message: '删除会话失败', type: 'error' });
            }
        }
    };
    window.renameSession = async (sessionId) => {
        const session = state.sessions.find((s) => s.id === sessionId);
        if (session) {
            const newName = await showInputDialog(
                '请输入新的会话名称:',
                session.name,
                '重命名会话'
            );
            if (newName && newName.trim()) {
                renameSession(sessionId, newName);
            }
        }
    };
    window.toggleSidebar = toggleSidebar;
}

/**
 * 清理侧边栏模块（用于重置或销毁）
 */
export function cleanupSidebar() {
    if (!_initialized) {
        return;
    }

    // 取消所有事件订阅
    _subscriptions.forEach((unsubscribe) => {
        if (typeof unsubscribe === 'function') {
            unsubscribe();
        }
    });
    _subscriptions = [];

    _initialized = false;
    _lastSearchActive = false;
    logger.debug('🧹 Sidebar cleaned up');
}
