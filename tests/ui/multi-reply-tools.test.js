/**
 * ui/multi-reply-tools.js 测试：多回复与客户端工具互斥
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../js/core/state.js', () => ({
    state: { replyCount: 1, computerUseEnabled: false }
}));

vi.mock('../../js/core/events.js', () => ({
    eventBus: { emit: vi.fn(), on: vi.fn() }
}));

vi.mock('../../js/tools/manager.js', () => ({
    getToolStats: vi.fn(() => ({ enabled: 0 }))
}));

vi.mock('../../js/utils/platform.js', () => ({
    isElectron: vi.fn(() => true)
}));

vi.mock('../../js/utils/logger.js', () => ({
    logger: { warn: vi.fn(), debug: vi.fn(), error: vi.fn() }
}));

import { state } from '../../js/core/state.js';
import { eventBus } from '../../js/core/events.js';
import { getToolStats } from '../../js/tools/manager.js';
import { isElectron } from '../../js/utils/platform.js';
import {
    describeEnabledClientTools,
    rejectComputerUseForMultiReply
} from '../../js/ui/multi-reply-tools.js';

beforeEach(() => {
    vi.clearAllMocks();
    state.replyCount = 1;
    state.computerUseEnabled = false;
    getToolStats.mockReturnValue({ enabled: 0 });
    isElectron.mockReturnValue(true);
});

describe('describeEnabledClientTools', () => {
    it('列出启用的工具数与桌面端的 Computer Use', () => {
        getToolStats.mockReturnValue({ enabled: 2 });
        state.computerUseEnabled = true;
        expect(describeEnabledClientTools()).toBe('2 个工具、Computer Use');
    });

    it('非桌面端的 Computer Use 不产生工具调用，不计入', () => {
        state.computerUseEnabled = true;
        isElectron.mockReturnValue(false);
        expect(describeEnabledClientTools()).toBe('');
    });

    it('工具系统未加载时只看 Computer Use', () => {
        getToolStats.mockImplementation(() => {
            throw new Error('not loaded');
        });
        state.computerUseEnabled = true;
        expect(describeEnabledClientTools()).toBe('Computer Use');
    });
});

describe('rejectComputerUseForMultiReply', () => {
    it('多回复数量大于 1 时拒绝开启并提示', () => {
        state.replyCount = 3;
        expect(rejectComputerUseForMultiReply()).toBe(true);
        expect(eventBus.emit).toHaveBeenCalledWith(
            'ui:notification',
            expect.objectContaining({
                type: 'error',
                message: expect.stringContaining('当前多回复数量为 3')
            })
        );
    });

    it('单回复或非桌面端时放行', () => {
        expect(rejectComputerUseForMultiReply()).toBe(false);
        state.replyCount = 2;
        isElectron.mockReturnValue(false);
        expect(rejectComputerUseForMultiReply()).toBe(false);
        expect(eventBus.emit).not.toHaveBeenCalled();
    });
});
