/**
 * message-compat.js 测试
 * 标准消息的工具调用编辑与渲染行为。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../js/core/state.js', () => ({
    state: {
        messages: [],
        messageIdMap: new Map(),
        messageStore: { findByEl: vi.fn(() => null), findIndexById: vi.fn(() => -1) },
        isToolCallContinuation: false,
        toolCallContinuationElement: null
    }
}));

vi.mock('../../js/core/elements.js', () => ({
    elements: { messagesArea: null }
}));

vi.mock('../../js/core/events.js', () => ({
    eventBus: {
        on: vi.fn(),
        emit: vi.fn()
    }
}));

vi.mock('../../js/core/state-mutations.js', () => ({
    removeMessageAt: vi.fn()
}));

vi.mock('../../js/messages/schema.js', () => ({
    PartType: {
        TEXT: 'text',
        THINKING: 'thinking',
        TOOL_CALL: 'tool_call',
        MEDIA: 'media',
        FILE: 'file'
    }
}));

import { state } from '../../js/core/state.js';
import { removeMessageAt } from '../../js/core/state-mutations.js';
import {
    hasToolCalls,
    safeDeleteMessage,
    canEditMessage,
    shouldRenderMessage,
    getRenderableMessages
} from '../../js/tools/message-compat.js';

beforeEach(() => {
    vi.clearAllMocks();
    state.messages = [];
});

describe('hasToolCalls', () => {
    it('无消息返回 false', () => {
        expect(hasToolCalls(null)).toBe(false);
        expect(hasToolCalls(undefined)).toBe(false);
    });

    it('从 parts[] 检测工具调用', () => {
        expect(hasToolCalls({ parts: [{ type: 'tool_call', id: '1' }] })).toBe(true);
        expect(hasToolCalls({ parts: [{ type: 'text', text: 'hello' }] })).toBe(false);
    });
});

describe('safeDeleteMessage', () => {
    it('不存在的消息返回失败', () => {
        state.messages = [];
        const result = safeDeleteMessage(0);
        expect(result.success).toBe(false);
    });

    it('删除普通消息', () => {
        state.messages = [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }];
        const result = safeDeleteMessage(0);
        expect(result.success).toBe(true);
        expect(removeMessageAt).toHaveBeenCalledWith(0);
    });

    it('工具结果内嵌于 part，删除消息无需跨消息联动', () => {
        state.messages = [{ role: 'assistant', parts: [{ type: 'tool_call', id: 'tc-1' }] }];
        const result = safeDeleteMessage(0);
        expect(result.success).toBe(true);
        expect(result.deletedIndices).toEqual([0]);
        expect(result.warnings).toEqual([]);
    });
});

describe('canEditMessage', () => {
    it('用户消息可编辑', () => {
        state.messages = [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }];
        expect(canEditMessage(0).canEdit).toBe(true);
    });

    it('普通助手消息可编辑', () => {
        state.messages = [{ role: 'assistant', parts: [{ type: 'text', text: 'hello' }] }];
        expect(canEditMessage(0).canEdit).toBe(true);
    });

    it('包含工具调用的助手消息可编辑（tool_call parts 由 editor 底层保留）', () => {
        state.messages = [{ role: 'assistant', parts: [{ type: 'tool_call', id: '1' }] }];
        const result = canEditMessage(0);
        expect(result.canEdit).toBe(true);
    });

    it('continuation 等待中的消息不可编辑', () => {
        state.messages = [{ role: 'assistant', parts: [{ type: 'tool_call', id: '1' }] }];
        state.isToolCallContinuation = true;
        state.toolCallContinuationElement = { dataset: { messageIndex: '0' } };
        const result = canEditMessage(0);
        expect(result.canEdit).toBe(false);
        expect(result.reason).toContain('续写');
        // 清理状态避免影响其他测试
        state.isToolCallContinuation = false;
        state.toolCallContinuationElement = null;
    });

    it('非对话角色不可编辑', () => {
        state.messages = [{ role: 'system', parts: [{ type: 'text', text: 'system' }] }];
        const result = canEditMessage(0);
        expect(result.canEdit).toBe(false);
    });

    it('不存在的消息不可编辑', () => {
        state.messages = [];
        const result = canEditMessage(0);
        expect(result.canEdit).toBe(false);
    });
});

describe('shouldRenderMessage', () => {
    it('用户消息显示', () => {
        expect(shouldRenderMessage({ role: 'user', parts: [{ type: 'text', text: 'hi' }] })).toBe(
            true
        );
    });

    it('有文本的工具调用消息显示', () => {
        expect(
            shouldRenderMessage({
                role: 'assistant',
                parts: [
                    { type: 'tool_call', id: '1' },
                    { type: 'text', text: 'some text' }
                ]
            })
        ).toBe(true);
    });

    it('纯工具调用消息（无文本）不显示', () => {
        expect(
            shouldRenderMessage({
                role: 'assistant',
                parts: [{ type: 'tool_call', id: '1' }]
            })
        ).toBe(false);
    });
});

describe('getRenderableMessages', () => {
    it('过滤不可渲染的消息', () => {
        const messages = [
            { role: 'user', parts: [{ type: 'text', text: 'hi' }] },
            { role: 'assistant', parts: [{ type: 'tool_call', id: '1' }] },
            { role: 'assistant', parts: [{ type: 'text', text: 'hello' }] }
        ];
        const renderable = getRenderableMessages(messages);
        expect(renderable.length).toBe(2);
    });
});
