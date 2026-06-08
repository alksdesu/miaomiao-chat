/**
 * openclaw-approval.js 审批弹窗测试
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../js/core/events.js', () => ({
    eventBus: { emit: vi.fn(), on: vi.fn() }
}));

vi.mock('../../js/api/openclaw.js', () => ({
    openclawClient: {
        approveAction: vi.fn(() => Promise.resolve())
    }
}));

vi.mock('../../js/utils/logger.js', () => ({
    logger: { warn: vi.fn(), debug: vi.fn(), error: vi.fn(), info: vi.fn() }
}));

import { eventBus } from '../../js/core/events.js';
import { initOpenClawApproval } from '../../js/ui/openclaw-approval.js';

describe('openclaw-approval', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
        document.body.innerHTML = '';
    });

    afterEach(() => {
        vi.useRealTimers();
        document.body.innerHTML = '';
    });

    it('初始化不抛错', () => {
        expect(() => initOpenClawApproval()).not.toThrow();
    });

    it('注册 approval-requested 事件', () => {
        initOpenClawApproval();
        expect(eventBus.on).toHaveBeenCalledWith(
            'openclaw:approval-requested',
            expect.any(Function)
        );
    });

    it('绑定 approve 按钮', () => {
        document.body.innerHTML = `
            <button id="openclaw-approve-btn"></button>
            <button id="openclaw-reject-btn"></button>
        `;
        const approveSpy = vi.spyOn(
            document.getElementById('openclaw-approve-btn'),
            'addEventListener'
        );
        initOpenClawApproval();
        expect(approveSpy).toHaveBeenCalledWith('click', expect.any(Function));
    });

    it('绑定 reject 按钮', () => {
        document.body.innerHTML = `
            <button id="openclaw-approve-btn"></button>
            <button id="openclaw-reject-btn"></button>
        `;
        const rejectSpy = vi.spyOn(
            document.getElementById('openclaw-reject-btn'),
            'addEventListener'
        );
        initOpenClawApproval();
        expect(rejectSpy).toHaveBeenCalledWith('click', expect.any(Function));
    });

    it('显示审批弹窗并填充内容', () => {
        document.body.innerHTML = `
            <div id="openclaw-approval-overlay" style="display:none">
                <span id="openclaw-approval-desc"></span>
                <span id="openclaw-approval-tool"></span>
                <div><span id="openclaw-approval-command"></span></div>
                <span id="openclaw-approval-risk"></span>
                <span id="openclaw-approval-countdown"></span>
            </div>
            <button id="openclaw-approve-btn"></button>
            <button id="openclaw-reject-btn"></button>
        `;

        initOpenClawApproval();

        // 获取注册的回调
        const approvalCallback = eventBus.on.mock.calls.find(
            (c) => c[0] === 'openclaw:approval-requested'
        )[1];

        approvalCallback({
            approvalId: 'ap-123',
            description: 'Delete file',
            tool: 'rm',
            command: 'rm -rf /',
            riskLevel: 'critical',
            timeoutSeconds: 30
        });

        const overlay = document.getElementById('openclaw-approval-overlay');
        expect(overlay.style.display).toBe('block');
        expect(overlay.dataset.approvalId).toBe('ap-123');
        expect(document.getElementById('openclaw-approval-desc').textContent).toBe('Delete file');
        expect(document.getElementById('openclaw-approval-tool').textContent).toBe('rm');
        expect(document.getElementById('openclaw-approval-command').textContent).toBe('rm -rf /');
        expect(document.getElementById('openclaw-approval-risk').textContent).toBe('极高');
        expect(document.getElementById('openclaw-approval-countdown').textContent).toBe('30');
    });

    it('审批弹窗默认风险等级', () => {
        document.body.innerHTML = `
            <div id="openclaw-approval-overlay" style="display:none">
                <span id="openclaw-approval-desc"></span>
                <span id="openclaw-approval-tool"></span>
                <div><span id="openclaw-approval-command"></span></div>
                <span id="openclaw-approval-risk"></span>
                <span id="openclaw-approval-countdown"></span>
            </div>
            <button id="openclaw-approve-btn"></button>
            <button id="openclaw-reject-btn"></button>
        `;

        initOpenClawApproval();
        const approvalCallback = eventBus.on.mock.calls.find(
            (c) => c[0] === 'openclaw:approval-requested'
        )[1];

        approvalCallback({
            approvalId: 'ap-456',
            description: 'Some action'
        });

        expect(document.getElementById('openclaw-approval-risk').textContent).toBe('中');
    });

    it('倒计时自动递减', () => {
        document.body.innerHTML = `
            <div id="openclaw-approval-overlay" style="display:none">
                <span id="openclaw-approval-desc"></span>
                <span id="openclaw-approval-countdown"></span>
            </div>
            <button id="openclaw-approve-btn"></button>
            <button id="openclaw-reject-btn"></button>
        `;

        initOpenClawApproval();
        const approvalCallback = eventBus.on.mock.calls.find(
            (c) => c[0] === 'openclaw:approval-requested'
        )[1];

        approvalCallback({
            approvalId: 'ap-789',
            description: 'Test',
            timeoutSeconds: 5
        });

        expect(document.getElementById('openclaw-approval-countdown').textContent).toBe('5');

        vi.advanceTimersByTime(2000);
        expect(document.getElementById('openclaw-approval-countdown').textContent).toBe('3');
    });

    it('点击 approve 按钮调用 approveAction(true)', async () => {
        const { openclawClient } = await import('../../js/api/openclaw.js');
        document.body.innerHTML = `
            <div id="openclaw-approval-overlay" style="display:none" data-approval-id="">
                <span id="openclaw-approval-desc"></span>
                <span id="openclaw-approval-countdown"></span>
            </div>
            <button id="openclaw-approve-btn"></button>
            <button id="openclaw-reject-btn"></button>
        `;

        initOpenClawApproval();
        const approvalCallback = eventBus.on.mock.calls.find(
            (c) => c[0] === 'openclaw:approval-requested'
        )[1];
        approvalCallback({
            approvalId: 'ap-approve',
            description: 'Test'
        });

        vi.clearAllMocks();
        const approveBtn = document.getElementById('openclaw-approve-btn');
        approveBtn.click();

        // 等待 async respondApproval
        await vi.waitFor(() => {
            expect(openclawClient.approveAction).toHaveBeenCalledWith('ap-approve', true);
        });

        expect(document.getElementById('openclaw-approval-overlay').style.display).toBe('none');
    });

    it('点击 reject 按钮调用 approveAction(false)', async () => {
        const { openclawClient } = await import('../../js/api/openclaw.js');
        document.body.innerHTML = `
            <div id="openclaw-approval-overlay" style="display:none" data-approval-id="">
                <span id="openclaw-approval-desc"></span>
                <span id="openclaw-approval-countdown"></span>
            </div>
            <button id="openclaw-approve-btn"></button>
            <button id="openclaw-reject-btn"></button>
        `;

        initOpenClawApproval();
        const approvalCallback = eventBus.on.mock.calls.find(
            (c) => c[0] === 'openclaw:approval-requested'
        )[1];
        approvalCallback({
            approvalId: 'ap-reject',
            description: 'Test'
        });

        vi.clearAllMocks();
        const rejectBtn = document.getElementById('openclaw-reject-btn');
        rejectBtn.click();

        await vi.waitFor(() => {
            expect(openclawClient.approveAction).toHaveBeenCalledWith('ap-reject', false);
        });
    });

    it('无 command 时隐藏命令行', () => {
        document.body.innerHTML = `
            <div id="openclaw-approval-overlay" style="display:none">
                <span id="openclaw-approval-desc"></span>
                <span id="openclaw-approval-tool"></span>
                <div><span id="openclaw-approval-command"></span></div>
                <span id="openclaw-approval-risk"></span>
                <span id="openclaw-approval-countdown"></span>
            </div>
            <button id="openclaw-approve-btn"></button>
            <button id="openclaw-reject-btn"></button>
        `;

        initOpenClawApproval();
        const approvalCallback = eventBus.on.mock.calls.find(
            (c) => c[0] === 'openclaw:approval-requested'
        )[1];

        approvalCallback({
            approvalId: 'ap-nocmd',
            description: 'No command',
            tool: 'test'
        });

        const cmdEl = document.getElementById('openclaw-approval-command');
        expect(cmdEl.parentElement.style.display).toBe('none');
    });
});
