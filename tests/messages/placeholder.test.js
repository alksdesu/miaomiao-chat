/**
 * placeholder.js 测试
 * 助手消息占位符创建
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../js/core/events.js', () => ({
    eventBus: {
        on: vi.fn(),
        emit: vi.fn()
    }
}));

import { createAssistantMessagePlaceholder } from '../../js/messages/placeholder.js';
import { eventBus } from '../../js/core/events.js';

beforeEach(() => {
    vi.clearAllMocks();
});

describe('createAssistantMessagePlaceholder', () => {
    it('返回 div 元素', () => {
        const el = createAssistantMessagePlaceholder();
        expect(el.tagName).toBe('DIV');
    });

    it('包含 message 和 assistant class', () => {
        const el = createAssistantMessagePlaceholder();
        expect(el.classList.contains('message')).toBe(true);
        expect(el.classList.contains('assistant')).toBe(true);
    });

    it('包含头像', () => {
        const el = createAssistantMessagePlaceholder();
        const avatar = el.querySelector('.message-avatar');
        expect(avatar).not.toBeNull();
        expect(avatar.textContent).toBe('G');
    });

    it('包含 message-content-wrapper', () => {
        const el = createAssistantMessagePlaceholder();
        expect(el.querySelector('.message-content-wrapper')).not.toBeNull();
    });

    it('包含 message-content', () => {
        const el = createAssistantMessagePlaceholder();
        expect(el.querySelector('.message-content')).not.toBeNull();
    });

    it('包含 thinking-dots 加载动画', () => {
        const el = createAssistantMessagePlaceholder();
        expect(el.querySelector('.thinking-dots')).not.toBeNull();
    });

    it('包含操作按钮区域', () => {
        const el = createAssistantMessagePlaceholder();
        const actions = el.querySelector('.message-actions');
        expect(actions).not.toBeNull();
        expect(actions.getAttribute('role')).toBe('toolbar');
    });

    it('包含重试按钮', () => {
        const el = createAssistantMessagePlaceholder();
        expect(el.querySelector('.retry-msg')).not.toBeNull();
    });

    it('包含编辑按钮', () => {
        const el = createAssistantMessagePlaceholder();
        expect(el.querySelector('.edit-msg')).not.toBeNull();
    });

    it('包含引用按钮', () => {
        const el = createAssistantMessagePlaceholder();
        expect(el.querySelector('.quote-msg')).not.toBeNull();
    });

    it('包含删除按钮', () => {
        const el = createAssistantMessagePlaceholder();
        expect(el.querySelector('.delete-msg')).not.toBeNull();
    });

    it('重试按钮有正确的 aria-label', () => {
        const el = createAssistantMessagePlaceholder();
        const retryBtn = el.querySelector('.retry-msg');
        expect(retryBtn.getAttribute('aria-label')).toBe('重新生成回复');
    });

    it('编辑按钮有正确的 aria-label', () => {
        const el = createAssistantMessagePlaceholder();
        const editBtn = el.querySelector('.edit-msg');
        expect(editBtn.getAttribute('aria-label')).toBe('编辑消息');
    });

    it('删除按钮有正确的 aria-label', () => {
        const el = createAssistantMessagePlaceholder();
        const deleteBtn = el.querySelector('.delete-msg');
        expect(deleteBtn.getAttribute('aria-label')).toBe('删除消息');
    });

    it('按钮点击触发事件', () => {
        vi.clearAllMocks(); // 清除模块加载时的调用
        const el = createAssistantMessagePlaceholder();

        el.querySelector('.retry-msg').click();
        expect(eventBus.emit).toHaveBeenCalledWith('message:retry-requested', expect.any(Object));

        vi.clearAllMocks();
        el.querySelector('.edit-msg').click();
        expect(eventBus.emit).toHaveBeenCalledWith('message:edit-requested', expect.any(Object));

        vi.clearAllMocks();
        el.querySelector('.delete-msg').click();
        expect(eventBus.emit).toHaveBeenCalledWith('message:delete-requested', expect.any(Object));
    });
});
