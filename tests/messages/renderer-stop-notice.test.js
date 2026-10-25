/**
 * 重渲染与多回复切换时的结束原因提示
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../../js/utils/markdown.js', () => ({
    safeMarkedParse: (text) => `<p>${text}</p>`
}));

vi.mock('../../js/messages/render-thinking.js', () => ({
    renderThinkingBlock: (text) => `<aside>${text}</aside>`,
    clearThinkingCache: vi.fn(),
    enhanceThinkingBlocks: vi.fn(),
    purgeThinkingCacheInElement: vi.fn(),
    captureExpandedThinkingState: vi.fn(() => []),
    restoreExpandedThinkingState: vi.fn()
}));

vi.mock('../../js/core/elements.js', () => {
    const messagesArea = document.createElement('div');
    messagesArea.scrollTo = () => {};
    return { elements: { messagesArea } };
});

import { rerenderMessageContent, renderReplyWithSelector } from '../../js/messages/renderer.js';
import { textPart } from '../../js/messages/schema.js';

const stop = { kind: 'max_tokens', reason: 'length' };

function createAssistantElement() {
    const messageEl = document.createElement('div');
    messageEl.className = 'message assistant';
    const wrapper = document.createElement('div');
    wrapper.className = 'message-content-wrapper';
    const content = document.createElement('div');
    content.className = 'message-content';
    wrapper.appendChild(content);
    messageEl.appendChild(wrapper);
    return { messageEl, content };
}

let messageEl;
let content;

beforeEach(() => {
    ({ messageEl, content } = createAssistantElement());
});

describe('rerenderMessageContent', () => {
    it('助手消息带结束原因时在正文末尾提示', () => {
        rerenderMessageContent(messageEl, 0, 'assistant', {
            id: 'm1',
            role: 'assistant',
            parts: [textPart('被截断的回')],
            meta: { stop }
        });

        expect(content.lastElementChild.className).toBe('stop-notice');
        expect(content.querySelector('.stop-notice-reason').textContent).toBe('length');
    });

    it('错误消息与用户消息不提示', () => {
        rerenderMessageContent(messageEl, 0, 'assistant', {
            id: 'm1',
            role: 'assistant',
            parts: [],
            meta: { stop },
            error: { type: 'max_tokens', message: 'x' }
        });
        expect(content.querySelector('.stop-notice')).toBeNull();

        rerenderMessageContent(messageEl, 0, 'user', {
            id: 'm2',
            role: 'user',
            parts: [textPart('问题')],
            meta: { stop }
        });
        expect(content.querySelector('.stop-notice')).toBeNull();
    });
});

describe('renderReplyWithSelector', () => {
    const replies = [
        { parts: [], meta: {}, error: { type: 'safety', message: '回复被安全策略拦截' } },
        { parts: [textPart('第二个回复')], meta: { stop }, error: null }
    ];

    it('选中带结束原因的回复时提示', () => {
        renderReplyWithSelector(replies, 1, messageEl);

        expect(content.querySelector('.stop-notice').dataset.stopKind).toBe('max_tokens');
        expect(messageEl.querySelectorAll('.reply-tab')).toHaveLength(2);
    });

    it('选中失败回复时只展示错误，不提示结束原因', () => {
        renderReplyWithSelector(replies, 0, messageEl);

        expect(content.querySelector('.stop-notice')).toBeNull();
        expect(content.querySelector('.error-humanized')).not.toBeNull();
    });
});
