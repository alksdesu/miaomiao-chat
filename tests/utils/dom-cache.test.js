/**
 * dom-cache.js 测试
 * DOM 查询缓存：DOMCache 类、全局缓存、作用域缓存
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DOMCache, domCache, createScopedCache } from '../../js/utils/dom-cache.js';

// 创建模拟 DOM 元素的辅助函数
function createMockElement(tag = 'div', connected = true) {
    return {
        tagName: tag.toUpperCase(),
        nodeType: 1,
        isConnected: connected,
        focus: vi.fn(),
        getAttribute: vi.fn(),
        getClientRects: vi.fn(() => [{}])
    };
}

function createMockContainer(elements = {}) {
    const container = createMockElement('div');
    container.querySelector = vi.fn((selector) => elements[selector] || null);
    container.querySelectorAll = vi.fn((selector) => {
        const key = `all:${selector}`;
        return elements[key] || elements[selector + ':all'] || [];
    });
    return container;
}

describe('DOMCache', () => {
    let container;
    let cache;

    beforeEach(() => {
        container = createMockContainer();
        cache = new DOMCache(container);
    });

    describe('query', () => {
        it('首次查询调用 querySelector', () => {
            const el = createMockElement();
            container.querySelector.mockReturnValue(el);

            const result = cache.query('.btn');
            expect(container.querySelector).toHaveBeenCalledWith('.btn');
            expect(result).toBe(el);
        });

        it('第二次查询从缓存获取', () => {
            const el = createMockElement();
            container.querySelector.mockReturnValue(el);

            cache.query('.btn');
            cache.query('.btn');

            expect(container.querySelector).toHaveBeenCalledTimes(1);
        });

        it('缓存元素断开连接后重新查询', () => {
            const el = createMockElement('div', true);
            container.querySelector.mockReturnValue(el);

            cache.query('.btn');
            el.isConnected = false;

            const el2 = createMockElement();
            container.querySelector.mockReturnValue(el2);

            const result = cache.query('.btn');
            expect(container.querySelector).toHaveBeenCalledTimes(2);
            expect(result).toBe(el2);
        });

        it('元素不存在返回 null', () => {
            container.querySelector.mockReturnValue(null);
            const result = cache.query('.nonexistent');
            expect(result).toBeNull();
        });

        it('null 元素不被缓存', () => {
            container.querySelector.mockReturnValue(null);
            cache.query('.nonexistent');
            cache.query('.nonexistent');
            expect(container.querySelector).toHaveBeenCalledTimes(2);
        });
    });

    describe('queryAll', () => {
        it('首次查询调用 querySelectorAll', () => {
            const els = [createMockElement(), createMockElement()];
            container.querySelectorAll.mockReturnValue(els);

            const result = cache.queryAll('.items');
            expect(container.querySelectorAll).toHaveBeenCalledWith('.items');
            expect(result).toBe(els);
        });

        it('第二次查询从缓存获取', () => {
            const els = [createMockElement()];
            container.querySelectorAll.mockReturnValue(els);

            cache.queryAll('.items');
            cache.queryAll('.items');

            expect(container.querySelectorAll).toHaveBeenCalledTimes(1);
        });

        it('空结果不缓存', () => {
            container.querySelectorAll.mockReturnValue([]);
            cache.queryAll('.empty');
            cache.queryAll('.empty');
            expect(container.querySelectorAll).toHaveBeenCalledTimes(2);
        });

        it('缓存元素断开连接后重新查询', () => {
            const el = createMockElement('div', true);
            container.querySelectorAll.mockReturnValue([el]);

            cache.queryAll('.items');
            el.isConnected = false;

            const el2 = createMockElement();
            container.querySelectorAll.mockReturnValue([el2]);

            cache.queryAll('.items');
            expect(container.querySelectorAll).toHaveBeenCalledTimes(2);
        });
    });

    describe('invalidate', () => {
        it('清除指定选择器缓存', () => {
            const el = createMockElement();
            container.querySelector.mockReturnValue(el);

            cache.query('.btn');
            expect(cache.size).toBe(1);

            cache.invalidate('.btn');
            expect(cache.size).toBe(0);
        });

        it('同时清除 query 和 queryAll 缓存', () => {
            const el = createMockElement();
            container.querySelector.mockReturnValue(el);
            container.querySelectorAll.mockReturnValue([el]);

            cache.query('.btn');
            cache.queryAll('.btn');
            expect(cache.size).toBe(2);

            cache.invalidate('.btn');
            expect(cache.size).toBe(0);
        });
    });

    describe('invalidateAll', () => {
        it('清除所有缓存', () => {
            const el = createMockElement();
            container.querySelector.mockReturnValue(el);

            cache.query('.a');
            cache.query('.b');
            expect(cache.size).toBe(2);

            cache.invalidateAll();
            expect(cache.size).toBe(0);
        });
    });

    describe('size', () => {
        it('初始为 0', () => {
            expect(cache.size).toBe(0);
        });

        it('缓存后增加', () => {
            const el = createMockElement();
            container.querySelector.mockReturnValue(el);
            cache.query('.btn');
            expect(cache.size).toBe(1);
        });
    });
});

describe('domCache (全局实例)', () => {
    beforeEach(() => {
        domCache.clearAll();
    });

    it('getCache 返回 DOMCache 实例', () => {
        const container = createMockContainer();
        const cache = domCache.getCache(container);
        expect(cache).toBeInstanceOf(DOMCache);
    });

    it('同一容器返回同一 cache', () => {
        const container = createMockContainer();
        const cache1 = domCache.getCache(container);
        const cache2 = domCache.getCache(container);
        expect(cache1).toBe(cache2);
    });

    it('query 代理到容器缓存', () => {
        const el = createMockElement();
        const container = createMockContainer();
        container.querySelector.mockReturnValue(el);

        const result = domCache.query('.btn', container);
        expect(result).toBe(el);
    });

    it('queryAll 代理到容器缓存', () => {
        const els = [createMockElement()];
        const container = createMockContainer();
        container.querySelectorAll.mockReturnValue(els);

        const result = domCache.queryAll('.items', container);
        expect(result).toBe(els);
    });

    it('invalidateContainer 清除指定容器缓存', () => {
        const el = createMockElement();
        const container = createMockContainer();
        container.querySelector.mockReturnValue(el);

        domCache.query('.btn', container);
        domCache.invalidateContainer(container);

        // 再次查询应该重新调用 querySelector
        domCache.query('.btn', container);
        expect(container.querySelector).toHaveBeenCalledTimes(2);
    });

    it('invalidateContainer 不存在的容器不抛出', () => {
        const container = createMockContainer();
        expect(() => domCache.invalidateContainer(container)).not.toThrow();
    });

    it('clearAll 清除所有缓存', () => {
        const c1 = createMockContainer();
        const c2 = createMockContainer();
        const el = createMockElement();
        c1.querySelector.mockReturnValue(el);
        c2.querySelector.mockReturnValue(el);

        domCache.query('.a', c1);
        domCache.query('.b', c2);
        domCache.clearAll();

        // 再次查询
        domCache.query('.a', c1);
        expect(c1.querySelector).toHaveBeenCalledTimes(2);
    });
});

describe('createScopedCache', () => {
    it('query 缓存结果', () => {
        const el = createMockElement();
        const container = createMockContainer();
        container.querySelector.mockReturnValue(el);

        const scoped = createScopedCache(container);

        scoped.query('.btn');
        scoped.query('.btn');

        expect(container.querySelector).toHaveBeenCalledTimes(1);
    });

    it('query 返回元素', () => {
        const el = createMockElement();
        const container = createMockContainer();
        container.querySelector.mockReturnValue(el);

        const scoped = createScopedCache(container);
        expect(scoped.query('.btn')).toBe(el);
    });

    it('query 返回 null', () => {
        const container = createMockContainer();
        container.querySelector.mockReturnValue(null);

        const scoped = createScopedCache(container);
        expect(scoped.query('.none')).toBeNull();
    });

    it('queryAll 缓存结果', () => {
        const els = [createMockElement()];
        const container = createMockContainer();
        container.querySelectorAll.mockReturnValue(els);

        const scoped = createScopedCache(container);

        scoped.queryAll('.items');
        scoped.queryAll('.items');

        expect(container.querySelectorAll).toHaveBeenCalledTimes(1);
    });

    it('queryAll 空结果不缓存', () => {
        const container = createMockContainer();
        container.querySelectorAll.mockReturnValue([]);

        const scoped = createScopedCache(container);
        scoped.queryAll('.empty');
        scoped.queryAll('.empty');

        expect(container.querySelectorAll).toHaveBeenCalledTimes(2);
    });

    it('cleanup 清除缓存', () => {
        const el = createMockElement();
        const container = createMockContainer();
        container.querySelector.mockReturnValue(el);

        const scoped = createScopedCache(container);
        scoped.query('.btn');
        scoped.cleanup();
        scoped.query('.btn');

        expect(container.querySelector).toHaveBeenCalledTimes(2);
    });
});
