/**
 * state/tab-sync.js 跨标签页同步测试
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../js/core/state.js', () => ({
    state: {
        sessions: [],
        currentSessionId: 'session-1'
    }
}));

vi.mock('../../js/core/events.js', () => ({
    eventBus: { emit: vi.fn(), on: vi.fn(), off: vi.fn() }
}));

// 模拟 BroadcastChannel
class MockBroadcastChannel {
    constructor(name) {
        this.name = name;
        this.onmessage = null;
        MockBroadcastChannel.instances.push(this);
    }
    postMessage(msg) {
        MockBroadcastChannel.lastMessage = msg;
    }
    close() {
        MockBroadcastChannel.closed = true;
    }
    static instances = [];
    static lastMessage = null;
    static closed = false;
    static reset() {
        MockBroadcastChannel.instances = [];
        MockBroadcastChannel.lastMessage = null;
        MockBroadcastChannel.closed = false;
    }
}

let tabSyncModule;
let mockedState;
let sessionsMock;
let mockedEventBus;

beforeEach(async () => {
    vi.clearAllMocks();
    MockBroadcastChannel.reset();
    globalThis.BroadcastChannel = MockBroadcastChannel;

    // 每次动态导入以重置模块状态
    vi.resetModules();

    // 重新 mock
    mockedState = {
        sessions: [
            { id: 'session-1', updatedAt: 1000 },
            { id: 'session-2', updatedAt: 2000 }
        ],
        currentSessionId: 'session-1',
        _lastKnownSessionUpdatedAt: new Map([['session-1', 1000]])
    };
    vi.doMock('../../js/core/state.js', () => ({ state: mockedState }));

    mockedEventBus = { emit: vi.fn(), on: vi.fn(), off: vi.fn() };
    vi.doMock('../../js/core/events.js', () => ({ eventBus: mockedEventBus }));

    sessionsMock = {
        addDeletedSessionId: vi.fn(),
        cancelPendingSave: vi.fn(),
        removeSessionMeta: vi.fn(() => true),
        stopSessionTask: vi.fn(),
        addSessionMetaIfAbsent: vi.fn(() => true),
        updateSessionMeta: vi.fn(() => true),
        applyRemoteSessionUpdate: vi.fn(async () => true)
    };
    vi.doMock('../../js/state/sessions.js', () => sessionsMock);

    tabSyncModule = await import('../../js/state/tab-sync.js');
});

function deliver(message) {
    return MockBroadcastChannel.instances[0].onmessage({ data: message });
}

afterEach(() => {
    delete globalThis.BroadcastChannel;
});

describe('initTabSync', () => {
    it('创建 BroadcastChannel', () => {
        tabSyncModule.initTabSync();
        expect(MockBroadcastChannel.instances.length).toBeGreaterThanOrEqual(1);
    });

    it('BroadcastChannel 不可用时不崩溃', async () => {
        delete globalThis.BroadcastChannel;
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        expect(() => tabSyncModule.initTabSync()).not.toThrow();
        consoleSpy.mockRestore();
    });
});

describe('broadcastEvent', () => {
    it('初始化后可广播事件', () => {
        tabSyncModule.initTabSync();
        tabSyncModule.broadcastEvent('session-deleted', { sessionId: 'test' });
        expect(MockBroadcastChannel.lastMessage).toEqual(
            expect.objectContaining({
                type: 'session-deleted',
                data: { sessionId: 'test' }
            })
        );
    });

    it('未初始化时不崩溃', () => {
        // 不调用 initTabSync
        expect(() => tabSyncModule.broadcastEvent('test', {})).not.toThrow();
    });
});

describe('destroyTabSync', () => {
    it('关闭通道', () => {
        tabSyncModule.initTabSync();
        tabSyncModule.destroyTabSync();
        expect(MockBroadcastChannel.closed).toBe(true);
    });

    it('未初始化时不崩溃', () => {
        expect(() => tabSyncModule.destroyTabSync()).not.toThrow();
    });
});

describe('session-pinned', () => {
    it('同步远端会话置顶状态', async () => {
        tabSyncModule.initTabSync();
        await MockBroadcastChannel.instances[0].onmessage({
            data: {
                type: 'session-pinned',
                data: { sessionId: 'session-1', pinned: true },
                tabId: 'remote-tab'
            }
        });

        expect(mockedState.sessions[0].pinned).toBe(true);
    });

    it('忽略不存在的会话', async () => {
        tabSyncModule.initTabSync();
        await MockBroadcastChannel.instances[0].onmessage({
            data: {
                type: 'session-pinned',
                data: { sessionId: 'missing', pinned: true },
                tabId: 'remote-tab'
            }
        });

        expect(mockedState.sessions.every((session) => !session.pinned)).toBe(true);
    });
});

describe('标签页 ID', () => {
    it('按页面实例生成，不复用 sessionStorage 里的旧值', async () => {
        sessionStorage.setItem('_tabId', 'copied-from-duplicated-tab');
        const firstId = tabSyncModule.getTabId();
        vi.resetModules();
        const reloaded = await import('../../js/state/tab-sync.js');

        expect(firstId).not.toBe('copied-from-duplicated-tab');
        expect(reloaded.getTabId()).not.toBe(firstId);
        sessionStorage.removeItem('_tabId');
    });
});

describe('初始化之前', () => {
    it('广播会建立通道，恢复快照后的保存通知能发给其他标签页', () => {
        tabSyncModule.broadcastEvent('session-updated', { sessionId: 'session-1' });

        expect(MockBroadcastChannel.instances).toHaveLength(1);
        expect(MockBroadcastChannel.lastMessage).toMatchObject({
            type: 'session-updated',
            tabId: tabSyncModule.getTabId()
        });
    });

    it('会话同步消息要等 initTabSync 之后才处理', async () => {
        tabSyncModule.broadcastEvent('noop', {});
        await deliver({
            type: 'session-pinned',
            data: { sessionId: 'session-1', pinned: true },
            tabId: 'remote-tab'
        });
        expect(mockedState.sessions[0].pinned).toBeUndefined();

        tabSyncModule.initTabSync();
        expect(MockBroadcastChannel.instances).toHaveLength(1);
        await deliver({
            type: 'session-pinned',
            data: { sessionId: 'session-1', pinned: true },
            tabId: 'remote-tab'
        });
        expect(mockedState.sessions[0].pinned).toBe(true);
    });
});

describe('标签页存活探测', () => {
    it('收到点名自己的 ping 时回 pong', async () => {
        tabSyncModule.broadcastEvent('noop', {});
        await deliver({
            type: 'tab-ping',
            data: { nonce: 'n1', tabIds: [tabSyncModule.getTabId()] },
            tabId: 'remote-tab'
        });

        expect(MockBroadcastChannel.lastMessage).toEqual({
            type: 'tab-pong',
            data: { nonce: 'n1' },
            tabId: tabSyncModule.getTabId()
        });
    });

    it('没点名自己的 ping 不回应', async () => {
        tabSyncModule.broadcastEvent('noop', {});
        await deliver({
            type: 'tab-ping',
            data: { nonce: 'n1', tabIds: ['someone-else'] },
            tabId: 'remote-tab'
        });

        expect(MockBroadcastChannel.lastMessage.type).toBe('noop');
    });

    it('目标全部回 pong 时立即返回存活集合', async () => {
        const probe = tabSyncModule.probeTabs(['tab-a', 'tab-b']);
        const ping = MockBroadcastChannel.lastMessage;
        expect(ping.type).toBe('tab-ping');

        await deliver({ type: 'tab-pong', data: { nonce: ping.data.nonce }, tabId: 'tab-a' });
        await deliver({ type: 'tab-pong', data: { nonce: ping.data.nonce }, tabId: 'tab-b' });

        await expect(probe).resolves.toEqual(new Set(['tab-a', 'tab-b']));
    });

    it('超时未回应的标签页视为已退出', async () => {
        vi.useFakeTimers();
        try {
            const probe = tabSyncModule.probeTabs(['tab-a', 'tab-dead'], { timeoutMs: 500 });
            const ping = MockBroadcastChannel.lastMessage;
            await deliver({ type: 'tab-pong', data: { nonce: ping.data.nonce }, tabId: 'tab-a' });
            await deliver({ type: 'tab-pong', data: { nonce: 'stale' }, tabId: 'tab-dead' });

            vi.advanceTimersByTime(500);
            await expect(probe).resolves.toEqual(new Set(['tab-a']));
        } finally {
            vi.useRealTimers();
        }
    });

    it('BroadcastChannel 不可用时返回 null，由调用方按心跳判断', async () => {
        delete globalThis.BroadcastChannel;
        await expect(tabSyncModule.probeTabs(['tab-a'])).resolves.toBeNull();
    });
});

describe('session-updated', () => {
    it('交给 sessions.js 判断是否重载与推进基线，不在这里直接改基线', async () => {
        tabSyncModule.initTabSync();
        await deliver({
            type: 'session-updated',
            data: { sessionId: 'session-1', updatedAt: 5000, messageCount: 3 },
            tabId: 'remote-tab'
        });

        expect(sessionsMock.updateSessionMeta).toHaveBeenCalledWith('session-1', {
            updatedAt: 5000,
            messageCount: 3
        });
        expect(sessionsMock.applyRemoteSessionUpdate).toHaveBeenCalledWith('session-1', 5000);
        expect(mockedState._lastKnownSessionUpdatedAt.get('session-1')).toBe(1000);
        expect(mockedEventBus.emit).toHaveBeenCalledWith('sessions:updated', expect.any(Object));
    });
});

describe('session-deleted', () => {
    it('中止本页该会话仍在运行的任务', async () => {
        tabSyncModule.initTabSync();
        await deliver({
            type: 'session-deleted',
            data: { sessionId: 'session-2' },
            tabId: 'remote-tab'
        });

        expect(sessionsMock.addDeletedSessionId).toHaveBeenCalledWith('session-2');
        expect(sessionsMock.stopSessionTask).toHaveBeenCalledWith(
            'session-2',
            'remote-session-deleted'
        );
    });
});
