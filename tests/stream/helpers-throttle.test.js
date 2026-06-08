/**
 * stream/helpers.js 节流 + flush + scroll 锁测试（P0-5）
 * 已有 tests/stream/helpers.test.js 覆盖 handleContentArray/cleanupAllIncompleteImages，
 * 本文件独立覆盖三层节流（阈值守卫 / RAF 合帧 / flushPendingRender）+ user-scrolled 锁
 *
 * 重要：helpers.js 内多个状态是模块级闭包（lastRenderedLen / userScrolledUp /
 * scrollListenerAttached）。scrollListener 全局只挂一次，因此 messagesArea/assistantMessage
 * 必须跨测试稳定引用（在 mock factory 里一次性创建），否则 wheel 事件挂不到 listener。
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// 常量 mock：RENDER_THROTTLE_CHARS=10 让 8 字符跳过 / 15 字符触发；时间阈值留大避免反向触发
vi.mock('../../js/utils/constants.js', () => ({
    RENDER_THROTTLE_CHARS: 10,
    RENDER_THROTTLE_MS: 10000,
    SCROLL_LOCK_TIMEOUT_MS: 5000,
    SCROLL_FOLLOW_THRESHOLD_PX: 120,
    THINKING_HEAVY_THRESHOLD_CHARS: 5000,
    THINKING_HEAVY_RENDER_THROTTLE_MS: 1500
}));

vi.mock('../../js/utils/logger.js', () => ({
    logger: { warn: vi.fn(), debug: vi.fn(), error: vi.fn(), info: vi.fn() }
}));

vi.mock('../../js/utils/markdown.js', () => ({
    safeMarkedParse: vi.fn((text) => `<p>${text}</p>`)
}));

vi.mock('../../js/utils/helpers.js', () => ({
    escapeHtml: vi.fn((s) => s)
}));

vi.mock('../../js/messages/renderer.js', () => ({
    renderThinkingBlock: vi.fn((text) => `<div class="thinking-block">${text}</div>`),
    enhanceCodeBlocks: vi.fn(),
    enhanceThinkingBlocks: vi.fn()
}));

vi.mock('../../js/utils/media.js', () => ({
    isVideoUrl: vi.fn(() => false)
}));

vi.mock('../../js/ui/media-cards.js', () => ({
    renderMediaCard: vi.fn(() => '<div class="media-card"></div>')
}));

vi.mock('../../js/utils/icons.js', () => ({
    getIcon: vi.fn(() => '<svg></svg>')
}));

// state + elements：必须在 vi.mock factory 内一次性创建，跨测试保留同一引用
vi.mock('../../js/core/state.js', () => {
    const messagesArea = document.createElement('div');
    messagesArea.scrollTo = vi.fn();
    Object.defineProperty(messagesArea, 'scrollHeight', { value: 1000, writable: true });
    Object.defineProperty(messagesArea, 'scrollTop', { value: 0, writable: true });
    Object.defineProperty(messagesArea, 'clientHeight', { value: 500, writable: true });

    const parent = document.createElement('div');
    const assistantMessage = document.createElement('div');
    parent.appendChild(assistantMessage);
    messagesArea.appendChild(parent);
    document.body.appendChild(messagesArea);

    return {
        state: {
            currentAssistantMessage: assistantMessage,
            imageBuffers: new Map()
        },
        elements: {
            messagesArea
        }
    };
});

import {
    updateStreamingMessage,
    flushPendingRender,
    renderFinalTextWithThinking
} from '../../js/stream/helpers.js';
import { safeMarkedParse } from '../../js/utils/markdown.js';
import { state, elements } from '../../js/core/state.js';

beforeEach(() => {
    vi.clearAllMocks();
    // 每个测试开头先 flush 任何残留 + 走 renderFinal 触发 cleanupStreamingState
    // 把 lastRenderedLen / userScrolledUp 复位（这是模块级闭包，否则跨测试串）
    flushPendingRender();
    renderFinalTextWithThinking('', null);
    vi.clearAllMocks();
    // 把 scrollTop 推到底部，避免 onScroll 在某些时序下触发解锁
    elements.messagesArea.scrollTop = 0;
});

afterEach(() => {
    flushPendingRender();
});

describe('stream/helpers.js - 三层节流 + scroll 锁', () => {
    it('阈值未触发时 doRender 跳过（requestAnimationFrame 未被排队）', () => {
        const rafSpy = vi.spyOn(globalThis, 'requestAnimationFrame');

        // baseline=0，本次 newLen=5（< 阈值 10）+ 时间也未过 → 守卫早 return
        updateStreamingMessage('hello', '');

        expect(rafSpy).not.toHaveBeenCalled();
        // doRender 未执行 → safeMarkedParse 没被调
        expect(safeMarkedParse).not.toHaveBeenCalled();
    });

    it('阈值触发后 doRender 通过 RAF 立即执行', async () => {
        const rafSpy = vi.spyOn(globalThis, 'requestAnimationFrame');

        // newLen=15 ≥ 阈值 10 → 跳过守卫，排 RAF
        updateStreamingMessage('a'.repeat(15), '');
        expect(rafSpy).toHaveBeenCalledTimes(1);

        // 触发 RAF 回调：jsdom 用 setTimeout polyfill，下一 tick 即可
        await new Promise((resolve) => setTimeout(resolve, 30));

        // doRender 执行后调 safeMarkedParse 渲染 text（带 isStreaming:true）
        expect(safeMarkedParse).toHaveBeenCalledWith('a'.repeat(15), { isStreaming: true });
    });

    it('flushPendingRender 同步排队 doRender（cancelAnimationFrame + 立即执行）', () => {
        const rafSpy = vi.spyOn(globalThis, 'requestAnimationFrame');
        const cancelSpy = vi.spyOn(globalThis, 'cancelAnimationFrame');

        // 触发 RAF 但不等 tick → 残留 pendingRenderData + rafId
        updateStreamingMessage('a'.repeat(15), '');
        expect(rafSpy).toHaveBeenCalled();
        expect(safeMarkedParse).not.toHaveBeenCalled();

        // flush：同步取消 RAF + 立即 doRender
        flushPendingRender();

        expect(cancelSpy).toHaveBeenCalled();
        expect(safeMarkedParse).toHaveBeenCalledWith('a'.repeat(15), { isStreaming: true });
    });

    it('userScrolledUp=true 时 scrollToBottom 跳过', () => {
        // 先正常渲染一次，让 ensureScrollListener 挂载 wheel/scroll 监听
        updateStreamingMessage('a'.repeat(15), '');
        flushPendingRender();
        // 此时 scrollTo 至少被调一次（首帧），清掉
        elements.messagesArea.scrollTo.mockClear();

        // 模拟用户 wheel 上滚 → lockUp 同步置 userScrolledUp=true
        elements.messagesArea.dispatchEvent(new Event('wheel'));

        // 再触发一次足够大的渲染（15→30 增量 ≥ 阈值）
        updateStreamingMessage('a'.repeat(30), '');
        flushPendingRender();

        // doRender 末尾 scrollToBottom 看 userScrolledUp=true → 早 return
        expect(elements.messagesArea.scrollTo).not.toHaveBeenCalled();
    });

    it('cleanupStreamingState 重置 lastRenderedLen + userScrolledUp（下一帧首发不被吞）', () => {
        // Step 1: 推 lastRenderedLen 到 50
        updateStreamingMessage('a'.repeat(50), '');
        flushPendingRender();
        expect(safeMarkedParse).toHaveBeenCalled();

        // Step 2: wheel 锁住 scroll
        elements.messagesArea.dispatchEvent(new Event('wheel'));

        // Step 3: renderFinal 末尾会调 cleanupStreamingState 重置三个状态
        renderFinalTextWithThinking('final text', '');

        // Step 4: 验证下一条流式消息从 baseline=0 起算（cleanup 已重置 lastRenderedLen）
        vi.clearAllMocks();
        elements.messagesArea.scrollTo.mockClear();

        // 12 字符 - baseline 0 = 12 ≥ 阈值 10 → 触发渲染；
        // 如果 cleanup 没重置 lastRenderedLen=50，则 12-50<0<10 仍跳过，断言会失败
        updateStreamingMessage('a'.repeat(12), '');
        flushPendingRender();

        expect(safeMarkedParse).toHaveBeenCalledWith('a'.repeat(12), { isStreaming: true });
        // userScrolledUp 也被 cleanup 重置 → scrollTo 又能调用
        expect(elements.messagesArea.scrollTo).toHaveBeenCalled();
    });
});
