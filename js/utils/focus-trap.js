/**
 * 通用焦点陷阱工具
 *
 * 把 Tab 键焦点限制在 element 内，Shift+Tab 从首项回到末项、Tab 从末项回到首项。
 * 配套 inert：activateModalIsolation 把 .app-container 设 inert + 调 trapFocus，
 * deactivateModalIsolation 反向解除并还原触发元素焦点 — 让 viewer/settings/sidebar/
 * code-editor/dialogs 五处模态共用一套实现，避免独立复制 + 差异漂移
 *
 * 调用方式：
 *   const isolation = activateModalIsolation(modal);  // 进入模态
 *   isolation.release();                              // 关闭时调用，还原焦点
 */
const FOCUSABLE_SELECTOR =
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// 嵌套弹层共享 .app-container 的 inert：计数归零才真正解除，防止内层关闭提前恢复背景交互
let inertCount = 0;

/**
 * 申请背景隔离：.app-container 加 inert（引用计数 +1）
 */
export function acquireInert() {
    inertCount += 1;
    document.querySelector('.app-container')?.setAttribute('inert', '');
}

/**
 * 释放背景隔离：引用计数 -1，归零才移除 inert
 */
export function releaseInert() {
    if (inertCount === 0) return;
    inertCount -= 1;
    if (inertCount === 0) {
        document.querySelector('.app-container')?.removeAttribute('inert');
    }
}

/**
 * 启用焦点陷阱：Tab/Shift+Tab 循环聚焦在 element 内
 * 幂等：重复调用同一 element 不会装多个 handler
 * @param {HTMLElement} element
 */
export function trapFocus(element) {
    if (!element || element._focusTrapHandler) return;

    const handler = (e) => {
        if (e.key !== 'Tab') return;
        // offsetParent 为 null 即 display:none 隐藏区（如折叠的表单），聚焦它们会让 Tab 丢失
        const focusable = Array.from(element.querySelectorAll(FOCUSABLE_SELECTOR)).filter(
            (el) => el.offsetParent !== null
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];

        if (e.shiftKey && document.activeElement === first) {
            last.focus();
            e.preventDefault();
        } else if (!e.shiftKey && document.activeElement === last) {
            first.focus();
            e.preventDefault();
        }
    };

    element.addEventListener('keydown', handler);
    element._focusTrapHandler = handler;
}

/**
 * 解除焦点陷阱
 * @param {HTMLElement} element
 */
export function removeFocusTrap(element) {
    if (!element?._focusTrapHandler) return;
    element.removeEventListener('keydown', element._focusTrapHandler);
    delete element._focusTrapHandler;
}

/**
 * 模态隔离：trapFocus + .app-container inert + 记忆触发元素以便还原焦点
 *
 * .app-container 加 inert 让背景所有交互/读屏失效，避免 Tab 跳到背景元素、
 * 屏幕阅读器朗读模态背后内容（WCAG 2.4.3 + 4.1.2 合规）
 *
 * @param {HTMLElement} modal - 模态根元素
 * @returns {{release: () => void}} release() 调用时解除 inert + trap + 还原焦点
 */
export function activateModalIsolation(modal) {
    if (!modal) return { release: () => {} };

    const previousActive = document.activeElement;
    acquireInert();
    trapFocus(modal);

    let released = false;
    return {
        release() {
            if (released) return;
            released = true;
            removeFocusTrap(modal);
            releaseInert();
            // 还原焦点：previousActive 仍在 DOM 中且支持 focus() 才还原（避免还原到已删除节点）
            if (
                previousActive &&
                typeof previousActive.focus === 'function' &&
                document.contains(previousActive)
            ) {
                try {
                    previousActive.focus();
                } catch {
                    // 还原焦点失败不阻断关闭流程
                }
            }
        }
    };
}
