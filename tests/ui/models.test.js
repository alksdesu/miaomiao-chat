/**
 * models.js 测试 (ui)
 * 模型列表聚合填充
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../js/core/state.js', () => ({
    state: {
        providers: [],
        selectedModel: '',
        apiFormat: 'openai'
    }
}));

vi.mock('../../js/core/elements.js', () => ({
    elements: {
        modelSelect: null
    }
}));

vi.mock('../../js/state/config.js', () => ({
    saveCurrentConfig: vi.fn()
}));

vi.mock('../../js/core/events.js', () => ({
    eventBus: {
        on: vi.fn(),
        emit: vi.fn()
    }
}));

vi.mock('../../js/utils/capability-badges.js', () => ({
    renderCapabilityBadgesText: vi.fn(() => '')
}));

vi.mock('../../js/ui/mobile-overflow-menu.js', () => ({
    updateMobileHeaderTitle: vi.fn()
}));

import { state } from '../../js/core/state.js';
import { elements } from '../../js/core/elements.js';
import { populateModelSelect } from '../../js/ui/models.js';

beforeEach(() => {
    vi.clearAllMocks();
    elements.modelSelect = document.createElement('select');
    state.providers = [];
    state.selectedModel = '';
});

describe('populateModelSelect', () => {
    it('modelSelect 为 null 时不报错', () => {
        elements.modelSelect = null;
        expect(() => populateModelSelect()).not.toThrow();
    });

    it('无启用提供商时显示提示', () => {
        state.providers = [{ id: 'p1', name: 'P1', enabled: false, models: ['m1'] }];
        populateModelSelect();
        const options = elements.modelSelect.querySelectorAll('option');
        expect(options.length).toBe(1);
        expect(options[0].disabled).toBe(true);
    });

    it('有提供商但无模型时显示提示', () => {
        state.providers = [{ id: 'p1', name: 'P1', enabled: true, models: [] }];
        populateModelSelect();
        const options = elements.modelSelect.querySelectorAll('option');
        expect(options[0].disabled).toBe(true);
    });

    it('渲染模型到 optgroup', () => {
        state.providers = [
            {
                id: 'p1',
                name: 'Provider 1',
                enabled: true,
                models: ['model-a', 'model-b']
            }
        ];
        populateModelSelect();
        const optgroups = elements.modelSelect.querySelectorAll('optgroup');
        expect(optgroups.length).toBe(1);
        expect(optgroups[0].label).toBe('Provider 1');

        const options = optgroups[0].querySelectorAll('option');
        expect(options.length).toBe(2);
    });

    it('支持对象格式模型', () => {
        state.providers = [
            {
                id: 'p1',
                name: 'P1',
                enabled: true,
                models: [{ id: 'obj-model', name: 'Object Model' }]
            }
        ];
        populateModelSelect();
        const option = elements.modelSelect.querySelector('option');
        expect(option.value).toBe('obj-model');
        expect(option.textContent).toContain('Object Model');
    });

    it('当前选中模型标记 selected', () => {
        state.selectedModel = 'model-b';
        state.providers = [
            {
                id: 'p1',
                name: 'P1',
                enabled: true,
                models: ['model-a', 'model-b']
            }
        ];
        populateModelSelect();
        // source 设置 option.selected = true（DOM 属性），不一定反映为 HTML 属性
        const options = elements.modelSelect.querySelectorAll('option');
        const selected = Array.from(options).find((o) => o.selected);
        expect(selected).not.toBeUndefined();
        expect(selected.value).toBe('model-b');
    });

    it('存储 providerId 到 dataset', () => {
        state.providers = [
            {
                id: 'p1',
                name: 'P1',
                enabled: true,
                models: ['model-a']
            }
        ];
        populateModelSelect();
        const option = elements.modelSelect.querySelector('option');
        expect(option.dataset.providerId).toBe('p1');
    });

    it('多个提供商分别创建 optgroup', () => {
        state.providers = [
            { id: 'p1', name: 'P1', enabled: true, models: ['m1'] },
            { id: 'p2', name: 'P2', enabled: true, models: ['m2'] }
        ];
        populateModelSelect();
        const optgroups = elements.modelSelect.querySelectorAll('optgroup');
        expect(optgroups.length).toBe(2);
    });
});
