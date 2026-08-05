/**
 * provider manager.js 测试
 * 测试 getCurrentProvider、getModelDisplayName、模型管理等纯函数逻辑
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// mock state
vi.mock('../../js/core/state.js', () => ({
    state: {
        providers: [],
        currentProviderId: null,
        apiFormat: 'openai',
        selectedModel: null,
        geminiApiKeyInHeader: false
    }
}));

// mock elements（无 DOM 环境）
vi.mock('../../js/core/elements.js', () => ({
    elements: {
        modelSelect: null
    }
}));

// mock events
vi.mock('../../js/core/events.js', () => ({
    eventBus: {
        emit: vi.fn(),
        on: vi.fn()
    }
}));

// mock config
vi.mock('../../js/state/config.js', () => ({
    saveCurrentConfig: vi.fn(),
    getDefaultCapabilities: vi.fn((format) => ({
        vision: false,
        thinking: false,
        format
    }))
}));

// mock provider-crud
vi.mock('../../js/providers/provider-crud.js', () => ({
    createProvider: vi.fn(),
    updateProvider: vi.fn(),
    deleteProvider: vi.fn(),
    migrateFromLegacyConfig: vi.fn()
}));

// mock key-rotation
vi.mock('../../js/providers/key-rotation.js', () => ({
    ensureApiKeysArray: vi.fn(),
    addApiKey: vi.fn(),
    removeApiKey: vi.fn(),
    setCurrentKey: vi.fn(),
    updateApiKey: vi.fn(),
    getActiveApiKey: vi.fn(() => 'test-key'),
    rotateToNextKey: vi.fn(),
    setKeyRotationConfig: vi.fn()
}));

import { state } from '../../js/core/state.js';
import { eventBus } from '../../js/core/events.js';
import {
    getCurrentProvider,
    getModelDisplayName,
    addModelToProvider,
    removeModelFromProvider,
    addModelsToProvider,
    fetchProviderModels,
    clearModelsCache,
    syncProviderState
} from '../../js/providers/manager.js';
import { saveCurrentConfig } from '../../js/state/config.js';

function makeProvider(id, name, apiFormat, models = [], enabled = true) {
    return { id, name, apiFormat, models, enabled };
}

beforeEach(() => {
    state.providers = [];
    state.currentProviderId = null;
    state.apiFormat = 'openai';
    state.selectedModel = null;
    vi.clearAllMocks();
});

// ========== getCurrentProvider ==========

describe('getCurrentProvider', () => {
    it('通过 currentProviderId 查找', () => {
        const p = makeProvider('p1', 'OpenAI', 'openai');
        state.providers = [p];
        state.currentProviderId = 'p1';

        const result = getCurrentProvider();
        expect(result).toBe(p);
    });

    it('currentProviderId 对应 provider 被禁用时回退', () => {
        state.providers = [
            makeProvider('p1', 'Disabled', 'openai', [], false),
            makeProvider('p2', 'Enabled', 'claude', [], true)
        ];
        state.currentProviderId = 'p1';

        const result = getCurrentProvider();
        expect(result.id).toBe('p2'); // 回退到第一个启用的
        expect(state.currentProviderId).toBeNull();
    });

    it('通过 selectedModel 查找', () => {
        state.providers = [
            makeProvider('p1', 'OpenAI', 'openai', ['gpt-4', 'gpt-3.5']),
            makeProvider('p2', 'Claude', 'claude', ['claude-3'])
        ];
        state.selectedModel = 'claude-3';

        const result = getCurrentProvider();
        expect(result.id).toBe('p2');
    });

    it('selectedModel 匹配对象格式模型', () => {
        state.providers = [
            makeProvider('p1', 'Provider', 'openai', [{ id: 'model-1', name: 'Model 1' }])
        ];
        state.selectedModel = 'model-1';

        const result = getCurrentProvider();
        expect(result.id).toBe('p1');
    });

    it('多个 provider 含同一模型时优先匹配 apiFormat', () => {
        state.providers = [
            makeProvider('p1', 'Provider1', 'openai', ['shared-model']),
            makeProvider('p2', 'Provider2', 'claude', ['shared-model'])
        ];
        state.selectedModel = 'shared-model';
        state.apiFormat = 'claude';

        const result = getCurrentProvider();
        expect(result.id).toBe('p2');
    });

    it('返回第一个启用的 provider 作为兜底', () => {
        state.providers = [
            makeProvider('p1', 'Disabled', 'openai', [], false),
            makeProvider('p2', 'Enabled', 'claude', [])
        ];

        const result = getCurrentProvider();
        expect(result.id).toBe('p2');
    });

    it('全部禁用时返回第一个', () => {
        state.providers = [
            makeProvider('p1', 'A', 'openai', [], false),
            makeProvider('p2', 'B', 'claude', [], false)
        ];

        const result = getCurrentProvider();
        expect(result.id).toBe('p1');
    });

    it('空 providers 返回 undefined', () => {
        state.providers = [];
        const result = getCurrentProvider();
        expect(result).toBeUndefined();
    });
});

// ========== syncProviderState ==========

describe('syncProviderState', () => {
    it('同步 apiFormat', () => {
        const p = makeProvider('p1', 'Claude', 'claude');
        state.apiFormat = 'openai';
        syncProviderState(p);
        expect(state.apiFormat).toBe('claude');
    });

    it('gemini 同步 geminiApiKeyInHeader', () => {
        const p = makeProvider('p1', 'Gemini', 'gemini');
        p.geminiApiKeyInHeader = true;
        syncProviderState(p);
        expect(state.geminiApiKeyInHeader).toBe(true);
    });

    it('格式变化时触发 providers:switched', () => {
        state.apiFormat = 'openai';
        syncProviderState(makeProvider('p1', 'Claude', 'claude'));
        expect(eventBus.emit).toHaveBeenCalledWith('providers:switched', expect.any(Object));
    });

    it('null provider 不报错', () => {
        expect(() => syncProviderState(null)).not.toThrow();
    });
});

// ========== getModelDisplayName ==========

describe('getModelDisplayName', () => {
    it('返回模型对象的 name', () => {
        state.providers = [
            makeProvider('p1', 'P', 'openai', [{ id: 'gpt-4', name: 'GPT-4 Turbo' }])
        ];
        state.currentProviderId = 'p1';

        expect(getModelDisplayName('gpt-4')).toBe('GPT-4 Turbo');
    });

    it('字符串模型返回 modelId', () => {
        state.providers = [makeProvider('p1', 'P', 'openai', ['gpt-4'])];
        state.currentProviderId = 'p1';

        expect(getModelDisplayName('gpt-4')).toBe('gpt-4');
    });

    it('未找到模型返回 modelId', () => {
        state.providers = [makeProvider('p1', 'P', 'openai', [])];
        state.currentProviderId = 'p1';

        expect(getModelDisplayName('unknown-model')).toBe('unknown-model');
    });

    it('无 modelId 返回 unknown', () => {
        expect(getModelDisplayName(null)).toBe('unknown');
        expect(getModelDisplayName('')).toBe('unknown');
    });
});

// ========== addModelToProvider ==========

describe('addModelToProvider', () => {
    it('添加字符串模型', () => {
        state.providers = [makeProvider('p1', 'P', 'openai', [])];
        const result = addModelToProvider('p1', 'new-model');
        expect(result).toBe(true);
        expect(state.providers[0].models).toHaveLength(1);
        expect(state.providers[0].models[0].id).toBe('new-model');
    });

    it('添加对象模型', () => {
        state.providers = [makeProvider('p1', 'P', 'openai', [])];
        addModelToProvider('p1', { id: 'model-1', name: 'Model One' });
        expect(state.providers[0].models[0].name).toBe('Model One');
    });

    it('重复模型不添加', () => {
        state.providers = [makeProvider('p1', 'P', 'openai', ['existing'])];
        const result = addModelToProvider('p1', 'existing');
        expect(result).toBe(false);
    });

    it('不存在的 provider 返回 false', () => {
        state.providers = [];
        expect(addModelToProvider('nonexistent', 'model')).toBe(false);
    });

    it('无效数据返回 false', () => {
        state.providers = [makeProvider('p1', 'P', 'openai', [])];
        expect(addModelToProvider('p1', 123)).toBe(false);
    });

    it('添加后触发事件和保存', () => {
        state.providers = [makeProvider('p1', 'P', 'openai', [])];
        addModelToProvider('p1', 'new-model');
        expect(saveCurrentConfig).toHaveBeenCalled();
        expect(eventBus.emit).toHaveBeenCalledWith('providers:models-changed', expect.any(Object));
    });

    it('provider 无 models 数组时初始化', () => {
        state.providers = [{ id: 'p1', name: 'P', apiFormat: 'openai', enabled: true }];
        addModelToProvider('p1', 'model-1');
        expect(state.providers[0].models).toHaveLength(1);
    });
});

// ========== removeModelFromProvider ==========

describe('removeModelFromProvider', () => {
    it('移除字符串模型', () => {
        state.providers = [makeProvider('p1', 'P', 'openai', ['model-1', 'model-2'])];
        const result = removeModelFromProvider('p1', 'model-1');
        expect(result).toBe(true);
        expect(state.providers[0].models).toHaveLength(1);
    });

    it('移除对象模型', () => {
        state.providers = [makeProvider('p1', 'P', 'openai', [{ id: 'model-1', name: 'M' }])];
        const result = removeModelFromProvider('p1', 'model-1');
        expect(result).toBe(true);
        expect(state.providers[0].models).toHaveLength(0);
    });

    it('不存在的模型返回 false', () => {
        state.providers = [makeProvider('p1', 'P', 'openai', ['model-1'])];
        expect(removeModelFromProvider('p1', 'nonexistent')).toBe(false);
    });

    it('不存在的 provider 返回 false', () => {
        expect(removeModelFromProvider('nonexistent', 'model')).toBe(false);
    });
});

// ========== addModelsToProvider ==========

describe('addModelsToProvider', () => {
    it('批量添加模型', () => {
        state.providers = [makeProvider('p1', 'P', 'openai', [])];
        const count = addModelsToProvider('p1', ['model-1', 'model-2', 'model-3']);
        expect(count).toBe(3);
        expect(state.providers[0].models).toHaveLength(3);
    });

    it('跳过已存在的模型', () => {
        state.providers = [makeProvider('p1', 'P', 'openai', ['model-1'])];
        const count = addModelsToProvider('p1', ['model-1', 'model-2']);
        expect(count).toBe(1);
    });

    it('跳过无效数据', () => {
        state.providers = [makeProvider('p1', 'P', 'openai', [])];
        // 123 是无效的 (非字符串非对象)
        // 注意: null 会导致异常（typeof null === 'object'），这里只测数字
        const count = addModelsToProvider('p1', ['valid', 123]);
        expect(count).toBe(1);
    });

    it('不存在的 provider 返回 0', () => {
        expect(addModelsToProvider('nonexistent', ['model'])).toBe(0);
    });

    it('全部为重复时不触发事件', () => {
        state.providers = [makeProvider('p1', 'P', 'openai', ['model-1'])];
        addModelsToProvider('p1', ['model-1']);
        expect(saveCurrentConfig).not.toHaveBeenCalled();
    });
});

// ========== clearModelsCache ==========

describe('clearModelsCache', () => {
    it('指定 providerId 不报错', () => {
        expect(() => clearModelsCache('p1')).not.toThrow();
    });

    it('不传参数清除所有缓存', () => {
        expect(() => clearModelsCache()).not.toThrow();
    });
});

describe('OpenAI Image 模型列表', () => {
    it('从图片端点推导 /v1/models 且不筛选模型名', async () => {
        state.providers = [
            {
                id: 'image-provider',
                name: 'Image API',
                apiFormat: 'openai-image',
                endpoint: 'https://api.example.com/v1/images/generations',
                enabled: true,
                models: []
            }
        ];
        const fetchMock = vi.fn(() =>
            Promise.resolve(
                new Response(
                    JSON.stringify({
                        data: [{ id: 'gpt-image-2' }, { id: 'vendor/custom-image:model@2' }]
                    }),
                    { status: 200 }
                )
            )
        );
        vi.stubGlobal('fetch', fetchMock);

        const models = await fetchProviderModels('image-provider', true);

        expect(fetchMock).toHaveBeenCalledWith(
            'https://api.example.com/v1/models',
            expect.objectContaining({ headers: { Authorization: 'Bearer test-key' } })
        );
        expect(models.map((model) => model.id)).toEqual([
            'gpt-image-2',
            'vendor/custom-image:model@2'
        ]);
        vi.unstubAllGlobals();
    });
});
