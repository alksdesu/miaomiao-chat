/**
 * Network 面板主体
 */

import { logger } from '../utils/logger.js';
import { clearRecords } from './store.js';

let panelEl = null;
let isOpen = false;
let activeTab = 'capture';

// 拆离窗口状态
let undockedWindow = null;
const controlChannel = new BroadcastChannel('network-panel-control');

function isInSubWindow() {
    return window.location.pathname.includes('network-window');
}

function undockPanel() {
    closeNetworkPanel();
    const width = 900;
    const height = 600;
    const left = window.screenX + 50;
    const top = window.screenY + 50;
    undockedWindow = window.open(
        'network-window.html',
        'network-monitor',
        `width=${width},height=${height},left=${left},top=${top},menubar=no,toolbar=no,location=no,status=no`
    );
    logger.debug('Network panel undocked to new window');
}

controlChannel.onmessage = (e) => {
    if (e.data?.type === 'undocked-window-closed') {
        undockedWindow = null;
    }
};

// 拖拽 resize 状态
let resizing = false;
let startY = 0;
let startHeight = 0;

// 移动端下拉关闭
let touchStartY = 0;

export function isPanelOpen() {
    return isOpen;
}

export function toggleNetworkPanel() {
    if (undockedWindow && !undockedWindow.closed) {
        undockedWindow.focus();
        return;
    }
    if (isOpen) closeNetworkPanel();
    else openNetworkPanel();
}

export function openNetworkPanel() {
    ensurePanel();
    panelEl.classList.add('open');
    isOpen = true;
    logger.debug('Network panel opened');
}

export function closeNetworkPanel() {
    if (!panelEl) return;
    panelEl.classList.remove('open');
    isOpen = false;
    import('./builder-view.js')
        .then(({ abortBuilderRequest, clearResponse }) => {
            abortBuilderRequest();
            clearResponse();
        })
        .catch(() => {});
    logger.debug('Network panel closed');
}

function ensurePanel() {
    if (panelEl) return;
    panelEl = buildPanel();
    document.body.appendChild(panelEl);
}

