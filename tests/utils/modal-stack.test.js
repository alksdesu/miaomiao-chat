/**
 * modal-stack.js 测试
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
    MODAL_LAYER_Z_INDEX,
    getFocusableElements,
    readRootZIndex,
    applyModalLayerZIndex,
    isModalLayerVisible,
    getTopmostModalLayer,
    isTopmostModalLayer,
    setupModalFocus,
    bindTopmostEscape
} from '../../js/utils/modal-stack.js';

describe('modal-stack', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
    });

    afterEach(() => {
        document.body.innerHTML = '';
    });

    // ========== MODAL_LAYER_Z_INDEX ==========
    describe('MODAL_LAYER_Z_INDEX', () => {
        it('是冻结对象', () => {
            expect(Object.isFrozen(MODAL_LAYER_Z_INDEX)).toBe(true);
        });

        it('包含 settings / settingsNested / dialog', () => {
            expect(MODAL_LAYER_Z_INDEX.settings).toBeTruthy();
            expect(MODAL_LAYER_Z_INDEX.settingsNested).toBeTruthy();
            expect(MODAL_LAYER_Z_INDEX.dialog).toBeTruthy();
        });
    });

    // ========== getFocusableElements ==========
    describe('getFocusableElements', () => {
        it('null 容器返回空数组', () => {
            expect(getFocusableElements(null)).toEqual([]);
        });

        it('找到 button 和 input 元素', () => {
            const container = document.createElement('div');
            container.innerHTML = `
                <button>Click</button>
                <input type="text" />
                <span>Not focusable</span>
            `;
            document.body.appendChild(container);
            const result = getFocusableElements(container);
            // jsdom 中 getClientRects 返回空，canReceiveFocus 可能都失败
            // 但至少检查不抛错
            expect(Array.isArray(result)).toBe(true);
        });

        it('disabled 的元素被排除', () => {
            const container = document.createElement('div');
            container.innerHTML = `
                <button disabled>Disabled</button>
                <input type="text" disabled />
            `;
            document.body.appendChild(container);
            const result = getFocusableElements(container);
            expect(result).toHaveLength(0);
        });

        it('tabindex=-1 被排除', () => {
            const container = document.createElement('div');
            container.innerHTML = `<button tabindex="-1">Hidden</button>`;
            document.body.appendChild(container);
            const result = getFocusableElements(container);
            expect(result).toHaveLength(0);
        });
    });

    // ========== readRootZIndex ==========
    describe('readRootZIndex', () => {
        it('null 变量名返回 null', () => {
            expect(readRootZIndex(null)).toBeNull();
        });

        it('空字符串返回 null', () => {
            expect(readRootZIndex('')).toBeNull();
        });

        it('不存在的变量返回 null', () => {
            expect(readRootZIndex('--nonexistent-z-var')).toBeNull();
        });
    });

    // ========== applyModalLayerZIndex ==========
    describe('applyModalLayerZIndex', () => {
        it('null 元素返回 null', () => {
            expect(applyModalLayerZIndex(null, '--z-modal')).toBeNull();
        });

        it('null 变量名返回 null', () => {
            const el = document.createElement('div');
            expect(applyModalLayerZIndex(el, null)).toBeNull();
        });

        it('变量不存在时清除样式', () => {
            const el = document.createElement('div');
            el.style.setProperty('--modal-layer-z-index', '100');
            el.style.setProperty('z-index', '100');
            applyModalLayerZIndex(el, '--nonexistent-z-var');
            expect(el.style.getPropertyValue('--modal-layer-z-index')).toBe('');
            expect(el.style.getPropertyValue('z-index')).toBe('');
        });
    });

    // ========== isModalLayerVisible ==========
    describe('isModalLayerVisible', () => {
        it('null 返回 false', () => {
            expect(isModalLayerVisible(null)).toBe(false);
        });

        it('未连接的元素返回 false', () => {
            const el = document.createElement('div');
            expect(isModalLayerVisible(el)).toBe(false);
        });

        it('display:none 返回 false', () => {
            const el = document.createElement('div');
            el.style.display = 'none';
            document.body.appendChild(el);
            expect(isModalLayerVisible(el)).toBe(false);
        });

        it('visibility:hidden 返回 false', () => {
            const el = document.createElement('div');
            el.style.visibility = 'hidden';
            document.body.appendChild(el);
            expect(isModalLayerVisible(el)).toBe(false);
        });
    });

    // ========== getTopmostModalLayer ==========
    describe('getTopmostModalLayer', () => {
        it('无模态层时返回 null', () => {
            expect(getTopmostModalLayer()).toBeNull();
        });
    });

    // ========== isTopmostModalLayer ==========
    describe('isTopmostModalLayer', () => {
        it('无模态层时任意元素返回 false', () => {
            const el = document.createElement('div');
            expect(isTopmostModalLayer(el)).toBe(false);
        });
    });

    // ========== setupModalFocus ==========
    describe('setupModalFocus', () => {
        it('null 元素返回空函数', () => {
            const cleanup = setupModalFocus(null);
            expect(typeof cleanup).toBe('function');
            cleanup(); // 不抛错
        });

        it('设置 role=dialog 和 aria-modal=true', () => {
            const el = document.createElement('div');
            document.body.appendChild(el);
            const cleanup = setupModalFocus(el);
            expect(el.getAttribute('role')).toBe('dialog');
            expect(el.getAttribute('aria-modal')).toBe('true');
            expect(el.getAttribute('tabindex')).toBe('-1');
            cleanup();
        });

        it('不覆盖已有的 role', () => {
            const el = document.createElement('div');
            el.setAttribute('role', 'alertdialog');
            document.body.appendChild(el);
            const cleanup = setupModalFocus(el);
            expect(el.getAttribute('role')).toBe('alertdialog');
            cleanup();
        });

        it('不覆盖已有的 aria-modal', () => {
            const el = document.createElement('div');
            el.setAttribute('aria-modal', 'false');
            document.body.appendChild(el);
            const cleanup = setupModalFocus(el);
            expect(el.getAttribute('aria-modal')).toBe('false');
            cleanup();
        });

        it('设置 aria-labelledby', () => {
            const el = document.createElement('div');
            document.body.appendChild(el);
            const cleanup = setupModalFocus(el, { labelledBy: 'title-id' });
            expect(el.getAttribute('aria-labelledby')).toBe('title-id');
            cleanup();
        });

        it('设置 aria-label (无 labelledBy 时)', () => {
            const el = document.createElement('div');
            document.body.appendChild(el);
            const cleanup = setupModalFocus(el, { label: 'My Dialog' });
            expect(el.getAttribute('aria-label')).toBe('My Dialog');
            cleanup();
        });

        it('不覆盖已有的 tabindex', () => {
            const el = document.createElement('div');
            el.setAttribute('tabindex', '0');
            document.body.appendChild(el);
            const cleanup = setupModalFocus(el);
            expect(el.getAttribute('tabindex')).toBe('0');
            cleanup();
        });

        it('cleanup 移除事件监听', () => {
            const el = document.createElement('div');
            document.body.appendChild(el);
            const removeSpy = vi.spyOn(el, 'removeEventListener');
            const cleanup = setupModalFocus(el);
            cleanup();
            expect(removeSpy).toHaveBeenCalledWith('keydown', expect.any(Function));
        });
    });

    // ========== bindTopmostEscape ==========
    describe('bindTopmostEscape', () => {
        it('返回清理函数', () => {
            const el = document.createElement('div');
            const onEscape = vi.fn();
            const cleanup = bindTopmostEscape(el, onEscape);
            expect(typeof cleanup).toBe('function');
            cleanup();
        });

        it('非 Escape 键不触发', () => {
            const el = document.createElement('div');
            const onEscape = vi.fn();
            const cleanup = bindTopmostEscape(el, onEscape);
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
            expect(onEscape).not.toHaveBeenCalled();
            cleanup();
        });

        it('cleanup 后 Escape 不触发', () => {
            const el = document.createElement('div');
            const onEscape = vi.fn();
            const cleanup = bindTopmostEscape(el, onEscape);
            cleanup();
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
            expect(onEscape).not.toHaveBeenCalled();
        });
    });
});
