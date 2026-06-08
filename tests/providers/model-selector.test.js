/**
 * provider-form.js / provider-list.js 测试
 * 提供商 UI 模块
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../js/core/state.js', () => ({
    state: {
        providers: []
    }
}));

vi.mock('../../js/core/events.js', () => ({
    eventBus: {
        on: vi.fn(),
        emit: vi.fn()
    }
}));

vi.mock('../../js/providers/manager.js', () => ({
    addModelToProvider: vi.fn(() => true),
    addModelsToProvider: vi.fn(() => 1),
    fetchProviderModels: vi.fn(async () => []),
    updateProvider: vi.fn()
}));

vi.mock('../../js/utils/capability-badges.js', () => ({
    renderCapabilityBadges: vi.fn(() => '')
}));

vi.mock('../../js/utils/dialogs.js', () => ({
    showInputDialog: vi.fn()
}));

vi.mock('../../js/utils/helpers.js', () => ({
    escapeHtml: vi.fn((s) => String(s || ''))
}));

vi.mock('../../js/ui/notifications.js', () => ({
    showNotification: vi.fn()
}));

vi.mock('../../js/utils/icons.js', () => ({
    getIcon: vi.fn(() => '<svg></svg>')
}));

vi.mock('../../js/utils/modal-stack.js', () => ({
    bindTopmostEscape: vi.fn(() => vi.fn())
}));

vi.mock('../../js/providers/shared-state.js', () => ({
    getSelectedProviderId: vi.fn(() => 'p1')
}));

vi.mock('../../js/providers/provider-form.js', () => ({
    showProviderForm: vi.fn()
}));

import { state } from '../../js/core/state.js';
import {
    closeModelsManageModal,
    closeEditModelModal,
    renderModelsList
} from '../../js/providers/model-selector.js';

beforeEach(() => {
    vi.clearAllMocks();
    state.providers = [];
    document.body.innerHTML = '';
});

describe('closeModelsManageModal', () => {
    it('modal 不存在时不报错', () => {
        expect(() => closeModelsManageModal()).not.toThrow();
    });

    it('移除 active class', () => {
        document.body.innerHTML = `
            <div id="models-manage-modal" class="active">
                <input id="models-search-input" />
                <div id="models-bulk-actions"></div>
            </div>
        `;
        closeModelsManageModal();
        expect(document.getElementById('models-manage-modal').classList.contains('active')).toBe(
            false
        );
    });
});

describe('closeEditModelModal', () => {
    it('modal 不存在时不报错', () => {
        expect(() => closeEditModelModal()).not.toThrow();
    });

    it('移除 active class', () => {
        document.body.innerHTML = '<div id="edit-model-modal" class="active"></div>';
        closeEditModelModal();
        expect(document.getElementById('edit-model-modal').classList.contains('active')).toBe(
            false
        );
    });
});

describe('renderModelsList', () => {
    it('空模型列表返回提示', () => {
        const html = renderModelsList({ models: [] });
        expect(html).toContain('暂无模型');
    });

    it('null models 返回提示', () => {
        const html = renderModelsList({ models: null });
        expect(html).toContain('暂无模型');
    });

    it('渲染模型 chip', () => {
        const html = renderModelsList({
            models: ['gpt-4', 'gpt-3.5']
        });
        expect(html).toContain('model-chip');
        expect(html).toContain('gpt-4');
        expect(html).toContain('gpt-3.5');
    });

    it('对象格式模型显示名称', () => {
        const html = renderModelsList({
            models: [{ id: 'gpt-4', name: 'GPT-4 Turbo' }]
        });
        expect(html).toContain('GPT-4 Turbo');
    });

    it('包含编辑和删除按钮', () => {
        const html = renderModelsList({
            models: ['test-model']
        });
        expect(html).toContain('edit-model-btn');
        expect(html).toContain('remove-model-btn');
    });

    it('删除按钮包含模型 ID', () => {
        const html = renderModelsList({
            models: ['my-model-id']
        });
        expect(html).toContain('data-model="my-model-id"');
    });
});
