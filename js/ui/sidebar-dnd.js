/**
 * 侧边栏拖拽模块
 * PC 端 HTML5 Drag & Drop，将会话拖入/移出文件夹
 */

import { moveSessionToFolder } from '../state/folders.js';
import { logger } from '../utils/logger.js';

let _draggedSessionId = null;

export function initSidebarDragAndDrop() {
    const sessionList = document.getElementById('session-list');
    if (!sessionList) return;

    sessionList.addEventListener('dragstart', handleDragStart);
    sessionList.addEventListener('dragover', handleDragOver);
    sessionList.addEventListener('dragleave', handleDragLeave);
    sessionList.addEventListener('drop', handleDrop);
    sessionList.addEventListener('dragend', handleDragEnd);
}

function handleDragStart(e) {
    const sessionItem = e.target.closest('.session-item');
    if (!sessionItem) {
        e.preventDefault();
        return;
    }
    _draggedSessionId = sessionItem.dataset.sessionId;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', _draggedSessionId);
    sessionItem.classList.add('dragging');
}

function handleDragOver(e) {
    if (!_draggedSessionId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';

    clearAllDragOver(e.currentTarget);

    const folderGroup = e.target.closest('.folder-group');
    if (folderGroup) {
        folderGroup.classList.add('drag-over');
    }
}

function handleDragLeave(e) {
    const folderGroup = e.target.closest('.folder-group');
    if (!folderGroup) return;
    // 只在真正离开 folder-group 时移除样式
    if (!folderGroup.contains(e.relatedTarget)) {
        folderGroup.classList.remove('drag-over');
    }
}

function handleDrop(e) {
    e.preventDefault();
    if (!_draggedSessionId) return;

    const folderGroup = e.target.closest('.folder-group');
    const targetFolderId = folderGroup ? folderGroup.dataset.folderId : null;

    moveSessionToFolder(_draggedSessionId, targetFolderId);
    logger.debug(`Session ${_draggedSessionId} moved to folder ${targetFolderId}`);

    cleanup(e.currentTarget);
}

function handleDragEnd(e) {
    cleanup(e.currentTarget);
}

function clearAllDragOver(container) {
    if (!container) return;
    container.querySelectorAll('.drag-over').forEach((el) => el.classList.remove('drag-over'));
}

function cleanup(container) {
    _draggedSessionId = null;
    if (!container) return;
    clearAllDragOver(container);
    const dragging = container.querySelector('.dragging');
    if (dragging) dragging.classList.remove('dragging');
}
