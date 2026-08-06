import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    updateMessageAt: vi.fn(),
    state: {
        messages: [],
        currentReplies: [],
        selectedReplyIndex: 0,
        messageStore: { findIndexById: vi.fn(() => -1) }
    }
}));

vi.mock('../../js/core/state.js', () => ({ state: mocks.state, elements: {} }));
vi.mock('../../js/core/state-mutations.js', () => ({ updateMessageAt: mocks.updateMessageAt }));
vi.mock('../../js/core/events.js', () => ({ eventBus: { on: vi.fn(), emit: vi.fn() } }));
vi.mock('../../js/state/sessions.js', () => ({ debouncedSaveSession: vi.fn() }));
vi.mock('../../js/messages/renderer.js', () => ({ renderReplyWithSelector: vi.fn() }));
vi.mock('../../js/messages/message-ui-state.js', () => ({ updateMessageUiState: vi.fn() }));
vi.mock('../../js/state/media-blob-store.js', () => ({
    hasStoredMedia: vi.fn(() => false),
    resolveMessagesMediaForApi: vi.fn()
}));
vi.mock('../../js/utils/logger.js', () => ({
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

import { applyReplyToMessage } from '../../js/messages/reply-selector.js';
import { PartType } from '../../js/messages/schema.js';

describe('reply selector canonical state', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.state.messages = [
            {
                parts: [
                    { type: PartType.TEXT, text: 'old' },
                    { type: PartType.FILE, name: 'shared.txt', mime: 'text/plain' },
                    { type: PartType.TOOL_CALL, id: 'call-1', name: 'lookup' }
                ],
                replies: { all: [{}, {}], selected: 0 }
            }
        ];
    });

    it('切换回复时替换内容并保留结构 part 和 canonical 状态', () => {
        const error = { type: 'api', message: 'failed' };
        const meta = { model: 'model-b' };

        applyReplyToMessage(0, { parts: [{ type: PartType.TEXT, text: 'new' }], meta, error }, 1);

        const updates = mocks.updateMessageAt.mock.calls[0][1];
        expect(updates.parts).toEqual([
            { type: PartType.TEXT, text: 'new' },
            { type: PartType.FILE, name: 'shared.txt', mime: 'text/plain' },
            { type: PartType.TOOL_CALL, id: 'call-1', name: 'lookup' }
        ]);
        expect(updates).toMatchObject({ meta, error, replies: { selected: 1 } });
        expect(updates.parts).not.toBe(mocks.state.messages[0].parts);
    });
});
