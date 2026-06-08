/**
 * dom-sync.js 测试
 * DOM 同步：setMessageIndex, setCurrentMessageIndex
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../js/core/state.js', () => ({
    state: {
        currentAssistantMessage: null
    }
}));

import { state } from '../../js/core/state.js';
import { setMessageIndex, setCurrentMessageIndex } from '../../js/messages/dom-sync.js';

beforeEach(() => {
    state.currentAssistantMessage = null;
});

describe('setMessageIndex', () => {
    it('设置 dataset.messageIndex', () => {
        const el = document.createElement('div');
        const result = setMessageIndex(el, 5);
        expect(result).toBe(true);
        expect(el.dataset.messageIndex).toBe('5');
    });

    it('null 元素返回 false', () => {
        expect(setMessageIndex(null, 0)).toBe(false);
    });

    it('undefined 索引返回 false', () => {
        const el = document.createElement('div');
        expect(setMessageIndex(el, undefined)).toBe(false);
    });

    it('null 索引返回 false', () => {
        const el = document.createElement('div');
        expect(setMessageIndex(el, null)).toBe(false);
    });

    it('索引为 0 正常工作', () => {
        const el = document.createElement('div');
        const result = setMessageIndex(el, 0);
        expect(result).toBe(true);
        expect(el.dataset.messageIndex).toBe('0');
    });

    it('大数索引正常工作', () => {
        const el = document.createElement('div');
        const result = setMessageIndex(el, 999);
        expect(result).toBe(true);
        expect(el.dataset.messageIndex).toBe('999');
    });
});

describe('setCurrentMessageIndex', () => {
    it('currentAssistantMessage 为 null 返回 false', () => {
        state.currentAssistantMessage = null;
        expect(setCurrentMessageIndex(0)).toBe(false);
    });

    it('正常设置索引', () => {
        const messageEl = document.createElement('div');
        messageEl.className = 'message';
        const contentDiv = document.createElement('div');
        contentDiv.className = 'message-content';
        messageEl.appendChild(contentDiv);

        state.currentAssistantMessage = contentDiv;

        const result = setCurrentMessageIndex(3);
        expect(result).toBe(true);
        expect(messageEl.dataset.messageIndex).toBe('3');
    });

    it('找不到 .message 父元素返回 false', () => {
        const orphan = document.createElement('span');
        state.currentAssistantMessage = orphan;
        expect(setCurrentMessageIndex(0)).toBe(false);
    });
});
