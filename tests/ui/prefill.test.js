/**
 * prefill.js 预填充消息编辑器测试
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../js/core/state.js', () => ({
    state: {
        prefillMessages: [],
        savedPrefillPresets: [],
        currentPrefillPresetName: '',
        systemPrompt: '',
        charName: 'Assistant',
        userName: 'User',
        prefillEnabled: false
    }
}));

vi.mock('../../js/core/events.js', () => ({
    eventBus: { emit: vi.fn(), on: vi.fn() }
}));

vi.mock('../../js/state/config.js', () => ({
    saveCurrentConfig: vi.fn()
}));

vi.mock('../../js/ui/notifications.js', () => ({
    showNotification: vi.fn()
}));

vi.mock('../../js/utils/helpers.js', () => ({
    escapeHtml: vi.fn((s) => s)
}));

vi.mock('../../js/utils/dialogs.js', () => ({
    showInputDialog: vi.fn(() => Promise.resolve(null)),
    showConfirmDialog: vi.fn(() => Promise.resolve(false))
}));

vi.mock('../../js/utils/logger.js', () => ({
    logger: { warn: vi.fn(), debug: vi.fn(), error: vi.fn(), info: vi.fn() }
}));

import { state } from '../../js/core/state.js';
import { saveCurrentConfig } from '../../js/state/config.js';
import {
    renderPrefillMessagesList,
    updatePrefillPresetSelect,
    initPrefillControls
} from '../../js/ui/prefill.js';

describe('prefill', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        document.body.innerHTML = '';
        state.prefillMessages = [];
        state.savedPrefillPresets = [];
        state.currentPrefillPresetName = '';
        state.systemPrompt = '';
        state.prefillEnabled = false;
    });

    afterEach(() => {
        document.body.innerHTML = '';
    });

    // ========== renderPrefillMessagesList ==========
    describe('renderPrefillMessagesList', () => {
        it('容器不存在静默返回', () => {
            expect(() => renderPrefillMessagesList()).not.toThrow();
        });

        it('空列表渲染空容器', () => {
            document.body.innerHTML = '<div id="prefill-messages-list"></div>';
            state.prefillMessages = [];
            renderPrefillMessagesList();
            const container = document.getElementById('prefill-messages-list');
            expect(container.innerHTML).toBe('');
        });

        it('渲染消息列表', () => {
            document.body.innerHTML = '<div id="prefill-messages-list"></div>';
            state.prefillMessages = [
                { role: 'user', content: 'Hello' },
                { role: 'assistant', content: 'Hi' }
            ];
            renderPrefillMessagesList();
            const items = document.querySelectorAll('.prefill-message-item');
            expect(items.length).toBe(2);
        });

        it('角色切换绑定 change 事件', () => {
            document.body.innerHTML = '<div id="prefill-messages-list"></div>';
            state.prefillMessages = [{ role: 'user', content: 'test' }];
            renderPrefillMessagesList();

            const select = document.querySelector('.prefill-role-select');
            expect(select).toBeTruthy();
            select.value = 'assistant';
            select.dispatchEvent(new Event('change'));
            expect(state.prefillMessages[0].role).toBe('assistant');
            expect(saveCurrentConfig).toHaveBeenCalled();
        });

        it('内容输入绑定 input 事件', () => {
            document.body.innerHTML = '<div id="prefill-messages-list"></div>';
            state.prefillMessages = [{ role: 'user', content: 'old' }];
            renderPrefillMessagesList();

            const textarea = document.querySelector('.prefill-msg-content');
            expect(textarea).toBeTruthy();
            textarea.value = 'new content';
            textarea.dispatchEvent(new Event('input'));
            expect(state.prefillMessages[0].content).toBe('new content');
        });

        it('删除按钮绑定 click 事件', () => {
            document.body.innerHTML = '<div id="prefill-messages-list"></div>';
            state.prefillMessages = [
                { role: 'user', content: 'first' },
                { role: 'assistant', content: 'second' }
            ];
            renderPrefillMessagesList();

            const deleteBtn = document.querySelector('.delete-prefill-msg');
            deleteBtn.click();
            expect(state.prefillMessages).toHaveLength(1);
        });
    });

    // ========== updatePrefillPresetSelect ==========
    describe('updatePrefillPresetSelect', () => {
        it('select 不存在静默返回', () => {
            expect(() => updatePrefillPresetSelect()).not.toThrow();
        });

        it('渲染预设选项', () => {
            document.body.innerHTML = '<select id="prefill-preset-select"></select>';
            state.savedPrefillPresets = [{ name: 'Preset A' }, { name: 'Preset B' }];
            updatePrefillPresetSelect();

            const options = document.querySelectorAll('#prefill-preset-select option');
            expect(options.length).toBe(3); // 默认 + 2个预设
            expect(options[1].value).toBe('Preset A');
        });

        it('当前预设标记 selected', () => {
            document.body.innerHTML = '<select id="prefill-preset-select"></select>';
            state.savedPrefillPresets = [{ name: 'Active' }];
            state.currentPrefillPresetName = 'Active';
            updatePrefillPresetSelect();

            const selected = document.querySelector('#prefill-preset-select option[selected]');
            expect(selected.value).toBe('Active');
        });
    });

    // ========== initPrefillControls ==========
    describe('initPrefillControls', () => {
        it('元素不存在不抛错', () => {
            expect(() => initPrefillControls()).not.toThrow();
        });

        it('prefill-enabled 开关绑定 change', () => {
            document.body.innerHTML = `
                <input type="checkbox" id="prefill-enabled" />
                <div id="prefill-config"></div>
            `;
            initPrefillControls();

            const checkbox = document.getElementById('prefill-enabled');
            checkbox.checked = true;
            checkbox.dispatchEvent(new Event('change'));
            expect(state.prefillEnabled).toBe(true);
            expect(saveCurrentConfig).toHaveBeenCalled();
        });

        it('system-prompt-input 绑定 input', () => {
            document.body.innerHTML = '<textarea id="system-prompt-input"></textarea>';
            state.systemPrompt = '';
            initPrefillControls();

            const input = document.getElementById('system-prompt-input');
            input.value = 'Be helpful';
            input.dispatchEvent(new Event('input'));
            expect(state.systemPrompt).toBe('Be helpful');
        });

        it('char-name 绑定 input', () => {
            document.body.innerHTML = '<input id="char-name" />';
            initPrefillControls();

            const input = document.getElementById('char-name');
            input.value = 'Bot';
            input.dispatchEvent(new Event('input'));
            expect(state.charName).toBe('Bot');
        });

        it('user-name 绑定 input', () => {
            document.body.innerHTML = '<input id="user-name" />';
            initPrefillControls();

            const input = document.getElementById('user-name');
            input.value = 'Player';
            input.dispatchEvent(new Event('input'));
            expect(state.userName).toBe('Player');
        });

        it('add-prefill-message 添加消息', () => {
            document.body.innerHTML = `
                <button id="add-prefill-message"></button>
                <div id="prefill-messages-list"></div>
            `;
            initPrefillControls();

            document.getElementById('add-prefill-message').click();
            expect(state.prefillMessages).toHaveLength(1);
            expect(state.prefillMessages[0].role).toBe('user');
        });

        it('system-prompt-input 初始化同步 state', () => {
            document.body.innerHTML = '<textarea id="system-prompt-input"></textarea>';
            state.systemPrompt = 'Already set';
            initPrefillControls();

            const input = document.getElementById('system-prompt-input');
            expect(input.value).toBe('Already set');
        });
    });
});
