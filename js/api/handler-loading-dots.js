/**
 * 加载指示器 DOM 工厂
 *
 * 把 handler.js / image-retry.js / placeholder-resolver.js 里散落的
 * `innerHTML = '<div class="thinking-dots">...</div>'` 字面量收口为 createElement 链路，
 * 杜绝 eslint-disable + 静态 HTML 字面量绕过 no-restricted-syntax 规则。
 */

/**
 * 构造 thinking-dots 的 3 个 span（共用 helper）
 * @param {HTMLElement} parent
 */
function appendThreeDots(parent) {
    for (let i = 0; i < 3; i++) {
        parent.appendChild(document.createElement('span'));
    }
}

/**
 * 构造一个 thinking-dots 容器，可选附加 class
 * @param {string|null} [extraClass]
 * @returns {HTMLElement}
 */
export function createThinkingDots(extraClass = null) {
    const dots = document.createElement('div');
    dots.className = extraClass ? `thinking-dots ${extraClass}` : 'thinking-dots';
    appendThreeDots(dots);
    return dots;
}

/**
 * Continuation 模式 loading：与原 'thinking-dots continuation-loading' 等价
 * @returns {HTMLElement}
 */
export function createContinuationLoading() {
    return createThinkingDots('continuation-loading');
}

/**
 * 图片压缩重试 loading + 提示文案
 * 用 DocumentFragment 让调用方一次 appendChild 注入两个兄弟节点
 * @returns {DocumentFragment}
 */
export function renderImageRetryLoading() {
    const fragment = document.createDocumentFragment();
    fragment.appendChild(createThinkingDots('retry-loading'));
    const hint = document.createElement('div');
    hint.className = 'image-retry-hint';
    hint.textContent = '图片过大，已自动压缩后重试...';
    fragment.appendChild(hint);
    return fragment;
}
