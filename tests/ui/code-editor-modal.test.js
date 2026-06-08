/**
 * code-editor-modal.js 代码编辑器模态框测试
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../js/core/events.js', () => ({
    eventBus: { emit: vi.fn(), on: vi.fn(), off: vi.fn() }
}));

vi.mock('../../js/utils/helpers.js', () => ({
    escapeHtml: vi.fn((s) => s)
}));

vi.mock('../../js/ui/code-editor-core.js', () => ({
    generateLanguageOptions: vi.fn(() => '<option value="javascript">JAVASCRIPT</option>'),
    initCodeEditor: vi.fn(),
    updateCodePreview: vi.fn(),
    runLivePreview: vi.fn(),
    analyzeCode: vi.fn()
}));

vi.mock('../../js/ui/code-editor-toolbar.js', () => ({
    trapFocus: vi.fn(),
    openFullscreenPreview: vi.fn()
}));

import { openCodeEditorModal } from '../../js/ui/code-editor-modal.js';
import { analyzeCode } from '../../js/ui/code-editor-core.js';
import { trapFocus } from '../../js/ui/code-editor-toolbar.js';

describe('openCodeEditorModal', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
        document.body.innerHTML = '<div class="app-container"></div>';
    });

    afterEach(() => {
        vi.useRealTimers();
        document.body.innerHTML = '';
    });

    it('创建模态框并添加到 body', () => {
        openCodeEditorModal('const x = 1;', 'javascript', vi.fn());
        const modal = document.getElementById('code-editor-modal');
        expect(modal).toBeTruthy();
    });

    it('调用 trapFocus', () => {
        openCodeEditorModal('code', 'js', vi.fn());
        expect(trapFocus).toHaveBeenCalled();
    });

    it('调用 analyzeCode', () => {
        openCodeEditorModal('code', 'javascript', vi.fn());
        expect(analyzeCode).toHaveBeenCalled();
    });

    it('设置 app-container 为 inert', () => {
        openCodeEditorModal('code', 'js', vi.fn());
        const appContainer = document.querySelector('.app-container');
        expect(appContainer.getAttribute('inert')).toBe('');
    });

    it('只读模式不显示保存按钮', () => {
        openCodeEditorModal('code', 'js', vi.fn(), true);
        const modal = document.getElementById('code-editor-modal');
        const saveBtn = modal.querySelector('#code-save-btn');
        // 只读模式下保存按钮应被隐藏或不存在
        if (saveBtn) {
            expect(
                saveBtn.style.display === 'none' ||
                    saveBtn.hidden === true ||
                    saveBtn.disabled === true
            ).toBeTruthy();
        }
    });

    it('包含 textarea', () => {
        openCodeEditorModal('hello world', 'text', vi.fn());
        const modal = document.getElementById('code-editor-modal');
        const textarea = modal.querySelector('#code-editor-textarea');
        expect(textarea).toBeTruthy();
        expect(textarea.value).toBe('hello world');
    });

    it('包含标签页按钮', () => {
        openCodeEditorModal('code', 'js', vi.fn());
        const modal = document.getElementById('code-editor-modal');
        const tabs = modal.querySelectorAll('.tab-btn, [data-tab]');
        expect(tabs.length).toBeGreaterThan(0);
    });
});
