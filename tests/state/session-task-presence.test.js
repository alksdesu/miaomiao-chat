import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    emit: vi.fn()
}));

vi.mock('../../js/core/events.js', () => ({
    eventBus: { emit: mocks.emit, on: vi.fn() }
}));
vi.mock('../../js/state/tab-sync.js', () => ({
    getTabId: () => 'tab-self'
}));
vi.mock('../../js/utils/logger.js', () => ({
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

import { EVENTS } from '../../js/core/events-registry.js';
import {
    getSessionTaskLockName,
    holdSessionTaskLock,
    isHoldingSessionTaskLock,
    isSessionTaskActiveElsewhere,
    queryActiveLockNames,
    refreshSessionTaskActivity,
    resetSessionTaskPresenceForTests
} from '../../js/state/session-task-presence.js';

/**
 * 按 Web Locks 规范的授予规则实现的最小 LockManager：exclusive 独占、shared 共享、同名请求先到先得
 */
function createFakeLockManager() {
    const held = [];
    const queue = [];

    function isGrantable(request) {
        const holders = held.filter((lock) => lock.name === request.name);
        const sameName = queue.filter((item) => item.name === request.name);
        const earlier = sameName.slice(0, sameName.indexOf(request));
        if (request.mode === 'exclusive') return holders.length === 0 && earlier.length === 0;
        return (
            !holders.some((lock) => lock.mode === 'exclusive') &&
            earlier.every((item) => item.mode === 'shared')
        );
    }

    function release(lock) {
        held.splice(held.indexOf(lock), 1);
        processQueue();
    }

    function grant(request) {
        queue.splice(queue.indexOf(request), 1);
        const lock = { name: request.name, mode: request.mode };
        held.push(lock);
        Promise.resolve()
            .then(() => request.callback({ name: request.name, mode: request.mode }))
            .then(
                (value) => {
                    release(lock);
                    request.resolve(value);
                },
                (error) => {
                    release(lock);
                    request.reject(error);
                }
            );
    }

    function processQueue() {
        let progressed = true;
        while (progressed) {
            progressed = false;
            for (const request of [...queue]) {
                if (queue.includes(request) && isGrantable(request)) {
                    grant(request);
                    progressed = true;
                }
            }
        }
    }

    return {
        request(name, optionsOrCallback, maybeCallback) {
            const options = typeof optionsOrCallback === 'function' ? {} : optionsOrCallback;
            const callback =
                typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
            return new Promise((resolve, reject) => {
                queue.push({
                    name,
                    mode: options?.mode || 'exclusive',
                    callback,
                    resolve,
                    reject
                });
                processQueue();
            });
        },
        query: vi.fn(async () => ({
            held: held.map(({ name, mode }) => ({ name, mode })),
            pending: queue.map(({ name, mode }) => ({ name, mode }))
        })),
        held,
        queue
    };
}

/**
 * 以其他标签页的身份持有会话任务锁，返回释放函数
 */
function holdAsOtherTab(locks, sessionId, tabId = 'tab-other') {
    let release;
    const releaseSignal = new Promise((resolve) => {
        release = resolve;
    });
    locks.request(getSessionTaskLockName(sessionId, tabId), () => releaseSignal);
    return release;
}

async function settle() {
    for (let i = 0; i < 20; i++) await Promise.resolve();
}

function setNavigatorLocks(value) {
    Object.defineProperty(navigator, 'locks', { get: () => value, configurable: true });
}

let locks;

beforeEach(() => {
    vi.clearAllMocks();
    resetSessionTaskPresenceForTests();
    locks = createFakeLockManager();
    setNavigatorLocks(locks);
});

afterEach(() => {
    setNavigatorLocks(undefined);
});

describe('本页持有会话任务锁', () => {
    it('锁名带上会话与本页标签页，任务结束后释放', async () => {
        let finishTask;
        const untilTaskEnds = new Promise((resolve) => {
            finishTask = resolve;
        });

        expect(holdSessionTaskLock('session-a', untilTaskEnds)).toBe(true);
        expect(isHoldingSessionTaskLock('session-a')).toBe(true);
        await settle();
        expect(locks.held).toEqual([
            { name: 'webchat-session-task:session-a:tab-self', mode: 'exclusive' }
        ]);

        finishTask();
        await settle();
        expect(locks.held).toEqual([]);
        expect(isHoldingSessionTaskLock('session-a')).toBe(false);
    });

    it('等待的任务失败也照常释放', async () => {
        holdSessionTaskLock('session-a', Promise.reject(new Error('boom')));
        await settle();

        expect(locks.held).toEqual([]);
        expect(isHoldingSessionTaskLock('session-a')).toBe(false);
    });

    it('Web Locks 不可用时不持锁', () => {
        setNavigatorLocks(undefined);

        expect(holdSessionTaskLock('session-a', new Promise(() => {}))).toBe(false);
        expect(isHoldingSessionTaskLock('session-a')).toBe(false);
    });
});

describe('查询会话是否在其他标签页执行', () => {
    it('只认持锁方的 exclusive 条目，等待释放的 shared 条目不算', async () => {
        holdAsOtherTab(locks, 'session-a');
        locks.request(
            getSessionTaskLockName('session-a', 'tab-other'),
            { mode: 'shared' },
            () => {}
        );
        await settle();

        const names = await queryActiveLockNames();

        expect([...names]).toEqual(['webchat-session-task:session-a:tab-other']);
    });

    it('查询失败或 Web Locks 不可用时返回 null', async () => {
        locks.query.mockRejectedValueOnce(new Error('denied'));
        expect(await queryActiveLockNames()).toBeNull();

        setNavigatorLocks(undefined);
        expect(await queryActiveLockNames()).toBeNull();
    });

    it('本页自己的锁不算其他标签页执行中', async () => {
        holdSessionTaskLock('session-a', new Promise(() => {}));
        await settle();

        expect(await refreshSessionTaskActivity('session-a')).toBe(false);
        expect(isSessionTaskActiveElsewhere('session-a')).toBe(false);
    });

    it('同名前缀的其他会话不算', async () => {
        holdAsOtherTab(locks, 'session-a-2');
        await settle();

        expect(await refreshSessionTaskActivity('session-a')).toBe(false);
    });

    it('查询失败时按未在执行处理', async () => {
        holdAsOtherTab(locks, 'session-a');
        await settle();
        locks.query.mockRejectedValueOnce(new Error('denied'));

        expect(await refreshSessionTaskActivity('session-a')).toBe(false);
        expect(isSessionTaskActiveElsewhere('session-a')).toBe(false);
    });
});

describe('等待其他标签页释放', () => {
    it('对方结束（或关闭、崩溃）后通知本页并清掉缓存', async () => {
        const releaseOther = holdAsOtherTab(locks, 'session-a');
        await settle();

        expect(await refreshSessionTaskActivity('session-a')).toBe(true);
        expect(isSessionTaskActiveElsewhere('session-a')).toBe(true);
        await settle();
        expect(locks.queue).toEqual([
            expect.objectContaining({
                name: 'webchat-session-task:session-a:tab-other',
                mode: 'shared'
            })
        ]);
        expect(mocks.emit).not.toHaveBeenCalled();

        releaseOther();
        await settle();

        expect(mocks.emit).toHaveBeenCalledWith(EVENTS.SESSION_REMOTE_TASK_ENDED, {
            sessionId: 'session-a'
        });
        expect(isSessionTaskActiveElsewhere('session-a')).toBe(false);
        expect(locks.held).toEqual([]);
    });

    it('重复查询不重复排队', async () => {
        holdAsOtherTab(locks, 'session-a');
        await settle();

        await refreshSessionTaskActivity('session-a');
        await refreshSessionTaskActivity('session-a');
        await settle();

        expect(locks.queue.filter((item) => item.mode === 'shared')).toHaveLength(1);
    });

    it('对方释放后立刻为新任务重新持锁时不误报结束，继续等待', async () => {
        const releaseFirst = holdAsOtherTab(locks, 'session-a');
        await settle();
        await refreshSessionTaskActivity('session-a');
        await settle();

        let releaseSecond;
        const secondTask = new Promise((resolve) => {
            releaseSecond = resolve;
        });
        releaseFirst();
        locks.request(getSessionTaskLockName('session-a', 'tab-other'), () => secondTask);
        await settle();

        expect(mocks.emit).not.toHaveBeenCalled();
        expect(isSessionTaskActiveElsewhere('session-a')).toBe(true);

        releaseSecond();
        await settle();

        expect(mocks.emit).toHaveBeenCalledTimes(1);
        expect(isSessionTaskActiveElsewhere('session-a')).toBe(false);
    });

    it('多个观察方排队互不当作仍在执行', async () => {
        const releaseOther = holdAsOtherTab(locks, 'session-a');
        // 第三个标签页也在等待同一把锁
        locks.request(
            getSessionTaskLockName('session-a', 'tab-other'),
            { mode: 'shared' },
            () => new Promise((resolve) => setTimeout(resolve, 0))
        );
        await settle();
        await refreshSessionTaskActivity('session-a');
        await settle();

        releaseOther();
        await settle();

        expect(mocks.emit).toHaveBeenCalledWith(EVENTS.SESSION_REMOTE_TASK_ENDED, {
            sessionId: 'session-a'
        });
    });
});
