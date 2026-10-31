/**
 * api/placeholder-resolver.js 续作轮出错时错误单独成条、压缩重试保留之前几轮内容的 DOM 处理
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
    resolveErrorTarget,
    resolvePlaceholder,
    removeRoundResidue
} from '../../js/api/placeholder-resolver.js';
import { state } from '../../js/core/state.js';
import { clearImageRetry } from '../../js/core/state-mutations.js';
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

/**
 * 压缩重试发起后的复用元素：之前几轮的正文与工具卡片 + 本轮残留 + 重试提示
 */
function createImageRetryMessage() {
    const area = document.createElement('div');
    const message = document.createElement('div');
    message.className = 'message assistant';
    message.innerHTML = `
        <div class="message-content-wrapper">
            <div class="message-content">
                <p>上一轮的正文</p>
                <div class="tool-calls-group">工具调用</div>
                <div class="continuation-content">本轮流式内容</div>
                <div class="thinking-dots retry-loading"><span></span><span></span><span></span></div>
                <div class="image-retry-hint">图片过大，已自动压缩后重试...</div>
            </div>
        </div>`;
    area.appendChild(message);
    document.body.replaceChildren(area);
    return message;
}

beforeEach(() => {
    vi.clearAllMocks();
    state.currentAssistantMessage = null;
    state.isToolCallContinuation = false;
    state.toolCallContinuationElement = null;
    state.toolCallContinuationSessionId = null;
    state.isImageCompressionRetry = false;
    state.imageRetryMessageElement = null;
    state.imageRetrySessionId = null;
    requestTaskRegistry.clearForTests();
});

describe('removeRoundResidue', () => {
    it('只移除本轮的流式内容与加载指示，之前几轮的内容保持不动', () => {
        const content = createImageRetryMessage().querySelector('.message-content');
        content.appendChild(
            Object.assign(document.createElement('div'), {
                className: 'thinking-dots continuation-loading'
            })
        );

        removeRoundResidue(content);

        expect(content.children).toHaveLength(2);
        expect(content.querySelector('p').textContent).toBe('上一轮的正文');
        expect(content.querySelector('.tool-calls-group')).not.toBeNull();
    });

    it('内容区不存在时什么都不做', () => {
        expect(() => removeRoundResidue(null)).not.toThrow();
    });
});

describe('resolvePlaceholder 图片压缩重试', () => {
    function arrangeImageRetry({ isSavingContinuation }) {
        const message = createImageRetryMessage();
        const task = requestTaskRegistry.create({
            sessionId: 'session-1',
            abortController: new AbortController()
        });
        task.isSavingContinuation = isSavingContinuation;
        state.isImageCompressionRetry = true;
        state.imageRetrySessionId = 'session-1';
        state.imageRetryMessageElement = message;
        const ctx = {
            sessionId: 'session-1',
            task,
            assistantMessageEl: null,
            isContinuationMode: false,
            isImageRetryMode: false
        };
        return { message, ctx };
    }

    it('续作轮保留之前几轮的正文与工具卡片，按续作追加加载点并打标记', () => {
        const { message, ctx } = arrangeImageRetry({ isSavingContinuation: true });

        resolvePlaceholder(ctx);

        const content = message.querySelector('.message-content');
        expect(content.querySelector('p').textContent).toBe('上一轮的正文');
        expect(content.querySelector('.tool-calls-group')).not.toBeNull();
        expect(content.querySelector('.continuation-content')).toBeNull();
        expect(content.querySelector('.retry-loading')).toBeNull();
        expect(content.querySelector('.image-retry-hint')).toBeNull();
        expect(content.querySelectorAll('.continuation-loading')).toHaveLength(1);
        expect(content.lastElementChild.classList.contains('continuation-loading')).toBe(true);
        expect(message.dataset.isContinuation).toBe('true');
        expect(content.dataset.isContinuation).toBe('true');
        expect(ctx.assistantMessageEl).toBe(message);
        expect(ctx.isImageRetryMode).toBe(true);
        expect(ctx.isContinuationMode).toBe(true);
        expect(state.currentAssistantMessage).toBe(content);
        expect(clearImageRetry).toHaveBeenCalled();
    });

    it('续作轮重试再出错时错误单独成条，原消息的内容保留', () => {
        const { message, ctx } = arrangeImageRetry({ isSavingContinuation: true });
        resolvePlaceholder(ctx);

        const target = resolveErrorTarget(ctx);

        expect(message.nextElementSibling).toBe(ctx.assistantMessageEl);
        expect(target).toBe(ctx.assistantMessageEl.querySelector('.message-content'));
        const content = message.querySelector('.message-content');
        expect(content.querySelector('.tool-calls-group')).not.toBeNull();
        expect(content.querySelector('.continuation-loading')).toBeNull();
    });

    it('首轮请求的重试照旧整块替换为加载点', () => {
        const { message, ctx } = arrangeImageRetry({ isSavingContinuation: false });

        resolvePlaceholder(ctx);

        const content = message.querySelector('.message-content');
        expect(content.children).toHaveLength(1);
        expect(content.firstElementChild.className).toBe('thinking-dots');
        expect(content.textContent).not.toContain('上一轮的正文');
        expect(message.dataset.isContinuation).toBeUndefined();
        expect(ctx.isImageRetryMode).toBe(true);
        expect(ctx.isContinuationMode).toBe(false);
    });
});

describe('resolvePlaceholder 工具续作', () => {
    it('开始新一轮时清掉残留的加载指示，只留一个续作加载点', () => {
        const message = createImageRetryMessage();
        state.isToolCallContinuation = true;
        state.toolCallContinuationSessionId = 'session-1';
        state.toolCallContinuationElement = message;
        const ctx = { sessionId: 'session-1', task: null };

        resolvePlaceholder(ctx);

        const content = message.querySelector('.message-content');
        expect(content.querySelector('.retry-loading')).toBeNull();
        expect(content.querySelector('.image-retry-hint')).toBeNull();
        expect(content.querySelectorAll('.continuation-loading')).toHaveLength(1);
        expect(content.querySelector('.tool-calls-group')).not.toBeNull();
        expect(ctx.isContinuationMode).toBe(true);
    });
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
