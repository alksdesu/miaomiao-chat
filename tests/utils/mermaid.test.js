/**
 * mermaid.js 测试
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../js/utils/logger.js', () => ({
    logger: { warn: vi.fn(), debug: vi.fn(), error: vi.fn(), info: vi.fn() }
}));

vi.mock('../../js/core/events.js', () => ({
    eventBus: { emit: vi.fn(), on: vi.fn(), off: vi.fn() }
}));

import {
    getCurrentMermaidTheme,
    setMermaidSourcePanelVisible,
    teardownMermaidViewportWatcher,
    cleanupHiddenRenderHost
} from '../../js/utils/mermaid.js';

describe('mermaid', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
        document.documentElement.className = '';
    });

    afterEach(() => {
        document.body.innerHTML = '';
    });

    // ========== getCurrentMermaidTheme ==========
    describe('getCurrentMermaidTheme', () => {
        it('light 主题返回 default', () => {
            expect(getCurrentMermaidTheme()).toBe('default');
        });

        it('dark 主题返回 dark', () => {
            document.documentElement.classList.add('dark-theme');
            expect(getCurrentMermaidTheme()).toBe('dark');
        });
    });

    // ========== setMermaidSourcePanelVisible ==========
    describe('setMermaidSourcePanelVisible', () => {
        it('显示源码面板', () => {
            const container = document.createElement('div');
            const panel = document.createElement('div');
            panel.className = 'mermaid-source-panel';
            panel.hidden = true;
            const button = document.createElement('button');
            button.className = 'mermaid-toggle-source';
            container.appendChild(panel);
            container.appendChild(button);
            document.body.appendChild(container);

            setMermaidSourcePanelVisible(container, true);
            expect(panel.hidden).toBe(false);
            expect(button.textContent).toBe('收起源码');
            expect(button.getAttribute('aria-expanded')).toBe('true');
        });

        it('隐藏源码面板', () => {
            const container = document.createElement('div');
            const panel = document.createElement('div');
            panel.className = 'mermaid-source-panel';
            const button = document.createElement('button');
            button.className = 'mermaid-toggle-source';
            container.appendChild(panel);
            container.appendChild(button);
            document.body.appendChild(container);

            setMermaidSourcePanelVisible(container, false);
            expect(panel.hidden).toBe(true);
            expect(button.textContent).toBe('源码');
            expect(button.getAttribute('aria-expanded')).toBe('false');
        });

        it('无 sourcePanel 不抛错', () => {
            const container = document.createElement('div');
            expect(() => setMermaidSourcePanelVisible(container, true)).not.toThrow();
        });

        it('无 toggleButton 不抛错', () => {
            const container = document.createElement('div');
            const panel = document.createElement('div');
            panel.className = 'mermaid-source-panel';
            container.appendChild(panel);
            expect(() => setMermaidSourcePanelVisible(container, true)).not.toThrow();
        });
    });

    // ========== teardownMermaidViewportWatcher ==========
    describe('teardownMermaidViewportWatcher', () => {
        it('不抛错', () => {
            expect(() => teardownMermaidViewportWatcher()).not.toThrow();
        });
    });

    // ========== cleanupHiddenRenderHost ==========
    describe('cleanupHiddenRenderHost', () => {
        it('不抛错', () => {
            expect(() => cleanupHiddenRenderHost()).not.toThrow();
        });
    });
});
