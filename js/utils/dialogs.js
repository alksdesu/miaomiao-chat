/**
 * 通用对话框工具
 * 替代 Electron 中不支持的 prompt() 和 confirm()
 */

import { bindTopmostEscape } from './modal-stack.js';
import { activateModalIsolation } from './focus-trap.js';
import { escapeHtml } from './helpers.js';

/**
 * 显示输入对话框（替代 prompt）
 * @param {string} message - 提示消息
 * @param {string} defaultValue - 默认值
 * @param {string} title - 对话框标题
 * @param {object} [options]
 * @param {AbortSignal} [options.signal] - 外部 signal abort 时自动 resolve(null) 关闭对话框
 * @param {number} [options.timeoutMs] - 自动超时（毫秒），超时 resolve(null)；不传则不超时
 * @returns {Promise<string|null>} 用户输入的值，或 null（取消/abort/timeout）
 */
export function showInputDialog(message, defaultValue = '', title = '输入', options = {}) {
    const { signal, timeoutMs } = options;
    return new Promise((resolve) => {
        // 外部已 abort：跳过 DOM 操作直接拒绝
        if (signal?.aborted) {
            resolve(null);
            return;
        }

        const modal = document.getElementById('input-dialog-modal');
        const titleEl = document.getElementById('input-dialog-title');
        const messageEl = document.getElementById('input-dialog-message');
        const input = document.getElementById('input-dialog-input');
        const confirmBtn = document.getElementById('input-dialog-confirm');
        const cancelBtn = document.getElementById('input-dialog-cancel');
        const closeBtn = document.getElementById('close-input-dialog');

        // 设置内容
        titleEl.textContent = title;
        messageEl.textContent = message;
        input.value = defaultValue;
        let removeEscapeListener = null;
        let timeoutId = null;
        let abortListener = null;

        // 显示对话框
        modal.style.display = 'flex';

        // 模态隔离：trapFocus + .app-container inert + 关闭时还原焦点
        const isolation = activateModalIsolation(modal);

        // 聚焦输入框并选中文本
        setTimeout(() => {
            input.focus();
            input.select();
        }, 100);

        // 确定按钮
        const handleConfirm = () => {
            const value = input.value.trim();
            cleanup();
            resolve(value || null);
        };

        // 取消按钮
        const handleCancel = () => {
            cleanup();
            resolve(null);
        };

        // 清理函数 - 正确移除所有事件监听器
        const cleanup = () => {
            removeEscapeListener?.();
            removeEscapeListener = null;
            if (timeoutId) clearTimeout(timeoutId);
            if (abortListener && signal) signal.removeEventListener('abort', abortListener);

            modal.style.display = 'none';
            isolation.release();
            confirmBtn.removeEventListener('click', handleConfirm);
            cancelBtn.removeEventListener('click', handleCancel);
            closeBtn.removeEventListener('click', handleCancel);
            modal.removeEventListener('click', handleOverlayClick);
            input.removeEventListener('keydown', handleKeydown);
        };

        // 点击遮罩层关闭
        const handleOverlayClick = (e) => {
            if (e.target === modal || e.target.classList.contains('modal-overlay')) {
                handleCancel();
            }
        };

        // 键盘事件
        const handleKeydown = (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                handleConfirm();
            }
        };

        // 绑定事件
        confirmBtn.addEventListener('click', handleConfirm);
        cancelBtn.addEventListener('click', handleCancel);
        closeBtn.addEventListener('click', handleCancel);
        modal.addEventListener('click', handleOverlayClick);
        input.addEventListener('keydown', handleKeydown);

        removeEscapeListener = bindTopmostEscape(modal, handleCancel);

        // 超时自动拒绝（与 showConfirmDialog 对称）
        if (typeof timeoutMs === 'number' && timeoutMs > 0) {
            timeoutId = setTimeout(handleCancel, timeoutMs);
        }

        // 外部 signal abort 时关闭对话框并拒绝
        if (signal) {
            abortListener = () => handleCancel();
            signal.addEventListener('abort', abortListener, { once: true });
        }
    });
}

/**
 * 显示确认对话框（替代 confirm）
 *
 * showConfirmDialog 共用单例 #confirm-dialog-modal DOM；并发调用会让后调起的
 * message/title/listeners 覆盖前者，用户点一次"允许"导致所有 Promise 同时 resolve 同结果
 * （权限隔离被破坏）。用 _dialogQueue 串行化保证同一时刻只有一个对话框可见
 *
 * @param {string} message - 确认消息
 * @param {string} title - 对话框标题
 * @param {object} [options]
 * @param {AbortSignal} [options.signal] - 外部 signal abort 时自动 resolve(false) 关闭对话框
 * @param {number} [options.timeoutMs] - 自动超时（毫秒），超时 resolve(false)；不传则不超时
 * @param {{label: string, key: string}} [options.allowSessionPersistOption]
 *        - 传入则在 body 末尾渲染 checkbox（默认未勾选）；用户勾选后调用方可在本次会话范围内
 *          以 `key` 为标识豁免后续相同确认。返回值升级为 `{confirmed, persistForSession}`；
 *          不传仍 resolve `boolean`，27 处既有调用零破坏。
 * @returns {Promise<boolean|{confirmed:boolean, persistForSession:boolean}>}
 *          未传 allowSessionPersistOption：boolean（true=确定, false=取消/abort/timeout）
 *          传了 allowSessionPersistOption：对象 {confirmed, persistForSession}
 */
