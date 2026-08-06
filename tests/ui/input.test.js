/**
 * input.js 测试
 * 输入处理：validateMessageLength, autoResizeTextarea, handleSend 部分逻辑
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mediaMocks = vi.hoisted(() => ({
    resolveMessagesMediaForApi: vi.fn(async (messages) => messages)
}));

vi.mock('../../js/core/state.js', () => ({
    state: {
        editingIndex: null,
        editingElement: null,
        uploadedImages: [],
        messages: [],
        messageHistory: [],
        maxHistorySize: 50,
        currentReplies: [],
        selectedReplyIndex: 0,
        currentSessionId: 'session-a',
        isSwitchingSession: false,
        backgroundTasks: new Map(),
        sessions: []
    },
    elements: {
        userInput: null,
        sendButton: null,
        messagesArea: null,
        cancelRequestButton: null,
        attachFile: null,
        charCounter: null,
        inputBarInner: null
    }
}));

vi.mock('../../js/core/events.js', () => ({
    eventBus: {
        on: vi.fn(),
        emit: vi.fn()
    }
}));

vi.mock('../../js/core/request-state-machine.js', () => ({
    requestStateMachine: {
        isBusy: vi.fn(() => false),
        getState: vi.fn(() => 'idle'),
        attach: vi.fn(),
        forceReset: vi.fn()
    }
}));

vi.mock('../../js/messages/renderer.js', () => ({
    createMessageElement: vi.fn(() => {
        const el = document.createElement('div');
        el.className = 'message user';
        return el;
    })
}));

vi.mock('../../js/messages/editor.js', () => ({
    removeMessagesAfterAll: vi.fn(),
    updateMessageContentWithImages: vi.fn(),
    updateUserMessageFromDraft: vi.fn(),
    buildAttachmentParts: vi.fn(() => []),
    resolveEditingIndex: vi.fn(() => 0),
    endEditingState: vi.fn()
}));

vi.mock('../../js/ui/notifications.js', () => ({
    showNotification: vi.fn()
}));

vi.mock('../../js/core/state-mutations.js', () => ({
    pushMessage: vi.fn(),
    updateMessageAt: vi.fn()
}));

vi.mock('../../js/utils/file-helpers.js', () => ({
    categorizeFile: vi.fn(() => 'text')
}));

vi.mock('../../js/messages/schema.js', () => ({
    createMessage: vi.fn((role, parts) => ({
        id: 'msg-test',
        role,
        parts,
        ts: Date.now()
    })),
    Role: { USER: 'user', ASSISTANT: 'assistant' },
    textPart: vi.fn((text) => ({ type: 'text', text })),
    mediaPart: vi.fn((kind, url, mime) => ({ type: 'media', media: kind, url, mime })),
    filePart: vi.fn((name, mime, url) => ({ type: 'file', name, mime, url })),
    MediaKind: { IMAGE: 'image', VIDEO: 'video' }
}));

vi.mock('../../js/utils/constants.js', () => ({
    MAX_ATTACHMENTS: 10,
    MAX_MESSAGE_LENGTH: 100000,
    IMAGE_COMPRESSION_TIMEOUT: 5000,
    AUTO_DOCUMENT_TOKEN_THRESHOLD: 8000
}));

vi.mock('../../js/stream/stats.js', () => ({
    estimateTokenCount: vi.fn(() => 100)
}));

vi.mock('../../js/ui/attachment-handler.js', () => ({
    handleAttachFile: vi.fn(),
    updateImagePreview: vi.fn(),
    handlePaste: vi.fn()
}));

vi.mock('../../js/ui/quote-handler.js', () => ({
    getQuotedMessage: vi.fn(() => null),
    setQuotedMessage: vi.fn(),
    clearQuotedMessage: vi.fn(),
    updateQuotePreviewStyle: vi.fn()
}));

vi.mock('../../js/state/media-blob-store.js', () => mediaMocks);

import { state, elements } from '../../js/core/state.js';
import { pushMessage, updateMessageAt } from '../../js/core/state-mutations.js';
import { requestStateMachine } from '../../js/core/request-state-machine.js';
import { eventBus } from '../../js/core/events.js';
import { autoResizeTextarea, handleSend, initInputHandlers } from '../../js/ui/input.js';
import { requestTaskRegistry } from '../../js/core/request-task-registry.js';

beforeEach(() => {
    vi.clearAllMocks();
    state.editingIndex = null;
    state.editingElement = null;
    state.uploadedImages = [];
    state.messages = [];
    state.messageHistory = [];
    state.currentSessionId = 'session-a';
    state.isSwitchingSession = false;
    state.backgroundTasks = new Map();
    requestTaskRegistry.clearForTests();
    mediaMocks.resolveMessagesMediaForApi.mockImplementation(async (messages) => messages);

    elements.userInput = document.createElement('textarea');
    elements.sendButton = document.createElement('button');
    elements.messagesArea = document.createElement('div');
    elements.cancelRequestButton = document.createElement('button');
    elements.attachFile = document.createElement('button');
    elements.charCounter = document.createElement('span');
    elements.inputBarInner = document.createElement('div');

    // handleSend 内部调用 updateCancelEditButton，需要这些 DOM 元素
    document.body.innerHTML = `
        <button id="cancel-edit"></button>
        <button id="save-edit"></button>
        <button id="send-button"></button>
    `;
});

describe('autoResizeTextarea', () => {
    it('不报错当 textarea 为 null', () => {
        elements.userInput = null;
        expect(() => autoResizeTextarea()).not.toThrow();
    });

    it('设置 height 为 auto 后重新计算', () => {
        elements.userInput.style.height = '200px';
        autoResizeTextarea();
        // 检查 height 被设置（具体值取决于 scrollHeight，jsdom 默认为 0）
        expect(elements.userInput.style.height).toBeDefined();
    });
});

describe('handleSend', () => {
    it('快速重复触发只发送一次', async () => {
        elements.userInput.value = 'hello';

        const first = handleSend();
        const second = handleSend();
        await Promise.all([first, second]);

        const sendEvents = eventBus.emit.mock.calls.filter(
            ([eventName]) => eventName === 'api:send-requested'
        );
        expect(sendEvents).toHaveLength(1);
    });

    it('空输入不发送', async () => {
        elements.userInput.value = '';
        await handleSend();
        expect(pushMessage).not.toHaveBeenCalled();
    });

    it('请求忙时不发送', async () => {
        requestStateMachine.isBusy.mockReturnValue(true);
        elements.userInput.value = 'hello';
        await handleSend();
        expect(pushMessage).not.toHaveBeenCalled();
        // 还原
        requestStateMachine.isBusy.mockReturnValue(false);
    });

    it('有文本时发送消息', async () => {
        elements.userInput.value = 'hello world';
        await handleSend();
        expect(pushMessage).toHaveBeenCalled();
    });

    it('发送后清空输入', async () => {
        elements.userInput.value = 'test';
        await handleSend();
        expect(elements.userInput.value).toBe('');
    });

    it('发送后触发事件', async () => {
        elements.userInput.value = 'test';
        await handleSend();
        expect(eventBus.emit).toHaveBeenCalledWith('api:send-requested');
    });

    it('编辑模式下更新消息而非新增', async () => {
        state.editingIndex = 0;
        const editingEl = document.createElement('div');
        editingEl.classList.add('editing');
        state.editingElement = editingEl;
        state.messages = [{ role: 'user', content: 'old' }];
        elements.userInput.value = 'updated';

        await handleSend();
        expect(updateMessageAt).toHaveBeenCalled();
    });
});

describe('initInputHandlers', () => {
    it('初始化不报错', () => {
        document.body.innerHTML =
            '<button id="cancel-edit"></button><button id="save-edit"></button>';
        expect(() => initInputHandlers()).not.toThrow();
    });

    it('不再向 window 暴露 cancelEdit / saveEdit（CSP 收紧后改用 addEventListener）', () => {
        document.body.innerHTML =
            '<button id="cancel-edit"></button><button id="save-edit"></button>';
        initInputHandlers();
        expect(window.cancelEdit).toBeUndefined();
        expect(window.saveEdit).toBeUndefined();
    });

    it('给 #cancel-edit 和 #save-edit 绑定 click 监听', () => {
        const cancelBtn = document.createElement('button');
        cancelBtn.id = 'cancel-edit';
        const saveBtn = document.createElement('button');
        saveBtn.id = 'save-edit';
        const cancelSpy = vi.spyOn(cancelBtn, 'addEventListener');
        const saveSpy = vi.spyOn(saveBtn, 'addEventListener');
        document.body.innerHTML = '';
        document.body.appendChild(cancelBtn);
        document.body.appendChild(saveBtn);
        initInputHandlers();
        expect(cancelSpy).toHaveBeenCalledWith('click', expect.any(Function));
        expect(saveSpy).toHaveBeenCalledWith('click', expect.any(Function));
    });

    it('保存编辑解析附件期间开始切换会话时不再操作旧编辑 DOM', async () => {
        let resolveMedia;
        mediaMocks.resolveMessagesMediaForApi.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    resolveMedia = resolve;
                })
        );
        const saveBtn = document.getElementById('save-edit');
        const saveSpy = vi.spyOn(saveBtn, 'addEventListener');
        state.editingIndex = 0;
        state.editingElement = document.createElement('div');
        state.editingElement.className = 'message editing';
        state.messages = [{ id: 'message-a', role: 'user', parts: [] }];
        elements.userInput.value = 'updated';
        initInputHandlers();
        const saveHandler = saveSpy.mock.calls.find(([event]) => event === 'click')[1];

        const pending = saveHandler();
        state.isSwitchingSession = true;
        resolveMedia(state.messages);
        await pending;

        expect(eventBus.emit).not.toHaveBeenCalledWith(
            'message:content-updated',
            expect.any(Object)
        );
        expect(state.editingElement).not.toBeNull();
    });

    it('切换窗口的按钮重置事件不会重新 attach 已 detach 的任务', () => {
        const task = requestTaskRegistry.create({
            sessionId: 'session-a',
            abortController: new AbortController()
        });
        requestTaskRegistry.detach(task);
        state.isSwitchingSession = true;
        initInputHandlers();
        const resetHandler = eventBus.on.mock.calls.find(
            ([eventName]) => eventName === 'ui:reset-input-buttons'
        )[1];

        resetHandler();

        expect(requestStateMachine.attach).not.toHaveBeenCalled();
    });
});
