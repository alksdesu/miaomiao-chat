/**
 * history.js 测试 (tools)
 * 工具调用历史记录、查询、统计、导入导出
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockState } = vi.hoisted(() => {
    const mockState = {
        toolHistoryEnabled: true,
        toolCallHistory: [],
        maxToolHistorySize: 100,
        currentSessionId: 'session-1'
    };
    return { mockState };
});

vi.mock('../../js/core/state.js', () => ({
    state: mockState
}));

vi.mock('../../js/state/sessions.js', () => ({
    debouncedSaveSession: vi.fn()
}));

vi.mock('../../js/state/storage.js', () => ({
    savePreference: vi.fn(),
    loadPreference: vi.fn(() => null)
}));

vi.mock('../../js/core/state-mutations.js', () => ({
    setToolHistoryEnabled: vi.fn((val) => {
        mockState.toolHistoryEnabled = val;
    }),
    setMaxToolHistorySize: vi.fn((val) => {
        mockState.maxToolHistorySize = val;
    })
}));

import { state } from '../../js/core/state.js';
import {
    recordToolCall,
    getToolHistory,
    getToolStats,
    clearToolHistory,
    exportToolHistory,
    importToolHistory,
    setToolHistoryEnabled,
    setMaxToolHistorySize
} from '../../js/tools/history.js';

beforeEach(() => {
    vi.clearAllMocks();
    state.toolHistoryEnabled = true;
    state.toolCallHistory = [];
    state.maxToolHistorySize = 100;
    state.currentSessionId = 'session-1';
});

describe('recordToolCall', () => {
    it('记录工具调用到历史', () => {
        recordToolCall({
            toolId: 'calc',
            toolName: 'calculator',
            args: { a: 1 },
            result: { sum: 2 },
            success: true,
            duration: 10
        });
        expect(state.toolCallHistory.length).toBe(1);
        expect(state.toolCallHistory[0].toolName).toBe('calculator');
    });

    it('最新的记录在前面', () => {
        recordToolCall({ toolId: 't1', toolName: 'first', success: true, duration: 1 });
        recordToolCall({ toolId: 't2', toolName: 'second', success: true, duration: 1 });
        expect(state.toolCallHistory[0].toolName).toBe('second');
    });

    it('记录包含时间戳', () => {
        recordToolCall({ toolId: 't', toolName: 'test', success: true, duration: 1 });
        expect(state.toolCallHistory[0].timestamp).toBeDefined();
        expect(state.toolCallHistory[0].datetime).toBeDefined();
    });

    it('记录包含 sessionId', () => {
        recordToolCall({ toolId: 't', toolName: 'test', success: true, duration: 1 });
        expect(state.toolCallHistory[0].sessionId).toBe('session-1');
    });

    it('超出最大限制时裁剪', () => {
        state.maxToolHistorySize = 3;
        for (let i = 0; i < 5; i++) {
            recordToolCall({ toolId: `t${i}`, toolName: `tool-${i}`, success: true, duration: 1 });
        }
        expect(state.toolCallHistory.length).toBe(3);
    });

    it('历史禁用时不记录', () => {
        state.toolHistoryEnabled = false;
        recordToolCall({ toolId: 't', toolName: 'test', success: true, duration: 1 });
        expect(state.toolCallHistory.length).toBe(0);
    });
});

describe('getToolHistory', () => {
    beforeEach(() => {
        state.toolCallHistory = [
            {
                toolName: 'calc',
                success: true,
                sessionId: 'session-1',
                timestamp: 1000,
                duration: 10
            },
            {
                toolName: 'search',
                success: false,
                sessionId: 'session-2',
                timestamp: 2000,
                duration: 20
            },
            {
                toolName: 'calc',
                success: true,
                sessionId: 'session-1',
                timestamp: 3000,
                duration: 5
            }
        ];
    });

    it('返回所有记录（无过滤）', () => {
        expect(getToolHistory().length).toBe(3);
    });

    it('按工具名过滤', () => {
        const result = getToolHistory({ toolName: 'calc' });
        expect(result.length).toBe(2);
    });

    it('按成功状态过滤', () => {
        const result = getToolHistory({ success: false });
        expect(result.length).toBe(1);
        expect(result[0].toolName).toBe('search');
    });

    it('按 sessionId 过滤', () => {
        const result = getToolHistory({ sessionId: 'session-2' });
        expect(result.length).toBe(1);
    });

    it('按时间戳过滤', () => {
        const result = getToolHistory({ since: 2000 });
        expect(result.length).toBe(2);
    });

    it('限制返回数量', () => {
        const result = getToolHistory({ limit: 1 });
        expect(result.length).toBe(1);
    });
});

describe('getToolStats', () => {
    beforeEach(() => {
        state.toolCallHistory = [
            {
                toolName: 'calc',
                success: true,
                sessionId: 's1',
                timestamp: 1000,
                duration: 100
            },
            {
                toolName: 'calc',
                success: false,
                sessionId: 's1',
                timestamp: 2000,
                duration: 50,
                error: 'fail'
            },
            {
                toolName: 'search',
                success: true,
                sessionId: 's2',
                timestamp: 3000,
                duration: 200
            }
        ];
    });

    it('统计总数', () => {
        const stats = getToolStats();
        expect(stats.total).toBe(3);
    });

    it('统计成功/失败', () => {
        const stats = getToolStats();
        expect(stats.success).toBe(2);
        expect(stats.failed).toBe(1);
    });

    it('计算平均时长', () => {
        const stats = getToolStats();
        expect(stats.avgDuration).toBe(Math.round((100 + 50 + 200) / 3));
    });

    it('按工具分组统计', () => {
        const stats = getToolStats();
        expect(stats.byTool.calc).toBeDefined();
        expect(stats.byTool.calc.total).toBe(2);
        expect(stats.byTool.search.total).toBe(1);
    });

    it('按会话分组统计', () => {
        const stats = getToolStats();
        expect(stats.bySession.s1).toBe(2);
        expect(stats.bySession.s2).toBe(1);
    });

    it('记录最近错误', () => {
        const stats = getToolStats();
        expect(stats.recentErrors.length).toBe(1);
        expect(stats.recentErrors[0].error).toBe('fail');
    });
});

describe('clearToolHistory', () => {
    it('清除所有历史', () => {
        state.toolCallHistory = [{ toolName: 'a' }, { toolName: 'b' }];
        clearToolHistory();
        expect(state.toolCallHistory.length).toBe(0);
    });

    it('按工具名清除', () => {
        state.toolCallHistory = [
            { toolName: 'keep', timestamp: 1 },
            { toolName: 'remove', timestamp: 2 }
        ];
        clearToolHistory({ toolName: 'remove' });
        expect(state.toolCallHistory.length).toBe(1);
        expect(state.toolCallHistory[0].toolName).toBe('keep');
    });

    it('按 sessionId 清除', () => {
        state.toolCallHistory = [
            { toolName: 'a', sessionId: 's1', timestamp: 1 },
            { toolName: 'b', sessionId: 's2', timestamp: 2 }
        ];
        clearToolHistory({ sessionId: 's1' });
        expect(state.toolCallHistory.length).toBe(1);
    });

    it('按时间戳清除', () => {
        state.toolCallHistory = [
            { toolName: 'old', timestamp: 100 },
            { toolName: 'new', timestamp: 2000 }
        ];
        clearToolHistory({ before: 1000 });
        expect(state.toolCallHistory.length).toBe(1);
        expect(state.toolCallHistory[0].toolName).toBe('new');
    });
});

describe('exportToolHistory', () => {
    it('JSON 格式导出', () => {
        state.toolCallHistory = [{ toolName: 'test', success: true }];
        const json = exportToolHistory('json');
        const parsed = JSON.parse(json);
        expect(parsed.length).toBe(1);
    });

    it('CSV 格式导出', () => {
        state.toolCallHistory = [
            {
                toolName: 'test',
                success: true,
                timestamp: 1,
                datetime: '2024-01-01',
                duration: 10,
                sessionId: 's1'
            }
        ];
        const csv = exportToolHistory('csv');
        expect(csv).toContain('timestamp');
        expect(csv).toContain('test');
    });

    it('空历史导出 CSV 为空', () => {
        state.toolCallHistory = [];
        const csv = exportToolHistory('csv');
        expect(csv).toBe('');
    });

    it('不支持的格式抛出错误', () => {
        expect(() => exportToolHistory('xml')).toThrow('不支持的导出格式');
    });
});

describe('importToolHistory', () => {
    it('导入 JSON 数据', () => {
        const data = JSON.stringify([{ toolName: 'imported', success: true }]);
        const count = importToolHistory(data);
        expect(count).toBe(1);
    });

    it('合并模式', () => {
        state.toolCallHistory = [{ toolName: 'existing' }];
        const data = JSON.stringify([{ toolName: 'new' }]);
        importToolHistory(data, { merge: true });
        expect(state.toolCallHistory.length).toBe(2);
    });

    it('替换模式', () => {
        state.toolCallHistory = [{ toolName: 'old' }];
        const data = JSON.stringify([{ toolName: 'new' }]);
        importToolHistory(data, { merge: false });
        expect(state.toolCallHistory.length).toBe(1);
        expect(state.toolCallHistory[0].toolName).toBe('new');
    });

    it('非数组格式抛出错误', () => {
        expect(() => importToolHistory('{"not": "array"}')).toThrow('数组格式');
    });

    it('无效 JSON 抛出错误', () => {
        expect(() => importToolHistory('not-json')).toThrow();
    });
});

describe('setToolHistoryEnabled', () => {
    it('启用历史记录', () => {
        setToolHistoryEnabled(true);
        expect(state.toolHistoryEnabled).toBe(true);
    });

    it('禁用历史记录', () => {
        setToolHistoryEnabled(false);
        expect(state.toolHistoryEnabled).toBe(false);
    });
});

describe('setMaxToolHistorySize', () => {
    it('设置最大数量', () => {
        setMaxToolHistorySize(50);
        expect(state.maxToolHistorySize).toBe(50);
    });

    it('超出限制时裁剪', () => {
        state.toolCallHistory = Array.from({ length: 10 }, (_, i) => ({ toolName: `t${i}` }));
        setMaxToolHistorySize(5);
        expect(state.toolCallHistory.length).toBe(5);
    });
});
