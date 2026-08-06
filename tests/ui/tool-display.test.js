/**
 * tool-display.js 测试
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../js/core/events.js', () => ({
    eventBus: { emit: vi.fn(), on: vi.fn(), off: vi.fn() }
}));

// elements 是 Proxy + 未初始化即抛错；测试环境给 plain 对象，scrollTop 写入不报即可
vi.mock('../../js/core/elements.js', () => ({
    elements: { messagesArea: { scrollTop: 0, scrollHeight: 0 } }
}));

vi.mock('../../js/utils/icons.js', () => ({
    getIcon: vi.fn(() => '<svg></svg>')
}));

vi.mock('../../js/utils/dialogs.js', () => ({
    showConfirmDialog: vi.fn(() => Promise.resolve(false))
}));

vi.mock('../../js/utils/logger.js', () => ({
    logger: { warn: vi.fn(), debug: vi.fn(), error: vi.fn(), info: vi.fn() }
}));

import {
    createToolCallUI,
    updateToolCallStatus,
    restoreToolCallsGroup
} from '../../js/ui/tool-display.js';

describe('tool-display', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
    });

    afterEach(() => {
        document.body.innerHTML = '';
    });

    // ========== createToolCallUI ==========
    describe('createToolCallUI', () => {
        it('无 target 时返回 null', async () => {
            const result = await createToolCallUI({ id: 'tc1', name: 'test', args: {} }, null);
            // 在没有 state.currentAssistantMessage 和 DOM 元素时应返回 null
            expect(result).toBeNull();
        });

        it('有 target 时创建 group', async () => {
            const container = document.createElement('div');
            container.className = 'message-content';
            const msgWrapper = document.createElement('div');
            msgWrapper.className = 'message assistant';
            msgWrapper.appendChild(container);
            document.body.appendChild(msgWrapper);

            const result = await createToolCallUI(
                { id: 'tc1', name: 'calculator', args: { expr: '1+1' } },
                container
            );
            expect(result).toBeTruthy();
            expect(result.classList.contains('tool-calls-group')).toBe(true);
        });

        it('重复调用同 id 工具不重复添加', async () => {
            const container = document.createElement('div');
            container.className = 'message-content';
            const msgWrapper = document.createElement('div');
            msgWrapper.className = 'message assistant';
            msgWrapper.appendChild(container);
            document.body.appendChild(msgWrapper);

            await createToolCallUI({ id: 'tc1', name: 'test', args: {} }, container);
            await createToolCallUI({ id: 'tc1', name: 'test', args: {} }, container);
            // 只有一个 group
            expect(container.querySelectorAll('.tool-calls-group').length).toBe(1);
        });

        it('不同 id 工具共用同一 group', async () => {
            const container = document.createElement('div');
            container.className = 'message-content';
            const msgWrapper = document.createElement('div');
            msgWrapper.className = 'message assistant';
            msgWrapper.appendChild(container);
            document.body.appendChild(msgWrapper);

            await createToolCallUI({ id: 'tc1', name: 'test1', args: {} }, container);
            await createToolCallUI({ id: 'tc2', name: 'test2', args: {} }, container);
            expect(container.querySelectorAll('.tool-calls-group').length).toBe(1);
            // summary 应显示 2 个工具
            const summaryText = container.querySelector('.summary-text');
            expect(summaryText.textContent).toContain('2');
        });
    });

    // ========== updateToolCallStatus ==========
    describe('updateToolCallStatus', () => {
        it('未找到工具不抛错', () => {
            expect(() => updateToolCallStatus('nonexistent', 'completed')).not.toThrow();
        });

        it('更新工具状态为 completed', async () => {
            const container = document.createElement('div');
            container.className = 'message-content';
            const msgWrapper = document.createElement('div');
            msgWrapper.className = 'message assistant';
            msgWrapper.appendChild(container);
            document.body.appendChild(msgWrapper);

            await createToolCallUI({ id: 'tc1', name: 'calc', args: {} }, container);
            updateToolCallStatus('tc1', 'completed', { result: 'ok' });
            const btn = container.querySelector('.tool-calls-summary-btn');
            expect(btn.getAttribute('data-status')).toBe('completed');
        });

        it('更新工具状态为 failed', async () => {
            const container = document.createElement('div');
            container.className = 'message-content';
            const msgWrapper = document.createElement('div');
            msgWrapper.className = 'message assistant';
            msgWrapper.appendChild(container);
            document.body.appendChild(msgWrapper);

            await createToolCallUI({ id: 'tc1', name: 'test', args: {} }, container);
            updateToolCallStatus('tc1', 'failed', { error: 'timeout' });
            const btn = container.querySelector('.tool-calls-summary-btn');
            expect(btn.getAttribute('data-status')).toBe('failed');
        });

        it('限定 scope 时不会更新其他消息中的同名工具 ID', async () => {
            const first = document.createElement('div');
            const second = document.createElement('div');
            first.className = 'message-content';
            second.className = 'message-content';
            document.body.append(first, second);

            await createToolCallUI({ id: 'shared', name: 'first', args: {} }, first);
            await createToolCallUI({ id: 'shared', name: 'second', args: {} }, second);
            updateToolCallStatus('shared', 'completed', { result: 'ok' }, second);

            expect(first.querySelector('.tool-calls-summary-btn').dataset.status).toBe('executing');
            expect(second.querySelector('.tool-calls-summary-btn').dataset.status).toBe(
                'completed'
            );
        });
    });

    // ========== restoreToolCallsGroup ==========
    describe('restoreToolCallsGroup', () => {
        it('空 toolCalls 不抛错', async () => {
            await expect(restoreToolCallsGroup([], null)).resolves.not.toThrow();
        });

        it('null toolCalls 不抛错', async () => {
            await expect(restoreToolCallsGroup(null, null)).resolves.not.toThrow();
        });

        it('无 contentDiv 不抛错', async () => {
            await expect(
                restoreToolCallsGroup([{ id: 'tc1', name: 'test' }], null)
            ).resolves.not.toThrow();
        });

        it('有数据和 DOM 时创建 group', async () => {
            const container = document.createElement('div');
            container.className = 'message-content';
            document.body.appendChild(container);

            await restoreToolCallsGroup(
                [{ id: 'tc1', name: 'calc', state: 'completed', result: 'ok' }],
                container
            );

            const group = container.querySelector('.tool-calls-group');
            expect(group).toBeTruthy();
        });
    });
});
