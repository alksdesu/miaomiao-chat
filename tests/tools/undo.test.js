/**
 * undo.js 测试
 * 工具调用撤销系统
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../js/core/state.js', () => ({
    state: {
        messages: [],
        currentAssistantMessage: null,
        currentSessionId: 'session-1'
    }
}));

vi.mock('../../js/core/events.js', () => ({
    eventBus: {
        on: vi.fn(),
        emit: vi.fn()
    }
}));

vi.mock('../../js/messages/restore.js', () => ({
    renderSessionMessages: vi.fn()
}));

vi.mock('../../js/core/state-mutations.js', () => ({
    replaceAllMessages: vi.fn()
}));

import { state } from '../../js/core/state.js';
import {
    createSnapshot,
    undo,
    clearUndoStack,
    getUndoStackInfo,
    canUndoNow,
    snapshotBeforeToolCall,
    undoLastToolCall,
    undoToSnapshot
} from '../../js/tools/undo.js';
import { replaceAllMessages } from '../../js/core/state-mutations.js';

beforeEach(() => {
    vi.clearAllMocks();
    clearUndoStack();
    state.messages = [];
    state.currentAssistantMessage = null;
});

describe('createSnapshot', () => {
    it('创建快照并返回对象', () => {
        state.messages = [{ role: 'user', content: 'hi' }];
        const snapshot = createSnapshot({ reason: 'test' });
        expect(snapshot.id).toBeDefined();
        expect(snapshot.messages).toHaveLength(1);
        expect(snapshot.metadata.reason).toBe('test');
    });

    it('深拷贝消息', () => {
        state.messages = [{ role: 'user', content: 'hi' }];
        const snapshot = createSnapshot();
        state.messages[0].content = 'modified';
        expect(snapshot.messages[0].content).toBe('hi');
    });

    it('快照进入撤销栈', () => {
        createSnapshot();
        expect(getUndoStackInfo().stackSize).toBe(1);
    });

    it('超出最大栈大小时移除最旧的', () => {
        for (let i = 0; i < 12; i++) {
            createSnapshot({ index: i });
        }
        expect(getUndoStackInfo().stackSize).toBeLessThanOrEqual(10);
    });

    it('创建后 canUndo 为 true', () => {
        createSnapshot();
        expect(canUndoNow()).toBe(true);
    });
});

describe('undo', () => {
    it('空栈返回 null', () => {
        expect(undo()).toBeNull();
    });

    it('恢复消息状态', () => {
        state.messages = [{ role: 'user', content: 'original' }];
        createSnapshot();
        state.messages = [{ role: 'user', content: 'modified' }];

        const result = undo();
        expect(result.success).toBe(true);
        expect(replaceAllMessages).toHaveBeenCalled();
    });

    it('撤销后减少栈大小', () => {
        createSnapshot();
        createSnapshot();
        expect(getUndoStackInfo().stackSize).toBe(2);

        undo();
        expect(getUndoStackInfo().stackSize).toBe(1);
    });

    it('全部撤销后 canUndo 为 false', () => {
        createSnapshot();
        undo();
        expect(canUndoNow()).toBe(false);
    });
});

describe('clearUndoStack', () => {
    it('清空撤销栈', () => {
        createSnapshot();
        createSnapshot();
        clearUndoStack();
        expect(getUndoStackInfo().stackSize).toBe(0);
        expect(canUndoNow()).toBe(false);
    });
});

describe('getUndoStackInfo', () => {
    it('返回栈信息', () => {
        const info = getUndoStackInfo();
        expect(info).toHaveProperty('canUndo');
        expect(info).toHaveProperty('stackSize');
        expect(info).toHaveProperty('maxStackSize');
        expect(info).toHaveProperty('snapshots');
    });

    it('快照信息包含必要字段', () => {
        createSnapshot({ reason: 'test' });
        const info = getUndoStackInfo();
        expect(info.snapshots[0]).toHaveProperty('id');
        expect(info.snapshots[0]).toHaveProperty('timestamp');
    });
});

describe('snapshotBeforeToolCall', () => {
    it('创建工具调用快照', () => {
        state.messages = [{ role: 'user', content: 'hi' }];
        const snapshot = snapshotBeforeToolCall([{ function: { name: 'calculator' } }]);
        expect(snapshot.metadata.type).toBe('tool_call');
        expect(snapshot.metadata.toolNames).toContain('calculator');
    });

    it('多个工具调用', () => {
        const snapshot = snapshotBeforeToolCall([
            { function: { name: 'calc' } },
            { function: { name: 'search' } }
        ]);
        expect(snapshot.metadata.toolCount).toBe(2);
        expect(snapshot.metadata.toolNames).toContain('calc');
        expect(snapshot.metadata.toolNames).toContain('search');
    });
});

describe('undoLastToolCall', () => {
    it('无工具快照返回 null', () => {
        createSnapshot({ type: 'manual' });
        expect(undoLastToolCall()).toBeNull();
    });

    it('撤销最近的工具调用', () => {
        snapshotBeforeToolCall([{ function: { name: 'calc' } }]);
        const result = undoLastToolCall();
        expect(result.success).toBe(true);
    });
});

describe('undoToSnapshot', () => {
    it('撤销到指定快照', () => {
        const s1 = createSnapshot({ index: 1 });
        createSnapshot({ index: 2 });

        const result = undoToSnapshot(s1.id);
        expect(result.success).toBe(true);
    });

    it('快照不存在返回 null', () => {
        expect(undoToSnapshot('nonexistent')).toBeNull();
    });
});

describe('canUndoNow', () => {
    it('空栈返回 false', () => {
        expect(canUndoNow()).toBe(false);
    });

    it('有快照返回 true', () => {
        createSnapshot();
        expect(canUndoNow()).toBe(true);
    });
});
