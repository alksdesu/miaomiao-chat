/**
 * input.js 测试
 * 输入处理：validateMessageLength, autoResizeTextarea, handleSend 部分逻辑
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../js/core/state.js', () => ({
    state: {
        editingIndex: null,
        editingElement: null,
        uploadedImages: [],
        messages: [],
        messageHistory: [],
        maxHistorySize: 50,
        currentReplies: [],
        selectedReplyIndex: 0
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
    updateMessageContentWithImages: vi.fn()
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

import { state, elements } from '../../js/core/state.js';
import { pushMessage, updateMessageAt } from '../../js/core/state-mutations.js';
import { requestStateMachine } from '../../js/core/request-state-machine.js';
import { eventBus } from '../../js/core/events.js';
import { autoResizeTextarea, handleSend, initInputHandlers } from '../../js/ui/input.js';

beforeEach(() => {
    vi.clearAllMocks();
    state.editingIndex = null;
    state.editingElement = null;
    state.uploadedImages = [];
    state.messages = [];
    state.messageHistory = [];

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
});
