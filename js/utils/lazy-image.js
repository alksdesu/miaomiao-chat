/**
 * 图片懒加载管理器
 * 优化大量图片加载性能，特别是4K图片场景
 */

import { logger } from './logger.js';
import { eventBus } from '../core/events.js';
import { longChatPerformance } from './long-chat-performance.js';

const IMAGE_PLACEHOLDER =
    'data:image/svg+xml,%3Csvg width="400" height="300" xmlns="http://www.w3.org/2000/svg"%3E%3Crect width="100%25" height="100%25" fill="%23f0f0f0"/%3E%3C/svg%3E';
const OFFSCREEN_UNLOAD_DELAY_MS = 1500;

/**
 * 图片懒加载管理器类
 */
export class LazyImageManager {
    constructor() {
        this.observer = null;
        this.loadedImages = new WeakSet(); // 使用WeakSet避免内存泄漏
        this.observedImages = new WeakSet();
        this.loadingImages = new Set(); // 正在加载的图片
        this.pendingLoaders = new WeakMap();
        this.unloadTimers = new Map();
        this.pinnedImages = new WeakSet();
        this.ownedObjectUrls = new Set();
        this.imageStats = {
            total: 0,
            loaded: 0,
            failed: 0
        };
        this.init();
    }

    init() {
        if (typeof IntersectionObserver !== 'undefined') {
            this.observer = new IntersectionObserver(
                (entries) => {
                    entries.forEach((entry) => {
                        if (entry.isIntersecting) {
                            this.cancelScheduledUnload(entry.target);
                            this.loadImage(entry.target);
                        } else {
                            this.cancelPendingLoad(entry.target);
                            this.scheduleUnload(entry.target);
                        }
                    });
                },
                {
                    // 提前加载视口外的图片，改善滚动体验
                    rootMargin: '200px',
                    // 只有图片10%可见时才开始加载
                    threshold: 0.1
                }
            );
        }

        // 监听会话切换事件，清理旧图片
        eventBus.on('session:before-switch', () => {
            this.cleanup();
        });
    }

    /**
     * 观察图片元素
     * @param {HTMLImageElement} img - 图片元素
     */
    observe(img) {
        if (!img || this.loadedImages.has(img)) return;

        img.loading = 'lazy';
        img.decoding = 'async';

        if (!this.observer) {
            this.loadImage(img);
            return;
        }

        if (!this.observedImages.has(img)) {
            this.observedImages.add(img);
            this.imageStats.total++;
        }
        longChatPerformance.setGauge('observedImages', this.imageStats.total);
        this.observer.observe(img);

        // 添加占位符样式
        img.classList.add('lazy-image');

        // 添加加载指示器
        const wrapper = img.parentElement;
        if (wrapper && !wrapper.querySelector('.image-loader')) {
            const loader = document.createElement('div');
            loader.className = 'image-loader';
            // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
            loader.innerHTML = '<div class="spinner"></div>';
            wrapper.appendChild(loader);
        }
    }

    /**
     * 加载图片
     * @param {HTMLImageElement} img - 图片元素
     */
    loadImage(img) {
        const src = img.dataset.src;
        if (!src || this.loadedImages.has(img) || this.loadingImages.has(img)) return;

        this.loadingImages.add(img);
        img.classList.add('loading');

        // 创建临时图片对象进行预加载
        const tempImg = new Image();
        this.pendingLoaders.set(img, tempImg);

        // 加载成功
        tempImg.onload = () => {
            // 淡入动画
            img.style.opacity = '0';
            img.src = src;

            requestAnimationFrame(() => {
                img.style.transition = 'opacity 0.3s ease';
                img.style.opacity = '1';

                img.classList.remove('loading');
                img.classList.add('loaded');

                // 移除加载指示器
                const loader = img.parentElement?.querySelector('.image-loader');
                if (loader) {
                    loader.remove();
                }

                this.loadedImages.add(img);
                this.loadingImages.delete(img);
                this.pendingLoaders.delete(img);
                this.imageStats.loaded++;
                longChatPerformance.setGauge('loadedImages', this.imageStats.loaded);
                this.logStats();
            });
        };

        // 加载失败
        tempImg.onerror = () => {
            img.classList.remove('loading');
            img.classList.add('error');

            // 显示错误占位图
            img.src =
                'data:image/svg+xml,%3Csvg width="400" height="300" xmlns="http://www.w3.org/2000/svg"%3E%3Crect width="100%25" height="100%25" fill="%23fee" stroke="%23c00" stroke-width="2"/%3E%3Ctext x="50%25" y="50%25" text-anchor="middle" dominant-baseline="middle" fill="%23c00"%3E图片加载失败%3C/text%3E%3C/svg%3E';

            // 移除加载指示器
            const loader = img.parentElement?.querySelector('.image-loader');
            if (loader) {
                loader.remove();
            }

            this.loadingImages.delete(img);
            this.pendingLoaders.delete(img);
            this.observer?.unobserve(img);
            this.imageStats.failed++;
            longChatPerformance.setGauge('failedImages', this.imageStats.failed);
            this.logStats();

            logger.error('[LazyImage] 图片加载失败:', src);
        };

        // 开始加载
        tempImg.src = src;
    }

