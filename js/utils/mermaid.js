/**
 * Mermaid 渲染工具模块
 * 提供按需加载、图表渲染与主题刷新能力
 */

import { logger } from './logger.js';
import { eventBus } from '../core/events.js';

let mermaidLoadPromise = null;
let mermaidInstance = null;
let mermaidRenderSeed = 0;
let themeRefreshSerial = 0;
let initializedMermaidTheme = null;
let hiddenRenderHost = null;
let mermaidViewportWatcherBound = false;
let mermaidCanvasRecenterRafId = 0;
let wasFullscreenViewport = false;

const MERMAID_FONT_FAMILY =
    'var(--font-ui-accent), "PingFang SC", "Microsoft YaHei", system-ui, sans-serif';
const FULLSCREEN_VIEWPORT_TOLERANCE = 8;

function resolveMermaidModule(module) {
    return module?.default || module;
}

function getMermaidConfig(theme = getCurrentMermaidTheme()) {
    return {
        startOnLoad: false,
        securityLevel: 'strict',
        useMaxWidth: false,
        theme,
        fontSize: 14,
        fontFamily: MERMAID_FONT_FAMILY,
        flowchart: {
            useMaxWidth: false,
            padding: 16,
            nodeSpacing: 48,
            rankSpacing: 56
        },
        sequence: {
            useMaxWidth: false,
            diagramMarginX: 72
        },
        gantt: {
            useMaxWidth: false,
            axisFormat: '%m-%d'
        }
    };
}

function configureMermaid(mermaid, theme = getCurrentMermaidTheme()) {
    if (initializedMermaidTheme === theme) {
        return false;
    }

    mermaid.initialize(getMermaidConfig(theme));
    initializedMermaidTheme = theme;
    return true;
}

function nextMermaidGraphId() {
    mermaidRenderSeed += 1;
    return `mermaid-graph-${mermaidRenderSeed}`;
}

function getMermaidSource(container) {
    return container.dataset.mermaidSource || '';
}

function getStatusTextElement(container) {
    return container.querySelector('.mermaid-status-text');
}

function getRetryButton(container) {
    return container.querySelector('.mermaid-retry-render');
}

function getCanvasElement(container) {
    return container.querySelector('.mermaid-canvas');
}

function resetMermaidCanvasScrollPosition(canvas) {
    if (!canvas) {
        return;
    }

    canvas.scrollTop = 0;
    const maxScrollLeft = Math.max(0, canvas.scrollWidth - canvas.clientWidth);
    canvas.scrollLeft = maxScrollLeft > 0 ? Math.round(maxScrollLeft / 2) : 0;
}

function isNearViewportSize(viewportWidth, viewportHeight, targetWidth, targetHeight) {
    return (
        Number.isFinite(targetWidth) &&
        Number.isFinite(targetHeight) &&
        Math.abs(viewportWidth - targetWidth) <= FULLSCREEN_VIEWPORT_TOLERANCE &&
        Math.abs(viewportHeight - targetHeight) <= FULLSCREEN_VIEWPORT_TOLERANCE
    );
}

function isFullscreenViewportActive() {
    if (document.fullscreenElement) {
        return true;
    }

    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const screenWidth = window.screen?.width;
    const screenHeight = window.screen?.height;
    const availableWidth = window.screen?.availWidth;
    const availableHeight = window.screen?.availHeight;

    return (
        isNearViewportSize(viewportWidth, viewportHeight, screenWidth, screenHeight) ||
        isNearViewportSize(viewportWidth, viewportHeight, availableWidth, availableHeight)
    );
}

function recenterVisibleMermaidCanvases() {
    const containers = Array.from(document.querySelectorAll('.mermaid-block')).filter(
        (container) => {
            return (
                container.isConnected &&
                container.dataset.mermaidStatus === 'ready' &&
                container.querySelector('.mermaid-canvas svg')
            );
        }
    );

    containers.forEach((container) => {
        resetMermaidCanvasScrollPosition(getCanvasElement(container));
    });
}

function scheduleVisibleMermaidCanvasRecenter() {
    if (mermaidCanvasRecenterRafId) {
        cancelAnimationFrame(mermaidCanvasRecenterRafId);
    }

    mermaidCanvasRecenterRafId = requestAnimationFrame(() => {
        mermaidCanvasRecenterRafId = requestAnimationFrame(() => {
            mermaidCanvasRecenterRafId = 0;
            recenterVisibleMermaidCanvases();
        });
    });
}

