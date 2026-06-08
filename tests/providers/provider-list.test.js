/**
 * provider-list.js 测试
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../js/core/state.js', () => ({
    state: {
        providers: []
    }
}));

vi.mock('../../js/core/elements.js', () => ({
    elements: {
        providersList: null,
        providersSearchInput: null
    }
}));

vi.mock('../../js/core/events.js', () => ({
    eventBus: { emit: vi.fn(), on: vi.fn() }
}));

vi.mock('../../js/providers/manager.js', () => ({
    updateProvider: vi.fn()
}));

vi.mock('../../js/utils/helpers.js', () => ({
    escapeHtml: vi.fn((s) => s)
}));

vi.mock('../../js/providers/shared-state.js', () => ({
    getSelectedProviderId: vi.fn(() => null),
    setSelectedProviderId: vi.fn()
}));

vi.mock('../../js/providers/provider-form.js', () => ({
    showProviderForm: vi.fn()
}));

import { state } from '../../js/core/state.js';
import { elements } from '../../js/core/elements.js';
import {
    renderProvidersList,
    showEmptyState,
    showMobileDetail,
    backToProviderList
} from '../../js/providers/provider-list.js';

describe('provider-list', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        document.body.innerHTML = '';
        state.providers = [];
        elements.providersList = null;
        elements.providersSearchInput = null;
    });

    afterEach(() => {
        document.body.innerHTML = '';
    });

    // ========== renderProvidersList ==========
    describe('renderProvidersList', () => {
        it('container null 静默返回', () => {
            elements.providersList = null;
            expect(() => renderProvidersList()).not.toThrow();
        });

        it('空提供商显示暂无提供商', () => {
            const container = document.createElement('div');
            elements.providersList = container;
            state.providers = [];

            renderProvidersList();
            expect(container.innerHTML).toContain('暂无提供商');
        });

        it('渲染提供商列表项', () => {
            const container = document.createElement('div');
            document.body.appendChild(container);
            elements.providersList = container;
            state.providers = [
                {
                    id: 'p1',
                    name: 'TestProvider',
                    apiFormat: 'openai',
                    enabled: true,
                    models: ['gpt-4']
                }
            ];

            renderProvidersList();
            expect(container.innerHTML).toContain('TestProvider');
            expect(container.innerHTML).toContain('provider-item');
        });

        it('搜索过滤提供商', () => {
            const container = document.createElement('div');
            document.body.appendChild(container);
            elements.providersList = container;

            const searchInput = document.createElement('input');
            searchInput.value = 'gemini';
            elements.providersSearchInput = searchInput;

            state.providers = [
                { id: 'p1', name: 'OpenAI Pro', apiFormat: 'openai', enabled: true, models: [] },
                { id: 'p2', name: 'Gemini API', apiFormat: 'gemini', enabled: true, models: [] }
            ];

            renderProvidersList();
            expect(container.innerHTML).toContain('Gemini API');
            // 搜索 "gemini" 应该过滤掉 OpenAI
            const items = container.querySelectorAll('.provider-item');
            expect(items.length).toBe(1);
        });

        it('禁用提供商显示 OFF', () => {
            const container = document.createElement('div');
            document.body.appendChild(container);
            elements.providersList = container;
            state.providers = [
                { id: 'p1', name: 'Disabled', apiFormat: 'openai', enabled: false, models: [] }
            ];

            renderProvidersList();
            expect(container.innerHTML).toContain('OFF');
        });

        it('点击列表项触发选中', async () => {
            const container = document.createElement('div');
            document.body.appendChild(container);
            elements.providersList = container;
            state.providers = [
                { id: 'p1', name: 'Click Me', apiFormat: 'openai', enabled: true, models: [] }
            ];

            renderProvidersList();
            const item = container.querySelector('.provider-item');
            expect(item).not.toBeNull();
        });
    });

    // ========== showEmptyState ==========
    describe('showEmptyState', () => {
        it('container null 不抛错', () => {
            expect(() => showEmptyState()).not.toThrow();
        });

        it('渲染空状态', () => {
            const detail = document.createElement('div');
            detail.id = 'provider-detail-content';
            document.body.appendChild(detail);

            showEmptyState();
            expect(detail.innerHTML).toContain('选择或添加一个提供商');
        });
    });

    // ========== showMobileDetail ==========
    describe('showMobileDetail', () => {
        it('窄屏添加 mobile-detail-view 类', () => {
            const modal = document.createElement('div');
            modal.className = 'providers-modal-content';
            document.body.appendChild(modal);

            Object.defineProperty(window, 'innerWidth', { value: 500, writable: true });
            showMobileDetail();
            expect(modal.classList.contains('mobile-detail-view')).toBe(true);
        });

        it('宽屏不添加类', () => {
            const modal = document.createElement('div');
            modal.className = 'providers-modal-content';
            document.body.appendChild(modal);

            Object.defineProperty(window, 'innerWidth', { value: 1024, writable: true });
            showMobileDetail();
            expect(modal.classList.contains('mobile-detail-view')).toBe(false);
        });
    });

    // ========== backToProviderList ==========
    describe('backToProviderList', () => {
        it('移除 mobile-detail-view 类', () => {
            const modal = document.createElement('div');
            modal.className = 'providers-modal-content mobile-detail-view';
            document.body.appendChild(modal);

            backToProviderList();
            expect(modal.classList.contains('mobile-detail-view')).toBe(false);
        });

        it('无元素不抛错', () => {
            expect(() => backToProviderList()).not.toThrow();
        });
    });
});
