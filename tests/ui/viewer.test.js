/**
 * viewer.js 测试
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../js/core/events.js', () => ({
    eventBus: { emit: vi.fn(), on: vi.fn(), off: vi.fn() }
}));

// elements 从 ../core/state.js 重新导出，viewer.js 也是从 state.js import
// vi.mock 工厂会被提升到文件顶部执行，所以 mock 对象需要在 factory 内创建
vi.mock('../../js/core/state.js', () => ({
    state: {},
    elements: {
        messagesArea: {
            addEventListener: vi.fn(),
            removeEventListener: vi.fn()
        }
    }
}));

vi.mock('../../js/utils/images.js', () => ({
    downloadImage: vi.fn()
}));

vi.mock('../../js/utils/media.js', () => ({
    downloadMedia: vi.fn(),
    getMediaExtension: vi.fn(() => 'png')
}));

vi.mock('../../js/utils/modal-stack.js', () => ({
    bindTopmostEscape: vi.fn()
}));

vi.mock('../../js/utils/focus-trap.js', () => ({
    trapFocus: vi.fn(),
    removeFocusTrap: vi.fn()
}));

vi.mock('../../js/utils/logger.js', () => ({
    logger: { warn: vi.fn(), debug: vi.fn(), error: vi.fn(), info: vi.fn() }
}));

import { openImageViewer, closeImageViewer, initImageViewer } from '../../js/ui/viewer.js';
import { elements } from '../../js/core/state.js';

describe('viewer', () => {
    beforeEach(() => {
        document.body.innerHTML = `
            <div class="app-container">
                <div id="image-viewer-modal">
                    <img id="image-viewer-img" />
                    <button class="image-viewer-close"></button>
                </div>
            </div>
        `;
        elements.messagesArea.addEventListener.mockClear();
    });

    afterEach(() => {
        document.body.innerHTML = '';
    });

    // ========== openImageViewer ==========
    describe('openImageViewer', () => {
        it('打开查看器并设置 src', () => {
            openImageViewer('http://example.com/img.png');
            const modal = document.getElementById('image-viewer-modal');
            const img = document.getElementById('image-viewer-img');
            expect(modal.classList.contains('open')).toBe(true);
            expect(img.src).toContain('example.com/img.png');
        });

        it('设置 body overflow hidden', () => {
            openImageViewer('test.png');
            expect(document.body.style.overflow).toBe('hidden');
        });

        it('给 app-container 添加 inert', () => {
            openImageViewer('test.png');
            const container = document.querySelector('.app-container');
            expect(container.hasAttribute('inert')).toBe(true);
        });

        it('modal 不存在时不抛错', () => {
            document.body.innerHTML = '';
            expect(() => openImageViewer('test.png')).not.toThrow();
        });
    });

    // ========== closeImageViewer ==========
    describe('closeImageViewer', () => {
        it('关闭查看器', () => {
            openImageViewer('test.png');
            closeImageViewer();
            const modal = document.getElementById('image-viewer-modal');
            expect(modal.classList.contains('open')).toBe(false);
        });

        it('恢复 body overflow', () => {
            openImageViewer('test.png');
            closeImageViewer();
            expect(document.body.style.overflow).toBe('');
        });

        it('移除 inert', () => {
            openImageViewer('test.png');
            closeImageViewer();
            const container = document.querySelector('.app-container');
            expect(container.hasAttribute('inert')).toBe(false);
        });

        it('modal 不存在时不抛错', () => {
            document.body.innerHTML = '';
            expect(() => closeImageViewer()).not.toThrow();
        });
    });

    // ========== initImageViewer ==========
    describe('initImageViewer', () => {
        it('不抛错', () => {
            expect(() => initImageViewer()).not.toThrow();
        });

        it('注册 ui:open-image-viewer 事件监听', async () => {
            initImageViewer();
            const events = await import('../../js/core/events.js');
            expect(events.eventBus.on).toHaveBeenCalledWith(
                'ui:open-image-viewer',
                expect.any(Function)
            );
        });

        it('在 messagesArea 上挂载媒体卡片事件委托', () => {
            initImageViewer();
            expect(elements.messagesArea.addEventListener).toHaveBeenCalledWith(
                'click',
                expect.any(Function)
            );
        });

        it('不向 window 暴露全局函数（CSP 收紧后改用 ESM import + 事件委托）', () => {
            initImageViewer();
            expect(window.openImageViewer).toBeUndefined();
            expect(window.closeImageViewer).toBeUndefined();
            expect(window.downloadImage).toBeUndefined();
            expect(window.downloadMedia).toBeUndefined();
        });
    });
});