    /**
     * 清理所有观察
     */
    cleanup() {
        this.observer?.disconnect();
        for (const timerId of this.unloadTimers.values()) clearTimeout(timerId);
        this.unloadTimers.clear();
        for (const img of this.loadingImages) this.cancelPendingLoad(img);
        this.loadingImages.clear();
        this.imageStats = { total: 0, loaded: 0, failed: 0 };
        this.observedImages = new WeakSet();
        this.loadedImages = new WeakSet();
        this.revokeAllObjectUrls();
        longChatPerformance.setGauge('observedImages', 0);
        longChatPerformance.setGauge('loadedImages', 0);
        longChatPerformance.setGauge('failedImages', 0);
        logger.debug('[LazyImage] 清理完成');
    }

    /**
     * 卸载所有图片（释放内存）
     */
    unloadAll() {
        document.querySelectorAll('img.lazy-image.loaded').forEach((img) => {
            this.unloadImage(img);
        });

        logger.debug('[LazyImage] 卸载所有图片以释放内存');
    }

    cancelPendingLoad(img) {
        if (!img || !this.loadingImages.has(img)) return false;
        const loader = this.pendingLoaders.get(img);
        if (loader) {
            loader.onload = null;
            loader.onerror = null;
            loader.src = '';
        }
        this.pendingLoaders.delete(img);
        this.loadingImages.delete(img);
        img.classList?.remove('loading');
        return true;
    }

    scheduleUnload(img) {
        if (!img || this.unloadTimers.has(img) || !this.loadedImages.has(img)) return false;
        const timerId = setTimeout(() => {
            this.unloadTimers.delete(img);
            if (img.isConnected) this.unloadImage(img);
        }, OFFSCREEN_UNLOAD_DELAY_MS);
        this.unloadTimers.set(img, timerId);
        return true;
    }

    cancelScheduledUnload(img) {
        const timerId = this.unloadTimers.get(img);
        if (timerId === undefined) return false;
        clearTimeout(timerId);
        this.unloadTimers.delete(img);
        return true;
    }

    pinMedia(img) {
        if (!img) return false;
        this.pinnedImages.add(img);
        return true;
    }

    unpinMedia(img) {
        if (!img) return false;
        return this.pinnedImages.delete(img);
    }

    isProtected(img) {
        if (!img) return true;
        if (this.pinnedImages.has(img)) return true;
        if (typeof document !== 'undefined' && document.activeElement === img) return true;
        return Boolean(img.closest('.image-viewer, .viewer-modal, .editing'));
    }

    unloadImage(img, { force = false, reobserve = true } = {}) {
        if (!img || (this.isProtected(img) && !force)) return false;
        this.cancelScheduledUnload(img);
        const wasLoaded = this.loadedImages.has(img) || img.classList.contains('loaded');
        this.cancelPendingLoad(img);

        const source = img.dataset.src || img.currentSrc || img.src;
        if (source && source !== IMAGE_PLACEHOLDER) img.dataset.src = source;
        img.src = IMAGE_PLACEHOLDER;
        img.classList.remove('loaded', 'loading', 'error');
        this.loadedImages.delete(img);
        img.parentElement?.querySelector('.image-loader')?.remove();
        if (wasLoaded) this.imageStats.loaded = Math.max(0, this.imageStats.loaded - 1);
        longChatPerformance.setGauge('loadedImages', this.imageStats.loaded);

        if (reobserve && img.isConnected) this.observe(img);
        return true;
    }

    unloadOutsideRange(startIndex, endIndex, root = document) {
        if (!root || typeof root.querySelectorAll !== 'function') return 0;
        let unloaded = 0;
        root.querySelectorAll('[data-message-index] img.lazy-image').forEach((img) => {
            const messageEl = img.closest('[data-message-index]');
            const index = Number.parseInt(messageEl?.dataset.messageIndex, 10);
            if (Number.isInteger(index) && (index < startIndex || index > endIndex)) {
                if (this.unloadImage(img)) unloaded += 1;
            }
        });
        longChatPerformance.increment('evictedImages', unloaded);
        return unloaded;
    }

    trackObjectUrl(url) {
        if (typeof url === 'string' && url.startsWith('blob:')) this.ownedObjectUrls.add(url);
        return url;
    }

    revokeObjectUrl(url) {
        if (!this.ownedObjectUrls.delete(url)) return false;
        URL.revokeObjectURL(url);
        return true;
    }

    revokeAllObjectUrls() {
        for (const url of this.ownedObjectUrls) URL.revokeObjectURL(url);
        this.ownedObjectUrls.clear();
    }

    /**
     * 打印统计信息
     */
    logStats() {
        const { total, loaded, failed } = this.imageStats;
        const percentage = total > 0 ? Math.round((loaded / total) * 100) : 0;
        logger.debug(
            `[LazyImage] 统计 - 总数: ${total}, 已加载: ${loaded} (${percentage}%), 失败: ${failed}`
        );
    }

    /**
     * 预加载指定范围内的图片
     * @param {number} startIndex - 起始索引
     * @param {number} endIndex - 结束索引
     */
    preloadRange(startIndex, endIndex) {
        const images = document.querySelectorAll(
            `[data-message-index] img.lazy-image:not(.loaded)`
        );
        images.forEach((img) => {
            const messageEl = img.closest('[data-message-index]');
            if (messageEl) {
                const index = parseInt(messageEl.dataset.messageIndex);
                if (index >= startIndex && index <= endIndex) {
                    this.loadImage(img);
                }
            }
        });
    }
}

// 创建全局实例
export const lazyImageManager = new LazyImageManager();

// 导出给虚拟滚动使用的预加载函数
export function preloadImagesInRange(start, end) {
    lazyImageManager.preloadRange(start, end);
}
