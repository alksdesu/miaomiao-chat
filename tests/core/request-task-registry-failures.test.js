/**
 * 请求任务表的失败标记：变化事件、启动恢复与跨标签页同步
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../js/core/state.js', () => ({
    state: {
        sessions: [],
        backgroundTasks: new Map()
    }
}));

vi.mock('../../js/core/events.js', () => ({
    eventBus: { emit: vi.fn() }
}));

import { RequestTaskRegistry } from '../../js/core/request-task-registry.js';
import { state } from '../../js/core/state.js';
import { eventBus } from '../../js/core/events.js';

const FAILURE_CHANGED = 'session:failure-changed';

function failureEvents() {
    return eventBus.emit.mock.calls.filter(([name]) => name === FAILURE_CHANGED);
}

function sessionsUpdatedCount() {
    return eventBus.emit.mock.calls.filter(([name]) => name === 'sessions:updated').length;
}

describe('RequestTaskRegistry 失败标记', () => {
    let registry;

    function finishDetachedWithError(sessionId) {
        const task = registry.create({ sessionId, abortController: new AbortController() });
        registry.detach(task);
        registry.finish(task, 'error');
        return task;
    }

    beforeEach(() => {
        registry = new RequestTaskRegistry();
        state.backgroundTasks.clear();
        eventBus.emit.mockClear();
    });

    describe('变化事件', () => {
        it('后台任务出错新增标记时发出失败变化', () => {
            finishDetachedWithError('session-a');

            expect(failureEvents()).toEqual([
                [FAILURE_CHANGED, { sessionId: 'session-a', failed: true }]
            ]);
        });

        it('任务运行期间其他标签页已标记同一会话，本页再失败不重复发出', () => {
            const task = registry.create({
                sessionId: 'session-a',
                abortController: new AbortController()
            });
            registry.detach(task);
            registry.syncFailure('session-a', true);
            eventBus.emit.mockClear();

            registry.finish(task, 'error');

            expect(registry.hasFailure('session-a')).toBe(true);
            expect(failureEvents()).toEqual([]);
            expect(sessionsUpdatedCount()).toBe(1);
        });

        it('清除标记时发出清除变化，没有标记时不发', () => {
            finishDetachedWithError('session-a');
            eventBus.emit.mockClear();

            expect(registry.clearFailure('session-a')).toBe(true);
            expect(failureEvents()).toEqual([
                [FAILURE_CHANGED, { sessionId: 'session-a', failed: false }]
            ]);

            eventBus.emit.mockClear();
            expect(registry.clearFailure('session-a')).toBe(false);
            expect(eventBus.emit).not.toHaveBeenCalled();
        });

        it('在失败的会话里重新发起请求同样发出清除变化', () => {
            registry.restoreFailures(['session-a']);
            eventBus.emit.mockClear();

            registry.create({ sessionId: 'session-a', abortController: new AbortController() });

            expect(registry.hasFailure('session-a')).toBe(false);
            expect(failureEvents()).toEqual([
                [FAILURE_CHANGED, { sessionId: 'session-a', failed: false }]
            ]);
        });
    });

    describe('restoreFailures', () => {
        it('只恢复本页标记并刷新侧栏，不发失败变化', () => {
            expect(registry.restoreFailures(['session-a', '', null, 'session-b'])).toBe(true);

            expect(registry.hasFailure('session-a')).toBe(true);
            expect(registry.hasFailure('session-b')).toBe(true);
            expect(failureEvents()).toEqual([]);
            expect(sessionsUpdatedCount()).toBe(1);
        });

        it('没有新标记时不刷新侧栏', () => {
            registry.restoreFailures(['session-a']);
            eventBus.emit.mockClear();

            expect(registry.restoreFailures(['session-a'])).toBe(false);
            expect(registry.restoreFailures([])).toBe(false);
            expect(registry.restoreFailures(undefined)).toBe(false);
            expect(eventBus.emit).not.toHaveBeenCalled();
        });
    });

    describe('syncFailure', () => {
        it('应用其他标签页的标记与清除，只刷新侧栏不回发', () => {
            expect(registry.syncFailure('session-a', true)).toBe(true);
            expect(registry.hasFailure('session-a')).toBe(true);

            expect(registry.syncFailure('session-a', false)).toBe(true);
            expect(registry.hasFailure('session-a')).toBe(false);

            expect(failureEvents()).toEqual([]);
            expect(sessionsUpdatedCount()).toBe(2);
        });

        it('状态没变或缺少会话 ID 时不做任何事', () => {
            registry.syncFailure('session-a', true);
            eventBus.emit.mockClear();

            expect(registry.syncFailure('session-a', true)).toBe(false);
            expect(registry.syncFailure('session-b', false)).toBe(false);
            expect(registry.syncFailure('', true)).toBe(false);
            expect(registry.hasFailure('')).toBe(false);
            expect(eventBus.emit).not.toHaveBeenCalled();
        });
    });
});
