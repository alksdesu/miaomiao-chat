/**
 * code-editor-toolbar.js 代码编辑器工具栏测试
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { trapFocus, openFullscreenPreview } from '../../js/ui/code-editor-toolbar.js';

describe('code-editor-toolbar', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
        document.body.innerHTML = '';
    });

    afterEach(() => {
        vi.useRealTimers();
        document.body.innerHTML = '';
    });

    describe('trapFocus', () => {
        it('绑定 keydown 不抛错', () => {
            const container = document.createElement('div');
            container.innerHTML = '<button>A</button><button>B</button>';
            document.body.appendChild(container);
            expect(() => trapFocus(container)).not.toThrow();
        });

        it('空容器不抛错', () => {
            const container = document.createElement('div');
            document.body.appendChild(container);
            expect(() => trapFocus(container)).not.toThrow();
        });

        it('Tab 在最后一个元素时跳到第一个', () => {
            const container = document.createElement('div');
            const btn1 = document.createElement('button');
            const btn2 = document.createElement('button');
            btn1.textContent = 'First';
            btn2.textContent = 'Last';
            container.appendChild(btn1);
            container.appendChild(btn2);
            document.body.appendChild(container);

            trapFocus(container);
            btn2.focus();

            const prevented = { defaultPrevented: false };
            const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true });
            Object.defineProperty(event, 'preventDefault', {
                value: () => {
                    prevented.defaultPrevented = true;
                }
            });
            container.dispatchEvent(event);

            // focus should have been called on first element
            expect(prevented.defaultPrevented).toBe(true);
        });

        it('初始聚焦在首个元素', () => {
            const container = document.createElement('div');
            const btn = document.createElement('button');
            btn.textContent = 'Focus me';
            container.appendChild(btn);
            document.body.appendChild(container);

            const spy = vi.spyOn(btn, 'focus');
            trapFocus(container);
            vi.advanceTimersByTime(200);
            expect(spy).toHaveBeenCalled();
        });
    });

    describe('openFullscreenPreview', () => {
        it('创建全屏预览 overlay', () => {
            openFullscreenPreview('<h1>Hello</h1>');
            vi.advanceTimersByTime(100);

            const overlay = document.getElementById('fullscreen-preview-overlay');
            expect(overlay).toBeTruthy();
            expect(overlay.querySelector('.fullscreen-preview-iframe')).toBeTruthy();
        });

        it('iframe 写入 HTML 内容', () => {
            openFullscreenPreview('<h1>Test</h1>');
            vi.advanceTimersByTime(100);

            const iframe = document.querySelector('.fullscreen-preview-iframe');
            expect(iframe.srcdoc).toBe('<h1>Test</h1>');
        });

        it('关闭按钮移除 overlay', () => {
            openFullscreenPreview('<p>Content</p>');
            vi.advanceTimersByTime(100);

            const closeBtn = document.querySelector('.fullscreen-preview-close');
            closeBtn.click();

            expect(document.getElementById('fullscreen-preview-overlay')).toBeNull();
        });

        it('ESC 关闭 overlay', () => {
            openFullscreenPreview('<p>Content</p>');
            vi.advanceTimersByTime(100);

            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
            expect(document.getElementById('fullscreen-preview-overlay')).toBeNull();
        });
    });
});