function buildPanel() {
    const panel = document.createElement('div');
    panel.id = 'network-panel';
    panel.className = 'network-panel';

    // resize handle
    const resizeHandle = document.createElement('div');
    resizeHandle.className = 'network-resize-handle';
    resizeHandle.addEventListener('mousedown', onResizeStart);
    panel.appendChild(resizeHandle);

    // 移动端下拉关闭
    panel.addEventListener('touchstart', onTouchStart, { passive: true });
    panel.addEventListener('touchmove', onTouchMove, { passive: false });
    panel.addEventListener('touchend', onTouchEnd, { passive: true });

    // toolbar
    const toolbar = document.createElement('div');
    toolbar.className = 'network-toolbar';

    const tabs = document.createElement('div');
    tabs.className = 'network-tabs';

    // Capture tab: radio/antenna icon
    const tabCapture = createTab(
        'capture',
        'Capture',
        true,
        '<path d="M12 20v-6M6 20v-4M18 20v-8"/><path d="M2 12h20"/>'
    );
    // Builder tab: tool/wrench icon
    const tabBuilder = createTab(
        'builder',
        'Builder',
        false,
        '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>'
    );
    tabs.appendChild(tabCapture);
    tabs.appendChild(tabBuilder);

    const actions = document.createElement('div');
    actions.className = 'network-toolbar-actions';

    const pauseSvg =
        '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>';
    const playSvg = '<polygon points="5 3 19 12 5 21 5 3"/>';
    const captureToggle = createBtn('capture-toggle', pauseSvg, '暂停/恢复抓包');
    captureToggle.addEventListener('click', async () => {
        const { enableCapture, disableCapture, isCapturing } = await import('./interceptor.js');
        if (isCapturing()) {
            disableCapture();
        } else {
            enableCapture();
        }
        // eslint-disable-next-line no-restricted-syntax -- 静态 SVG 切换
        captureToggle.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${isCapturing() ? pauseSvg : playSvg}</svg>`;
        logger.debug(`Capture ${isCapturing() ? 'active' : 'paused'}`);
    });

    // trash icon
    const clearBtn = createBtn(
        'clear-btn',
        '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
        '清空记录'
    );
    clearBtn.addEventListener('click', () => clearRecords());

    // x icon
    const closeBtn = createBtn(
        'close-btn',
        '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
        '关闭'
    );
    closeBtn.addEventListener('click', isInSubWindow() ? () => window.close() : closeNetworkPanel);

    actions.appendChild(captureToggle);
    actions.appendChild(clearBtn);

    // 子窗口显示 dock 按钮，主窗口显示 undock 按钮
    if (isInSubWindow()) {
        const dockBtn = createBtn(
            'dock-btn',
            '<polyline points="9 21 3 21 3 15"/><path d="M21 3l-11 11"/><path d="M14 3h7v7"/>',
            '还原到主窗口'
        );
        dockBtn.addEventListener('click', () => window.close());
        actions.appendChild(dockBtn);
    } else {
        const undockBtn = createBtn(
            'undock-btn',
            '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>',
            '拆离为独立窗口'
        );
        undockBtn.addEventListener('click', undockPanel);
        actions.appendChild(undockBtn);
    }

    actions.appendChild(closeBtn);

    toolbar.appendChild(tabs);
    toolbar.appendChild(actions);
    panel.appendChild(toolbar);

    // 内容区
    const content = document.createElement('div');
    content.className = 'network-content';

    const captureContent = document.createElement('div');
    captureContent.className = 'network-tab-content active';
    captureContent.dataset.tab = 'capture';

    const builderContent = document.createElement('div');
    builderContent.className = 'network-tab-content';
    builderContent.dataset.tab = 'builder';

    content.appendChild(captureContent);
    content.appendChild(builderContent);
    panel.appendChild(content);

    // 延迟初始化 capture-view
    initCaptureView(captureContent);
    // 延迟初始化 builder-view
    initBuilderView(builderContent);

    return panel;
}

async function initCaptureView(container) {
    try {
        const { renderCaptureView } = await import('./capture-view.js');
        renderCaptureView(container);
    } catch (e) {
        logger.error('Failed to init capture view', e);
    }
}

async function initBuilderView(container) {
    try {
        const { renderBuilderView } = await import('./builder-view.js');
        renderBuilderView(container);
    } catch (e) {
        logger.error('Failed to init builder view', e);
    }
}

function createTab(tabId, label, active, svgPath) {
    const btn = document.createElement('button');
    btn.className = 'network-tab' + (active ? ' active' : '');
    btn.dataset.tab = tabId;
    if (svgPath) {
        // eslint-disable-next-line no-restricted-syntax -- 已审计：svgPath 为模块内联静态 SVG path 字符串，与同文件 251 行 createBtn innerHTML 同源
        btn.insertAdjacentHTML(
            'afterbegin',
            `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${svgPath}</svg> `
        );
    }
    btn.appendChild(document.createTextNode(label));
    btn.addEventListener('click', () => switchTab(tabId));
    return btn;
}

function createBtn(cls, svgPath, title) {
    const btn = document.createElement('button');
    btn.className = `network-btn ${cls}`;
    // eslint-disable-next-line no-restricted-syntax -- 静态 SVG 图标
    btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${svgPath}</svg>`;
    btn.title = title;
    return btn;
}

export function switchTab(tabId) {
    if (activeTab === tabId || !panelEl) return;
    activeTab = tabId;

    panelEl.querySelectorAll('.network-tab').forEach((t) => {
        t.classList.toggle('active', t.dataset.tab === tabId);
    });
    panelEl.querySelectorAll('.network-tab-content').forEach((c) => {
        c.classList.toggle('active', c.dataset.tab === tabId);
    });
}

// resize handle 拖拽
function onResizeStart(e) {
    resizing = true;
    startY = e.clientY;
    startHeight = panelEl.offsetHeight;
    document.addEventListener('mousemove', onResizeMove);
    document.addEventListener('mouseup', onResizeEnd);
    e.preventDefault();
}

function onResizeMove(e) {
    if (!resizing) return;
    const delta = startY - e.clientY;
    const newHeight = Math.max(150, Math.min(window.innerHeight * 0.9, startHeight + delta));
    panelEl.style.height = newHeight + 'px';
}

function onResizeEnd() {
    resizing = false;
    document.removeEventListener('mousemove', onResizeMove);
    document.removeEventListener('mouseup', onResizeEnd);
}

// 移动端下拉关闭（仅在 toolbar/resize-handle 区域触发，不阻止内容区滚动）
let touchStartTarget = null;

function onTouchStart(e) {
    touchStartY = e.touches[0].clientY;
    touchStartTarget = e.target;
}

function isInScrollableArea(el) {
    while (el && el !== panelEl) {
        const style = window.getComputedStyle(el);
        const overflowY = style.overflowY;
        if ((overflowY === 'auto' || overflowY === 'scroll') && el.scrollHeight > el.clientHeight) {
            return true;
        }
        el = el.parentElement;
    }
    return false;
}

function onTouchMove(e) {
    if (isInScrollableArea(touchStartTarget)) return;
    const dy = e.touches[0].clientY - touchStartY;
    if (dy > 20) e.preventDefault();
}

function onTouchEnd(e) {
    if (isInScrollableArea(touchStartTarget)) return;
    const dy = e.changedTouches[0].clientY - touchStartY;
    if (dy > 100) closeNetworkPanel();
    touchStartTarget = null;
}
