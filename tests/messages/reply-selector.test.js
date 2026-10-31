// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    updateMessageAt: vi.fn(),
    state: {
        currentSessionId: 'session-a',
        messages: [],
        currentReplies: [],
        selectedReplyIndex: 0,
        currentAssistantMessage: null,
        messageStore: { findIndexById: vi.fn(() => -1) }
    },
    elements: { messagesArea: null },
    hasStoredMedia: vi.fn(() => false),
    resolveMessagesMediaForApi: vi.fn(),
    renderReplyWithSelector: vi.fn(),
    updateMessageUiState: vi.fn(),
    debouncedSaveSession: vi.fn()
}));

vi.mock('../../js/core/state.js', () => ({ state: mocks.state, elements: mocks.elements }));
vi.mock('../../js/core/state-mutations.js', () => ({ updateMessageAt: mocks.updateMessageAt }));
vi.mock('../../js/core/events.js', () => ({ eventBus: { on: vi.fn(), emit: vi.fn() } }));
vi.mock('../../js/state/sessions.js', () => ({
    debouncedSaveSession: mocks.debouncedSaveSession
}));
vi.mock('../../js/messages/renderer.js', () => ({
    renderReplyWithSelector: mocks.renderReplyWithSelector
}));
vi.mock('../../js/messages/message-ui-state.js', () => ({
    updateMessageUiState: mocks.updateMessageUiState
}));
vi.mock('../../js/state/media-blob-store.js', () => ({
    hasStoredMedia: mocks.hasStoredMedia,
    resolveMessagesMediaForApi: mocks.resolveMessagesMediaForApi
}));
vi.mock('../../js/utils/logger.js', () => ({
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

import { applyReplyToMessage, selectReply } from '../../js/messages/reply-selector.js';
import { PartType, ToolState } from '../../js/messages/schema.js';
import { REPLY_TOOL_SKIPPED_MESSAGE } from '../../js/utils/constants.js';

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

    it('切换回复时替换内容，保留文件 part 并写回 canonical 状态', () => {
        const error = { type: 'api', message: 'failed' };
        const meta = { model: 'model-b' };

        applyReplyToMessage(0, { parts: [{ type: PartType.TEXT, text: 'new' }], meta, error }, 1);

        const updates = mocks.updateMessageAt.mock.calls[0][1];
        expect(updates.parts).toEqual([
            { type: PartType.TEXT, text: 'new' },
            { type: PartType.FILE, name: 'shared.txt', mime: 'text/plain' }
        ]);
        expect(updates).toMatchObject({ meta, error, replies: { selected: 1 } });
        expect(updates.parts).not.toBe(mocks.state.messages[0].parts);
    });

    it('工具调用随回复走：不沿用上一个回复的调用，新回复未执行的调用按已跳过处理', () => {
        const reply = {
            parts: [
                { type: PartType.TEXT, text: 'reply-b' },
                {
                    type: PartType.TOOL_CALL,
                    id: 'call-b',
                    name: 'search',
                    state: ToolState.PENDING
                },
                {
                    type: PartType.TOOL_CALL,
                    id: 'srv-b',
                    name: 'web_search',
                    server: true,
                    state: ToolState.DONE,
                    result: { content: 'hits' }
                }
            ]
        };

        applyReplyToMessage(0, reply, 1);

        const toolParts = mocks.updateMessageAt.mock.calls[0][1].parts.filter(
            (part) => part.type === PartType.TOOL_CALL
        );
        expect(toolParts.map((part) => part.id)).toEqual(['call-b', 'srv-b']);
        expect(toolParts[0]).toMatchObject({
            state: ToolState.SKIPPED,
            result: { content: REPLY_TOOL_SKIPPED_MESSAGE, skipped: true }
        });
        expect(toolParts[1]).toMatchObject({ state: ToolState.DONE, result: { content: 'hits' } });
        expect(reply.parts[1].state).toBe(ToolState.PENDING);
    });
});

describe('selectReply 异步加载后的会话校验', () => {
    let messageEl;
    let resolveMedia;

    beforeEach(() => {
        vi.clearAllMocks();
        document.body.replaceChildren();
        mocks.elements.messagesArea = document.createElement('div');
        document.body.appendChild(mocks.elements.messagesArea);
        messageEl = document.createElement('div');
        messageEl.className = 'message assistant';
        messageEl.dataset.messageId = 'msg-1';
        mocks.elements.messagesArea.appendChild(messageEl);

        mocks.state.currentSessionId = 'session-a';
        mocks.state.messages = [
            {
                id: 'msg-1',
                role: 'assistant',
                parts: [{ type: PartType.TEXT, text: 'reply-a' }],
                replies: {
                    all: [
                        { parts: [{ type: PartType.TEXT, text: 'reply-a' }] },
                        { parts: [{ type: PartType.MEDIA, mediaId: 'media-1' }] }
                    ],
                    selected: 0
                }
            }
        ];
        mocks.state.messageStore.findIndexById.mockImplementation((id) =>
            mocks.state.messages.findIndex((message) => message.id === id)
        );
        mocks.hasStoredMedia.mockReturnValue(true);
        mocks.resolveMessagesMediaForApi.mockImplementation(
            () =>
                new Promise((resolve) => {
                    resolveMedia = resolve;
                })
        );
    });

    it('加载期间切换了会话时放弃本次切换，不写入任何会话', async () => {
        const pending = selectReply(1, 0, 'msg-1');
        mocks.state.currentSessionId = 'session-b';
        mocks.state.messages = [{ id: 'other', role: 'assistant', parts: [] }];
        resolveMedia([{ parts: [] }]);
        await pending;

        expect(mocks.updateMessageAt).not.toHaveBeenCalled();
        expect(mocks.updateMessageUiState).not.toHaveBeenCalled();
        expect(mocks.renderReplyWithSelector).not.toHaveBeenCalled();
        expect(mocks.debouncedSaveSession).not.toHaveBeenCalled();
    });

    it('加载期间消息位置变化时按消息 id 重新定位后再应用', async () => {
        const pending = selectReply(1, 0, 'msg-1');
        mocks.state.messages = [
            { id: 'inserted', role: 'user', parts: [] },
            ...mocks.state.messages
        ];
        resolveMedia([{ parts: [{ type: PartType.MEDIA, url: 'blob:media-1' }] }]);
        await pending;

        expect(mocks.updateMessageAt).toHaveBeenCalledWith(1, expect.any(Object));
        expect(mocks.updateMessageUiState).toHaveBeenCalledWith('msg-1', { selectedReply: 1 });
        expect(mocks.renderReplyWithSelector).toHaveBeenCalledWith(expect.any(Array), 1, messageEl);
    });

    it('加载期间目标消息被删除时放弃本次切换', async () => {
        const pending = selectReply(1, 0, 'msg-1');
        mocks.state.messages = [];
        resolveMedia([{ parts: [] }]);
        await pending;

        expect(mocks.updateMessageAt).not.toHaveBeenCalled();
    });

    it('加载期间回复列表被重载替换时放弃本次切换，不用旧回复覆盖', async () => {
        const pending = selectReply(1, 0, 'msg-1');
        mocks.state.messages = [
            {
                ...mocks.state.messages[0],
                replies: {
                    all: [{ parts: [{ type: PartType.TEXT, text: 'reloaded' }] }],
                    selected: 0
                }
            }
        ];
        resolveMedia([{ parts: [] }]);
        await pending;

        expect(mocks.updateMessageAt).not.toHaveBeenCalled();
        expect(mocks.renderReplyWithSelector).not.toHaveBeenCalled();
    });
});
