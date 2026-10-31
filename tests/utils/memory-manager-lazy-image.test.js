/**
 * 内存管理器与懒加载器联动：两边都用真实模块，卸载后的状态必须让懒加载器能照常重新加载
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const observerHandle = vi.hoisted(() => {
    const handle = { instance: null };
    // 懒加载器单例在导入时就创建观察器，必须先于导入替换
    globalThis.IntersectionObserver = class {
        constructor(callback) {
            this.callback = callback;
            this.observe = vi.fn();
            this.unobserve = vi.fn();
            this.disconnect = vi.fn();
            handle.instance = this;
        }
    };
    return handle;
});

vi.mock('../../js/utils/logger.js', () => ({
    logger: { warn: vi.fn(), debug: vi.fn(), error: vi.fn(), info: vi.fn() }
}));

import { lazyImageManager } from '../../js/utils/lazy-image.js';
import { initMemoryManager } from '../../js/utils/memory-manager.js';
import { eventBus } from '../../js/core/events.js';

const IMAGE_URL = 'https://example.com/photo.png';

function createLoadedImage(parent = document.body) {
    const wrapper = document.createElement('div');
    const img = document.createElement('img');
    img.className = 'lazy-image loaded';
    img.src = IMAGE_URL;
    wrapper.appendChild(img);
    parent.appendChild(wrapper);
    lazyImageManager.loadedImages.add(img);
    return img;
}

function createEditingContainer() {
    const editing = document.createElement('div');
    editing.className = 'editing';
    document.body.appendChild(editing);
    return editing;
}

function placeFarBelowViewport(img) {
    img.getBoundingClientRect = () => ({ top: 5000, bottom: 5300, left: 0, right: 400 });
}

function scrollIntoView(img) {
    observerHandle.instance.callback([{ target: img, isIntersecting: true }]);
}

describe('内存管理器与懒加载器联动', () => {
    let manager;

    beforeEach(() => {
        manager = initMemoryManager();
    });

    afterEach(() => {
        manager.cleanup();
        lazyImageManager.cleanup();
        document.body.replaceChildren();
    });

    it('内存清理卸载的图片滚回视口后重新加载', async () => {
        const img = createLoadedImage();
        placeFarBelowViewport(img);

        await manager.performMemoryCleanup();

        expect(img.dataset.src).toBe(IMAGE_URL);
        expect(img.classList.contains('loaded')).toBe(false);
        expect(lazyImageManager.loadedImages.has(img)).toBe(false);

        scrollIntoView(img);
        expect(lazyImageManager.loadingImages.has(img)).toBe(true);
    });

    it('内存清理跳过编辑中的图片，也不提示释放', async () => {
        const img = createLoadedImage(createEditingContainer());
        placeFarBelowViewport(img);
        const notify = vi.fn();
        const unsubscribe = eventBus.on('ui:notification', notify);

        await manager.performMemoryCleanup();
        unsubscribe();

        expect(img.classList.contains('loaded')).toBe(true);
        expect(img.src).toBe(IMAGE_URL);
        expect(notify).not.toHaveBeenCalled();
    });

    it('切换会话前卸载全部已加载图片（含编辑中的），且不再观察旧节点', () => {
        const plain = createLoadedImage();
        const edited = createLoadedImage(createEditingContainer());
        observerHandle.instance.observe.mockClear();

        eventBus.emit('session:before-switch');

        for (const img of [plain, edited]) {
            expect(img.classList.contains('loaded')).toBe(false);
            expect(img.dataset.src).toBe(IMAGE_URL);
        }
        expect(observerHandle.instance.observe).not.toHaveBeenCalled();
        expect(document.querySelector('.image-loader')).toBeNull();
    });
});
