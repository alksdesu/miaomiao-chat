/**
 * openclaw-cron.js 定时任务管理测试
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../js/core/events.js', () => ({
    eventBus: { emit: vi.fn(), on: vi.fn() }
}));

vi.mock('../../js/api/openclaw.js', () => ({
    openclawClient: {
        connected: false,
        send: vi.fn(() => Promise.resolve([]))
    }
}));

vi.mock('../../js/utils/helpers.js', () => ({
    escapeHtml: vi.fn((s) => s)
}));

vi.mock('../../js/utils/logger.js', () => ({
    logger: { warn: vi.fn(), debug: vi.fn(), error: vi.fn(), info: vi.fn() }
}));

import { eventBus } from '../../js/core/events.js';
import { initOpenClawCron, openCronPanel } from '../../js/ui/openclaw-cron.js';
import { openclawClient } from '../../js/api/openclaw.js';

describe('openclaw-cron', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        document.body.innerHTML = '';
    });

    afterEach(() => {
        document.body.innerHTML = '';
    });

    it('初始化不抛错', () => {
        expect(() => initOpenClawCron()).not.toThrow();
    });

    it('注册 cron-event 事件', () => {
        initOpenClawCron();
        expect(eventBus.on).toHaveBeenCalledWith('openclaw:cron-event', expect.any(Function));
    });

    it('绑定关闭按钮', () => {
        document.body.innerHTML = '<button id="openclaw-cron-close"></button>';
        const spy = vi.spyOn(document.getElementById('openclaw-cron-close'), 'addEventListener');
        initOpenClawCron();
        expect(spy).toHaveBeenCalledWith('click', expect.any(Function));
    });

    it('绑定添加按钮', () => {
        document.body.innerHTML = '<button id="openclaw-cron-add"></button>';
        const spy = vi.spyOn(document.getElementById('openclaw-cron-add'), 'addEventListener');
        initOpenClawCron();
        expect(spy).toHaveBeenCalledWith('click', expect.any(Function));
    });

    it('schedule change 切换自定义输入显示', () => {
        document.body.innerHTML = `
            <select id="openclaw-cron-schedule">
                <option value="custom">自定义</option>
            </select>
            <input id="openclaw-cron-custom" style="display:none" />
        `;
        initOpenClawCron();

        const select = document.getElementById('openclaw-cron-schedule');
        select.value = 'custom';
        select.dispatchEvent(new Event('change'));

        const custom = document.getElementById('openclaw-cron-custom');
        expect(custom.style.display).toBe('');
    });

    describe('openCronPanel', () => {
        it('overlay 不存在静默返回', async () => {
            await expect(openCronPanel()).resolves.not.toThrow();
        });

        it('未连接显示提示', async () => {
            document.body.innerHTML = `
                <div id="openclaw-cron-overlay" style="display:none">
                    <div id="openclaw-cron-list"></div>
                </div>
            `;
            openclawClient.connected = false;

            await openCronPanel();
            const list = document.getElementById('openclaw-cron-list');
            expect(list.innerHTML).toContain('未连接');
        });

        it('已连接加载任务列表', async () => {
            document.body.innerHTML = `
                <div id="openclaw-cron-overlay" style="display:none">
                    <div id="openclaw-cron-list"></div>
                </div>
            `;
            openclawClient.connected = true;
            openclawClient.send.mockResolvedValue([]);

            await openCronPanel();
            expect(openclawClient.send).toHaveBeenCalledWith('cron.list');
        });
    });
});
