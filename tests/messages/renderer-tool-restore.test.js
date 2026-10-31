/**
 * 工具卡片恢复：执行中与已中断的区分、多回复按选中回复重建
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

import { state } from '../../js/core/state.js';
import { eventBus } from '../../js/core/events.js';
import { requestTaskRegistry } from '../../js/core/request-task-registry.js';
import {
    buildRestoredToolCalls,
    renderReplyWithSelector,
    restoreToolCallsFromMessage
} from '../../js/messages/renderer.js';
import { PartType, ToolState, textPart } from '../../js/messages/schema.js';
import { REPLY_TOOL_SKIPPED_MESSAGE } from '../../js/utils/constants.js';

function toolCall(id, toolState, extra = {}) {
    return {
        type: PartType.TOOL_CALL,
        id,
        name: 'calculator',
        args: { expression: '1+1' },
        ...(toolState ? { state: toolState } : {}),
        ...extra
    };
}

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

let restored;
let unsubscribe;

beforeEach(() => {
    requestTaskRegistry.clearForTests();
    state.currentSessionId = 'session-a';
    restored = [];
    unsubscribe = eventBus.on('restore:tool-calls', (payload) => restored.push(payload));
});

afterEach(() => {
    unsubscribe?.();
    requestTaskRegistry.clearForTests();
});

describe('buildRestoredToolCalls', () => {
    it('不属于正在执行的这一轮时，没有结果的调用显示为已中断', () => {
        const toolCalls = buildRestoredToolCalls([
            toolCall('call_pending', ToolState.PENDING),
            toolCall('call_running', ToolState.RUNNING)
        ]);

        expect(toolCalls.map((tc) => [tc.id, tc.status, tc.error, tc.result])).toEqual([
            ['call_pending', 'failed', '工具执行已中断', null],
            ['call_running', 'failed', '工具执行已中断', null]
        ]);
    });

    it('属于正在执行的这一轮时显示为执行中', () => {
        const [tc] = buildRestoredToolCalls([toolCall('call_running', ToolState.RUNNING)], {
            inActiveRound: true
        });

        expect(tc.status).toBe('executing');
        expect(tc.result).toBeNull();
        expect(tc.error).toBeUndefined();
    });

    it('已结束的调用保持原有的状态映射与结果兜底', () => {
        const toolCalls = buildRestoredToolCalls([
            toolCall('call_done', ToolState.DONE, { result: { value: 2 } }),
            toolCall('call_error', ToolState.ERROR, { error: 'bad input' }),
            toolCall('call_legacy', null)
        ]);

        expect(toolCalls[0]).toMatchObject({ status: 'completed', result: { value: 2 } });
        expect(toolCalls[1]).toMatchObject({ status: 'failed', error: 'bad input', result: null });
        expect(toolCalls[2]).toMatchObject({
            status: 'completed',
            result: { restored: true, message: '(工具结果未保存)' }
        });
    });

    it('没有工具调用时返回空数组且不发恢复事件', () => {
        const { content } = createAssistantElement();

        expect(buildRestoredToolCalls([textPart('hi')])).toEqual([]);
        restoreToolCallsFromMessage({ parts: [textPart('hi')] }, content);

        expect(restored).toEqual([]);
    });
});

describe('restoreToolCallsFromMessage 判断是否为正在执行的这一轮', () => {
    const olderMessage = {
        id: 'a-old',
        role: 'assistant',
        parts: [toolCall('call_orphan', ToolState.PENDING)]
    };
    const currentRound = {
        id: 'a-current',
        role: 'assistant',
        parts: [toolCall('call_live', ToolState.RUNNING)]
    };

    beforeEach(() => {
        state.messages = [olderMessage, { id: 'u1', role: 'user', parts: [] }, currentRound];
    });

    afterEach(() => {
        state.messages = [];
    });

    function restoredStatus(message) {
        const { content } = createAssistantElement();
        restoreToolCallsFromMessage(message, content);
        return restored.at(-1).toolCalls[0].status;
    }

    it('当前会话任务仍在执行时，最后一条消息的调用显示为执行中', () => {
        requestTaskRegistry.create({
            sessionId: 'session-a',
            abortController: new AbortController()
        });

        expect(restoredStatus(currentRound)).toBe('executing');
    });

    it('任务执行期间更早消息里的中断残留仍显示为已中断', () => {
        requestTaskRegistry.create({
            sessionId: 'session-a',
            abortController: new AbortController()
        });

        expect(restoredStatus(olderMessage)).toBe('failed');
    });

    it('只认当前会话的任务，其他会话或已取消的任务不算执行中', () => {
        requestTaskRegistry.create({
            sessionId: 'session-b',
            abortController: new AbortController()
        });
        expect(restoredStatus(currentRound)).toBe('failed');

        const aborted = new AbortController();
        requestTaskRegistry.create({ sessionId: 'session-a', abortController: aborted });
        aborted.abort();
        expect(restoredStatus(currentRound)).toBe('failed');
    });
});

describe('renderReplyWithSelector 工具卡片', () => {
    it('按当前展示的回复重建，不取消息顶层的工具调用', () => {
        const { messageEl, content } = createAssistantElement();
        messageEl.dataset.messageIndex = '0';
        state.messages = [
            {
                id: 'm1',
                role: 'assistant',
                parts: [textPart('第一个回复'), toolCall('call_reply_0', ToolState.SKIPPED)]
            }
        ];
        const replies = [
            {
                parts: [textPart('第一个回复'), toolCall('call_reply_0', ToolState.SKIPPED)],
                meta: {},
                error: null
            },
            {
                parts: [textPart('第二个回复'), toolCall('call_reply_1', null)],
                meta: {},
                error: null
            }
        ];

        renderReplyWithSelector(replies, 1, messageEl);

        expect(restored).toHaveLength(1);
        expect(restored[0].contentDiv).toBe(content);
        expect(restored[0].toolCalls).toEqual([
            expect.objectContaining({
                id: 'call_reply_1',
                status: 'skipped',
                result: { content: REPLY_TOOL_SKIPPED_MESSAGE, skipped: true }
            })
        ]);
        expect(replies[1].parts[1].state).toBeUndefined();
        state.messages = [];
    });

    it('多回复里未执行的调用即使会话有任务在跑也显示为已跳过', () => {
        requestTaskRegistry.create({
            sessionId: 'session-a',
            abortController: new AbortController()
        });
        const { messageEl } = createAssistantElement();
        const replies = [
            { parts: [textPart('a')], meta: {}, error: null },
            { parts: [textPart('b'), toolCall('call_x', ToolState.PENDING)], meta: {}, error: null }
        ];

        renderReplyWithSelector(replies, 1, messageEl);

        expect(restored[0].toolCalls[0].status).toBe('skipped');
    });
});
