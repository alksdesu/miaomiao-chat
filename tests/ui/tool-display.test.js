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

vi.mock('../../js/utils/media.js', async (importOriginal) => ({
    ...(await importOriginal()),
    downloadMedia: vi.fn(() => Promise.resolve({ savedTo: null }))
}));

import {
    createToolCallUI,
    updateToolCallStatus,
    restoreToolCallsGroup
} from '../../js/ui/tool-display.js';
import { downloadMedia } from '../../js/utils/media.js';

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

        it('结果里的 media 数组渲染为图片', async () => {
            const container = document.createElement('div');
            container.className = 'message-content';
            document.body.appendChild(container);

            await createToolCallUI({ id: 'tc1', name: 'screenshot', args: {} }, container);
            updateToolCallStatus('tc1', 'completed', {
                result: {
                    content: '',
                    media: [
                        { type: 'image', url: 'data:image/png;base64,SHOT', mimeType: 'image/png' }
                    ]
                }
            });

            const images = container.querySelectorAll('.tool-media-area img');
            expect(images).toHaveLength(1);
            expect(images[0].getAttribute('src')).toBe('data:image/png;base64,SHOT');
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

        it('批量动作中止的动作显示为未执行，原因用中文，不计入失败', async () => {
            const container = document.createElement('div');
            container.className = 'message-content';
            document.body.appendChild(container);

            await createToolCallUI({ id: 'a', name: 'left_click', args: {} }, container);
            await createToolCallUI({ id: 'b', name: 'type', args: {} }, container);
            updateToolCallStatus('a', 'completed', { result: { content: 'OK' } });
            updateToolCallStatus('b', 'skipped', {
                result: {
                    error: 'Not executed: an earlier computer action in this turn failed.',
                    is_error: true,
                    error_kind: 'not_executed'
                }
            });

            const btn = container.querySelector('.tool-calls-summary-btn');
            expect(btn.dataset.status).toBe('completed');
            expect(btn.querySelector('.summary-status').textContent).toBe('1 完成 / 1 跳过');
            btn.click();
            const skipped = document.querySelector('.tool-detail-skipped-msg');
            expect(skipped.textContent).toBe('同一批中前面的桌面动作失败，此动作未执行');
            expect(document.querySelector('.tool-detail-panel').textContent).not.toContain(
                'Not executed'
            );
        });

        it('停止请求后未执行与执行中被中止的动作分别给出原因', async () => {
            const container = document.createElement('div');
            container.className = 'message-content';
            document.body.appendChild(container);

            await createToolCallUI({ id: 'a', name: 'wait', args: {} }, container);
            await createToolCallUI({ id: 'b', name: 'left_click', args: {} }, container);
            updateToolCallStatus('a', 'skipped', {
                result: { error: 'aborted', is_error: true, error_kind: 'aborted' }
            });
            updateToolCallStatus('b', 'skipped', {
                result: { error: 'x', is_error: true, error_kind: 'aborted', executed: false }
            });

            const btn = container.querySelector('.tool-calls-summary-btn');
            expect(btn.dataset.status).toBe('skipped');
            btn.click();
            const reasons = [...document.querySelectorAll('.tool-detail-skipped-msg')].map(
                (el) => el.textContent
            );
            expect(reasons).toEqual(['请求已停止，执行被中止', '请求已停止，此动作未执行']);
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

        it('工具结果图片的下载按钮走统一的媒体下载', async () => {
            const container = document.createElement('div');
            container.className = 'message-content';
            document.body.appendChild(container);
            const imageUrl = 'data:image/png;base64,iVBORw0KGgo=';

            await restoreToolCallsGroup(
                [
                    {
                        id: 'tc1',
                        name: 'screenshot',
                        status: 'completed',
                        result: { image: imageUrl }
                    }
                ],
                container
            );

            container.querySelector('.download-image-btn').click();
            expect(downloadMedia).toHaveBeenCalledWith(
                imageUrl,
                expect.stringMatching(/^tool-image-\d+\.png$/)
            );
        });

        it('落库为 error 的中止动作恢复为未执行，失败动作仍显示失败', async () => {
            const container = document.createElement('div');
            container.className = 'message-content';
            document.body.appendChild(container);

            await restoreToolCallsGroup(
                [
                    {
                        id: 'a',
                        name: 'left_click',
                        status: 'failed',
                        result: {
                            error: 'Error: Mouse permission denied',
                            is_error: true,
                            error_kind: 'execution_failed'
                        }
                    },
                    {
                        id: 'b',
                        name: 'type',
                        status: 'failed',
                        result: {
                            error: 'Not executed: an earlier computer action in this turn failed.',
                            is_error: true,
                            error_kind: 'not_executed'
                        }
                    }
                ],
                container
            );

            const btn = container.querySelector('.tool-calls-summary-btn');
            expect(btn.dataset.status).toBe('failed');
            expect(btn.querySelector('.summary-status').textContent).toBe('1 个失败');
            btn.click();
            const items = [...document.querySelectorAll('.tool-detail-item')];
            expect(items.map((item) => item.dataset.status)).toEqual(['failed', 'skipped']);
            expect(items[1].querySelector('.tool-detail-skipped-msg').textContent).toBe(
                '同一批中前面的桌面动作失败，此动作未执行'
            );
        });

        it('其他标签页执行中的调用在汇总里注明，本页执行中的保持原文案', async () => {
            const remote = document.createElement('div');
            remote.className = 'message-content';
            const local = document.createElement('div');
            local.className = 'message-content';
            document.body.append(remote, local);

            await restoreToolCallsGroup(
                [
                    { id: 'done', name: 'calc', status: 'completed', result: 'ok' },
                    { id: 'remote', name: 'bash', status: 'executing', executingElsewhere: true }
                ],
                remote
            );
            await restoreToolCallsGroup([{ id: 'live', name: 'bash', status: 'executing' }], local);

            const remoteBtn = remote.querySelector('.tool-calls-summary-btn');
            expect(remoteBtn.dataset.status).toBe('executing');
            expect(remoteBtn.querySelector('.summary-status').textContent).toBe(
                '其他标签页执行中 1/2'
            );
            expect(local.querySelector('.summary-status').textContent).toBe('执行中 0/1');
        });
    });
});
