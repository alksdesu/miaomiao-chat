/**
 * providers/ui.js 测试
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../js/utils/logger.js', () => ({
    logger: { warn: vi.fn(), debug: vi.fn(), error: vi.fn(), info: vi.fn() }
}));

vi.mock('../../js/core/state.js', () => ({
    state: {
        providers: []
    }
}));

vi.mock('../../js/core/elements.js', () => ({
    elements: {
        providersToggle: null,
        closeProvidersModal: null,
        providersModal: null,
        providersSearchInput: null,
        addProviderBtn: null
    }
}));

vi.mock('../../js/core/events.js', () => ({
    eventBus: { emit: vi.fn(), on: vi.fn(), off: vi.fn() }
}));

vi.mock('../../js/utils/modal-stack.js', () => ({
    bindTopmostEscape: vi.fn(() => vi.fn())
}));

vi.mock('../../js/providers/shared-state.js', () => ({
    getSelectedProviderId: vi.fn(() => null),
    setSelectedProviderId: vi.fn()
}));

vi.mock('../../js/providers/provider-list.js', () => ({
    renderProvidersList: vi.fn(),
    showEmptyState: vi.fn(),
    showMobileDetail: vi.fn(),
    backToProviderList: vi.fn()
}));

vi.mock('../../js/providers/provider-form.js', () => ({
    showProviderForm: vi.fn()
}));

vi.mock('../../js/providers/model-selector.js', () => ({
    initModelSelectorEvents: vi.fn()
}));

import { elements } from '../../js/core/elements.js';
import { state } from '../../js/core/state.js';
import { initProvidersUI } from '../../js/providers/ui.js';

describe('providers/ui', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        document.body.innerHTML = '';
        state.providers = [];
    });

    afterEach(() => {
        document.body.innerHTML = '';
    });

    it('elements 全 null 不抛错', () => {
        elements.providersToggle = null;
        elements.closeProvidersModal = null;
        elements.providersModal = null;
        elements.providersSearchInput = null;
        elements.addProviderBtn = null;
        expect(() => initProvidersUI()).not.toThrow();
    });

    it('绑定 providersToggle click', () => {
        const btn = document.createElement('button');
        elements.providersToggle = btn;
        const spy = vi.spyOn(btn, 'addEventListener');
        initProvidersUI();
        expect(spy).toHaveBeenCalledWith('click', expect.any(Function));
    });

    it('绑定 closeProvidersModal click', () => {
        const btn = document.createElement('button');
        elements.closeProvidersModal = btn;
        const spy = vi.spyOn(btn, 'addEventListener');
        initProvidersUI();
        expect(spy).toHaveBeenCalledWith('click', expect.any(Function));
    });

    it('绑定 search input', () => {
        const input = document.createElement('input');
        elements.providersSearchInput = input;
        const spy = vi.spyOn(input, 'addEventListener');
        initProvidersUI();
        expect(spy).toHaveBeenCalledWith('input', expect.any(Function));
    });

    it('绑定 addProviderBtn click', () => {
        const btn = document.createElement('button');
        elements.addProviderBtn = btn;
        const spy = vi.spyOn(btn, 'addEventListener');
        initProvidersUI();
        expect(spy).toHaveBeenCalledWith('click', expect.any(Function));
    });

    it('监听 providers 事件', async () => {
        initProvidersUI();
        const { eventBus } = await import('../../js/core/events.js');
        const eventNames = eventBus.on.mock.calls.map((c) => c[0]);
        expect(eventNames).toContain('providers:added');
        expect(eventNames).toContain('providers:updated');
        expect(eventNames).toContain('providers:deleted');
        expect(eventNames).toContain('providers:switched');
    });

    it('调用 initModelSelectorEvents', async () => {
        initProvidersUI();
        const { initModelSelectorEvents } = await import('../../js/providers/model-selector.js');
        expect(initModelSelectorEvents).toHaveBeenCalled();
    });
});
