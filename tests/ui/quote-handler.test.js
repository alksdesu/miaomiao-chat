/**
 * quote-handler.js 测试
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../js/core/state.js', () => ({
    elements: { userInput: null }
}));

vi.mock('../../js/utils/helpers.js', () => ({
    escapeHtml: vi.fn((s) => {
        if (!s) return '';
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    })
}));

import {
    getQuotedMessage,
    setQuotedMessage,
    clearQuotedMessage,
    updateQuotePreviewStyle
} from '../../js/ui/quote-handler.js';

describe('quote-handler', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
        clearQuotedMessage();
    });

    // ========== getQuotedMessage ==========
    describe('getQuotedMessage', () => {
        it('初始为 null', () => {
            expect(getQuotedMessage()).toBeNull();
        });
    });

    // ========== setQuotedMessage ==========
    describe('setQuotedMessage', () => {
        it('设置引用消息', () => {
            // 需要 DOM 结构（input-bar + resize-handle）
            document.body.innerHTML = `
                <div class="input-bar">
                    <div id="input-resize-handle"></div>
                </div>
            `;
            setQuotedMessage('user', 'hello');
            const msg = getQuotedMessage();
            expect(msg).toBeDefined();
            expect(msg.role).toBe('user');
            expect(msg.content).toBe('hello');
            expect(msg.preview).toBe('hello');
        });

        it('超过 100 字截断预览', () => {
            document.body.innerHTML = `<div class="input-bar"><div id="input-resize-handle"></div></div>`;
            const longText = 'a'.repeat(150);
            setQuotedMessage('assistant', longText);
            const msg = getQuotedMessage();
            expect(msg.preview.length).toBeLessThan(longText.length);
            expect(msg.preview).toContain('...');
        });

        it('渲染 quote-preview 元素', () => {
            document.body.innerHTML = `<div class="input-bar"><div id="input-resize-handle"></div></div>`;
            setQuotedMessage('user', 'test message');
            const preview = document.getElementById('quote-preview');
            expect(preview).toBeTruthy();
        });

        it('user 角色显示用户标签', () => {
            document.body.innerHTML = `<div class="input-bar"><div id="input-resize-handle"></div></div>`;
            setQuotedMessage('user', 'msg');
            const preview = document.getElementById('quote-preview');
            expect(preview.innerHTML).toContain('用户');
        });

        it('assistant 角色显示 AI 标签', () => {
            document.body.innerHTML = `<div class="input-bar"><div id="input-resize-handle"></div></div>`;
            setQuotedMessage('assistant', 'msg');
            const preview = document.getElementById('quote-preview');
            expect(preview.innerHTML).toContain('AI');
        });

        it('重复设置复用同一 preview 元素', () => {
            document.body.innerHTML = `<div class="input-bar"><div id="input-resize-handle"></div></div>`;
            setQuotedMessage('user', 'first');
            setQuotedMessage('user', 'second');
            const previews = document.querySelectorAll('#quote-preview');
            expect(previews.length).toBe(1);
        });
    });

    // ========== clearQuotedMessage ==========
    describe('clearQuotedMessage', () => {
        it('清除后为 null', () => {
            document.body.innerHTML = `<div class="input-bar"><div id="input-resize-handle"></div></div>`;
            setQuotedMessage('user', 'test');
            clearQuotedMessage();
            expect(getQuotedMessage()).toBeNull();
        });

        it('移除 preview DOM', () => {
            document.body.innerHTML = `<div class="input-bar"><div id="input-resize-handle"></div></div>`;
            setQuotedMessage('user', 'test');
            expect(document.getElementById('quote-preview')).toBeTruthy();
            clearQuotedMessage();
            expect(document.getElementById('quote-preview')).toBeNull();
        });
    });

    // ========== updateQuotePreviewStyle ==========
    describe('updateQuotePreviewStyle', () => {
        it('无 quote-preview 不抛错', () => {
            expect(() => updateQuotePreviewStyle()).not.toThrow();
        });

        it('无图片时添加 standalone class', () => {
            document.body.innerHTML = `<div id="quote-preview" class="quote-preview"></div>`;
            updateQuotePreviewStyle();
            expect(document.getElementById('quote-preview').classList.contains('standalone')).toBe(
                true
            );
        });

        it('有图片时移除 standalone class', () => {
            document.body.innerHTML = `
                <div id="quote-preview" class="quote-preview standalone"></div>
                <div id="image-preview-container" class="has-images"></div>
            `;
            updateQuotePreviewStyle();
            expect(document.getElementById('quote-preview').classList.contains('standalone')).toBe(
                false
            );
        });
    });
});