function handleMermaidViewportChange() {
    const isFullscreenViewport = isFullscreenViewportActive();

    if (isFullscreenViewport && !wasFullscreenViewport) {
        scheduleVisibleMermaidCanvasRecenter();
    }

    wasFullscreenViewport = isFullscreenViewport;
}

function ensureMermaidViewportWatcher() {
    if (mermaidViewportWatcherBound) {
        return;
    }

    wasFullscreenViewport = isFullscreenViewportActive();
    window.addEventListener('resize', handleMermaidViewportChange);
    document.addEventListener('fullscreenchange', handleMermaidViewportChange);
    mermaidViewportWatcherBound = true;
}

export function teardownMermaidViewportWatcher() {
    if (!mermaidViewportWatcherBound) {
        return;
    }

    window.removeEventListener('resize', handleMermaidViewportChange);
    document.removeEventListener('fullscreenchange', handleMermaidViewportChange);
    mermaidViewportWatcherBound = false;

    if (mermaidCanvasRecenterRafId) {
        cancelAnimationFrame(mermaidCanvasRecenterRafId);
        mermaidCanvasRecenterRafId = 0;
    }
}

export function cleanupHiddenRenderHost() {
    if (hiddenRenderHost?.isConnected) {
        hiddenRenderHost.remove();
    }
    hiddenRenderHost = null;
}

function enqueueMicrotask(task) {
    Promise.resolve().then(task);
}

function isLatestRequest(container, requestId) {
    return container.isConnected && container.dataset.mermaidRequestId === String(requestId);
}

function classifyMermaidError(error) {
    const message = error?.message || '';

    if (
        message.includes('Mermaid 资源加载失败') ||
        message.includes('Mermaid 接口不可用') ||
        /fetch dynamically imported module|importing a module script failed|failed to fetch/i.test(
            message
        )
    ) {
        return {
            status: 'load-error',
            text: 'Mermaid 资源加载失败',
            canRetry: true
        };
    }

    if (
        error?.name === 'UnknownDiagramError' ||
        /syntax error|parse error|lexical error|unknown diagram|diagram .* not found|no diagram type detected|expecting/i.test(
            message
        )
    ) {
        return {
            status: 'syntax-error',
            text: 'Mermaid 语法错误',
            canRetry: false
        };
    }

    return {
        status: 'render-error',
        text: 'Mermaid 渲染失败',
        canRetry: true
    };
}

function setMermaidStatus(container, status, text, options = {}) {
    const { showRetry = false } = options;
    const statusTextElement = getStatusTextElement(container);
    const retryButton = getRetryButton(container);

    container.dataset.mermaidStatus = status;
    container.setAttribute(
        'aria-busy',
        status === 'loading-lib' || status === 'rendering' ? 'true' : 'false'
    );

    if (statusTextElement) {
        statusTextElement.textContent = text;
    }

    if (retryButton) {
        retryButton.hidden = !showRetry;
    }
}

function clearPendingThemeRefresh(container, targetTheme = '') {
    if (!container?.dataset) {
        return;
    }

    if (!targetTheme || container.dataset.mermaidPendingTheme === targetTheme) {
        delete container.dataset.mermaidNeedsThemeRefresh;
        delete container.dataset.mermaidPendingTheme;
    }
}

function scheduleThemeMismatchRefresh(container, targetTheme, retryCount = 0) {
    const MAX_THEME_REFRESH_RETRIES = 3;

    if (!container?.isConnected || !targetTheme) {
        return;
    }

    if (container.dataset.mermaidPendingTheme === targetTheme) {
        container.dataset.mermaidNeedsThemeRefresh = 'true';
        return;
    }

    container.dataset.mermaidNeedsThemeRefresh = 'true';
    container.dataset.mermaidPendingTheme = targetTheme;

    enqueueMicrotask(() => {
        if (!container.isConnected) {
            clearPendingThemeRefresh(container, targetTheme);
            return;
        }

        if (container.dataset.mermaidPendingTheme !== targetTheme) {
            return;
        }

        const liveTheme = getCurrentMermaidTheme();
        if (liveTheme !== targetTheme) {
            clearPendingThemeRefresh(container, targetTheme);
            if (retryCount < MAX_THEME_REFRESH_RETRIES) {
                scheduleThemeMismatchRefresh(container, liveTheme, retryCount + 1);
            } else {
                logger.warn('[Mermaid] 主题刷新重试次数已达上限，放弃');
            }
            return;
        }

        if (
            container.dataset.mermaidTheme === targetTheme &&
            container.dataset.mermaidStatus === 'ready'
        ) {
            clearPendingThemeRefresh(container, targetTheme);
            return;
        }

        clearPendingThemeRefresh(container, targetTheme);
        void renderMermaidBlock(container, {
            force: true,
            reason: 'theme-mismatch-follow-up'
        });
    });
}

