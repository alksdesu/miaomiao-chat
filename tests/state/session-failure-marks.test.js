/**
 * state/session-failure-marks.js 失败标记持久化与跨标签页广播
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const harness = vi.hoisted(() => {
    const handlers = new Map();
    const store = new Map();
    let lockTail = Promise.resolve();
    return {
        handlers,
        store,
        eventBus: {
            on: (name, handler) => {
                if (!handlers.has(name)) handlers.set(name, []);
                handlers.get(name).push(handler);
            },
            emit: (name, payload) => {
                for (const handler of handlers.get(name) || []) handler(payload);
            }
        },
        // 按请求顺序串行执行，与 navigator.locks 的排队语义一致
        withDBLock: (_name, fn) => {
            const run = lockTail.then(fn);
            lockTail = run.catch(() => {});
            return run;
        }
    };
});

vi.mock('../../js/core/state.js', () => ({
    state: { sessions: [], backgroundTasks: new Map() }
}));

vi.mock('../../js/core/events.js', () => ({ eventBus: harness.eventBus }));

vi.mock('../../js/state/preferences-storage.js', () => ({
    loadPreference: vi.fn(async (key) =>
        harness.store.has(key) ? structuredClone(harness.store.get(key)) : null
    ),
    savePreference: vi.fn(async (key, value) => {
        harness.store.set(key, structuredClone(value));
    })
}));

vi.mock('../../js/state/indexeddb.js', () => ({
    withDBLock: vi.fn(harness.withDBLock)
}));

vi.mock('../../js/state/tab-sync.js', () => ({
    broadcastEvent: vi.fn()
}));

vi.mock('../../js/utils/logger.js', () => ({
    logger: { warn: vi.fn(), debug: vi.fn(), error: vi.fn(), info: vi.fn() }
}));

import { state } from '../../js/core/state.js';
import { requestTaskRegistry } from '../../js/core/request-task-registry.js';
import { loadPreference, savePreference } from '../../js/state/preferences-storage.js';
import { withDBLock } from '../../js/state/indexeddb.js';
import { broadcastEvent } from '../../js/state/tab-sync.js';
import { logger } from '../../js/utils/logger.js';
import { restoreSessionFailureMarks } from '../../js/state/session-failure-marks.js';

const PREF_KEY = 'failedSessionIds';

function storedIds() {
    return harness.store.get(PREF_KEY);
}

function failInBackground(sessionId) {
    const task = requestTaskRegistry.create({
        sessionId,
        abortController: new AbortController()
    });
    requestTaskRegistry.detach(task);
    requestTaskRegistry.finish(task, 'error');
}

function waitForBroadcasts(count) {
    return vi.waitFor(() => expect(broadcastEvent).toHaveBeenCalledTimes(count));
}

describe('session-failure-marks', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        harness.store.clear();
        requestTaskRegistry.clearForTests();
        state.backgroundTasks.clear();
    });

    describe('标记变化', () => {
        it('新增标记只追加该会话并广播，广播在落库之后', async () => {
            harness.store.set(PREF_KEY, ['session-x']);

            failInBackground('session-a');
            await waitForBroadcasts(1);

            expect(storedIds()).toEqual(['session-x', 'session-a']);
            expect(broadcastEvent).toHaveBeenCalledWith('session-failure-changed', {
                sessionId: 'session-a',
                failed: true
            });
            expect(savePreference.mock.invocationCallOrder[0]).toBeLessThan(
                broadcastEvent.mock.invocationCallOrder[0]
            );
            expect(withDBLock).toHaveBeenCalledWith(
                'webchat-failed-session-marks',
                expect.any(Function)
            );
        });

        it('清除标记只移除该会话并广播', async () => {
            harness.store.set(PREF_KEY, ['session-a', 'session-b']);
            requestTaskRegistry.restoreFailures(['session-a', 'session-b']);

            requestTaskRegistry.clearFailure('session-a');
            await waitForBroadcasts(1);

            expect(storedIds()).toEqual(['session-b']);
            expect(broadcastEvent).toHaveBeenCalledWith('session-failure-changed', {
                sessionId: 'session-a',
                failed: false
            });
        });

        it('连续两次变更各自读出最新列表再改写，两条都保留', async () => {
            failInBackground('session-a');
            failInBackground('session-b');
            await waitForBroadcasts(2);

            expect(storedIds()).toEqual(['session-a', 'session-b']);
            expect(savePreference).toHaveBeenCalledTimes(2);
        });

        it('其他标签页已写入相同结果时不重复写', async () => {
            harness.store.set(PREF_KEY, ['session-a']);

            failInBackground('session-a');
            await waitForBroadcasts(1);

            expect(savePreference).not.toHaveBeenCalled();
            expect(storedIds()).toEqual(['session-a']);
        });

        it('持久化失败只告警，其他标签页照样收到广播', async () => {
            savePreference.mockRejectedValueOnce(new Error('quota'));

            failInBackground('session-a');
            await waitForBroadcasts(1);

            expect(logger.warn).toHaveBeenCalledWith(
                '[FailureMarks] 失败标记持久化失败:',
                expect.any(Error)
            );
            expect(requestTaskRegistry.hasFailure('session-a')).toBe(true);
        });

        it('格式不对的变化事件直接忽略', async () => {
            harness.eventBus.emit('session:failure-changed', { sessionId: 'session-a' });
            harness.eventBus.emit('session:failure-changed', { failed: true });
            harness.eventBus.emit('session:failure-changed', undefined);
            await Promise.resolve();

            expect(withDBLock).not.toHaveBeenCalled();
            expect(broadcastEvent).not.toHaveBeenCalled();
        });

        it('同步其他标签页的变化不回写也不再广播', async () => {
            requestTaskRegistry.syncFailure('session-a', true);
            requestTaskRegistry.syncFailure('session-a', false);
            await Promise.resolve();

            expect(withDBLock).not.toHaveBeenCalled();
            expect(broadcastEvent).not.toHaveBeenCalled();
        });
    });

    describe('restoreSessionFailureMarks', () => {
        it('恢复现存会话的标记，剔除已删除会话后写回', async () => {
            harness.store.set(PREF_KEY, ['session-a', 'gone', 'session-b']);

            await restoreSessionFailureMarks(['session-a', 'session-b', 'session-c']);

            expect(requestTaskRegistry.hasFailure('session-a')).toBe(true);
            expect(requestTaskRegistry.hasFailure('session-b')).toBe(true);
            expect(requestTaskRegistry.hasFailure('gone')).toBe(false);
            expect(storedIds()).toEqual(['session-a', 'session-b']);
            expect(broadcastEvent).not.toHaveBeenCalled();
        });

        it('剔除时按锁内最新列表过滤，不覆盖期间其他标签页新加的标记', async () => {
            harness.store.set(PREF_KEY, ['session-a', 'gone']);
            withDBLock.mockImplementationOnce((name, fn) => {
                harness.store.set(PREF_KEY, ['session-a', 'gone', 'session-c']);
                return harness.withDBLock(name, fn);
            });

            await restoreSessionFailureMarks(['session-a', 'session-c']);

            expect(storedIds()).toEqual(['session-a', 'session-c']);
            expect(requestTaskRegistry.hasFailure('session-c')).toBe(false);
        });

        it('没有需要剔除的记录时不写回', async () => {
            harness.store.set(PREF_KEY, ['session-a']);

            await restoreSessionFailureMarks(['session-a']);

            expect(requestTaskRegistry.hasFailure('session-a')).toBe(true);
            expect(savePreference).not.toHaveBeenCalled();
        });

        it('从未写过或存了脏数据时只保留合法的会话 ID', async () => {
            await restoreSessionFailureMarks(['session-a']);
            expect(requestTaskRegistry.hasFailure('session-a')).toBe(false);
            expect(savePreference).not.toHaveBeenCalled();

            harness.store.set(PREF_KEY, 'session-a');
            await restoreSessionFailureMarks(['session-a']);
            expect(requestTaskRegistry.hasFailure('session-a')).toBe(false);

            harness.store.set(PREF_KEY, [1, null, '', 'session-a']);
            await restoreSessionFailureMarks(['session-a']);
            expect(requestTaskRegistry.hasFailure('session-a')).toBe(true);
            expect(loadPreference).toHaveBeenCalledWith(PREF_KEY);
        });
    });
});
