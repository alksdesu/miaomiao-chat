/**
 * key-rotation.js 密钥轮换策略测试
 * 测试密钥管理和轮换策略的纯逻辑
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// mock 外部依赖
vi.mock('../../js/core/state.js', () => ({
    state: { providers: [] }
}));

vi.mock('../../js/core/events.js', () => ({
    eventBus: { emit: vi.fn() }
}));

vi.mock('../../js/state/config.js', () => ({
    saveCurrentConfig: vi.fn()
}));

vi.mock('../../js/providers/models-cache.js', () => ({
    clearModelsCache: vi.fn()
}));

vi.mock('../../js/utils/logger.js', () => ({
    logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn()
    }
}));

import {
    generateKeyId,
    ensureApiKeysArray,
    addApiKey,
    removeApiKey,
    setCurrentKey,
    updateApiKey,
    getActiveApiKey,
    rotateToNextKey,
    setKeyRotationConfig
} from '../../js/providers/key-rotation.js';

import { state } from '../../js/core/state.js';

function createProvider(overrides = {}) {
    return {
        id: 'p1',
        name: 'Test Provider',
        apiKey: 'original-key',
        apiKeys: null,
        currentKeyId: null,
        keyRotation: null,
        ...overrides
    };
}

beforeEach(() => {
    state.providers = [];
});

// ========== generateKeyId ==========

describe('generateKeyId', () => {
    it('以 key- 开头', () => {
        expect(generateKeyId().startsWith('key-')).toBe(true);
    });

    it('每次生成唯一 ID', () => {
        const a = generateKeyId();
        const b = generateKeyId();
        expect(a).not.toBe(b);
    });
});

// ========== ensureApiKeysArray ==========

describe('ensureApiKeysArray', () => {
    it('无 apiKeys 时初始化空数组', () => {
        const provider = { apiKey: '' };
        ensureApiKeysArray(provider);
        expect(Array.isArray(provider.apiKeys)).toBe(true);
        expect(provider.keyRotation).toBeTruthy();
        expect(provider.keyRotation.strategy).toBe('round-robin');
    });

    it('有 apiKey 时迁移为 apiKeys 数组', () => {
        const provider = { apiKey: 'sk-123' };
        ensureApiKeysArray(provider);
        expect(provider.apiKeys).toHaveLength(1);
        expect(provider.apiKeys[0].key).toBe('sk-123');
        expect(provider.apiKeys[0].enabled).toBe(true);
        expect(provider.currentKeyId).toBe(provider.apiKeys[0].id);
    });

    it('apiKeys 已存在时不重复初始化', () => {
        const provider = { apiKeys: [{ id: 'k1', key: 'existing' }] };
        ensureApiKeysArray(provider);
        expect(provider.apiKeys).toHaveLength(1);
    });
});

// ========== addApiKey ==========

describe('addApiKey', () => {
    it('添加密钥到提供商', () => {
        const provider = createProvider();
        state.providers = [provider];
        ensureApiKeysArray(provider);

        const result = addApiKey('p1', 'sk-new', '新密钥');
        expect(result).not.toBeNull();
        expect(result.key).toBe('sk-new');
        expect(result.name).toBe('新密钥');
    });

    it('重复密钥返回 null', () => {
        const provider = createProvider();
        state.providers = [provider];
        ensureApiKeysArray(provider);

        addApiKey('p1', 'sk-dup');
        const result = addApiKey('p1', 'sk-dup');
        expect(result).toBeNull();
    });

    it('不存在的提供商返回 null', () => {
        state.providers = [];
        expect(addApiKey('nonexist', 'key')).toBeNull();
    });

    it('第一个密钥自动设为当前密钥', () => {
        const provider = createProvider({ apiKey: '' });
        state.providers = [provider];
        provider.apiKeys = [];
        provider.currentKeyId = null;
        provider.keyRotation = { enabled: false, strategy: 'round-robin', currentIndex: 0 };

        const result = addApiKey('p1', 'sk-first');
        expect(provider.currentKeyId).toBe(result.id);
        expect(provider.apiKey).toBe('sk-first');
    });

    it('自动生成密钥名称', () => {
        const provider = createProvider();
        state.providers = [provider];
        ensureApiKeysArray(provider);

        const result = addApiKey('p1', 'sk-auto');
        expect(result.name).toMatch(/密钥/);
    });
});

// ========== removeApiKey ==========

describe('removeApiKey', () => {
    it('删除密钥返回 true', () => {
        const provider = createProvider();
        state.providers = [provider];
        ensureApiKeysArray(provider);
        const newKey = addApiKey('p1', 'sk-del');

        expect(removeApiKey('p1', newKey.id)).toBe(true);
    });

    it('删除不存在的密钥返回 false', () => {
        const provider = createProvider();
        state.providers = [provider];
        ensureApiKeysArray(provider);

        expect(removeApiKey('p1', 'nonexist')).toBe(false);
    });

    it('删除当前密钥后自动切换', () => {
        const provider = createProvider({ apiKey: '' });
        state.providers = [provider];
        provider.apiKeys = [];
        provider.currentKeyId = null;
        provider.keyRotation = {
            enabled: false,
            strategy: 'round-robin',
            rotateOnError: true,
            currentIndex: 0
        };

        const k1 = addApiKey('p1', 'sk-1', '密钥1');
        const k2 = addApiKey('p1', 'sk-2', '密钥2');

        // 当前密钥是 k1（第一个添加的）
        expect(provider.currentKeyId).toBe(k1.id);

        removeApiKey('p1', k1.id);
        expect(provider.currentKeyId).toBe(k2.id);
        expect(provider.apiKey).toBe('sk-2');
    });
});

// ========== setCurrentKey ==========

describe('setCurrentKey', () => {
    it('切换当前密钥', () => {
        const provider = createProvider({ apiKey: '' });
        state.providers = [provider];
        provider.apiKeys = [];
        provider.currentKeyId = null;
        provider.keyRotation = {
            enabled: false,
            strategy: 'round-robin',
            currentIndex: 0
        };

        const k1 = addApiKey('p1', 'sk-1');
        const k2 = addApiKey('p1', 'sk-2');

        expect(setCurrentKey('p1', k2.id)).toBe(true);
        expect(provider.apiKey).toBe('sk-2');
    });

    it('不存在的密钥返回 false', () => {
        const provider = createProvider();
        state.providers = [provider];
        ensureApiKeysArray(provider);

        expect(setCurrentKey('p1', 'no-such-key')).toBe(false);
    });
});

// ========== updateApiKey ==========

describe('updateApiKey', () => {
    it('更新密钥名称', () => {
        const provider = createProvider();
        state.providers = [provider];
        ensureApiKeysArray(provider);

        const key = provider.apiKeys[0];
        const result = updateApiKey('p1', key.id, { name: '新名称' });
        expect(result.name).toBe('新名称');
    });

    it('更新不存在的密钥返回 null', () => {
        const provider = createProvider();
        state.providers = [provider];
        ensureApiKeysArray(provider);

        expect(updateApiKey('p1', 'no-such', { name: 'test' })).toBeNull();
    });
});

// ========== getActiveApiKey ==========

describe('getActiveApiKey', () => {
    it('无轮询返回当前密钥', () => {
        const provider = createProvider();
        state.providers = [provider];
        ensureApiKeysArray(provider);

        const key = getActiveApiKey('p1');
        expect(key).toBe('original-key');
    });

    it('不存在的提供商返回空字符串', () => {
        state.providers = [];
        expect(getActiveApiKey('nonexist')).toBe('');
    });

    it('轮询 round-robin 策略循环选择', () => {
        const provider = createProvider({ apiKey: '' });
        state.providers = [provider];
        provider.apiKeys = [
            { id: 'k1', key: 'key1', enabled: true, usageCount: 0, lastUsed: null, errorCount: 0 },
            { id: 'k2', key: 'key2', enabled: true, usageCount: 0, lastUsed: null, errorCount: 0 }
        ];
        provider.currentKeyId = 'k1';
        provider.keyRotation = {
            enabled: true,
            strategy: 'round-robin',
            currentIndex: 0
        };

        const first = getActiveApiKey('p1');
        const second = getActiveApiKey('p1');
        expect([first, second]).toContain('key1');
        expect([first, second]).toContain('key2');
    });

    it('轮询 least-used 策略选使用最少的', () => {
        const provider = createProvider({ apiKey: '' });
        state.providers = [provider];
        provider.apiKeys = [
            {
                id: 'k1',
                key: 'key1',
                enabled: true,
                usageCount: 10,
                lastUsed: null,
                errorCount: 0
            },
            {
                id: 'k2',
                key: 'key2',
                enabled: true,
                usageCount: 2,
                lastUsed: null,
                errorCount: 0
            }
        ];
        provider.currentKeyId = 'k1';
        provider.keyRotation = { enabled: true, strategy: 'least-used', currentIndex: 0 };

        expect(getActiveApiKey('p1')).toBe('key2');
    });

    it('轮询 smart 策略综合考虑使用量和错误数', () => {
        const provider = createProvider({ apiKey: '' });
        state.providers = [provider];
        provider.apiKeys = [
            {
                id: 'k1',
                key: 'key1',
                enabled: true,
                usageCount: 5,
                lastUsed: null,
                errorCount: 3
            },
            {
                id: 'k2',
                key: 'key2',
                enabled: true,
                usageCount: 8,
                lastUsed: null,
                errorCount: 0
            }
        ];
        provider.currentKeyId = 'k1';
        provider.keyRotation = { enabled: true, strategy: 'smart', currentIndex: 0 };

        // k1 score = 5 + 3*10 = 35, k2 score = 8 + 0 = 8
        expect(getActiveApiKey('p1')).toBe('key2');
    });

    it('禁用的密钥不被轮询选中', () => {
        const provider = createProvider({ apiKey: '' });
        state.providers = [provider];
        provider.apiKeys = [
            {
                id: 'k1',
                key: 'disabled',
                enabled: false,
                usageCount: 0,
                lastUsed: null,
                errorCount: 0
            },
            {
                id: 'k2',
                key: 'enabled',
                enabled: true,
                usageCount: 0,
                lastUsed: null,
                errorCount: 0
            }
        ];
        provider.currentKeyId = 'k1';
        provider.keyRotation = {
            enabled: true,
            strategy: 'round-robin',
            currentIndex: 0
        };

        expect(getActiveApiKey('p1')).toBe('enabled');
    });
});

// ========== rotateToNextKey ==========

describe('rotateToNextKey', () => {
    it('切换到下一个可用密钥', () => {
        const provider = createProvider({ apiKey: '' });
        state.providers = [provider];
        provider.apiKeys = [
            {
                id: 'k1',
                key: 'key1',
                enabled: true,
                usageCount: 0,
                lastUsed: null,
                errorCount: 0
            },
            {
                id: 'k2',
                key: 'key2',
                enabled: true,
                usageCount: 0,
                lastUsed: null,
                errorCount: 0
            }
        ];
        provider.currentKeyId = 'k1';
        provider.keyRotation = {
            enabled: true,
            strategy: 'round-robin',
            currentIndex: 0
        };

        const newKey = rotateToNextKey('p1');
        expect(newKey).toBe('key2');
    });

    it('markError 增加错误计数', () => {
        const provider = createProvider({ apiKey: '' });
        state.providers = [provider];
        provider.apiKeys = [
            {
                id: 'k1',
                key: 'key1',
                enabled: true,
                usageCount: 0,
                lastUsed: null,
                errorCount: 0
            },
            {
                id: 'k2',
                key: 'key2',
                enabled: true,
                usageCount: 0,
                lastUsed: null,
                errorCount: 0
            }
        ];
        provider.currentKeyId = 'k1';
        provider.keyRotation = {
            enabled: true,
            strategy: 'round-robin',
            currentIndex: 0
        };

        rotateToNextKey('p1', true);
        expect(provider.apiKeys[0].errorCount).toBe(1);
    });

    it('只有一个密钥时返回当前密钥', () => {
        const provider = createProvider({ apiKey: 'solo' });
        state.providers = [provider];
        ensureApiKeysArray(provider);

        expect(rotateToNextKey('p1')).toBe('solo');
    });
});

// ========== setKeyRotationConfig ==========

describe('setKeyRotationConfig', () => {
    it('更新轮询配置', () => {
        const provider = createProvider();
        state.providers = [provider];
        ensureApiKeysArray(provider);

        setKeyRotationConfig('p1', { enabled: true, strategy: 'random' });
        expect(provider.keyRotation.enabled).toBe(true);
        expect(provider.keyRotation.strategy).toBe('random');
    });

    it('不存在的提供商静默忽略', () => {
        state.providers = [];
        expect(() => setKeyRotationConfig('nonexist', {})).not.toThrow();
    });
});