function syncThemeRefreshState(container, renderedTheme) {
    const liveTheme = getCurrentMermaidTheme();

    if (liveTheme === renderedTheme) {
        clearPendingThemeRefresh(container);
        return;
    }

    scheduleThemeMismatchRefresh(container, liveTheme);
}

function createHiddenRenderHost() {
    const host = document.createElement('div');
    host.id = 'mermaid-hidden-render-host';
    host.setAttribute('aria-hidden', 'true');
    Object.assign(host.style, {
        position: 'fixed',
        left: '-9999px',
        top: '-9999px',
        visibility: 'hidden',
        pointerEvents: 'none',
        overflow: 'hidden',
        width: 'max-content',
        zIndex: '-1'
    });
    return host;
}

function ensureHiddenRenderHost() {
    const body = document.body;
    if (!body) {
        throw new Error('Mermaid 隐藏渲染容器不可用');
    }

    if (!hiddenRenderHost) {
        hiddenRenderHost = createHiddenRenderHost();
    }

    if (!hiddenRenderHost.isConnected) {
        body.appendChild(hiddenRenderHost);
    }

    if (!hiddenRenderHost.isConnected) {
        throw new Error('Mermaid 隐藏渲染容器挂载失败');
    }

    return hiddenRenderHost;
}

function createHiddenRenderWorkspace() {
    const host = ensureHiddenRenderHost();
    const workspace = document.createElement('div');
    workspace.className = 'mermaid-hidden-render-workspace';
    // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
    workspace.innerHTML = '';
    Object.assign(workspace.style, {
        display: 'inline-block',
        width: 'max-content',
        maxWidth: 'none'
    });
    host.appendChild(workspace);

    if (!workspace.isConnected || workspace.parentElement !== host) {
        throw new Error('Mermaid 隐藏渲染容器复用失败');
    }

    return workspace;
}

function cleanupHiddenRenderWorkspace(workspace) {
    workspace?.remove();
}

function getSvgRoot(renderOutput) {
    if (!renderOutput) {
        return null;
    }

    return renderOutput.tagName?.toLowerCase() === 'svg'
        ? renderOutput
        : renderOutput.querySelector('svg');
}

function readSvgViewBox(root) {
    const viewBox = root?.viewBox?.baseVal;
    if (
        !viewBox ||
        !Number.isFinite(viewBox.x) ||
        !Number.isFinite(viewBox.y) ||
        !Number.isFinite(viewBox.width) ||
        !Number.isFinite(viewBox.height) ||
        viewBox.width <= 0 ||
        viewBox.height <= 0
    ) {
        return null;
    }

    return {
        x: viewBox.x,
        y: viewBox.y,
        width: viewBox.width,
        height: viewBox.height
    };
}

function readFixedSvgDimension(value) {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (!normalized || normalized.endsWith('%')) {
        return null;
    }

    const numericValue = Number.parseFloat(normalized);
    if (!Number.isFinite(numericValue) || numericValue <= 0) {
        return null;
    }

    return numericValue;
}

function normalizeRenderedSvgSize(renderOutput) {
    const root = getSvgRoot(renderOutput);
    const currentViewBox = readSvgViewBox(root);
    if (!root || !currentViewBox) {
        return;
    }

    const nextWidth = Math.max(
        1,
        Math.ceil(
            Math.max(currentViewBox.width, readFixedSvgDimension(root.getAttribute('width')) || 0)
        )
    );
    const nextHeight = Math.max(
        1,
        Math.ceil(
            Math.max(currentViewBox.height, readFixedSvgDimension(root.getAttribute('height')) || 0)
        )
    );

    root.setAttribute('width', String(nextWidth));
    root.setAttribute('height', String(nextHeight));
    root.style.width = `${nextWidth}px`;
    root.style.height = `${nextHeight}px`;
    root.style.maxWidth = 'none';
    root.style.maxHeight = 'none';
}

