/**
 * mcp-server-form.js 测试
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../js/core/state.js', () => ({
    state: {
        mcpServers: []
    }
}));

vi.mock('../../js/state/storage.js', () => ({
    saveMCPServer: vi.fn(() => Promise.resolve())
}));

vi.mock('../../js/ui/notifications.js', () => ({
    showNotification: vi.fn()
}));

vi.mock('../../js/utils/platform.js', () => ({
    detectPlatform: vi.fn(() => 'web')
}));

vi.mock('../../js/ui/mcp-server-list.js', () => ({
    renderServerList: vi.fn(),
    connectToServer: vi.fn()
}));

vi.mock('../../js/utils/logger.js', () => ({
    logger: { warn: vi.fn(), debug: vi.fn(), error: vi.fn(), info: vi.fn() }
}));

import { state } from '../../js/core/state.js';
import { saveMCPServer } from '../../js/state/storage.js';
import { showNotification } from '../../js/ui/notifications.js';
import {
    showServerForm,
    hideServerForm,
    handleSaveServer,
    toggleConfigSection
} from '../../js/ui/mcp-server-form.js';

describe('mcp-server-form', () => {
    let modal;

    beforeEach(() => {
        vi.clearAllMocks();
        state.mcpServers = [];
        modal = document.createElement('div');
        modal.innerHTML = `
            <div id="mcp-server-form" style="display:none"></div>
            <div id="mcp-remote-config"></div>
            <div id="mcp-local-config" style="display:none"></div>
        `;
        document.body.appendChild(modal);
    });

    afterEach(() => {
        document.body.innerHTML = '';
    });

    // ========== showServerForm ==========
    describe('showServerForm', () => {
        it('渲染表单并显示', () => {
            const setFormOpen = vi.fn();
            showServerForm(modal, setFormOpen);

            const form = modal.querySelector('#mcp-server-form');
            expect(form.style.display).toBe('block');
            expect(setFormOpen).toHaveBeenCalledWith(true);
        });

        it('表单包含必要字段', () => {
            const setFormOpen = vi.fn();
            showServerForm(modal, setFormOpen);

            expect(modal.querySelector('#mcp-server-type')).toBeTruthy();
            expect(modal.querySelector('#mcp-server-name')).toBeTruthy();
            expect(modal.querySelector('#mcp-server-url')).toBeTruthy();
        });

        it('form 不存在静默返回', () => {
            const emptyModal = document.createElement('div');
            const setFormOpen = vi.fn();
            expect(() => showServerForm(emptyModal, setFormOpen)).not.toThrow();
            expect(setFormOpen).not.toHaveBeenCalled();
        });
    });

    // ========== hideServerForm ==========
    describe('hideServerForm', () => {
        it('隐藏表单并清空', () => {
            const setFormOpen = vi.fn();
            showServerForm(modal, setFormOpen);
            hideServerForm(modal, setFormOpen);

            const form = modal.querySelector('#mcp-server-form');
            expect(form.style.display).toBe('none');
            expect(form.innerHTML).toBe('');
            expect(setFormOpen).toHaveBeenCalledWith(false);
        });

        it('form 不存在不抛错', () => {
            const emptyModal = document.createElement('div');
            const setFormOpen = vi.fn();
            expect(() => hideServerForm(emptyModal, setFormOpen)).not.toThrow();
            expect(setFormOpen).toHaveBeenCalledWith(false);
        });
    });

    // ========== toggleConfigSection ==========
    describe('toggleConfigSection', () => {
        it('切换到本地模式', () => {
            const remoteConfig = modal.querySelector('#mcp-remote-config');
            const localConfig = modal.querySelector('#mcp-local-config');

            toggleConfigSection(modal, true);
            expect(remoteConfig.style.display).toBe('none');
            expect(localConfig.style.display).toBe('block');
        });

        it('切换到远程模式', () => {
            const remoteConfig = modal.querySelector('#mcp-remote-config');
            const localConfig = modal.querySelector('#mcp-local-config');

            toggleConfigSection(modal, false);
            expect(remoteConfig.style.display).toBe('block');
            expect(localConfig.style.display).toBe('none');
        });

        it('元素不存在不抛错', () => {
            const emptyModal = document.createElement('div');
            expect(() => toggleConfigSection(emptyModal, true)).not.toThrow();
        });
    });

    // ========== handleSaveServer ==========
    describe('handleSaveServer', () => {
        it('名称为空显示错误', async () => {
            const setFormOpen = vi.fn();
            showServerForm(modal, setFormOpen);

            const nameInput = modal.querySelector('#mcp-server-name');
            nameInput.value = '';

            await handleSaveServer(modal, setFormOpen);
            expect(showNotification).toHaveBeenCalledWith('请输入服务器名称', 'error');
        });

        it('远程模式 URL 为空显示错误', async () => {
            const setFormOpen = vi.fn();
            showServerForm(modal, setFormOpen);

            modal.querySelector('#mcp-server-name').value = 'Test Server';
            modal.querySelector('#mcp-server-type').value = 'remote';
            modal.querySelector('#mcp-server-url').value = '';

            await handleSaveServer(modal, setFormOpen);
            expect(showNotification).toHaveBeenCalledWith('请输入有效的服务器 URL', 'error');
        });

        it('远程模式 URL 格式错误显示错误', async () => {
            const setFormOpen = vi.fn();
            showServerForm(modal, setFormOpen);

            modal.querySelector('#mcp-server-name').value = 'Test Server';
            modal.querySelector('#mcp-server-type').value = 'remote';
            modal.querySelector('#mcp-server-url').value = 'invalid-url';

            await handleSaveServer(modal, setFormOpen);
            expect(showNotification).toHaveBeenCalledWith('请输入有效的服务器 URL', 'error');
        });

        it('保存成功', async () => {
            const setFormOpen = vi.fn();
            showServerForm(modal, setFormOpen);

            modal.querySelector('#mcp-server-name').value = 'My Server';
            modal.querySelector('#mcp-server-type').value = 'remote';
            modal.querySelector('#mcp-server-url').value = 'https://mcp.example.com';

            await handleSaveServer(modal, setFormOpen);
            expect(saveMCPServer).toHaveBeenCalled();
            expect(state.mcpServers).toHaveLength(1);
            expect(state.mcpServers[0].name).toBe('My Server');
            expect(showNotification).toHaveBeenCalledWith('服务器添加成功', 'success');
        });

        it('保存带 API Key', async () => {
            const setFormOpen = vi.fn();
            showServerForm(modal, setFormOpen);

            modal.querySelector('#mcp-server-name').value = 'Secure Server';
            modal.querySelector('#mcp-server-type').value = 'remote';
            modal.querySelector('#mcp-server-url').value = 'https://secure.example.com';
            modal.querySelector('#mcp-server-apikey').value = 'sk-12345';

            await handleSaveServer(modal, setFormOpen);
            expect(state.mcpServers[0].apiKey).toBe('sk-12345');
        });

        it('保存失败显示错误', async () => {
            saveMCPServer.mockRejectedValueOnce(new Error('save failed'));
            const setFormOpen = vi.fn();
            showServerForm(modal, setFormOpen);

            modal.querySelector('#mcp-server-name').value = 'Fail Server';
            modal.querySelector('#mcp-server-type').value = 'remote';
            modal.querySelector('#mcp-server-url').value = 'https://fail.example.com';

            await handleSaveServer(modal, setFormOpen);
            expect(showNotification).toHaveBeenCalledWith('保存失败，请重试', 'error');
        });
    });

    // ========== 内联验证 ==========
    describe('内联验证', () => {
        it('name blur 触发验证', () => {
            const setFormOpen = vi.fn();
            showServerForm(modal, setFormOpen);

            const nameInput = modal.querySelector('#mcp-server-name');
            nameInput.value = '';
            nameInput.dispatchEvent(new Event('blur'));

            const errorEl = modal.querySelector('#mcp-server-name-error');
            expect(errorEl.textContent).toContain('请输入服务器名称');
        });

        it('name input 清除错误', () => {
            const setFormOpen = vi.fn();
            showServerForm(modal, setFormOpen);

            const nameInput = modal.querySelector('#mcp-server-name');
            nameInput.value = '';
            nameInput.dispatchEvent(new Event('blur'));
            nameInput.value = 'Test';
            nameInput.dispatchEvent(new Event('input'));

            const errorEl = modal.querySelector('#mcp-server-name-error');
            expect(errorEl.textContent).toBe('');
        });

        it('URL blur 触发验证', () => {
            const setFormOpen = vi.fn();
            showServerForm(modal, setFormOpen);

            const urlInput = modal.querySelector('#mcp-server-url');
            urlInput.value = 'not-a-url';
            urlInput.dispatchEvent(new Event('blur'));

            const errorEl = modal.querySelector('#mcp-server-url-error');
            expect(errorEl.textContent).toContain('URL');
        });
    });
});
