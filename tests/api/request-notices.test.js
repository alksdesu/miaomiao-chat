/**
 * api/request-notices.js 预检提示按会话去重测试
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../js/core/events.js', () => ({ eventBus: { emit: vi.fn() } }));
vi.mock('../../js/utils/logger.js', () => ({
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

import { emitRequestNotices, clearRequestNoticesForTests } from '../../js/api/request-notices.js';
import { eventBus } from '../../js/core/events.js';

const notice = { key: 'claude.sampling', message: '已忽略 temperature' };

beforeEach(() => {
    vi.clearAllMocks();
    clearRequestNoticesForTests();
});

describe('emitRequestNotices', () => {
    it('以警告通知弹出提示', () => {
        emitRequestNotices('s1', [notice]);
        expect(eventBus.emit).toHaveBeenCalledWith('ui:notification', {
            message: '已忽略 temperature',
            type: 'warning',
            duration: 6000
        });
    });

    it('同一会话同一项只提示一次', () => {
        emitRequestNotices('s1', [notice]);
        emitRequestNotices('s1', [notice]);
        expect(eventBus.emit).toHaveBeenCalledTimes(1);
    });

    it('不同会话各提示一次', () => {
        emitRequestNotices('s1', [notice]);
        emitRequestNotices('s2', [notice]);
        expect(eventBus.emit).toHaveBeenCalledTimes(2);
    });

    it('同一会话不同项分别提示', () => {
        emitRequestNotices('s1', [notice, { key: 'claude.assistant-prefill', message: '已跳过' }]);
        expect(eventBus.emit).toHaveBeenCalledTimes(2);
    });

    it('忽略缺少 key 或文案的提示与空列表', () => {
        emitRequestNotices('s1', [{ key: 'x' }, { message: 'y' }, null]);
        emitRequestNotices('s1', undefined);
        expect(eventBus.emit).not.toHaveBeenCalled();
    });
});
