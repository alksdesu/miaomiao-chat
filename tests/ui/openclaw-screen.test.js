/**
 * openclaw-screen.js 屏幕画面展示测试
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../js/core/events.js', () => ({
    eventBus: { emit: vi.fn(), on: vi.fn() }
}));

vi.mock('../../js/core/state.js', () => ({
    state: {
        currentAssistantMessage: null
    }
}));

vi.mock('../../js/ui/viewer.js', () => ({
    openImageViewer: vi.fn()
}));

import { eventBus } from '../../js/core/events.js';
import { initOpenClawScreen } from '../../js/ui/openclaw-screen.js';

describe('openclaw-screen', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        document.body.innerHTML = '';
    });

    afterEach(() => {
        document.body.innerHTML = '';
    });

    it('初始化注册事件', () => {
        initOpenClawScreen();
        const events = eventBus.on.mock.calls.map((c) => c[0]);
        expect(events).toContain('openclaw:screen-capture');
        expect(events).toContain('openclaw:chat-done');
    });
});
