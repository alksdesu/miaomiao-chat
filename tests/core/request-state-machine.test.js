/**
 * request-state-machine.js 请求状态机测试
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// mock DOM —— request-state-machine 在 _onCancelled 等钩子调 querySelector / querySelectorAll
globalThis.document = {
    querySelectorAll: () => [],
    querySelector: () => null
};

vi.mock('../../js/core/events.js', () => ({
    eventBus: { emit: vi.fn(), on: vi.fn() }
}));

vi.mock('../../js/core/elements.js', () => ({
    elements: {
        sendButton: { disabled: false, style: { display: 'inline-flex' } },
        cancelRequestButton: { style: { display: 'none' } }
    }
}));

vi.mock('../../js/core/state.js', () => ({
    state: {
        isLoading: false,
        isSending: false,
        currentAssistantMessage: null,
        currentSessionId: null
    }
}));

vi.mock('../../js/utils/logger.js', () => ({
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

import { RequestStateMachine, RequestState } from '../../js/core/request-state-machine.js';
import { state } from '../../js/core/state.js';

let sm;

beforeEach(() => {
    sm = new RequestStateMachine();
    vi.clearAllMocks();
    vi.useFakeTimers();
});

// ========== 初始状态 ==========

describe('初始状态', () => {
    it('初始为 IDLE', () => {
        expect(sm.getState()).toBe(RequestState.IDLE);
    });

    it('初始不忙', () => {
        expect(sm.isBusy()).toBe(false);
    });

    it('状态历史为空', () => {
        expect(sm.getStateHistory()).toHaveLength(0);
    });
});

// ========== canTransition ==========

describe('canTransition', () => {
    it('IDLE -> SENDING 合法', () => {
        expect(sm.canTransition(RequestState.SENDING)).toBe(true);
    });

    it('IDLE -> STREAMING 非法', () => {
        expect(sm.canTransition(RequestState.STREAMING)).toBe(false);
    });

    it('SENDING -> STREAMING 合法', () => {
        sm.transition(RequestState.SENDING, {
            abortController: new AbortController(),
            sessionId: 's1'
        });
        expect(sm.canTransition(RequestState.STREAMING)).toBe(true);
    });

    it('SENDING -> ERROR 合法', () => {
        sm.transition(RequestState.SENDING, {
            abortController: new AbortController(),
            sessionId: 's1'
        });
        expect(sm.canTransition(RequestState.ERROR)).toBe(true);
    });

    it('STREAMING -> TOOL_CALLING 合法', () => {
        sm.transition(RequestState.SENDING, {
            abortController: new AbortController(),
            sessionId: 's1'
        });
        sm.transition(RequestState.STREAMING, {});
        expect(sm.canTransition(RequestState.TOOL_CALLING)).toBe(true);
    });

    it('STREAMING -> COMPLETED 合法', () => {
        sm.transition(RequestState.SENDING, {
            abortController: new AbortController(),
            sessionId: 's1'
        });
        sm.transition(RequestState.STREAMING, {});
        expect(sm.canTransition(RequestState.COMPLETED)).toBe(true);
    });
});

// ========== transition ==========

describe('transition', () => {
    it('合法转换返回 true', () => {
        expect(
            sm.transition(RequestState.SENDING, {
                abortController: new AbortController(),
                sessionId: 's1'
            })
        ).toBe(true);
        expect(sm.getState()).toBe(RequestState.SENDING);
    });

    it('非法转换返回 false', () => {
        expect(sm.transition(RequestState.STREAMING, {})).toBe(false);
        expect(sm.getState()).toBe(RequestState.IDLE);
    });

    it('转换后记录历史', () => {
        sm.transition(RequestState.SENDING, {
            abortController: new AbortController(),
            sessionId: 's1'
        });
        const history = sm.getStateHistory();
        expect(history).toHaveLength(1);
        expect(history[0].from).toBe(RequestState.IDLE);
        expect(history[0].to).toBe(RequestState.SENDING);
    });

    it('历史超过 maxHistorySize 时截断', () => {
        sm.maxHistorySize = 3;
        sm.transition(RequestState.SENDING, {
            abortController: new AbortController(),
            sessionId: 's1'
        });
        sm.transition(RequestState.STREAMING, {});
        sm.transition(RequestState.COMPLETED, {});
        vi.advanceTimersByTime(200);
        sm.transition(RequestState.SENDING, {
            abortController: new AbortController(),
            sessionId: 's1'
        });
        expect(sm.getStateHistory().length).toBeLessThanOrEqual(4);
    });

    it('SENDING 设置 isLoading / isSending 为 true', () => {
        sm.transition(RequestState.SENDING, {
            abortController: new AbortController(),
            sessionId: 's1'
        });
        expect(state.isLoading).toBe(true);
        expect(state.isSending).toBe(true);
    });

    it('COMPLETED 后自动回 IDLE', () => {
        sm.transition(RequestState.SENDING, {
            abortController: new AbortController(),
            sessionId: 's1'
        });
        sm.transition(RequestState.STREAMING, {});
        sm.transition(RequestState.COMPLETED, {});
        vi.advanceTimersByTime(200);
        expect(sm.getState()).toBe(RequestState.IDLE);
    });

    it('ERROR 后自动回 IDLE', () => {
        sm.transition(RequestState.SENDING, {
            abortController: new AbortController(),
            sessionId: 's1'
        });
        sm.transition(RequestState.ERROR, { error: 'test error' });
        vi.advanceTimersByTime(200);
        expect(sm.getState()).toBe(RequestState.IDLE);
    });

    it('CANCELLED 后自动回 IDLE', () => {
        sm.transition(RequestState.SENDING, {
            abortController: new AbortController(),
            sessionId: 's1'
        });
        sm.transition(RequestState.CANCELLED, {});
        vi.advanceTimersByTime(200);
        expect(sm.getState()).toBe(RequestState.IDLE);
    });
});

// ========== isBusy ==========

describe('isBusy', () => {
    it('SENDING 时为忙', () => {
        sm.transition(RequestState.SENDING, {
            abortController: new AbortController(),
            sessionId: 's1'
        });
        expect(sm.isBusy()).toBe(true);
    });

    it('STREAMING 时为忙', () => {
        sm.transition(RequestState.SENDING, {
            abortController: new AbortController(),
            sessionId: 's1'
        });
        sm.transition(RequestState.STREAMING, {});
        expect(sm.isBusy()).toBe(true);
    });

    it('完成并回 IDLE 后不忙', () => {
        sm.transition(RequestState.SENDING, {
            abortController: new AbortController(),
            sessionId: 's1'
        });
        sm.transition(RequestState.STREAMING, {});
        sm.transition(RequestState.COMPLETED, {});
        vi.advanceTimersByTime(200);
        expect(sm.isBusy()).toBe(false);
    });
});

// ========== cancel ==========

describe('cancel', () => {
    it('IDLE 状态取消返回 false', () => {
        expect(sm.cancel()).toBe(false);
    });

    it('SENDING 状态取消返回 true', () => {
        const ac = new AbortController();
        sm.transition(RequestState.SENDING, { abortController: ac, sessionId: 's1' });
        expect(sm.cancel()).toBe(true);
        expect(ac.signal.aborted).toBe(true);
    });

    it('STREAMING 状态取消', () => {
        const ac = new AbortController();
        sm.transition(RequestState.SENDING, { abortController: ac, sessionId: 's1' });
        sm.transition(RequestState.STREAMING, {});
        expect(sm.cancel()).toBe(true);
    });
});

// ========== forceReset ==========

describe('forceReset', () => {
    it('强制重置到 IDLE', () => {
        sm.transition(RequestState.SENDING, {
            abortController: new AbortController(),
            sessionId: 's1'
        });
        sm.forceReset({ silent: true });
        expect(sm.getState()).toBe(RequestState.IDLE);
    });

    it('强制重置时 abort 请求', () => {
        const ac = new AbortController();
        sm.transition(RequestState.SENDING, { abortController: ac, sessionId: 's1' });
        sm.forceReset({ silent: true });
        expect(ac.signal.aborted).toBe(true);
    });

    it('skipAbort 不取消请求', () => {
        const ac = new AbortController();
        sm.transition(RequestState.SENDING, { abortController: ac, sessionId: 's1' });
        sm.forceReset({ skipAbort: true, silent: true });
        expect(ac.signal.aborted).toBe(false);
    });

    it('记录到历史', () => {
        sm.transition(RequestState.SENDING, {
            abortController: new AbortController(),
            sessionId: 's1'
        });
        sm.forceReset({ silent: true });
        const history = sm.getStateHistory();
        expect(history[history.length - 1].to).toBe(RequestState.IDLE);
    });
});

// ========== clearSendLockTimeout ==========

describe('clearSendLockTimeout', () => {
    it('清除定时器', () => {
        sm.transition(RequestState.SENDING, {
            abortController: new AbortController(),
            sessionId: 's1'
        });
        expect(sm.sendLockTimeout).not.toBeNull();
        sm.clearSendLockTimeout();
        expect(sm.sendLockTimeout).toBeNull();
    });

    it('无定时器时不报错', () => {
        expect(() => sm.clearSendLockTimeout()).not.toThrow();
    });
});

// ========== 完整流程 ==========

describe('完整请求流程', () => {
    it('正常流程: IDLE -> SENDING -> STREAMING -> COMPLETED -> IDLE', () => {
        const ac = new AbortController();
        expect(sm.transition(RequestState.SENDING, { abortController: ac, sessionId: 's1' })).toBe(
            true
        );
        expect(sm.transition(RequestState.STREAMING, {})).toBe(true);
        expect(sm.transition(RequestState.COMPLETED, {})).toBe(true);
        vi.advanceTimersByTime(200);
        expect(sm.getState()).toBe(RequestState.IDLE);
    });

    it('工具调用流程: IDLE -> SENDING -> STREAMING -> TOOL_CALLING -> CONTINUATION -> STREAMING -> COMPLETED', () => {
        sm.transition(RequestState.SENDING, {
            abortController: new AbortController(),
            sessionId: 's1'
        });
        sm.transition(RequestState.STREAMING, {});
        sm.transition(RequestState.TOOL_CALLING, {});
        sm.transition(RequestState.CONTINUATION, {});
        sm.transition(RequestState.STREAMING, {});
        sm.transition(RequestState.COMPLETED, {});
        vi.advanceTimersByTime(200);
        expect(sm.getState()).toBe(RequestState.IDLE);
    });

    it('错误流程: IDLE -> SENDING -> ERROR -> IDLE', () => {
        sm.transition(RequestState.SENDING, {
            abortController: new AbortController(),
            sessionId: 's1'
        });
        sm.transition(RequestState.ERROR, { error: 'timeout' });
        vi.advanceTimersByTime(200);
        expect(sm.getState()).toBe(RequestState.IDLE);
    });
});
