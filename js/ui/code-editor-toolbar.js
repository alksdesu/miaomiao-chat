/**
 * 代码编辑器工具栏
 * 全屏预览、焦点陷阱
 */

/**
 * 焦点陷阱 — 限制 Tab 焦点在模态框内循环
 * @param {HTMLElement} element - 容器元素
 */
export function trapFocus(element) {
    const focusableElements = element.querySelectorAll(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    const firstFocusable = focusableElements[0];
    const lastFocusable = focusableElements[focusableElements.length - 1];

    element.addEventListener('keydown', (e) => {
        if (e.key === 'Tab') {
            if (e.shiftKey) {
                if (document.activeElement === firstFocusable) {
                    e.preventDefault();
                    lastFocusable.focus();
                }
            } else {
                if (document.activeElement === lastFocusable) {
                    e.preventDefault();
                    firstFocusable.focus();
                }
            }
        }
    });

    // 初始聚焦
    setTimeout(() => firstFocusable?.focus(), 100);
}

/**
 * 打开全屏预览
 * @param {string} htmlContent - HTML内容
 */
export function openFullscreenPreview(htmlContent) {
    // 创建全屏预览容器
    const fullscreenOverlay = document.createElement('div');
    fullscreenOverlay.id = 'fullscreen-preview-overlay';
    fullscreenOverlay.className = 'fullscreen-preview-overlay';

    // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
    fullscreenOverlay.innerHTML = `
        <div class="fullscreen-preview-header">
            <span class="fullscreen-preview-title">全屏预览</span>
            <button class="fullscreen-preview-close" title="退出全屏 (ESC)">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M18 6L6 18M6 6l12 12"></path>
                </svg>
            </button>
        </div>
        <iframe class="fullscreen-preview-iframe" sandbox="allow-scripts"></iframe>
    `;

    document.body.appendChild(fullscreenOverlay);

    // 写入内容到 iframe
    const iframe = fullscreenOverlay.querySelector('.fullscreen-preview-iframe');
    iframe.srcdoc = htmlContent;

    // 使用 AbortController 自动清理事件监听器
    const abortController = new AbortController();
    const { signal } = abortController;

    // 关闭全屏预览
    const closeFullscreen = () => {
        abortController.abort(); // 清理所有监听器
        fullscreenOverlay.remove();
    };

    // ESC 键关闭
    const escHandler = (e) => {
        if (e.key === 'Escape') {
            closeFullscreen();
        }
    };
    document.addEventListener('keydown', escHandler, { signal });

    // 点击关闭按钮
    const closeBtn = fullscreenOverlay.querySelector('.fullscreen-preview-close');
    closeBtn.addEventListener('click', closeFullscreen, { signal });

    // 动画效果
    requestAnimationFrame(() => {
        fullscreenOverlay.classList.add('active');
    });
}
