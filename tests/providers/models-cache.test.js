/**
 * models-cache.js 测试
 * 模型缓存管理
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../js/utils/logger.js', () => ({
    logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn()
    }
}));

import { getCacheEntry, setCacheEntry, clearModelsCache } from '../../js/providers/models-cache.js';

beforeEach(() => {
    clearModelsCache(); // 清除所有缓存
});

describe('setCacheEntry / getCacheEntry', () => {
    it('设置并获取缓存', () => {
        const entry = { models: ['gpt-4', 'gpt-3.5'], timestamp: Date.now() };
        setCacheEntry('provider-1', entry);
        expect(getCacheEntry('provider-1')).toEqual(entry);
    });

    it('不存在的缓存返回 undefined', () => {
        expect(getCacheEntry('nonexistent')).toBeUndefined();
    });

    it('覆盖已有缓存', () => {
        setCacheEntry('p1', { models: ['old'], timestamp: 1 });
        setCacheEntry('p1', { models: ['new'], timestamp: 2 });
        expect(getCacheEntry('p1').models).toEqual(['new']);
    });

    it('不同提供商独立缓存', () => {
        setCacheEntry('p1', { models: ['a'], timestamp: 1 });
        setCacheEntry('p2', { models: ['b'], timestamp: 2 });
        expect(getCacheEntry('p1').models).toEqual(['a']);
        expect(getCacheEntry('p2').models).toEqual(['b']);
    });
});

describe('clearModelsCache', () => {
    it('清除指定提供商缓存', () => {
        setCacheEntry('p1', { models: ['a'], timestamp: 1 });
        setCacheEntry('p2', { models: ['b'], timestamp: 2 });
        clearModelsCache('p1');
        expect(getCacheEntry('p1')).toBeUndefined();
        expect(getCacheEntry('p2')).toBeDefined();
    });

    it('清除所有缓存', () => {
        setCacheEntry('p1', { models: ['a'], timestamp: 1 });
        setCacheEntry('p2', { models: ['b'], timestamp: 2 });
        clearModelsCache();
        expect(getCacheEntry('p1')).toBeUndefined();
        expect(getCacheEntry('p2')).toBeUndefined();
    });

    it('清除不存在的提供商不报错', () => {
        expect(() => clearModelsCache('nonexistent')).not.toThrow();
    });
});
