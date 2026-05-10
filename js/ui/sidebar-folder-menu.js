/**
 * 移动端长按菜单
 * 触摸设备上长按会话项，弹出文件夹选择菜单
 */

import { state } from '../core/state.js';
import { moveSessionToFolder } from '../state/folders.js';
import { escapeHtml } from '../utils/helpers.js';

let _activeMenu = null;

export function initFolderContextMenu() {
    const sessionList = document.getElementById('session-list');
    if (!sessionList) return;
    if (!('ontouchstart' in window)) return;

    let longPressTimer = null;

    sessionList.addEventListener(
        'touchstart',
        (e) => {
            const sessionItem = e.target.closest('.session-item');
            if (!sessionItem) return;
            longPressTimer = setTimeout(() => {
                longPressTimer = null;
                showFolderMenu(sessionItem, e.touches[0]);
            }, 500);
        },
        { passive: true }
    );

    sessionList.addEventListener(
        'touchmove',
        () => {
            if (longPressTimer) {
                clearTimeout(longPressTimer);
                longPressTimer = null;
            }
        },
        { passive: true }
    );

    sessionList.addEventListener(
        'touchend',
        () => {
            if (longPressTimer) {
                clearTimeout(longPressTimer);
                longPressTimer = null;
            }
        },
        { passive: true }
    );
}

function showFolderMenu(sessionItem, touch) {
    closeFolderMenu();
    navigator.vibrate?.(50);

    const sessionId = sessionItem.dataset.sessionId;
    const session = state.sessions.find((s) => s.id === sessionId);
    if (!session) return;

    const currentFolderId = session.folderId || null;
    const folders = state.folders || [];

    const menu = document.createElement('div');
    menu.className = 'folder-context-menu';

    let html = '';
    for (const folder of folders) {
        const isCurrent = folder.id === currentFolderId;
        const cls = isCurrent ? ' current' : '';
        html += `<div class="folder-menu-item${cls}" data-folder-id="${escapeHtml(folder.id)}">
            <span>📁</span><span>${escapeHtml(folder.name)}</span>
        </div>`;
    }

    if (currentFolderId) {
        if (folders.length > 0) {
            html += '<div class="folder-menu-separator"></div>';
        }
        html += '<div class="folder-menu-item" data-folder-id="">移出文件夹</div>';
    }

    if (!html) {
        html =
            '<div class="folder-menu-item" style="opacity:0.5;pointer-events:none">暂无文件夹</div>';
    }

    // eslint-disable-next-line no-restricted-syntax -- 已审计：escapeHtml处理所有动态数据
    menu.innerHTML = html;

    document.body.appendChild(menu);

    // 定位：靠近触摸点，但不超出视口
    const rect = menu.getBoundingClientRect();
    let left = touch.clientX;
    let top = touch.clientY;
    if (left + rect.width > window.innerWidth) {
        left = window.innerWidth - rect.width - 8;
    }
    if (top + rect.height > window.innerHeight) {
        top = window.innerHeight - rect.height - 8;
    }
    menu.style.left = `${Math.max(8, left)}px`;
    menu.style.top = `${Math.max(8, top)}px`;

    menu.addEventListener('click', (e) => {
        const item = e.target.closest('.folder-menu-item');
        if (!item || item.style.pointerEvents === 'none') return;
        const folderId = item.dataset.folderId || null;
        if (folderId !== currentFolderId) {
            moveSessionToFolder(sessionId, folderId);
        }
        closeFolderMenu();
    });

    _activeMenu = menu;

    setTimeout(() => {
        document.addEventListener('touchstart', onOutsideTouch, { once: true, passive: true });
        document.addEventListener('scroll', closeFolderMenu, {
            once: true,
            capture: true,
            passive: true
        });
    }, 0);
}

function onOutsideTouch(e) {
    if (_activeMenu && !_activeMenu.contains(e.target)) {
        closeFolderMenu();
    } else if (_activeMenu) {
        document.addEventListener('touchstart', onOutsideTouch, { once: true, passive: true });
    }
}

function closeFolderMenu() {
    if (_activeMenu) {
        _activeMenu.remove();
        _activeMenu = null;
    }
}
