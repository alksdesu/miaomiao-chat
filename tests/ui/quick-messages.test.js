/**
 * quick-messages.js 快捷消息 UI 测试
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../js/core/state.js', () => ({
    state: {
        quickMessages: []
    }
}));

vi.mock('../../js/core/elements.js', () => ({
    elements: {
        quickMessagesToggle: null,
        closeQuickMessagesModal: null,
        quickMessagesModal: null,
        quickMessagesList: null,
        addQuickMessageBtn: null,
        editQuickMessageModal: null,
        closeEditQmModal: null,
        saveQmBtn: null,
        cancelEditQmBtn: null,
        qmNameInput: null,
        qmContentInput: null,
        qmCategoryInput: null
    }
}));

vi.mock('../../js/core/events.js', () => ({
    eventBus: { emit: vi.fn(), on: vi.fn(), off: vi.fn() }
}));

vi.mock('../../js/state/quick-messages.js', () => ({
    createQuickMessage: vi.fn(),
    updateQuickMessage: vi.fn(),
    deleteQuickMessage: vi.fn(),
    sendQuickMessage: vi.fn()
}));

vi.mock('../../js/utils/helpers.js', () => ({
    escapeHtml: vi.fn((s) => s)
}));

vi.mock('../../js/ui/notifications.js', () => ({
    showNotification: vi.fn()
}));

vi.mock('../../js/utils/dialogs.js', () => ({
    showConfirmDialog: vi.fn(() => Promise.resolve(false))
}));

vi.mock('../../js/utils/modal-stack.js', () => ({
    bindTopmostEscape: vi.fn(() => vi.fn()),
    setupModalFocus: vi.fn(() => vi.fn())
}));

vi.mock('../../js/utils/logger.js', () => ({
    logger: { warn: vi.fn(), debug: vi.fn(), error: vi.fn(), info: vi.fn() }
}));

import { state } from '../../js/core/state.js';
import { elements } from '../../js/core/elements.js';
import { eventBus } from '../../js/core/events.js';
import { initQuickMessagesUI, renderQuickMessagesList } from '../../js/ui/quick-messages.js';

describe('quick-messages UI', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        document.body.innerHTML = '';
        state.quickMessages = [];
        Object.keys(elements).forEach((k) => {
            elements[k] = null;
        });
    });

    afterEach(() => {
        document.body.innerHTML = '';
    });

    // ========== initQuickMessagesUI ==========
    describe('initQuickMessagesUI', () => {
        it('所有 elements null 不抛错', () => {
            expect(() => initQuickMessagesUI()).not.toThrow();
        });

        it('注册 eventBus 事件', () => {
            initQuickMessagesUI();
            const events = eventBus.on.mock.calls.map((c) => c[0]);
            expect(events).toContain('quickmsg:updated');
            expect(events).toContain('quickmsg:modal-close-requested');
        });
    });

    // ========== renderQuickMessagesList ==========
    describe('renderQuickMessagesList', () => {
        it('quickMessagesList null 静默返回', () => {
            elements.quickMessagesList = null;
            expect(() => renderQuickMessagesList()).not.toThrow();
        });

        it('空列表显示空状态', () => {
            const list = document.createElement('div');
            elements.quickMessagesList = list;
            state.quickMessages = [];
            renderQuickMessagesList();
            expect(list.querySelector('.empty-quick-messages')).toBeTruthy();
        });

        it('渲染消息列表', () => {
            const list = document.createElement('div');
            elements.quickMessagesList = list;
            state.quickMessages = [
                { id: 'qm1', name: 'Greeting', content: 'Hello!', category: '常用' },
                { id: 'qm2', name: 'Bye', content: 'Goodbye!', category: '常用' }
            ];
            renderQuickMessagesList();
            const items = list.querySelectorAll('.quick-message-item');
            expect(items.length).toBe(2);
        });

        it('按分类分组', () => {
            const list = document.createElement('div');
            elements.quickMessagesList = list;
            state.quickMessages = [
                { id: 'qm1', name: 'A', content: 'content', category: '常用' },
                { id: 'qm2', name: 'B', content: 'content', category: '特殊' }
            ];
            renderQuickMessagesList();
            const groups = list.querySelectorAll('.quick-message-category');
            expect(groups.length).toBe(2);
        });

        it('无分类默认为常用', () => {
            const list = document.createElement('div');
            elements.quickMessagesList = list;
            state.quickMessages = [{ id: 'qm1', name: 'A', content: 'content' }];
            renderQuickMessagesList();
            const header = list.querySelector('.category-header');
            expect(header.textContent).toBe('常用');
        });
    });
});
