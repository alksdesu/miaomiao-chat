/**
 * 内存管理器
 * 监控和管理图片内存占用，防止内存泄漏
 */

import { logger } from './logger.js';
import { eventBus } from '../core/events.js';
import { lazyImageManager } from './lazy-image.js';

function getPerformanceMemory() {
    if (typeof performance === 'undefined' || !('memory' in performance) || !performance.memory) {
        return null;
    }

    return performance.memory;
}

function getNavigatorMemory() {
    if (typeof navigator === 'undefined' || !('memory' in navigator) || !navigator.memory) {
        return null;
    }

    return navigator.memory;
}

class MemoryManager {
    constructor() {
        this.config = {
            memoryCheckInterval: 30000,
            memoryThreshold: 300 * 1024 * 1024
        };

        this.initialized = false;
        this.checkTimer = null;
        this.lastMemoryUsage = 0;
        this.imageCount = 0;
        this.lastCheckAt = null;

        this.unsubscribeBeforeSwitch = null;
        this.handleBeforeUnload = null;
        this.handleMemoryPressure = null;
        this.navigatorMemoryTarget = null;
    }

    init() {
        if (this.initialized) {
            return this;
        }

        this.initialized = true;
        this.startMemoryMonitoring();

        this.unsubscribeBeforeSwitch = eventBus.on('session:before-switch', () => {
            this.cleanupBeforeSwitch();
        });

        if (typeof window !== 'undefined') {
            this.handleBeforeUnload = () => {
                this.cleanup();
            };
            window.addEventListener('beforeunload', this.handleBeforeUnload);
        }

        this.setupMemoryPressureListener();
        return this;
    }

    /**
     * 开始内存监控
     */
    startMemoryMonitoring() {
        if (this.checkTimer) return;

        this.checkMemory();
        this.checkTimer = setInterval(() => {
            this.checkMemory();
        }, this.config.memoryCheckInterval);
    }

    /**
     * 停止内存监控
     */
    stopMemoryMonitoring() {
        if (!this.checkTimer) return;

        clearInterval(this.checkTimer);
        this.checkTimer = null;
    }

    /**
     * 检查内存使用情况
     */
    async checkMemory() {
        const memory = getPerformanceMemory();
        if (!memory) return;

        try {
            const usedJSHeapSize = memory.usedJSHeapSize;
            const jsHeapSizeLimit = memory.jsHeapSizeLimit;
            const memoryUsagePercent = (usedJSHeapSize / jsHeapSizeLimit) * 100;

            const loadedImages = document.querySelectorAll('img.lazy-image.loaded').length;
            const totalImages = document.querySelectorAll('img.lazy-image').length;

            logger.debug(
                `[MemoryManager] 内存使用: ${this.formatBytes(usedJSHeapSize)}/${this.formatBytes(jsHeapSizeLimit)} (${memoryUsagePercent.toFixed(1)}%) | 图片: ${loadedImages}/${totalImages} 已加载`
            );

            if (usedJSHeapSize > this.config.memoryThreshold) {
                logger.warn('[MemoryManager] 内存使用过高，开始清理...');
                await this.performMemoryCleanup();
            }

            this.lastMemoryUsage = usedJSHeapSize;
            this.imageCount = loadedImages;
            this.lastCheckAt = new Date().toISOString();
        } catch (error) {
            logger.error('[MemoryManager] 检查内存失败:', error);
        }
    }