function shortenGanttAxisLabel(text) {
    const trimmed = (text || '').trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
        return trimmed.slice(5);
    }

    return trimmed;
}

function getVisibleGanttAxisLabels(labels) {
    return labels.filter((label) => label.style.display !== 'none');
}

function hasOverlappingGanttAxisLabels(labels) {
    let previousRight = -Infinity;

    for (const label of labels) {
        const box = label.getBoundingClientRect();
        if (!box.width) {
            continue;
        }

        if (box.left < previousRight + 4) {
            return true;
        }

        previousRight = box.right;
    }

    return false;
}

function normalizeGanttAxisLabels(renderOutput) {
    const root = getSvgRoot(renderOutput);
    if (!root) {
        return;
    }

    const labels = Array.from(root.querySelectorAll('.grid .tick text'));
    if (labels.length < 2) {
        return;
    }

    labels.forEach((label) => {
        const compactText = shortenGanttAxisLabel(label.textContent);
        if (compactText) {
            label.textContent = compactText;
        }
    });

    if (!hasOverlappingGanttAxisLabels(getVisibleGanttAxisLabels(labels))) {
        return;
    }

    for (let step = 2; step <= labels.length; step += 1) {
        labels.forEach((label, index) => {
            label.style.display =
                index === 0 || index === labels.length - 1 || index % step === 0 ? '' : 'none';
        });

        if (!hasOverlappingGanttAxisLabels(getVisibleGanttAxisLabels(labels))) {
            break;
        }
    }
}

export function getCurrentMermaidTheme() {
    return document.documentElement.classList.contains('dark-theme') ? 'dark' : 'default';
}

function notifyMermaidLayoutUpdated(container) {
    if (container?.isConnected) {
        eventBus.emit('mermaid:layout-updated', { container });
    }
}

export function setMermaidSourcePanelVisible(container, visible) {
    const sourcePanel = container.querySelector('.mermaid-source-panel');
    const toggleButton = container.querySelector('.mermaid-toggle-source');

    if (sourcePanel) {
        sourcePanel.hidden = !visible;
    }

    if (toggleButton) {
        toggleButton.textContent = visible ? '收起源码' : '源码';
        toggleButton.setAttribute('aria-expanded', visible ? 'true' : 'false');
    }

    notifyMermaidLayoutUpdated(container);
}

export async function loadMermaid() {
    if (mermaidInstance?.render) {
        return mermaidInstance;
    }

    if (mermaidLoadPromise) {
        return mermaidLoadPromise;
    }

    mermaidLoadPromise = import('../../libs/mermaid/mermaid.esm.min.mjs')
        .then((module) => {
            const mermaid = resolveMermaidModule(module);
            if (!mermaid?.render || !mermaid?.initialize) {
                throw new Error('Mermaid 接口不可用');
            }

            configureMermaid(mermaid);
            mermaidInstance = mermaid;
            return mermaid;
        })
        .catch((error) => {
            mermaidLoadPromise = null;
            mermaidInstance = null;
            initializedMermaidTheme = null;

            const loadError = new Error('Mermaid 资源加载失败');
            loadError.cause = error;
            throw loadError;
        });

    return mermaidLoadPromise;
}

export async function renderMermaid(code) {
    const mermaid = mermaidInstance?.render ? mermaidInstance : await loadMermaid();
    const workspace = createHiddenRenderWorkspace();

    try {
        // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
        workspace.innerHTML = '';
        return await mermaid.render(nextMermaidGraphId(), code, workspace);
    } finally {
        cleanupHiddenRenderWorkspace(workspace);
    }
}

