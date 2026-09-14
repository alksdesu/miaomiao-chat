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
        currentSessionId: 'session-1'
    };
    vi.doMock('../../js/core/state.js', () => ({ state: mockedState }));

    vi.doMock('../../js/core/events.js', () => ({
        eventBus: { emit: vi.fn(), on: vi.fn(), off: vi.fn() }
    }));

    tabSyncModule = await import('../../js/state/tab-sync.js');
});

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