    /**
     * 执行内存清理
     */
    async performMemoryCleanup() {
        logger.debug('[MemoryManager] 开始内存清理...');

        if (typeof window !== 'undefined' && typeof window.gc === 'function') {
            window.gc();
        }

        const visibleRect = {
            top: window.scrollY - 500,
            bottom: window.scrollY + window.innerHeight + 500
        };

        const images = document.querySelectorAll('img.lazy-image.loaded');

        // 先纯读收集再纯写卸载：unloadImage 改 src/class 会失效布局，
        // 读写交替会让每次 getBoundingClientRect 强制同步 reflow
        const toUnload = [];
        images.forEach((img) => {
            const rect = img.getBoundingClientRect();
            const absoluteTop = rect.top + window.scrollY;

            if (absoluteTop < visibleRect.top || absoluteTop > visibleRect.bottom) {
                toUnload.push(img);
            }
        });

        toUnload.forEach((img) => {
            this.unloadImage(img);
        });
        const unloadedCount = toUnload.length;

        this.cleanupOrphanedReferences();

        logger.debug(`[MemoryManager] 清理完成，卸载了 ${unloadedCount} 张图片`);

        if (unloadedCount > 0) {
            eventBus.emit('ui:notification', {
                message: `已释放 ${unloadedCount} 张图片内存`,
                type: 'info',
                duration: 3000
            });
        }
    }

    /**
     * 卸载单个图片
     */
    unloadImage(img) {
        if (!img.classList.contains('loaded')) return;

        img.dataset.src = img.src;
        img.src =
            'data:image/svg+xml,%3Csvg width="400" height="300" xmlns="http://www.w3.org/2000/svg"%3E%3Crect width="100%25" height="100%25" fill="%23f5f5f5"/%3E%3C/svg%3E';
        img.classList.remove('loaded', 'observed');
        img.classList.add('unloaded');

        lazyImageManager.observe(img);
    }

    /**
     * 清理孤立引用
     */
    cleanupOrphanedReferences() {
        if (lazyImageManager.loadedImages) {
            // WeakSet 会自动清理，这里只保留显式语义。
        }
    }

    /**
     * 会话切换前的清理
     */
    cleanupBeforeSwitch() {
        logger.debug('[MemoryManager] 会话切换，执行清理...');

        const images = document.querySelectorAll('img.lazy-image.loaded');
        images.forEach((img) => {
            this.unloadImage(img);
        });

        lazyImageManager.cleanup();
    }

    /**
     * 设置内存压力监听器
     */
    setupMemoryPressureListener() {
        if (this.handleMemoryPressure) return;

        const navigatorMemory = getNavigatorMemory();
        if (!navigatorMemory || typeof navigatorMemory.addEventListener !== 'function') {
            return;
        }

        this.navigatorMemoryTarget = navigatorMemory;
        this.handleMemoryPressure = (event) => {
            logger.warn('[MemoryManager] 收到内存压力事件:', event);
            this.performMemoryCleanup();
        };

        navigatorMemory.addEventListener('pressure', this.handleMemoryPressure);
    }

    /**
     * 格式化字节数
     */
    formatBytes(bytes) {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    /**
     * 获取内存统计信息
     */
    getMemoryStats() {
        const memory = getPerformanceMemory();
        if (!memory) {
            return { supported: false };
        }

        return {
            supported: true,
            used: memory.usedJSHeapSize,
            total: memory.totalJSHeapSize,
            limit: memory.jsHeapSizeLimit,
            usagePercent: (memory.usedJSHeapSize / memory.jsHeapSizeLimit) * 100,
            imageCount: this.imageCount,
            lastCheck: this.lastCheckAt
        };
    }

    /**
     * 清理
     */
    cleanup() {
        this.stopMemoryMonitoring();

        this.unsubscribeBeforeSwitch?.();
        this.unsubscribeBeforeSwitch = null;

        if (typeof window !== 'undefined' && this.handleBeforeUnload) {
            window.removeEventListener('beforeunload', this.handleBeforeUnload);
            this.handleBeforeUnload = null;
        }

        if (
            this.navigatorMemoryTarget &&
            this.handleMemoryPressure &&
            typeof this.navigatorMemoryTarget.removeEventListener === 'function'
        ) {
            this.navigatorMemoryTarget.removeEventListener('pressure', this.handleMemoryPressure);
        }

        this.navigatorMemoryTarget = null;
        this.handleMemoryPressure = null;
        this.initialized = false;
    }
}

const memoryManager = new MemoryManager();

export function initMemoryManager() {
    return memoryManager.init();
}

export function checkMemoryUsage() {
    return memoryManager.getMemoryStats();
}
