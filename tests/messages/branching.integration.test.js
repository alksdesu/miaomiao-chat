import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    state: {
        currentSessionId: 'source-session',
        isSwitchingSession: false,
        isLoading: false,
        messages: [
            { id: 'message-1', role: 'user', parts: [{ type: 'text', text: '问题' }] },
            { id: 'message-2', role: 'assistant', parts: [{ type: 'text', text: '回答' }] },
            { id: 'message-3', role: 'user', parts: [{ type: 'text', text: '追问' }] }
        ],
        sessions: [{ id: 'source-session', name: '原会话' }],
        messageStore: { findIndexById: vi.fn(() => 1) },
        sessionDirty: false
    },
    createNewSession: vi.fn(),
    saveCurrentSessionMessages: vi.fn(),
    switchToSession: vi.fn(),
    materializeCurrentSessionMessages: vi.fn(),
    replaceAllMessages: vi.fn(),
    renderSessionMessages: vi.fn(),
    showNotification: vi.fn(),
    eventBus: { on: vi.fn(), emit: vi.fn() },
    requestTaskRegistry: { getBySession: vi.fn(() => null), isActive: vi.fn() }
}));

vi.mock('../../js/core/state.js', () => ({ state: mocks.state }));
vi.mock('../../js/core/events.js', () => ({ eventBus: mocks.eventBus }));
vi.mock('../../js/core/request-task-registry.js', () => ({
    requestTaskRegistry: mocks.requestTaskRegistry
}));
vi.mock('../../js/state/sessions.js', () => ({
    createNewSession: mocks.createNewSession,
    saveCurrentSessionMessages: mocks.saveCurrentSessionMessages,
    switchToSession: mocks.switchToSession
}));
vi.mock('../../js/state/session-message-repository.js', () => ({
    materializeCurrentSessionMessages: mocks.materializeCurrentSessionMessages
}));
vi.mock('../../js/core/state-mutations.js', () => ({
    replaceAllMessages: mocks.replaceAllMessages
}));
vi.mock('../../js/messages/restore.js', () => ({
    renderSessionMessages: mocks.renderSessionMessages
}));
vi.mock('../../js/ui/notifications.js', () => ({ showNotification: mocks.showNotification }));

import { branchFromMessage } from '../../js/messages/branching.js';

beforeEach(() => {
    vi.clearAllMocks();
    mocks.state.currentSessionId = 'source-session';
    mocks.state.isSwitchingSession = false;
    mocks.state.isLoading = false;
    mocks.state.sessionDirty = false;
    mocks.state.sessions = [{ id: 'source-session', name: '原会话' }];
    mocks.state.messages = [
        { id: 'message-1', role: 'user', parts: [{ type: 'text', text: '问题' }] },
        { id: 'message-2', role: 'assistant', parts: [{ type: 'text', text: '回答' }] },
        { id: 'message-3', role: 'user', parts: [{ type: 'text', text: '追问' }] }
    ];
    mocks.state.messageStore.findIndexById.mockReturnValue(1);
    mocks.materializeCurrentSessionMessages.mockResolvedValue(mocks.state.messages);
    mocks.createNewSession.mockResolvedValue({ id: 'branch-session', name: '新会话' });
    mocks.switchToSession.mockImplementation(async (sessionId) => {
        mocks.state.currentSessionId = sessionId;
        mocks.state.isSwitchingSession = false;
    });
    mocks.replaceAllMessages.mockImplementation((messages) => {
        mocks.state.messages = messages;
    });
    mocks.saveCurrentSessionMessages.mockResolvedValue(undefined);
});

describe('message branching flow', () => {
    it('复制目标消息之前的内容到新会话并保存', async () => {
        await branchFromMessage({ dataset: { messageId: 'message-2' } });

        expect(mocks.createNewSession).toHaveBeenCalledWith(false);
        expect(mocks.switchToSession).toHaveBeenCalledWith('branch-session', false);
        expect(mocks.state.messages).toHaveLength(2);
        expect(mocks.state.messages.map((message) => message.id)).toEqual([
            'message-1',
            'message-2'
        ]);
        expect(mocks.saveCurrentSessionMessages).toHaveBeenCalledWith(true);
        expect(mocks.showNotification).toHaveBeenCalledWith('已创建分支：原会话 · 分支', 'success');
    });

    it('生成中时不创建分支', async () => {
        mocks.state.isLoading = true;

        await branchFromMessage({ dataset: { messageId: 'message-2' } });

        expect(mocks.createNewSession).not.toHaveBeenCalled();
        expect(mocks.showNotification).toHaveBeenCalledWith(
            '请等待当前回复完成后再创建分支',
            'warning'
        );
    });
});
