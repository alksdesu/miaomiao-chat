/**
 * state/quick-messages.js 快捷消息管理测试
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../js/core/state.js', () => ({
    state: {
        quickMessages: [],
        storageMode: 'indexeddb'
    }
}));

vi.mock('../../js/core/elements.js', () => ({
    elements: {
        userInput: { value: '', focus: vi.fn() }
    }
}));

vi.mock('../../js/core/events.js', () => ({
    eventBus: { emit: vi.fn() }
}));

vi.mock('../../js/ui/notifications.js', () => ({
    showNotification: vi.fn()
}));

vi.mock('../../js/state/config.js', () => ({
    saveCurrentConfig: vi.fn()
}));

vi.mock('../../js/state/storage.js', () => ({
    loadAllQuickMessages: vi.fn(async () => []),
    saveQuickMessage: vi.fn(async () => {})
}));

import {
    createQuickMessage,
    updateQuickMessage,
    deleteQuickMessage,
    getQuickMessage,
    getAllQuickMessages,
    sendQuickMessage
} from '../../js/state/quick-messages.js';
import { state } from '../../js/core/state.js';
import { eventBus } from '../../js/core/events.js';
import { showNotification } from '../../js/ui/notifications.js';
import { elements } from '../../js/core/elements.js';

beforeEach(() => {
    vi.clearAllMocks();
    state.quickMessages = [];
});

describe('createQuickMessage', () => {
    it('创建新快捷消息', () => {
        const result = createQuickMessage('问候', '你好！');

        expect(result.name).toBe('问候');
        expect(result.content).toBe('你好！');
        expect(result.category).toBe('常用');
        expect(result.id).toMatch(/^qm_/);
        expect(state.quickMessages).toHaveLength(1);
        expect(eventBus.emit).toHaveBeenCalledWith('quickmsg:updated');
        expect(showNotification).toHaveBeenCalled();
    });

    it('自定义分类', () => {
        const result = createQuickMessage('代码', 'console.log', '开发');
        expect(result.category).toBe('开发');
    });

    it('去除名称和内容空白', () => {
        const result = createQuickMessage('  test  ', '  content  ');
        expect(result.name).toBe('test');
        expect(result.content).toBe('content');
    });

    it('空分类默认为常用', () => {
        const result = createQuickMessage('test', 'content', '');
        expect(result.category).toBe('常用');
    });
});

describe('updateQuickMessage', () => {
    beforeEach(() => {
        state.quickMessages = [
            {
                id: 'qm_1',
                name: 'old',
                content: 'old content',
                category: '常用',
                createdAt: 1000,
                updatedAt: 1000
            }
        ];
    });

    it('更新名称', () => {
        const result = updateQuickMessage('qm_1', { name: 'new name' });
        expect(result).toBe(true);
        expect(state.quickMessages[0].name).toBe('new name');
    });

    it('更新内容', () => {
        updateQuickMessage('qm_1', { content: 'new content' });
        expect(state.quickMessages[0].content).toBe('new content');
    });

    it('更新分类', () => {
        updateQuickMessage('qm_1', { category: '开发' });
        expect(state.quickMessages[0].category).toBe('开发');
    });

    it('更新时间戳', () => {
        const before = Date.now();
        updateQuickMessage('qm_1', { name: 'updated' });
        expect(state.quickMessages[0].updatedAt).toBeGreaterThanOrEqual(before);
    });

    it('不存在的 ID 返回 false', () => {
        const result = updateQuickMessage('qm_999', { name: 'x' });
        expect(result).toBe(false);
        expect(showNotification).toHaveBeenCalledWith('快捷消息不存在', 'error');
    });

    it('去除更新值空白', () => {
        updateQuickMessage('qm_1', { name: '  trimmed  ', content: '  text  ' });
        expect(state.quickMessages[0].name).toBe('trimmed');
        expect(state.quickMessages[0].content).toBe('text');
    });
});

describe('deleteQuickMessage', () => {
    beforeEach(() => {
        state.quickMessages = [
            { id: 'qm_1', name: 'first', content: 'a' },
            { id: 'qm_2', name: 'second', content: 'b' }
        ];
    });

    it('删除指定消息', () => {
        const result = deleteQuickMessage('qm_1');
        expect(result).toBe(true);
        expect(state.quickMessages).toHaveLength(1);
        expect(state.quickMessages[0].id).toBe('qm_2');
    });

    it('不存在的 ID 返回 false', () => {
        const result = deleteQuickMessage('qm_999');
        expect(result).toBe(false);
    });

    it('触发更新事件', () => {
        deleteQuickMessage('qm_1');
        expect(eventBus.emit).toHaveBeenCalledWith('quickmsg:updated');
    });
});

describe('getQuickMessage', () => {
    beforeEach(() => {
        state.quickMessages = [{ id: 'qm_1', name: 'test', content: 'hello' }];
    });

    it('根据 ID 获取', () => {
        const result = getQuickMessage('qm_1');
        expect(result.name).toBe('test');
    });

    it('不存在返回 null', () => {
        expect(getQuickMessage('qm_999')).toBeNull();
    });
});

describe('getAllQuickMessages', () => {
    it('返回所有消息', () => {
        state.quickMessages = [{ id: 'qm_1' }, { id: 'qm_2' }];
        const result = getAllQuickMessages();
        expect(result).toHaveLength(2);
    });

    it('空数组', () => {
        state.quickMessages = [];
        expect(getAllQuickMessages()).toEqual([]);
    });
});

describe('sendQuickMessage', () => {
    beforeEach(() => {
        state.quickMessages = [{ id: 'qm_1', name: 'greeting', content: '你好世界' }];
        elements.userInput = { value: '', focus: vi.fn() };
    });

    it('填充输入框', () => {
        sendQuickMessage('qm_1');
        expect(elements.userInput.value).toBe('你好世界');
        expect(elements.userInput.focus).toHaveBeenCalled();
    });

    it('不存在的消息提示错误', () => {
        sendQuickMessage('qm_999');
        expect(showNotification).toHaveBeenCalledWith('快捷消息不存在', 'error');
    });

    it('触发模态框关闭', () => {
        sendQuickMessage('qm_1');
        expect(eventBus.emit).toHaveBeenCalledWith('quickmsg:modal-close-requested');
    });
});
