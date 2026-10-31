/**
 * memory-manager.js 测试
 * 内存管理：监控、清理、统计
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../js/core/events.js', () => ({
    eventBus: {
        on: vi.fn(() => vi.fn()),
        emit: vi.fn()
    }
}));

vi.mock('../../js/utils/lazy-image.js', () => ({
    lazyImageManager: {
        unloadImage: vi.fn(() => true),
        unloadAll: vi.fn(() => 0),
        cleanup: vi.fn()
    }
}));

// mock DOM
const mockImages = [];
const mockDocument = {
    querySelectorAll: vi.fn(() => mockImages)
};

const mockPerformanceMemory = {
    usedJSHeapSize: 100 * 1024 * 1024,
    totalJSHeapSize: 200 * 1024 * 1024,
    jsHeapSizeLimit: 2048 * 1024 * 1024
};

vi.stubGlobal('document', mockDocument);
vi.stubGlobal('performance', { memory: mockPerformanceMemory });
vi.stubGlobal('navigator', {});
vi.stubGlobal('window', {
    scrollY: 0,
    innerHeight: 800,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn()
});

import { initMemoryManager, checkMemoryUsage } from '../../js/utils/memory-manager.js';
import { lazyImageManager } from '../../js/utils/lazy-image.js';
import { eventBus } from '../../js/core/events.js';

beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockImages.length = 0;
});

afterEach(() => {
    vi.useRealTimers();
});

describe('initMemoryManager', () => {
    it('返回管理器实例', () => {
        const manager = initMemoryManager();
        expect(manager).toBeDefined();
        manager.cleanup();
    });

    it('重复初始化不重复设置', () => {
        const m1 = initMemoryManager();
        const m2 = initMemoryManager();
        expect(m1).toBe(m2);
        m1.cleanup();
    });
});

describe('checkMemoryUsage', () => {
    it('返回内存统计', () => {
        const stats = checkMemoryUsage();
        expect(stats).toHaveProperty('supported', true);
        expect(stats).toHaveProperty('used');
        expect(stats).toHaveProperty('total');
        expect(stats).toHaveProperty('limit');
        expect(stats).toHaveProperty('usagePercent');
    });

    it('计算使用率', () => {
        const stats = checkMemoryUsage();
        const expectedPercent =
            (mockPerformanceMemory.usedJSHeapSize / mockPerformanceMemory.jsHeapSizeLimit) * 100;
        expect(stats.usagePercent).toBeCloseTo(expectedPercent, 1);
    });
});

describe('MemoryManager 内部方法', () => {
    let manager;

    beforeEach(() => {
        manager = initMemoryManager();
    });

    afterEach(() => {
        manager.cleanup();
    });

    it('formatBytes - 0 bytes', () => {
        expect(manager.formatBytes(0)).toBe('0 B');
    });

    it('formatBytes - KB', () => {
        expect(manager.formatBytes(1024)).toBe('1 KB');
    });

    it('formatBytes - MB', () => {
        expect(manager.formatBytes(1024 * 1024)).toBe('1 MB');
    });

    it('formatBytes - GB', () => {
        expect(manager.formatBytes(1024 * 1024 * 1024)).toBe('1 GB');
    });

    it('formatBytes - 小数', () => {
        const result = manager.formatBytes(1536);
        expect(result).toBe('1.5 KB');
    });

    it('stopMemoryMonitoring 清除定时器', () => {
        manager.startMemoryMonitoring();
        manager.stopMemoryMonitoring();
        expect(manager.checkTimer).toBeNull();
    });

    it('cleanup 重置状态', () => {
        manager.cleanup();
        expect(manager.initialized).toBe(false);
        expect(manager.checkTimer).toBeNull();
    });

    it('getMemoryStats 在无 performance.memory 时', () => {
        const origMemory = performance.memory;
        delete performance.memory;
        const stats = manager.getMemoryStats();
        expect(stats).toEqual({ supported: false });
        performance.memory = origMemory;
    });

    it('内存清理把视口外的图片交给懒加载器卸载，按实际卸载数提示', async () => {
        const inView = { getBoundingClientRect: () => ({ top: 100 }) };
        const below = { getBoundingClientRect: () => ({ top: 5000 }) };
        const protectedAbove = { getBoundingClientRect: () => ({ top: -2000 }) };
        mockImages.push(inView, below, protectedAbove);
        lazyImageManager.unloadImage.mockImplementation((img) => img === below);

        await manager.performMemoryCleanup();

        expect(lazyImageManager.unloadImage).toHaveBeenCalledTimes(2);
        expect(lazyImageManager.unloadImage).toHaveBeenCalledWith(below);
        expect(lazyImageManager.unloadImage).toHaveBeenCalledWith(protectedAbove);
        expect(eventBus.emit).toHaveBeenCalledWith(
            'ui:notification',
            expect.objectContaining({ message: '已释放 1 张图片内存' })
        );
    });

    it('视口外的图片都受保护时不提示', async () => {
        mockImages.push({ getBoundingClientRect: () => ({ top: 5000 }) });
        lazyImageManager.unloadImage.mockImplementation(() => false);

        await manager.performMemoryCleanup();

        expect(lazyImageManager.unloadImage).toHaveBeenCalledTimes(1);
        expect(eventBus.emit).not.toHaveBeenCalledWith('ui:notification', expect.anything());
    });

    it('切换会话前强制卸载全部图片且不再观察，之后清理懒加载器', () => {
        manager.cleanupBeforeSwitch();

        expect(lazyImageManager.unloadAll).toHaveBeenCalledWith({ force: true, reobserve: false });
        expect(lazyImageManager.unloadAll.mock.invocationCallOrder[0]).toBeLessThan(
            lazyImageManager.cleanup.mock.invocationCallOrder[0]
        );
    });
});
