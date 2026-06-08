/**
 * clear.js 测试
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../js/core/state.js', () => ({
    state: {
        isLoading: false,
        charName: 'TestAI',
        editingElement: null,
        lastUserMessage: null,
        editingIndex: null,
        currentReplies: [],
        selectedReplyIndex: 0,
        currentAssistantMessage: null,
        sessionDirty: false
    }
}));

vi.mock('../../js/core/elements.js', () => ({
    elements: {
        messagesArea: null,
        clearButton: null
    }
}));

vi.mock('../../js/state/sessions.js', () => ({
    saveCurrentSessionMessages: vi.fn(() => Promise.resolve())
}));

vi.mock('../../js/utils/dialogs.js', () => ({
    showConfirmDialog: vi.fn(() => Promise.resolve(true))
}));

vi.mock('../../js/core/state-mutations.js', () => ({
    replaceAllMessages: vi.fn()
}));

vi.mock('../../js/tools/undo.js', () => ({
    clearUndoStack: vi.fn()
}));

vi.mock('../../js/utils/logger.js', () => ({
    logger: { warn: vi.fn(), debug: vi.fn(), error: vi.fn(), info: vi.fn() }
}));

import { state } from '../../js/core/state.js';
import { elements } from '../../js/core/elements.js';
import { handleClear, initClearChat } from '../../js/ui/clear.js';

describe('clear', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
        state.isLoading = false;
        state.charName = 'TestAI';
        state.editingElement = null;
        state.lastUserMessage = null;
        state.editingIndex = null;
        state.currentReplies = [];
        state.selectedReplyIndex = 0;
        state.currentAssistantMessage = null;
        state.sessionDirty = false;
        elements.messagesArea = document.createElement('div');
        elements.clearButton = document.createElement('button');
    });

    // ========== handleClear ==========
    describe('handleClear', () => {
        it('加载中不执行', async () => {
            state.isLoading = true;
            await handleClear();
            // 加载中提前返回，messagesArea 未被填充欢迎消息
            expect(elements.messagesArea.innerHTML).toBe('');
        });

        it('用户取消不执行', async () => {
            const { showConfirmDialog } = await import('../../js/utils/dialogs.js');
            showConfirmDialog.mockResolvedValueOnce(false);
            await handleClear();
            expect(elements.messagesArea.innerHTML).toBe('');
        });

        it('确认后清空消息', async () => {
            const { showConfirmDialog } = await import('../../js/utils/dialogs.js');
            showConfirmDialog.mockResolvedValueOnce(true);
            await handleClear();
            const { replaceAllMessages } = await import('../../js/core/state-mutations.js');
            expect(replaceAllMessages).toHaveBeenCalledWith([]);
        });

        it('确认后清空撤销栈', async () => {
            const { showConfirmDialog } = await import('../../js/utils/dialogs.js');
            showConfirmDialog.mockResolvedValueOnce(true);
            await handleClear();
            const { clearUndoStack } = await import('../../js/tools/undo.js');
            expect(clearUndoStack).toHaveBeenCalled();
        });

        it('确认后恢复欢迎消息', async () => {
            const { showConfirmDialog } = await import('../../js/utils/dialogs.js');
            showConfirmDialog.mockResolvedValueOnce(true);
            await handleClear();
            expect(elements.messagesArea.innerHTML).toContain('welcome-message');
        });

        it('欢迎消息包含 charName', async () => {
            state.charName = 'MyBot';
            const { showConfirmDialog } = await import('../../js/utils/dialogs.js');
            showConfirmDialog.mockResolvedValueOnce(true);
            await handleClear();
            expect(elements.messagesArea.innerHTML).toContain('MyBot');
        });

        it('确认后标记脏并保存', async () => {
            const { showConfirmDialog } = await import('../../js/utils/dialogs.js');
            showConfirmDialog.mockResolvedValueOnce(true);
            await handleClear();
            expect(state.sessionDirty).toBe(true);
            const { saveCurrentSessionMessages } = await import('../../js/state/sessions.js');
            expect(saveCurrentSessionMessages).toHaveBeenCalledWith(true);
        });

        it('编辑元素被清除', async () => {
            const editEl = document.createElement('div');
            editEl.classList.add('editing');
            state.editingElement = editEl;

            const { showConfirmDialog } = await import('../../js/utils/dialogs.js');
            showConfirmDialog.mockResolvedValueOnce(true);
            await handleClear();
            expect(editEl.classList.contains('editing')).toBe(false);
            expect(state.editingElement).toBe(null);
        });
    });

    // ========== initClearChat ==========
    describe('initClearChat', () => {
        it('不抛错', () => {
            expect(() => initClearChat()).not.toThrow();
        });

        it('绑定 click 事件到 clearButton', () => {
            const spy = vi.spyOn(elements.clearButton, 'addEventListener');
            initClearChat();
            expect(spy).toHaveBeenCalledWith('click', expect.any(Function));
            spy.mockRestore();
        });

        it('clearButton 为 null 不抛错', () => {
            elements.clearButton = null;
            expect(() => initClearChat()).not.toThrow();
        });
    });
});
