/**
 * utils/dialogs.js 对话框测试
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../js/utils/modal-stack.js', () => ({
    bindTopmostEscape: vi.fn(() => vi.fn())
}));

import { showInputDialog, showConfirmDialog } from '../../js/utils/dialogs.js';

function createDialogDOM(prefix) {
    const modal = document.createElement('div');
    modal.id = `${prefix}-dialog-modal`;
    modal.style.display = 'none';

    const title = document.createElement('div');
    title.id = `${prefix}-dialog-title`;

    const message = document.createElement('div');
    message.id = `${prefix}-dialog-message`;

    const confirmBtn = document.createElement('button');
    confirmBtn.id = `${prefix}-dialog-confirm`;

    const cancelBtn = document.createElement('button');
    cancelBtn.id = `${prefix}-dialog-cancel`;

    const closeBtn = document.createElement('button');
    closeBtn.id = `close-${prefix}-dialog`;

    modal.append(title, message, confirmBtn, cancelBtn, closeBtn);

    // input dialog needs extra input
    if (prefix === 'input') {
        const input = document.createElement('input');
        input.id = 'input-dialog-input';
        modal.appendChild(input);
    }

    document.body.appendChild(modal);
    return { modal, confirmBtn, cancelBtn, closeBtn };
}

beforeEach(() => {
    document.body.innerHTML = '';
    vi.clearAllMocks();
});

describe('showInputDialog', () => {
    it('点击确定返回输入值', async () => {
        const { confirmBtn } = createDialogDOM('input');

        const promise = showInputDialog('请输入名称', 'default');

        // 模拟用户输入
        const input = document.getElementById('input-dialog-input');
        input.value = 'test value';

        // 模拟点击确定
        confirmBtn.click();

        const result = await promise;
        expect(result).toBe('test value');
    });

    it('点击取消返回 null', async () => {
        const { cancelBtn } = createDialogDOM('input');

        const promise = showInputDialog('请输入');
        cancelBtn.click();

        expect(await promise).toBeNull();
    });

    it('空输入返回 null', async () => {
        const { confirmBtn } = createDialogDOM('input');

        const promise = showInputDialog('请输入');
        const input = document.getElementById('input-dialog-input');
        input.value = '   ';
        confirmBtn.click();

        expect(await promise).toBeNull();
    });

    it('点击关闭按钮返回 null', async () => {
        const { closeBtn } = createDialogDOM('input');

        const promise = showInputDialog('请输入');
        closeBtn.click();

        expect(await promise).toBeNull();
    });

    it('设置标题和消息', async () => {
        const { cancelBtn } = createDialogDOM('input');

        const promise = showInputDialog('输入名称', 'default', '自定义标题');

        const title = document.getElementById('input-dialog-title');
        const message = document.getElementById('input-dialog-message');
        expect(title.textContent).toBe('自定义标题');
        expect(message.textContent).toBe('输入名称');

        cancelBtn.click();
        await promise;
    });

    it('设置默认值', async () => {
        const { cancelBtn } = createDialogDOM('input');

        const promise = showInputDialog('请输入', 'hello');

        const input = document.getElementById('input-dialog-input');
        expect(input.value).toBe('hello');

        cancelBtn.click();
        await promise;
    });

    it('Enter 键确认', async () => {
        createDialogDOM('input');

        const promise = showInputDialog('请输入');
        const input = document.getElementById('input-dialog-input');
        input.value = 'enter-test';

        // 模拟 Enter 键
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));

        expect(await promise).toBe('enter-test');
    });

    it('确认后隐藏对话框', async () => {
        const { modal, confirmBtn } = createDialogDOM('input');

        const promise = showInputDialog('请输入');
        const input = document.getElementById('input-dialog-input');
        input.value = 'test';
        confirmBtn.click();

        await promise;
        expect(modal.style.display).toBe('none');
    });
});

describe('showConfirmDialog', () => {
    it('点击确定返回 true', async () => {
        const { confirmBtn } = createDialogDOM('confirm');

        const promise = showConfirmDialog('确认删除？');
        confirmBtn.click();

        expect(await promise).toBe(true);
    });

    it('点击取消返回 false', async () => {
        const { cancelBtn } = createDialogDOM('confirm');

        const promise = showConfirmDialog('确认删除？');
        cancelBtn.click();

        expect(await promise).toBe(false);
    });

    it('点击关闭返回 false', async () => {
        const { closeBtn } = createDialogDOM('confirm');

        const promise = showConfirmDialog('确认？');
        closeBtn.click();

        expect(await promise).toBe(false);
    });

    it('设置标题', async () => {
        const { cancelBtn } = createDialogDOM('confirm');

        const promise = showConfirmDialog('确认？', '警告');

        const title = document.getElementById('confirm-dialog-title');
        expect(title.textContent).toBe('警告');

        cancelBtn.click();
        await promise;
    });

    it('确认后隐藏对话框', async () => {
        const { modal, confirmBtn } = createDialogDOM('confirm');

        const promise = showConfirmDialog('确认？');
        confirmBtn.click();

        await promise;
        expect(modal.style.display).toBe('none');
    });

    it('点击遮罩层关闭', async () => {
        const { modal } = createDialogDOM('confirm');

        const promise = showConfirmDialog('确认？');

        // 模拟点击遮罩层（modal 本身）
        modal.dispatchEvent(new MouseEvent('click', { bubbles: true }));

        expect(await promise).toBe(false);
    });
});
