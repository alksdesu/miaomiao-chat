/**
 * message-compat.js 测试
 * 工具调用消息兼容性：hasToolCalls, isToolResult, canEditMessage, etc.
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
    isToolResult,
    findAssociatedToolResults,
    findAssociatedAssistantMessage,
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

    it('旧格式 tool_calls 检测', () => {
        expect(hasToolCalls({ tool_calls: [{ id: '1' }] })).toBe(true);
        expect(hasToolCalls({ tool_calls: [] })).toBe(false);
    });

    it('兼容 toolCalls 字段', () => {
        expect(hasToolCalls({ toolCalls: [{ id: '1' }] })).toBe(true);
    });

    it('新格式 parts[] 检测', () => {
        expect(hasToolCalls({ parts: [{ type: 'tool_call', id: '1' }] })).toBe(true);
        expect(hasToolCalls({ parts: [{ type: 'text', text: 'hello' }] })).toBe(false);
    });
});

describe('isToolResult', () => {
    it('工具结果消息', () => {
        expect(isToolResult({ role: 'tool' })).toBe(true);
    });

    it('非工具结果', () => {
        expect(isToolResult({ role: 'user' })).toBe(false);
        expect(isToolResult({ role: 'assistant' })).toBe(false);
        expect(isToolResult(null)).toBeFalsy();
    });
});

describe('findAssociatedToolResults', () => {
    it('找到关联的工具结果', () => {
        state.messages = [
            { role: 'assistant', parts: [{ type: 'tool_call', id: 'tc-1' }] },
            { role: 'tool', tool_call_id: 'tc-1' }
        ];
        const results = findAssociatedToolResults(0);
        expect(results).toEqual([1]);
    });

    it('没有工具调用时返回空', () => {
        state.messages = [{ role: 'assistant', content: 'hello' }];
        expect(findAssociatedToolResults(0)).toEqual([]);
    });

    it('遇到助手消息时停止', () => {
        state.messages = [
            { role: 'assistant', parts: [{ type: 'tool_call', id: 'tc-1' }] },
            { role: 'tool', tool_call_id: 'tc-1' },
            { role: 'assistant', content: 'next' },
            { role: 'tool', tool_call_id: 'tc-1' } // 不应被找到
        ];
        const results = findAssociatedToolResults(0);
        expect(results).toEqual([1]);
    });

    it('旧格式 tool_calls 也能查找', () => {
        state.messages = [
            { role: 'assistant', tool_calls: [{ id: 'tc-old' }] },
            { role: 'tool', tool_call_id: 'tc-old' }
        ];
        const results = findAssociatedToolResults(0);
        expect(results).toEqual([1]);
    });
});

describe('findAssociatedAssistantMessage', () => {
    it('找到关联的助手消息', () => {
        state.messages = [
            { role: 'assistant', parts: [{ type: 'tool_call', id: 'tc-1' }] },
            { role: 'tool', tool_call_id: 'tc-1' }
        ];
        expect(findAssociatedAssistantMessage(1)).toBe(0);
    });

    it('非工具结果返回 null', () => {
        state.messages = [{ role: 'user', content: 'hi' }];
        expect(findAssociatedAssistantMessage(0)).toBeNull();
    });

    it('找不到时返回 null', () => {
        state.messages = [{ role: 'tool', tool_call_id: 'tc-orphan' }];
        expect(findAssociatedAssistantMessage(0)).toBeNull();
    });
});

describe('safeDeleteMessage', () => {
    it('不存在的消息返回失败', () => {
        state.messages = [];
        const result = safeDeleteMessage(0);
        expect(result.success).toBe(false);
    });

    it('删除普通消息', () => {
        state.messages = [{ role: 'user', content: 'hi' }];
        const result = safeDeleteMessage(0);
        expect(result.success).toBe(true);
        expect(removeMessageAt).toHaveBeenCalledWith(0);
    });

    it('删除工具调用消息时连带删除结果', () => {
        state.messages = [
            { role: 'assistant', parts: [{ type: 'tool_call', id: 'tc-1' }] },
            { role: 'tool', tool_call_id: 'tc-1' }
        ];
        const result = safeDeleteMessage(0);
        expect(result.success).toBe(true);
        expect(result.deletedIndices).toContain(0);
        expect(result.deletedIndices).toContain(1);
        expect(result.warnings.length).toBeGreaterThan(0);
    });

    it('删除工具结果消息带警告', () => {
        state.messages = [
            { role: 'assistant', parts: [{ type: 'tool_call', id: 'tc-1' }] },
            { role: 'tool', tool_call_id: 'tc-1' }
        ];
        const result = safeDeleteMessage(1);
        expect(result.success).toBe(true);
        expect(result.warnings.length).toBeGreaterThan(0);
    });
});

describe('canEditMessage', () => {
    it('用户消息可编辑', () => {
        state.messages = [{ role: 'user', content: 'hi' }];
        expect(canEditMessage(0).canEdit).toBe(true);
    });

    it('普通助手消息可编辑', () => {
        state.messages = [{ role: 'assistant', content: 'hello' }];
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

    it('工具结果不可编辑', () => {
        state.messages = [{ role: 'tool', tool_call_id: '1' }];
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
        expect(shouldRenderMessage({ role: 'user', content: 'hi' })).toBe(true);
    });

    it('工具结果不显示', () => {
        expect(shouldRenderMessage({ role: 'tool' })).toBe(false);
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
            { role: 'user', content: 'hi' },
            { role: 'tool', tool_call_id: '1' },
            { role: 'assistant', content: 'hello' }
        ];
        const renderable = getRenderableMessages(messages);
        expect(renderable.length).toBe(2);
    });
});
