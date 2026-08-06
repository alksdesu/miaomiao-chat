/**
 * provider-sync.js 测试
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const repositoryMocks = vi.hoisted(() => ({
    hasLazyMessages: vi.fn(
        (messages) => Array.isArray(messages) && messages.some((message) => message?._lazy)
    ),
    materializeSessionMessages: vi.fn(async (_sessionId, messages) => messages)
}));

const storageMocks = vi.hoisted(() => ({
    saveSessionMessages: vi.fn(() => Promise.resolve())
}));

vi.mock('../../js/core/state.js', () => ({
    state: {
        apiFormat: 'openai',
        geminiApiKeyInHeader: false,
        currentProviderId: null,
        currentSessionId: null,
        messages: [],
        sessionDirty: false
    }
}));

vi.mock('../../js/core/events.js', () => ({
    eventBus: { emit: vi.fn(), on: vi.fn() }
}));

vi.mock('../../js/utils/logger.js', () => ({
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

vi.mock('../../js/state/session-message-repository.js', () => repositoryMocks);
vi.mock('../../js/state/storage.js', () => storageMocks);

import { state } from '../../js/core/state.js';
import { eventBus } from '../../js/core/events.js';
import {
    syncProviderState,
    waitForProviderHistoryCleanup
} from '../../js/providers/provider-sync.js';

beforeEach(() => {
    state.apiFormat = 'openai';
    state.geminiApiKeyInHeader = false;
    state.currentProviderId = null;
    state.currentSessionId = null;
    state.messages = [];
    state.sessionDirty = false;
    repositoryMocks.materializeSessionMessages.mockImplementation(
        async (_sessionId, messages) => messages
    );
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

    it('切换提供商时清理分页历史并在请求前可等待完成', async () => {
        state.apiFormat = 'claude';
        state.currentProviderId = 'p1';
        state.currentSessionId = 's1';
        state.messages = [
            {
                id: 'm1',
                role: 'assistant',
                parts: [],
                _lazy: { sessionId: 's1', index: 0 }
            }
        ];
        const fullHistory = [
            {
                id: 'm1',
                role: 'assistant',
                parts: [
                    {
                        type: 'thinking',
                        text: 'thought',
                        signature: 'claude-signature',
                        signatureFormat: 'claude'
                    }
                ],
                meta: {
                    raw: {
                        openai: { encryptedContent: 'provider-private' }
                    }
                }
            }
        ];
        repositoryMocks.materializeSessionMessages.mockResolvedValue(fullHistory);

        syncProviderState({ id: 'p2', apiFormat: 'gemini' });
        await waitForProviderHistoryCleanup();

        expect(storageMocks.saveSessionMessages).toHaveBeenCalledWith('s1', {
            messages: fullHistory
        });
        expect(fullHistory[0].parts[0].signature).toBeUndefined();
        expect(fullHistory[0].meta.raw.openai.encryptedContent).toBeUndefined();
    });
});
