/**
 * 模态层级辅助工具
 * 用于判断当前顶层弹层，并统一处理 Escape 关闭约定、焦点约束与层级来源
 */

const MODAL_LAYER_SELECTOR = '.modal, [aria-modal="true"], .image-viewer-modal.open';
const DOCUMENT_POSITION_PRECEDING = 2;
const DOCUMENT_POSITION_FOLLOWING = 4;
const DOCUMENT_POSITION_CONTAINED_BY = 16;
const FOCUSABLE_SELECTOR = [
    'button:not([disabled])',
    '[href]',
    'input:not([disabled]):not([type="hidden"])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])'
].join(', ');

export const MODAL_LAYER_Z_INDEX = Object.freeze({
    settings: '--z-modal-settings',
    settingsNested: '--z-modal-settings-nested',
    dialog: '--z-modal-dialog'
});

function getNumericZIndex(element) {
    const rawValue = window.getComputedStyle(element).zIndex;
    const parsedValue = Number.parseInt(rawValue, 10);
    return Number.isFinite(parsedValue) ? parsedValue : 0;
}

function isElementNode(value) {
    return Boolean(value) && typeof value === 'object' && value.nodeType === 1;
}

function isNodeLike(value) {
    return Boolean(value) && typeof value === 'object' && typeof value.nodeType === 'number';
}

function isTextSelectableControl(value) {
    return (
        isElementNode(value) &&
        ['INPUT', 'TEXTAREA'].includes(value.tagName) &&
        typeof value.select === 'function'
    );
}

function canReceiveFocus(element) {
    if (!isElementNode(element)) return false;
    if (element.hidden || element.getAttribute('aria-hidden') === 'true') return false;

    const style = window.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden') {
        return false;
    }

    return element.getClientRects().length > 0 || element === document.activeElement;
}

function resolveElement(target, container) {
    if (!target) return null;

    if (typeof target === 'function') {
        return resolveElement(target(), container);
    }

    if (typeof target === 'string') {
        return container?.querySelector(target) ?? document.querySelector(target);
    }

    return isElementNode(target) ? target : null;
}

function focusElement(element) {
    if (!isElementNode(element) || typeof element.focus !== 'function') return false;

    try {
        element.focus({ preventScroll: true });
    } catch {
        element.focus();
    }

    return document.activeElement === element;
}

export function getFocusableElements(container) {
    if (!container) return [];

    return Array.from(container.querySelectorAll(FOCUSABLE_SELECTOR)).filter(canReceiveFocus);
}

function getDefaultFocusTarget(container) {
    return getFocusableElements(container)[0] ?? container;
}

export function readRootZIndex(variableName) {
    if (!variableName) return null;

    const rawValue = window
        .getComputedStyle(document.documentElement)
        .getPropertyValue(variableName)
        .trim();
    const parsedValue = Number.parseInt(rawValue, 10);
    return Number.isFinite(parsedValue) ? parsedValue : null;
}

export function applyModalLayerZIndex(element, variableName) {
    if (!element || !variableName) return null;

    const zIndex = readRootZIndex(variableName);
    if (zIndex === null) {
        element.style.removeProperty('--modal-layer-z-index');
        element.style.removeProperty('z-index');
        return null;
    }

    element.style.setProperty('--modal-layer-z-index', String(zIndex));
    element.style.removeProperty('z-index');
    return zIndex;
}

export function isModalLayerVisible(element) {
    if (!element || !element.isConnected) return false;

    const style = window.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden') {
        return false;
    }

    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
}

function compareModalLayerOrder(a, b) {
    const zIndexDiff = getNumericZIndex(a) - getNumericZIndex(b);
    if (zIndexDiff !== 0) {
        return zIndexDiff;
    }

    const position = a.compareDocumentPosition(b);

    // 嵌套关系：子节点（被包含）比父节点更高
    if (position & DOCUMENT_POSITION_CONTAINED_BY) {
        return -1;
    }

    if (position & DOCUMENT_POSITION_FOLLOWING) {
        return -1;
    }
    if (position & DOCUMENT_POSITION_PRECEDING) {
        return 1;
    }

    return 0;
}

function getVisibleModalLayers() {
    const uniqueLayers = [];
    const seen = new Set();

    document.querySelectorAll(MODAL_LAYER_SELECTOR).forEach((element) => {
        if (seen.has(element)) return;
        seen.add(element);

        if (isModalLayerVisible(element)) {
            uniqueLayers.push(element);
        }
    });

    return uniqueLayers;
}

export function getTopmostModalLayer() {
    const visibleLayers = getVisibleModalLayers();
    if (visibleLayers.length === 0) {
        return null;
    }

    visibleLayers.sort(compareModalLayerOrder);
    return visibleLayers.at(-1) ?? null;
}

