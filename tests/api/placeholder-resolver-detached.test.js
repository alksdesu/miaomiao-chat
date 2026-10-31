/**
 * api/placeholder-resolver.js 测试：复用元素已脱离页面时改用新占位符
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    state: {},
    elements: { messagesArea: null }
}));

vi.mock('../../js/core/state.js', () => ({
    state: mocks.state,
    elements: mocks.elements
}));
vi.mock('../../js/core/state-mutations.js', () => ({
    clearToolCallContinuation: vi.fn(() => {
        mocks.state.isToolCallContinuation = false;
        mocks.state.toolCallContinuationElement = null;
        mocks.state.toolCallContinuationSessionId = null;
    }),
    clearImageRetry: vi.fn(() => {
        mocks.state.isImageCompressionRetry = false;
        mocks.state.imageRetryMessageElement = null;
        mocks.state.imageRetrySessionId = null;
    })
}));
vi.mock('../../js/messages/placeholder.js', () => ({
    createAssistantMessagePlaceholder: vi.fn(() => createAssistantElement('placeholder'))
}));
vi.mock('../../js/api/handler-loading-dots.js', () => ({
    createContinuationLoading: vi.fn(() => {
        const el = document.createElement('div');
        el.className = 'continuation-loading';
        return el;
    }),
    createThinkingDots: vi.fn(() => {
        const el = document.createElement('div');
        el.className = 'thinking-dots';
        return el;
    })
}));
vi.mock('../../js/utils/logger.js', () => ({
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

import { resolvePlaceholder } from '../../js/api/placeholder-resolver.js';

function createAssistantElement(name) {
    const messageEl = document.createElement('div');
    messageEl.className = 'message assistant';
    messageEl.dataset.name = name;
    const content = document.createElement('div');
    content.className = 'message-content';
    content.textContent = `${name} 的内容`;
    messageEl.appendChild(content);
    return messageEl;
}

beforeEach(() => {
    vi.clearAllMocks();
    document.body.replaceChildren();
    mocks.elements.messagesArea = document.createElement('div');
    document.body.appendChild(mocks.elements.messagesArea);
    Object.assign(mocks.state, {
        currentAssistantMessage: null,
        isSavingContinuation: false,
        isToolCallContinuation: false,
        toolCallContinuationElement: null,
        toolCallContinuationSessionId: null,
        isImageCompressionRetry: false,
        imageRetryMessageElement: null,
        imageRetrySessionId: null
    });
});

describe('continuation 元素', () => {
    it('仍在页面上时复用', () => {
        const messageEl = createAssistantElement('reused');
        mocks.elements.messagesArea.appendChild(messageEl);
        Object.assign(mocks.state, {
            isToolCallContinuation: true,
            toolCallContinuationElement: messageEl,
            toolCallContinuationSessionId: 'session-a'
        });
        const ctx = { sessionId: 'session-a' };

        resolvePlaceholder(ctx);

        expect(ctx.assistantMessageEl).toBe(messageEl);
        expect(ctx.isContinuationMode).toBe(true);
        expect(messageEl.querySelector('.continuation-loading')).not.toBeNull();
        // 流式渲染读内容区上的标记，出错拆分读消息根元素上的标记
        expect(messageEl.dataset.isContinuation).toBe('true');
        expect(messageEl.querySelector('.message-content').dataset.isContinuation).toBe('true');
    });

    it('切走再切回后已脱离页面时改用新占位符，不往看不见的节点里写', () => {
        const detached = createAssistantElement('detached');
        Object.assign(mocks.state, {
            isToolCallContinuation: true,
            toolCallContinuationElement: detached,
            toolCallContinuationSessionId: 'session-a'
        });
        const ctx = { sessionId: 'session-a' };

        resolvePlaceholder(ctx);

        expect(ctx.assistantMessageEl).not.toBe(detached);
        expect(ctx.assistantMessageEl.dataset.name).toBe('placeholder');
        expect(ctx.assistantMessageEl.isConnected).toBe(true);
        expect(ctx.isContinuationMode).toBeUndefined();
        expect(mocks.state.isToolCallContinuation).toBe(false);
        expect(mocks.state.toolCallContinuationElement).toBeNull();
        expect(mocks.state.currentAssistantMessage).toBe(
            ctx.assistantMessageEl.querySelector('.message-content')
        );
        expect(detached.querySelector('.continuation-loading')).toBeNull();
    });
});

describe('image-retry 元素', () => {
    it('仍在页面上时复用并清空内容', () => {
        const messageEl = createAssistantElement('retry');
        mocks.elements.messagesArea.appendChild(messageEl);
        Object.assign(mocks.state, {
            isImageCompressionRetry: true,
            imageRetryMessageElement: messageEl,
            imageRetrySessionId: 'session-a'
        });
        const ctx = { sessionId: 'session-a' };

        resolvePlaceholder(ctx);

        expect(ctx.assistantMessageEl).toBe(messageEl);
        expect(ctx.isImageRetryMode).toBe(true);
        expect(messageEl.querySelector('.thinking-dots')).not.toBeNull();
    });

    it('已脱离页面时改用新占位符', () => {
        const detached = createAssistantElement('detached-retry');
        Object.assign(mocks.state, {
            isImageCompressionRetry: true,
            imageRetryMessageElement: detached,
            imageRetrySessionId: 'session-a'
        });
        const ctx = { sessionId: 'session-a' };

        resolvePlaceholder(ctx);

        expect(ctx.assistantMessageEl.dataset.name).toBe('placeholder');
        expect(ctx.isImageRetryMode).toBeUndefined();
        expect(mocks.state.isImageCompressionRetry).toBe(false);
        expect(detached.querySelector('.message-content').textContent).toBe(
            'detached-retry 的内容'
        );
    });
});
