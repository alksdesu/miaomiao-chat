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
    renderModelsList,
    openEditModelModal,
    saveEditedModel,
    initModelSelectorEvents
} from '../../js/providers/model-selector.js';
import { updateProvider } from '../../js/providers/manager.js';

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

// ========== 模型编辑弹窗：官方型号别名 ==========

const EDIT_MODAL_HTML = `
    <div id="edit-model-modal" class="modal">
        <input id="edit-model-id" />
        <input id="edit-model-name" />
        <div id="edit-model-profile-group">
            <input id="edit-model-profile-alias" />
            <datalist id="edit-model-profile-alias-options"></datalist>
            <p id="edit-model-profile-status"></p>
        </div>
        <input type="checkbox" id="edit-model-image-input" />
        <input type="checkbox" id="edit-model-image-output" />
    </div>
`;

describe('模型编辑弹窗的官方型号别名', () => {
    beforeEach(() => {
        document.body.innerHTML = EDIT_MODAL_HTML;
        initModelSelectorEvents();
    });

    it('打开时列出该格式可选的官方型号并回填别名', () => {
        state.providers = [
            {
                id: 'p1',
                apiFormat: 'claude',
                models: [{ id: 'proxy-x', name: 'X', profileAlias: 'claude-opus-5-5' }]
            }
        ];

        openEditModelModal('p1', 'proxy-x');

        const options = [...document.querySelectorAll('#edit-model-profile-alias-options option')];
        expect(options.map((option) => option.value)).toContain('claude-sonnet-5-5');
        expect(document.getElementById('edit-model-profile-alias').value).toBe('claude-opus-5-5');
        expect(document.getElementById('edit-model-profile-status').textContent).toContain(
            'claude-opus-5-5'
        );
    });

    it('输入别名时实时显示识别结果', () => {
        state.providers = [{ id: 'p1', apiFormat: 'claude', models: ['proxy-x'] }];
        openEditModelModal('p1', 'proxy-x');
        const input = document.getElementById('edit-model-profile-alias');
        const status = document.getElementById('edit-model-profile-status');

        expect(status.textContent).toContain('未识别');
        input.value = 'claude-sonnet-5-5';
        input.dispatchEvent(new Event('input'));
        expect(status.textContent).toContain('claude-sonnet-5-5');
        input.value = 'not-a-model';
        input.dispatchEvent(new Event('input'));
        expect(status.textContent).toContain('未找到');
    });

    it('没有能力表的格式隐藏别名输入', () => {
        state.providers = [{ id: 'p1', apiFormat: 'openclaw', models: ['agent'] }];
        openEditModelModal('p1', 'agent');
        expect(document.getElementById('edit-model-profile-group').hidden).toBe(true);
    });

    it('保存时写入别名并保留弹窗不编辑的字段', async () => {
        state.providers = [
            {
                id: 'p1',
                apiFormat: 'claude',
                models: [
                    {
                        id: 'proxy-x',
                        name: 'X',
                        capabilities: { imageInput: true, imageOutput: false, audioInput: true },
                        contextWindow: 200000
                    }
                ]
            }
        ];
        openEditModelModal('p1', 'proxy-x');
        document.getElementById('edit-model-profile-alias').value = ' claude-sonnet-5-5 ';

        await saveEditedModel();

        expect(state.providers[0].models[0]).toEqual({
            id: 'proxy-x',
            name: 'X',
            capabilities: { imageInput: true, imageOutput: false, audioInput: true },
            contextWindow: 200000,
            profileAlias: 'claude-sonnet-5-5'
        });
        expect(updateProvider).toHaveBeenCalledWith('p1', { models: state.providers[0].models });
    });

    it('清空别名时移除字段，字符串格式的模型升级为对象', async () => {
        state.providers = [
            {
                id: 'p1',
                apiFormat: 'claude',
                models: [{ id: 'proxy-x', name: 'X', profileAlias: 'claude-opus-5-5' }, 'plain']
            }
        ];
        openEditModelModal('p1', 'proxy-x');
        document.getElementById('edit-model-profile-alias').value = '';
        await saveEditedModel();
        expect(state.providers[0].models[0]).not.toHaveProperty('profileAlias');

        openEditModelModal('p1', 'plain');
        await saveEditedModel();
        expect(state.providers[0].models[1]).toEqual({
            id: 'plain',
            name: 'plain',
            capabilities: { imageInput: false, imageOutput: false }
        });
    });
});