export function isTopmostModalLayer(element) {
    return getTopmostModalLayer() === element;
}

/**
 * 为模态框补齐焦点约束、初始聚焦与关闭后的焦点恢复。
 * @param {object} element - 模态框根节点
 * @param {Object} options - 配置项
 * @param {string|object|Function} [options.initialFocus] - 打开后优先聚焦的目标
 * @param {string} [options.labelledBy] - 标题元素 ID
 * @param {string} [options.label] - 无标题时的兜底名称
 * @param {boolean} [options.restoreFocus=true] - 关闭时是否恢复到打开前焦点
 * @param {boolean} [options.selectText=false] - 聚焦到输入类控件后是否自动全选
 * @returns {Function} 清理函数
 */
export function setupModalFocus(element, options = {}) {
    if (!element) return () => {};

    const previousActiveElement = isElementNode(document.activeElement)
        ? document.activeElement
        : null;
    const restoreFocus = options.restoreFocus ?? true;
    const selectText = options.selectText ?? false;

    if (!element.hasAttribute('role')) {
        element.setAttribute('role', 'dialog');
    }
    if (!element.hasAttribute('aria-modal')) {
        element.setAttribute('aria-modal', 'true');
    }
    if (options.labelledBy) {
        element.setAttribute('aria-labelledby', options.labelledBy);
    } else if (options.label && !element.hasAttribute('aria-label')) {
        element.setAttribute('aria-label', options.label);
    }
    if (!element.hasAttribute('tabindex')) {
        element.setAttribute('tabindex', '-1');
    }

    const moveFocusInside = () => {
        const preferredTarget = resolveElement(options.initialFocus, element);
        const focusTarget = canReceiveFocus(preferredTarget)
            ? preferredTarget
            : getDefaultFocusTarget(element);

        if (!focusTarget) return;

        focusElement(focusTarget);

        if (selectText && isTextSelectableControl(focusTarget)) {
            focusTarget.select();
        }
    };

    const redirectFocusToBoundary = (preferLast = false) => {
        const focusableElements = getFocusableElements(element);
        const target = preferLast
            ? (focusableElements.at(-1) ?? focusableElements[0] ?? element)
            : (focusableElements[0] ?? focusableElements.at(-1) ?? element);

        focusElement(target);
    };

    const handleTab = (event) => {
        if (event.key !== 'Tab') return;
        if (!isModalLayerVisible(element)) return;
        if (!isTopmostModalLayer(element)) return;

        const focusableElements = getFocusableElements(element);
        if (focusableElements.length === 0) {
            event.preventDefault();
            focusElement(element);
            return;
        }

        const firstElement = focusableElements[0];
        const lastElement = focusableElements.at(-1) ?? firstElement;
        const activeElement = document.activeElement;
        const isFocusInside = isNodeLike(activeElement) && element.contains(activeElement);

        if (event.shiftKey) {
            if (!isFocusInside || activeElement === firstElement) {
                event.preventDefault();
                focusElement(lastElement);
            }
            return;
        }

        if (!isFocusInside || activeElement === lastElement) {
            event.preventDefault();
            focusElement(firstElement);
        }
    };

    const handleFocusIn = (event) => {
        if (!isModalLayerVisible(element)) return;
        if (!isTopmostModalLayer(element)) return;
        if (isNodeLike(event.target) && element.contains(event.target)) return;

        redirectFocusToBoundary(false);
    };

    const focusFrameId = window.requestAnimationFrame(() => {
        if (!isModalLayerVisible(element)) return;
        moveFocusInside();
    });

    element.addEventListener('keydown', handleTab);
    document.addEventListener('focusin', handleFocusIn, true);

    return () => {
        window.cancelAnimationFrame(focusFrameId);
        element.removeEventListener('keydown', handleTab);
        document.removeEventListener('focusin', handleFocusIn, true);

        if (
            restoreFocus &&
            previousActiveElement?.isConnected &&
            canReceiveFocus(previousActiveElement)
        ) {
            focusElement(previousActiveElement);
        }
    };
}

export function bindTopmostEscape(element, onEscape, options = {}) {
    const capture = options.capture ?? true;

    const handler = (event) => {
        if (event.key !== 'Escape') return;
        if (!isModalLayerVisible(element)) return;
        if (!isTopmostModalLayer(element)) return;

        event.preventDefault();
        event.stopPropagation();

        onEscape(event);
    };

    document.addEventListener('keydown', handler, capture);

    return () => {
        document.removeEventListener('keydown', handler, capture);
    };
}
