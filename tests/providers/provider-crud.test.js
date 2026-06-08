/**
 * provider-crud.js 提供商增删改查测试
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../js/core/state.js', () => ({
    state: {
        providers: [],
        currentProviderId: null,
        apiFormat: 'openai',
        selectedModel: '',
        endpoints: { openai: '', gemini: '', claude: '' },
        apiKeys: { openai: '', gemini: '', claude: '' },
        customModels: { openai: '', gemini: '', claude: '' },
        geminiApiKeyInHeader: false
    }
}));

vi.mock('../../js/core/elements.js', () => ({
    elements: { modelSelect: { value: '' } }
}));

vi.mock('../../js/core/events.js', () => ({
    eventBus: { emit: vi.fn(), on: vi.fn() }
}));

vi.mock('../../js/state/config.js', () => ({
    saveCurrentConfig: vi.fn()
}));

vi.mock('../../js/providers/provider-sync.js', () => ({
    syncProviderState: vi.fn()
}));

vi.mock('../../js/providers/key-rotation.js', () => ({
    generateKeyId: vi.fn(() => 'key-mock-123')
}));

import { state } from '../../js/core/state.js';
import { eventBus } from '../../js/core/events.js';
import { saveCurrentConfig } from '../../js/state/config.js';
import { syncProviderState } from '../../js/providers/provider-sync.js';
import {
    createProvider,
    updateProvider,
    deleteProvider,
    migrateFromLegacyConfig
} from '../../js/providers/provider-crud.js';

if (
    typeof globalThis.localStorage === 'undefined' ||
    typeof globalThis.localStorage.setItem !== 'function'
) {
    const store = new Map();
    globalThis.localStorage = {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => store.set(k, String(v)),
        removeItem: (k) => store.delete(k),
        clear: () => store.clear(),
        key: (i) => Array.from(store.keys())[i] ?? null,
        get length() {
            return store.size;
        }
    };
}

beforeEach(() => {
    state.providers = [];
    state.currentProviderId = null;
    state.apiFormat = 'openai';
    state.selectedModel = '';
    state.endpoints = { openai: '', gemini: '', claude: '' };
    state.apiKeys = { openai: '', gemini: '', claude: '' };
    state.customModels = { openai: '', gemini: '', claude: '' };
    state.geminiApiKeyInHeader = false;
    vi.clearAllMocks();
});

// ========== createProvider ==========

describe('createProvider', () => {
    it('创建基本提供商', () => {
        const provider = createProvider({
            name: 'TestProvider',
            apiFormat: 'openai',
            endpoint: 'https://api.openai.com',
            apiKey: 'sk-test'
        });
        expect(provider.name).toBe('TestProvider');
        expect(provider.apiFormat).toBe('openai');
        expect(provider.endpoint).toBe('https://api.openai.com');
        expect(provider.enabled).toBe(true);
        expect(provider.id).toBeTruthy();
    });

    it('有 apiKey 时创建 apiKeys 数组', () => {
        const provider = createProvider({ name: 'Test', apiFormat: 'openai', apiKey: 'sk-test' });
        expect(provider.apiKeys).toHaveLength(1);
        expect(provider.apiKeys[0].key).toBe('sk-test');
        expect(provider.apiKeys[0].enabled).toBe(true);
        expect(provider.currentKeyId).toBe('key-mock-123');
    });

    it('无 apiKey 时 apiKeys 为空', () => {
        const provider = createProvider({ name: 'Test', apiFormat: 'openai' });
        expect(provider.apiKeys).toHaveLength(0);
        expect(provider.currentKeyId).toBeNull();
    });

    it('默认 keyRotation 配置', () => {
        const provider = createProvider({ name: 'Test', apiFormat: 'openai' });
        expect(provider.keyRotation).toEqual({
            enabled: false,
            strategy: 'round-robin',
            rotateOnError: true,
            currentIndex: 0
        });
    });

    it('models 默认为空数组', () => {
        expect(createProvider({ name: 'Test', apiFormat: 'openai' }).models).toEqual([]);
    });

    it('传入 models', () => {
        const p = createProvider({ name: 'Test', apiFormat: 'openai', models: ['gpt-4o'] });
        expect(p.models).toEqual(['gpt-4o']);
    });

    it('添加到 state.providers', () => {
        createProvider({ name: 'Test', apiFormat: 'openai' });
        expect(state.providers).toHaveLength(1);
    });

    it('调用 saveCurrentConfig', () => {
        createProvider({ name: 'Test', apiFormat: 'openai' });
        expect(saveCurrentConfig).toHaveBeenCalledTimes(1);
    });

    it('发出 providers:added 事件', () => {
        createProvider({ name: 'Test', apiFormat: 'openai' });
        expect(eventBus.emit).toHaveBeenCalledWith('providers:added', expect.any(Object));
    });

    it('endpoint 默认为空字符串', () => {
        expect(createProvider({ name: 'Test', apiFormat: 'openai' }).endpoint).toBe('');
    });

    it('geminiApiKeyInHeader 配置', () => {
        const p = createProvider({
            name: 'Gemini',
            apiFormat: 'gemini',
            geminiApiKeyInHeader: true
        });
        expect(p.geminiApiKeyInHeader).toBe(true);
    });

    it('包含 createdAt 时间戳', () => {
        const before = Date.now();
        expect(
            createProvider({ name: 'Test', apiFormat: 'openai' }).createdAt
        ).toBeGreaterThanOrEqual(before);
    });
});

// ========== updateProvider ==========

describe('updateProvider', () => {
    it('更新提供商属性', () => {
        const provider = createProvider({ name: 'Old', apiFormat: 'openai' });
        vi.clearAllMocks();
        const updated = updateProvider(provider.id, { name: 'New' });
        expect(updated.name).toBe('New');
    });

    it('不存在的 id 返回 null', () => {
        expect(updateProvider('non-existent', { name: 'Test' })).toBeNull();
    });

    it('当前提供商更新时同步 state', () => {
        const provider = createProvider({ name: 'Test', apiFormat: 'openai' });
        state.currentProviderId = provider.id;
        vi.clearAllMocks();
        updateProvider(provider.id, { endpoint: 'https://new.com' });
        expect(syncProviderState).toHaveBeenCalled();
    });

    it('非当前提供商更新时不同步', () => {
        const p1 = createProvider({ name: 'P1', apiFormat: 'openai' });
        const p2 = createProvider({ name: 'P2', apiFormat: 'openai' });
        state.currentProviderId = p1.id;
        vi.clearAllMocks();
        updateProvider(p2.id, { name: 'Updated' });
        expect(syncProviderState).not.toHaveBeenCalled();
    });

    it('调用 saveCurrentConfig', () => {
        const provider = createProvider({ name: 'Test', apiFormat: 'openai' });
        vi.clearAllMocks();
        updateProvider(provider.id, { name: 'Updated' });
        expect(saveCurrentConfig).toHaveBeenCalledTimes(1);
    });

    it('发出 providers:updated 事件', () => {
        const provider = createProvider({ name: 'Test', apiFormat: 'openai' });
        vi.clearAllMocks();
        updateProvider(provider.id, { name: 'Updated' });
        expect(eventBus.emit).toHaveBeenCalledWith(
            'providers:updated',
            expect.objectContaining({ id: provider.id })
        );
    });

    it('选中的模型在 provider 中时同步', () => {
        const provider = createProvider({
            name: 'Test',
            apiFormat: 'openai',
            models: [{ id: 'gpt-4o', name: 'GPT-4o' }]
        });
        state.currentProviderId = null;
        state.selectedModel = 'gpt-4o';
        vi.clearAllMocks();
        updateProvider(provider.id, { endpoint: 'https://new.com' });
        expect(syncProviderState).toHaveBeenCalled();
    });
});

// ========== deleteProvider ==========

describe('deleteProvider', () => {
    it('删除提供商', () => {
        const provider = createProvider({ name: 'Test', apiFormat: 'openai' });
        vi.clearAllMocks();
        expect(deleteProvider(provider.id)).toBe(true);
        expect(state.providers).toHaveLength(0);
    });

    it('不存在的 id 返回 false', () => {
        expect(deleteProvider('non-existent')).toBe(false);
    });

    it('删除当前提供商时切换到其他', () => {
        const p1 = createProvider({ name: 'P1', apiFormat: 'openai' });
        const p2 = createProvider({ name: 'P2', apiFormat: 'openai' });
        state.currentProviderId = p1.id;
        vi.clearAllMocks();
        deleteProvider(p1.id);
        expect(state.currentProviderId).toBe(p2.id);
    });

    it('删除唯一提供商时 currentProviderId 为 null', () => {
        const provider = createProvider({ name: 'Test', apiFormat: 'openai' });
        state.currentProviderId = provider.id;
        vi.clearAllMocks();
        deleteProvider(provider.id);
        expect(state.currentProviderId).toBeNull();
    });

    it('调用 saveCurrentConfig', () => {
        const provider = createProvider({ name: 'Test', apiFormat: 'openai' });
        vi.clearAllMocks();
        deleteProvider(provider.id);
        expect(saveCurrentConfig).toHaveBeenCalledTimes(1);
    });

    it('发出 providers:deleted 事件', () => {
        const provider = createProvider({ name: 'Test', apiFormat: 'openai' });
        vi.clearAllMocks();
        deleteProvider(provider.id);
        expect(eventBus.emit).toHaveBeenCalledWith('providers:deleted', { id: provider.id });
    });
});

// ========== migrateFromLegacyConfig ==========

describe('migrateFromLegacyConfig', () => {
    it('已有提供商时跳过迁移', () => {
        state.providers = [{ id: 'existing', name: 'Existing' }];
        migrateFromLegacyConfig();
        expect(state.providers.length).toBe(1);
    });

    it('迁移 openai 旧配置', () => {
        state.providers = [];
        state.apiKeys.openai = 'sk-old';
        state.endpoints.openai = 'https://api.openai.com';
        state.apiFormat = 'openai';
        state.customModels.openai = '';
        state.customModels.gemini = '';
        state.customModels.claude = '';
        state.apiKeys.gemini = '';
        state.apiKeys.claude = '';
        state.endpoints.gemini = '';
        state.endpoints.claude = '';

        migrateFromLegacyConfig();
        expect(state.providers.length).toBeGreaterThanOrEqual(1);
        const openaiProvider = state.providers.find((p) => p.apiFormat === 'openai');
        expect(openaiProvider).toBeTruthy();
    });

    it('迁移多个旧格式', () => {
        state.providers = [];
        state.apiKeys = { openai: 'sk-1', gemini: 'gk-2', claude: '' };
        state.endpoints = {
            openai: 'https://api.openai.com',
            gemini: 'https://generativelanguage.googleapis.com',
            claude: ''
        };
        state.customModels = { openai: '', gemini: '', claude: '' };
        state.apiFormat = 'openai';

        migrateFromLegacyConfig();
        expect(state.providers.length).toBe(2);
    });

    it('包含 customModels 的迁移', () => {
        state.providers = [];
        state.apiKeys = { openai: 'sk-1', gemini: '', claude: '' };
        state.endpoints = { openai: 'https://api.openai.com', gemini: '', claude: '' };
        state.customModels = { openai: 'my-custom-model', gemini: '', claude: '' };
        state.apiFormat = 'openai';

        migrateFromLegacyConfig();
        const p = state.providers.find((p) => p.apiFormat === 'openai');
        expect(p.models).toContain('my-custom-model');
    });

    it('无旧配置为当前格式创建默认提供商', () => {
        state.providers = [];
        state.apiKeys = { openai: '', gemini: '', claude: '' };
        state.endpoints = { openai: '', gemini: '', claude: '' };
        state.customModels = { openai: '', gemini: '', claude: '' };
        state.apiFormat = 'gemini';

        migrateFromLegacyConfig();
        expect(state.providers.length).toBeGreaterThan(0);
    });
});
