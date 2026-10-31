/**
 * api/placeholder-resolver.js 续作轮出错时错误单独成条的 DOM 处理
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../js/core/state.js', () => ({
    state: { currentAssistantMessage: null, backgroundTasks: new Map() },
    elements: { messagesArea: null }
}));
vi.mock('../../js/core/events.js', () => ({ eventBus: { emit: vi.fn(), on: vi.fn() } }));
vi.mock('../../js/core/state-mutations.js', () => ({
    clearToolCallContinuation: vi.fn(),
    clearImageRetry: vi.fn()
}));
vi.mock('../../js/utils/logger.js', () => ({
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

import {
    splitContinuationErrorPlaceholder,
    resolveErrorTarget
} from '../../js/api/placeholder-resolver.js';
import { state } from '../../js/core/state.js';
import { requestTaskRegistry } from '../../js/core/request-task-registry.js';

function createReusedMessage() {
    const area = document.createElement('div');
    const message = document.createElement('div');
    message.className = 'message assistant';
    message.dataset.isContinuation = 'true';
    message.dataset.messageIndex = '3';
    message.innerHTML = `
        <div class="message-content-wrapper">
            <div class="message-content">
                <p>上一轮的正文</p>
                <div class="tool-calls-group">工具调用</div>
                <div class="continuation-content">本轮流式内容<span class="typing-cursor"></span></div>
                <div class="continuation-loading"></div>
            </div>
        </div>`;
    area.appendChild(message);
    document.body.replaceChildren(area);
    return message;
}

beforeEach(() => {
    state.currentAssistantMessage = null;
    requestTaskRegistry.clearForTests();
});

describe('splitContinuationErrorPlaceholder', () => {
    it('复用元素回到续作前的样子，错误占位紧随其后', () => {
        const reused = createReusedMessage();

        const placeholder = splitContinuationErrorPlaceholder(reused);

        const content = reused.querySelector('.message-content');
        expect(content.querySelector('.continuation-content')).toBeNull();
        expect(content.querySelector('.continuation-loading')).toBeNull();
        expect(content.querySelector('.tool-calls-group')).not.toBeNull();
        expect(content.textContent).toContain('上一轮的正文');
        expect(reused.dataset.isContinuation).toBeUndefined();
        expect(reused.dataset.messageIndex).toBe('3');
        expect(reused.nextElementSibling).toBe(placeholder);
        expect(state.currentAssistantMessage).toBe(placeholder.querySelector('.message-content'));
    });

    it('不是续作复用的元素或已脱离文档时不拆分', () => {
        const fresh = document.createElement('div');
        fresh.className = 'message assistant';
        document.body.appendChild(fresh);
        expect(splitContinuationErrorPlaceholder(fresh)).toBeNull();

        const detached = createReusedMessage();
        detached.remove();
        expect(splitContinuationErrorPlaceholder(detached)).toBeNull();
        expect(splitContinuationErrorPlaceholder(null)).toBeNull();
    });
});

describe('resolveErrorTarget', () => {
    it('续作轮返回新建占位的内容区，并同步到上下文与任务', () => {
        const reused = createReusedMessage();
        const task = requestTaskRegistry.create({
            sessionId: 'session-1',
            abortController: new AbortController()
        });
        const ctx = { isContinuationMode: true, assistantMessageEl: reused, task };

        const target = resolveErrorTarget(ctx);

        expect(ctx.assistantMessageEl).toBe(reused.nextElementSibling);
        expect(task.assistantMessageEl).toBe(ctx.assistantMessageEl);
        expect(target).toBe(ctx.assistantMessageEl.querySelector('.message-content'));
    });

    it('同一次请求再次出错时不重复拆分', () => {
        const reused = createReusedMessage();
        const ctx = { isContinuationMode: true, assistantMessageEl: reused, task: null };
        resolveErrorTarget(ctx);
        const first = ctx.assistantMessageEl;

        resolveErrorTarget(ctx);

        expect(ctx.assistantMessageEl).toBe(first);
        expect(document.querySelectorAll('.message.assistant')).toHaveLength(2);
    });

    it('普通请求直接返回原占位的内容区', () => {
        const message = document.createElement('div');
        message.innerHTML = '<div class="message-content"></div>';
        const ctx = { isContinuationMode: false, assistantMessageEl: message, task: null };

        expect(resolveErrorTarget(ctx)).toBe(message.querySelector('.message-content'));
        expect(ctx.assistantMessageEl).toBe(message);
    });
});
