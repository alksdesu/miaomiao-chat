/**
 * messages/render-stop-notice.js 正文末尾结束原因提示条测试
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { appendStopNotice } from '../../js/messages/render-stop-notice.js';

let contentEl;

beforeEach(() => {
    contentEl = document.createElement('div');
    contentEl.className = 'message-content';
    contentEl.appendChild(document.createElement('p')).textContent = '正文';
});

describe('appendStopNotice', () => {
    it('追加在正文之后并带上原因码', () => {
        appendStopNotice(contentEl, { kind: 'max_tokens', reason: 'length' });

        const notice = contentEl.lastElementChild;
        expect(notice.className).toBe('stop-notice');
        expect(notice.getAttribute('role')).toBe('note');
        expect(notice.dataset.stopKind).toBe('max_tokens');
        expect(notice.querySelector('.stop-notice-text').textContent).toContain('最大输出长度');
        expect(notice.querySelector('.stop-notice-reason').textContent).toBe('length');
        expect(notice.querySelector('.stop-notice-detail')).toBeNull();
        expect(contentEl.firstElementChild.textContent).toBe('正文');
    });

    it('说明按纯文本渲染', () => {
        appendStopNotice(contentEl, {
            kind: 'refusal',
            reason: 'refusal',
            detail: '<img src=x onerror=alert(1)>'
        });

        const detail = contentEl.querySelector('.stop-notice-detail');
        expect(detail.textContent).toBe('<img src=x onerror=alert(1)>');
        expect(detail.querySelector('img')).toBeNull();
    });

    it('重复调用只保留最新一条', () => {
        appendStopNotice(contentEl, { kind: 'max_tokens', reason: 'length' });
        appendStopNotice(contentEl, { kind: 'safety', reason: 'content_filter' });

        const notices = contentEl.querySelectorAll('.stop-notice');
        expect(notices).toHaveLength(1);
        expect(notices[0].dataset.stopKind).toBe('safety');
    });

    it('无需提示的原因只清除旧提示', () => {
        appendStopNotice(contentEl, { kind: 'max_tokens', reason: 'length' });
        appendStopNotice(contentEl, { kind: 'end', reason: 'stop' });
        expect(contentEl.querySelector('.stop-notice')).toBeNull();

        appendStopNotice(contentEl, { kind: 'max_tokens', reason: 'length' });
        appendStopNotice(contentEl, null);
        expect(contentEl.querySelector('.stop-notice')).toBeNull();
    });

    it('没有容器时安全返回', () => {
        expect(() =>
            appendStopNotice(null, { kind: 'max_tokens', reason: 'length' })
        ).not.toThrow();
    });
});