export async function renderMermaidBlock(container, options = {}) {
    const { force = false, reason = 'initial' } = options;

    if (!container?.isConnected) {
        return { ok: false, status: 'skipped', skipped: true };
    }
    ensureMermaidViewportWatcher();

    const canvas = getCanvasElement(container);
    if (!canvas) {
        return { ok: false, status: 'skipped', skipped: true };
    }

    const existingSvg = canvas.querySelector('svg');
    if (!force && container.dataset.mermaidStatus === 'ready' && existingSvg) {
        return { ok: true, status: 'ready', skipped: true };
    }

    const requestId = String(Number(container.dataset.mermaidRequestId || '0') + 1);
    const requestedTheme = getCurrentMermaidTheme();
    const needsLoad = !mermaidInstance?.render;

    container.dataset.mermaidRequestId = requestId;

    setMermaidStatus(
        container,
        needsLoad ? 'loading-lib' : 'rendering',
        needsLoad ? 'Mermaid 资源加载中…' : '正在生成图表…'
    );

    try {
        const mermaid = await loadMermaid();
        if (!isLatestRequest(container, requestId)) {
            return { ok: false, status: 'stale', skipped: true };
        }

        configureMermaid(mermaid, requestedTheme);
        setMermaidStatus(container, 'rendering', '正在生成图表…');

        const { svg, bindFunctions, diagramType } = await renderMermaid(
            getMermaidSource(container)
        );

        if (!isLatestRequest(container, requestId)) {
            return { ok: false, status: 'stale', skipped: true };
        }

        // DOMPurify 二次消毒：防止 Mermaid 内部消毒策略变化导致的 XSS
        // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
        canvas.innerHTML =
            typeof DOMPurify !== 'undefined'
                ? DOMPurify.sanitize(svg, {
                      USE_PROFILES: { svg: true, svgFilters: true },
                      ADD_TAGS: ['foreignObject']
                  })
                : svg;
        const renderOutput = canvas.firstElementChild;
        renderOutput?.classList.add('mermaid-render-output');
        if (diagramType === 'gantt' && renderOutput) {
            normalizeGanttAxisLabels(renderOutput);
        }
        normalizeRenderedSvgSize(renderOutput);
        if (typeof bindFunctions === 'function') {
            bindFunctions(canvas);
        }

        container.dataset.mermaidTheme = requestedTheme;
        container.dataset.mermaidDiagramType = diagramType || '';
        resetMermaidCanvasScrollPosition(canvas);
        setMermaidStatus(container, 'ready', '已生成图表');
        syncThemeRefreshState(container, requestedTheme);
        notifyMermaidLayoutUpdated(container);

        return {
            ok: true,
            status: 'ready',
            diagramType: diagramType || ''
        };
    } catch (error) {
        if (!isLatestRequest(container, requestId)) {
            return { ok: false, status: 'stale', skipped: true };
        }

        const failure = classifyMermaidError(error);
        logger.error(`[Mermaid] ${reason} 渲染失败:`, error);

        if (!existingSvg) {
            // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
            canvas.innerHTML = '';
        }

        setMermaidSourcePanelVisible(container, true);
        setMermaidStatus(container, failure.status, failure.text, {
            showRetry: failure.canRetry
        });
        notifyMermaidLayoutUpdated(container);

        return {
            ok: false,
            status: failure.status,
            error
        };
    }
}

export async function updateVisibleMermaidTheme() {
    if (!mermaidInstance?.render) {
        return { refreshedCount: 0, failedCount: 0 };
    }

    themeRefreshSerial += 1;
    const refreshSerial = themeRefreshSerial;
    const currentTheme = getCurrentMermaidTheme();

    const containers = Array.from(document.querySelectorAll('.mermaid-block')).filter(
        (container) => {
            return (
                container.isConnected &&
                container.dataset.mermaidStatus === 'ready' &&
                container.querySelector('.mermaid-canvas svg')
            );
        }
    );

    let refreshedCount = 0;
    let failedCount = 0;

    for (const container of containers) {
        if (refreshSerial !== themeRefreshSerial) {
            break;
        }

        if (container.dataset.mermaidTheme === currentTheme) {
            clearPendingThemeRefresh(container, currentTheme);
            continue;
        }

        const result = await renderMermaidBlock(container, {
            force: true,
            reason: 'theme-change'
        });

        if (refreshSerial !== themeRefreshSerial) {
            break;
        }

        if (result.ok) {
            refreshedCount += 1;
        } else if (!result.skipped) {
            failedCount += 1;
        }
    }

    return { refreshedCount, failedCount };
}
