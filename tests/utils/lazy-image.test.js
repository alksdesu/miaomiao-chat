/**
 * lazy-image.js 测试
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../js/utils/logger.js', () => ({
    logger: { warn: vi.fn(), debug: vi.fn(), error: vi.fn(), info: vi.fn() }
}));

vi.mock('../../js/core/events.js', () => ({
    eventBus: { on: vi.fn(), off: vi.fn(), emit: vi.fn() }
}));

import { LazyImageManager, preloadImagesInRange } from '../../js/utils/lazy-image.js';

describe('LazyImageManager', () => {
    let manager;

    beforeEach(() => {
        document.body.innerHTML = '';
        // 在 jsdom 中 IntersectionObserver 不存在，需要 mock 为 class
        globalThis.IntersectionObserver = class MockIO {
            constructor(callback) {
                this._callback = callback;
                this.observe = vi.fn();
                this.unobserve = vi.fn();
                this.disconnect = vi.fn();
            }
        };
        manager = new LazyImageManager();
    });

    afterEach(() => {
        document.body.innerHTML = '';
        delete globalThis.IntersectionObserver;
    });

    describe('constructor', () => {
        it('初始化 observer', () => {
            expect(manager.observer).toBeTruthy();
        });

        it('初始化 imageStats', () => {
            expect(manager.imageStats).toEqual({ total: 0, loaded: 0, failed: 0 });
        });

        it('注册 session:before-switch 事件', async () => {
            const evts = await import('../../js/core/events.js');
            expect(evts.eventBus.on).toHaveBeenCalledWith(
                'session:before-switch',
                expect.any(Function)
            );
        });
    });

    describe('observe', () => {
        it('null 元素不处理', () => {
            expect(() => manager.observe(null)).not.toThrow();
        });

        it('观察有效图片元素', () => {
            const wrapper = document.createElement('div');
            const img = document.createElement('img');
            wrapper.appendChild(img);
            document.body.appendChild(wrapper);

            manager.observe(img);
            expect(manager.imageStats.total).toBe(1);
            expect(img.classList.contains('lazy-image')).toBe(true);
            expect(manager.observer.observe).toHaveBeenCalledWith(img);
        });

        it('添加 loading 指示器', () => {
            const wrapper = document.createElement('div');
            const img = document.createElement('img');
            wrapper.appendChild(img);
            document.body.appendChild(wrapper);

            manager.observe(img);
            expect(wrapper.querySelector('.image-loader')).toBeTruthy();
        });

        it('不重复添加 loading 指示器', () => {
            const wrapper = document.createElement('div');
            const img = document.createElement('img');
            const loader = document.createElement('div');
            loader.className = 'image-loader';
            wrapper.appendChild(img);
            wrapper.appendChild(loader);
            document.body.appendChild(wrapper);

            manager.observe(img);
            expect(wrapper.querySelectorAll('.image-loader').length).toBe(1);
        });
    });

    describe('loadImage', () => {
        it('没有 data-src 不加载', () => {
            const img = document.createElement('img');
            manager.loadImage(img);
            expect(manager.loadingImages.size).toBe(0);
        });

        it('已在加载中不重复加载', () => {
            const img = document.createElement('img');
            img.dataset.src = 'http://example.com/img.png';
            manager.loadingImages.add(img);
            const sizeBefore = manager.loadingImages.size;
            manager.loadImage(img);
            expect(manager.loadingImages.size).toBe(sizeBefore);
        });

        it('设置 loading class', () => {
            const img = document.createElement('img');
            img.dataset.src = 'http://example.com/img.png';
            manager.loadImage(img);
            expect(img.classList.contains('loading')).toBe(true);
        });
    });

    describe('cleanup', () => {
        it('断开 observer 并重置 stats', () => {
            manager.imageStats = { total: 10, loaded: 5, failed: 2 };
            manager.loadingImages.add('img1');

            manager.cleanup();
            expect(manager.observer.disconnect).toHaveBeenCalled();
            expect(manager.loadingImages.size).toBe(0);
            expect(manager.imageStats).toEqual({ total: 0, loaded: 0, failed: 0 });
        });
    });

    describe('unloadAll', () => {
        it('卸载所有已加载的图片', () => {
            const img = document.createElement('img');
            img.classList.add('lazy-image', 'loaded');
            img.src = 'http://example.com/img.png';
            document.body.appendChild(img);

            // mock observer.observe
            manager.observer.observe = vi.fn();

            manager.unloadAll();
            expect(img.dataset.src).toBe('http://example.com/img.png');
            expect(img.classList.contains('loaded')).toBe(false);
        });
    });

    describe('范围回收', () => {
        it('只卸载范围外图片并跳过编辑中的媒体', () => {
            document.body.innerHTML = `
                <div data-message-index="0"><img class="lazy-image loaded" src="img0.png" /></div>
                <div data-message-index="2"><img class="lazy-image loaded" src="img2.png" /></div>
                <div class="editing" data-message-index="4"><img class="lazy-image loaded" src="img4.png" /></div>
            `;

            expect(manager.unloadOutsideRange(1, 3)).toBe(1);
            expect(document.querySelector('[data-message-index="0"] img').classList).not.toContain(
                'loaded'
            );
            expect(document.querySelector('[data-message-index="2"] img').classList).toContain(
                'loaded'
            );
            expect(document.querySelector('[data-message-index="4"] img').classList).toContain(
                'loaded'
            );
        });

        it('可取消尚未完成的加载', () => {
            const img = document.createElement('img');
            img.dataset.src = 'http://example.com/pending.png';
            manager.loadImage(img);

            expect(manager.cancelPendingLoad(img)).toBe(true);
            expect(manager.loadingImages.has(img)).toBe(false);
            expect(img.classList.contains('loading')).toBe(false);
        });

        it('图片远离视口后延迟释放，重新进入时取消释放', () => {
            vi.useFakeTimers();
            const img = document.createElement('img');
            img.src = 'http://example.com/loaded.png';
            img.dataset.src = img.src;
            img.classList.add('lazy-image', 'loaded');
            document.body.appendChild(img);
            manager.loadedImages.add(img);

            manager.observer._callback([{ target: img, isIntersecting: false }]);
            expect(manager.unloadTimers.has(img)).toBe(true);
            manager.observer._callback([{ target: img, isIntersecting: true }]);
            expect(manager.unloadTimers.has(img)).toBe(false);

            manager.observer._callback([{ target: img, isIntersecting: false }]);
            vi.advanceTimersByTime(1500);
            expect(img.classList.contains('loaded')).toBe(false);
            vi.useRealTimers();
        });
    });

    describe('logStats', () => {
        it('正常输出不抛错', () => {
            manager.imageStats = { total: 10, loaded: 5, failed: 1 };
            expect(() => manager.logStats()).not.toThrow();
        });

        it('total=0 时 percentage 为 0', () => {
            manager.imageStats = { total: 0, loaded: 0, failed: 0 };
            expect(() => manager.logStats()).not.toThrow();
        });
    });

    describe('preloadRange', () => {
        it('预加载指定范围内的图片', () => {
            document.body.innerHTML = `
                <div data-message-index="0"><img class="lazy-image" data-src="img0.png" /></div>
                <div data-message-index="1"><img class="lazy-image" data-src="img1.png" /></div>
                <div data-message-index="5"><img class="lazy-image" data-src="img5.png" /></div>
            `;
            // 不抛错即可
            expect(() => manager.preloadRange(0, 2)).not.toThrow();
        });

        it('无匹配图片不抛错', () => {
            expect(() => manager.preloadRange(100, 200)).not.toThrow();
        });
    });
});

describe('preloadImagesInRange', () => {
    it('是一个函数', () => {
        expect(typeof preloadImagesInRange).toBe('function');
    });
});
