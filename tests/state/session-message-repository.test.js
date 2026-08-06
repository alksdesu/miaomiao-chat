import { beforeEach, describe, expect, it, vi } from 'vitest';

const manifest = {
    sessionId: 's1',
    messageCount: 600,
    pageSize: 100,
    pageCount: 6,
    state: 'complete',
    summaries: Array.from({ length: 600 }, (_, index) => ({
        id: `m${index}`,
        role: index % 2 ? 'assistant' : 'user',
        index
    }))
};
const storedMessages = Array.from({ length: 600 }, (_, index) => ({
    id: `m${index}`,
    role: index % 2 ? 'assistant' : 'user',
    parts: [{ type: 'text', text: `message ${index}` }]
}));

vi.mock('../../js/state/message-page-repository.js', () => ({
    loadMessageManifest: vi.fn(async () => manifest),
    loadSessionMessageRange: vi.fn(async (_sessionId, start, end) => ({
        messages: storedMessages.slice(start, end),
        manifest,
        start,
        end
    })),
    loadAllPagedSessionMessages: vi.fn(async () => ({ messages: storedMessages, manifest }))
}));

vi.mock('../../js/core/state.js', () => ({
    state: {
        currentSessionId: 's1',
        messages: [],
        messageStore: { replaceAll: vi.fn(), toArray: vi.fn(() => []) }
    }
}));

vi.mock('../../js/core/events.js', () => ({
    eventBus: { emit: vi.fn(), on: vi.fn(), off: vi.fn() }
}));

import {
    getCurrentSessionMessagesSnapshot,
    hasLazyMessages,
    isLazyMessage,
    loadSessionMessageWindow,
    materializeCurrentSessionMessages,
    materializeSessionMessages
} from '../../js/state/session-message-repository.js';
import { state } from '../../js/core/state.js';

describe('session-message-repository', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        state.currentSessionId = 's1';
        state.messages = [];
        state.messageStore.toArray.mockImplementation(() => state.messages.slice());
    });

    it('长会话只加载尾部窗口，较早消息保留轻量引用', async () => {
        const result = await loadSessionMessageWindow('s1', { tailCount: 200 });

        expect(result.windowed).toBe(true);
        expect(result.messages).toHaveLength(600);
        expect(isLazyMessage(result.messages[0])).toBe(true);
        expect(result.messages[0]).toMatchObject({ id: 'm0', role: 'user', parts: [] });
        expect(isLazyMessage(result.messages[399])).toBe(true);
        expect(isLazyMessage(result.messages[400])).toBe(false);
    });

    it('materialize 保留已修改消息和本地新增尾部', async () => {
        const lazyMessages = manifest.summaries.map((summary, index) => ({
            id: summary.id,
            role: summary.role,
            parts: [],
            _lazy: { sessionId: 's1', index }
        }));
        lazyMessages[500] = { ...storedMessages[500], parts: [{ type: 'text', text: 'edited' }] };
        lazyMessages.push({ id: 'new', role: 'user', parts: [{ type: 'text', text: 'new' }] });

        expect(hasLazyMessages(lazyMessages)).toBe(true);
        const result = await materializeSessionMessages('s1', lazyMessages);

        expect(result).toHaveLength(601);
        expect(result[0]).toEqual(storedMessages[0]);
        expect(result[500].parts[0].text).toBe('edited');
        expect(result[600].id).toBe('new');
    });

    it('异步读取期间切换会话不会污染已锁定快照', async () => {
        state.messages = manifest.summaries.map((summary, index) => ({
            id: summary.id,
            role: summary.role,
            parts: [],
            _lazy: { sessionId: 's1', index }
        }));

        const snapshotPromise = getCurrentSessionMessagesSnapshot();
        state.currentSessionId = 's2';
        state.messages.splice(0, state.messages.length, {
            id: 'other-session',
            role: 'user',
            parts: [{ type: 'text', text: 'other' }]
        });

        const snapshot = await snapshotPromise;
        expect(snapshot).toHaveLength(600);
        expect(snapshot[0].id).toBe('m0');
        expect(snapshot.some((message) => message.id === 'other-session')).toBe(false);
    });

    it('实体化期间切换会话不会覆盖新会话状态', async () => {
        state.messages = manifest.summaries.map((summary, index) => ({
            id: summary.id,
            role: summary.role,
            parts: [],
            _lazy: { sessionId: 's1', index }
        }));

        const materializePromise = materializeCurrentSessionMessages();
        state.currentSessionId = 's2';
        state.messages.splice(0, state.messages.length, {
            id: 'other-session',
            role: 'user',
            parts: [{ type: 'text', text: 'other' }]
        });

        await materializePromise;
        expect(state.messageStore.replaceAll).not.toHaveBeenCalled();
        expect(state.messages).toHaveLength(1);
        expect(state.messages[0].id).toBe('other-session');
    });
});