let _activeDialog = null;
export function showConfirmDialog(message, title = '确认', options = {}) {
    // 已有 dialog 在显示：排队等其结束后再启动新 dialog，避免并发抢同一 DOM。
    // 闲时直接同步调 _showConfirmDialogImpl，保证 listener 绑定与 click 触发在同步路径内
    if (_activeDialog) {
        return _activeDialog.then(() => showConfirmDialog(message, title, options));
    }
    const p = _showConfirmDialogImpl(message, title, options);
    _activeDialog = p.finally(() => {
        _activeDialog = null;
    });
    return p;
}

function _showConfirmDialogImpl(message, title, options) {
    const { signal, timeoutMs, allowSessionPersistOption } = options;
    // 决定返回形态：传 option → 对象；未传 → 历史 boolean 契约
    const hasPersistOption = !!(
        allowSessionPersistOption &&
        typeof allowSessionPersistOption.label === 'string' &&
        typeof allowSessionPersistOption.key === 'string'
    );
    const buildResult = (confirmed, persistForSession) =>
        hasPersistOption ? { confirmed, persistForSession } : confirmed;

    return new Promise((resolve) => {
        // 外部已 abort：跳过 DOM 操作直接拒绝
        if (signal?.aborted) {
            resolve(buildResult(false, false));
            return;
        }

        const modal = document.getElementById('confirm-dialog-modal');
        const titleEl = document.getElementById('confirm-dialog-title');
        const messageEl = document.getElementById('confirm-dialog-message');
        const confirmBtn = document.getElementById('confirm-dialog-confirm');
        const cancelBtn = document.getElementById('confirm-dialog-cancel');
        const closeBtn = document.getElementById('close-confirm-dialog');
        const bodyEl = messageEl?.parentElement || null;

        // 设置内容
        titleEl.textContent = title;
        messageEl.textContent = message;

        // 可选 checkbox：动态注入，cleanup 时移除，避免污染下次复用 modal
        let persistContainer = null;
        let persistCheckbox = null;
        if (hasPersistOption && bodyEl) {
            persistContainer = document.createElement('label');
            persistContainer.className = 'confirm-dialog-persist-option';
            persistContainer.dataset.persistKey = allowSessionPersistOption.key;
            // 主题色对齐 + 与上方消息留间距；颜色 token 走全局变量，深浅色主题自动跟随
            persistContainer.style.cssText =
                'display:flex;align-items:center;gap:8px;margin-top:14px;' +
                'color:var(--color-text-primary);font-family:var(--font-sans);' +
                'font-size:var(--fs-base);line-height:1.5;cursor:pointer;user-select:none;';
            // eslint-disable-next-line no-restricted-syntax -- label 文本走 escapeHtml 转义，checkbox 是静态结构
            persistContainer.innerHTML =
                '<input type="checkbox" style="width:18px;height:18px;margin:0;' +
                'accent-color:var(--md-blue);cursor:pointer;flex-shrink:0;" />' +
                '<span>' +
                escapeHtml(allowSessionPersistOption.label) +
                '</span>';
            persistCheckbox = persistContainer.querySelector('input[type="checkbox"]');
            bodyEl.appendChild(persistContainer);
        }

        let removeEscapeListener = null;
        let timeoutId = null;
        let abortListener = null;

        // 显示对话框
        modal.style.display = 'flex';

        // 模态隔离：trapFocus + .app-container inert + 关闭时还原焦点
        const isolation = activateModalIsolation(modal);

        // 聚焦确定按钮
        setTimeout(() => {
            confirmBtn.focus();
        }, 100);

        // 清理函数
        const cleanup = () => {
            removeEscapeListener?.();
            removeEscapeListener = null;
            if (timeoutId) clearTimeout(timeoutId);
            if (abortListener && signal) signal.removeEventListener('abort', abortListener);

            modal.style.display = 'none';
            isolation.release();
            confirmBtn.removeEventListener('click', handleConfirm);
            cancelBtn.removeEventListener('click', handleCancel);
            closeBtn.removeEventListener('click', handleCancel);
            modal.removeEventListener('click', handleOverlayClick);
            // 移除本次注入的 checkbox，防止下次复用 modal 时残留
            persistContainer?.remove();
            persistContainer = null;
            persistCheckbox = null;
        };

        const handleConfirm = () => {
            const persist = !!persistCheckbox?.checked;
            cleanup();
            resolve(buildResult(true, persist));
        };

        const handleCancel = () => {
            // 取消/abort/timeout 一律视为未授予本次会话豁免，避免拒绝同时打开免确认通道
            cleanup();
            resolve(buildResult(false, false));
        };

        // 点击遮罩层关闭（点击模态框内容区域外的部分）
        const handleOverlayClick = (e) => {
            if (e.target === modal || e.target.classList.contains('modal-overlay')) {
                handleCancel();
            }
        };

        // 绑定事件
        confirmBtn.addEventListener('click', handleConfirm);
        cancelBtn.addEventListener('click', handleCancel);
        closeBtn.addEventListener('click', handleCancel);
        modal.addEventListener('click', handleOverlayClick);
        // 打开后默认聚焦确定按钮，因此常规路径下回车仍会确认；
        // 若用户主动切到其他控件，则遵循当前焦点元素的原生行为，避免对话框外误触发确认

        removeEscapeListener = bindTopmostEscape(modal, handleCancel);

        // 超时自动拒绝（工具调用确认场景，用户长时间不响应不能让工具永久 RUNNING）
        if (typeof timeoutMs === 'number' && timeoutMs > 0) {
            timeoutId = setTimeout(handleCancel, timeoutMs);
        }

        // 外部 signal abort 时关闭对话框并拒绝（用户点停止按钮触发请求 abortController.abort）
        if (signal) {
            abortListener = () => handleCancel();
            signal.addEventListener('abort', abortListener, { once: true });
        }
    });
}
