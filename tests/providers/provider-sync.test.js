/**
 * provider-sync.js 测试
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../js/core/state.js', () => ({
    state: {
        apiFormat: 'openai',
        geminiApiKeyInHeader: false,
        currentProviderId: null
    }
}));

vi.mock('../../js/core/events.js', () => ({
    eventBus: { emit: vi.fn(), on: vi.fn() }
}));

vi.mock('../../js/utils/logger.js', () => ({
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

import { state } from '../../js/core/state.js';
import { eventBus } from '../../js/core/events.js';
import { syncProviderState } from '../../js/providers/provider-sync.js';

beforeEach(() => {
    state.apiFormat = 'openai';
    state.geminiApiKeyInHeader = false;
    state.currentProviderId = null;
    vi.clearAllMocks();
});

describe('syncProviderState', () => {
    it('null provider 不报错', () => {
        expect(() => syncProviderState(null)).not.toThrow();
    });

    it('同步 apiFormat', () => {
        syncProviderState({ id: 'p1', apiFormat: 'claude' });
        expect(state.apiFormat).toBe('claude');
    });

    it('相同 apiFormat 不重复设置', () => {
        state.apiFormat = 'openai';
        syncProviderState({ id: 'p1', apiFormat: 'openai' });
        expect(state.apiFormat).toBe('openai');
    });

    it('Gemini 同步 geminiApiKeyInHeader', () => {
        syncProviderState({ id: 'p1', apiFormat: 'gemini', geminiApiKeyInHeader: true });
        expect(state.geminiApiKeyInHeader).toBe(true);
    });

    it('非 Gemini 不同步 geminiApiKeyInHeader', () => {
        syncProviderState({ id: 'p1', apiFormat: 'openai', geminiApiKeyInHeader: true });
        expect(state.geminiApiKeyInHeader).toBe(false);
    });

    it('格式变更发出 providers:switched', () => {
        syncProviderState({ id: 'p1', apiFormat: 'claude' });
        expect(eventBus.emit).toHaveBeenCalledWith(
            'providers:switched',
            expect.objectContaining({
                provider: expect.objectContaining({ apiFormat: 'claude' })
            })
        );
    });

    it('providerId 变更发出 providers:switched', () => {
        state.currentProviderId = 'p1';
        syncProviderState({ id: 'p2', apiFormat: 'openai' });
        expect(eventBus.emit).toHaveBeenCalledWith('providers:switched', expect.any(Object));
    });

    it('相同格式和 providerId 不发出事件', () => {
        state.currentProviderId = 'p1';
        syncProviderState({ id: 'p1', apiFormat: 'openai' });
        expect(eventBus.emit).not.toHaveBeenCalled();
    });
});
