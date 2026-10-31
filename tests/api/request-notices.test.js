/**
 * api/request-notices.js 预检提示按会话去重测试
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../js/core/events.js', () => ({ eventBus: { emit: vi.fn() } }));
vi.mock('../../js/core/state.js', () => ({
    state: { currentSessionId: 's1', sessions: [] }
}));
vi.mock('../../js/utils/logger.js', () => ({
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

import {
    emitRequestNotices,
    clearRequestNoticesForTests,
    withSessionLabel
} from '../../js/api/request-notices.js';
import { eventBus } from '../../js/core/events.js';
import { state } from '../../js/core/state.js';

const notice = { key: 'claude.sampling', message: '已忽略 temperature' };

beforeEach(() => {
    vi.clearAllMocks();
    clearRequestNoticesForTests();
    state.currentSessionId = 's1';
    state.sessions = [
        { id: 's1', name: '当前会话' },
        { id: 's2', name: '写作助手' }
    ];
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

    it('同一会话同样的提示只出现一次', () => {
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

    it('提示文案带上模型名', () => {
        emitRequestNotices('s1', [notice], { modelName: 'claude-opus-4-5' });
        expect(eventBus.emit).toHaveBeenCalledWith(
            'ui:notification',
            expect.objectContaining({ message: 'claude-opus-4-5：已忽略 temperature' })
        );
    });

    it('同一项换了模型或提示内容变化时重新提示', () => {
        emitRequestNotices('s1', [notice], { modelName: 'model-a' });
        emitRequestNotices('s1', [notice], { modelName: 'model-b' });
        emitRequestNotices('s1', [{ ...notice, message: '已忽略 top_p' }], {
            modelName: 'model-b'
        });
        emitRequestNotices('s1', [notice], { modelName: 'model-b' });
        expect(eventBus.emit).toHaveBeenCalledTimes(3);
    });

    it('后台会话的提示带上会话名', () => {
        emitRequestNotices('s2', [notice], { modelName: 'gpt-5' });
        expect(eventBus.emit).toHaveBeenCalledWith(
            'ui:notification',
            expect.objectContaining({ message: '「写作助手」gpt-5：已忽略 temperature' })
        );
    });
});

describe('withSessionLabel', () => {
    it('找不到会话时用通用称呼', () => {
        expect(withSessionLabel('missing', '的回复失败')).toBe('「会话」的回复失败');
        expect(withSessionLabel(null, '的回复失败')).toBe('「会话」的回复失败');
    });
});
