/**
 * Vitest 全局 setup
 * jsdom opaque origin (about:blank) 不暴露 localStorage —— 提供 polyfill 兜底
 * 优先用 jsdom 原生 Storage 类，让测试中 vi.spyOn(Storage.prototype, 'getItem') 能命中
 */
import { beforeEach } from 'vitest';

function installLocalStoragePolyfill() {
    // jsdom 提供 Storage class 时优先继承之 —— spyOn(Storage.prototype, ...) 才能命中
    if (typeof Storage === 'function') {
        const store = new Map();
        const polyfill = Object.create(Storage.prototype);
        // configurable: true —— 允许测试中 vi.spyOn(localStorage, 'getItem') 重定义
        Object.defineProperties(polyfill, {
            getItem: {
                value: (k) => (store.has(k) ? store.get(k) : null),
                writable: true,
                configurable: true
            },
            setItem: {
                value: (k, v) => store.set(String(k), String(v)),
                writable: true,
                configurable: true
            },
            removeItem: {
                value: (k) => store.delete(String(k)),
                writable: true,
                configurable: true
            },
            clear: { value: () => store.clear(), writable: true, configurable: true },
            key: {
                value: (i) => Array.from(store.keys())[i] ?? null,
                writable: true,
                configurable: true
            },
            length: {
                get() {
                    return store.size;
                },
                configurable: true
            }
        });
        Object.defineProperty(globalThis, 'localStorage', {
            configurable: true,
            writable: true,
            value: polyfill
        });
        return;
    }

    // 非 jsdom 环境（node 默认）—— 纯 plain object 兜底
    const store = new Map();
    const polyfill = {
        getItem(k) {
            return store.has(k) ? store.get(k) : null;
        },
        setItem(k, v) {
            store.set(String(k), String(v));
        },
        removeItem(k) {
            store.delete(String(k));
        },
        clear() {
            store.clear();
        },
        key(i) {
            return Array.from(store.keys())[i] ?? null;
        },
        get length() {
            return store.size;
        }
    };
    Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        writable: true,
        value: polyfill
    });
}

beforeEach(() => {
    if (
        typeof globalThis.localStorage === 'undefined' ||
        typeof globalThis.localStorage.setItem !== 'function'
    ) {
        installLocalStoragePolyfill();
    }
});
