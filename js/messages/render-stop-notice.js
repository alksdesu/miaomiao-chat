/**
 * 回复结束原因提示条：截断、拦截、拒答时追加在消息正文末尾
 */

import { describeStop } from './stop-reason.js';

/**
 * 重复调用只保留一条提示；stop 无需提示时仅清除旧提示
 * @param {HTMLElement|null} contentEl .message-content
 * @param {import('./stop-reason.js').StopInfo|null|undefined} stop
 */
export function appendStopNotice(contentEl, stop) {
    if (!contentEl) return;
    for (const child of Array.from(contentEl.children)) {
        if (child.classList.contains('stop-notice')) child.remove();
    }

    const notice = describeStop(stop);
    if (!notice) return;

    const noticeEl = document.createElement('div');
    noticeEl.className = 'stop-notice';
    noticeEl.setAttribute('role', 'note');
    noticeEl.dataset.stopKind = stop.kind;

    const textEl = document.createElement('span');
    textEl.className = 'stop-notice-text';
    textEl.textContent = notice.title;

    const reasonEl = document.createElement('code');
    reasonEl.className = 'stop-notice-reason';
    reasonEl.textContent = notice.reason;

    noticeEl.append(textEl, reasonEl);

    if (notice.detail) {
        const detailEl = document.createElement('div');
        detailEl.className = 'stop-notice-detail';
        detailEl.textContent = notice.detail;
        noticeEl.append(detailEl);
    }

    contentEl.appendChild(noticeEl);
}
