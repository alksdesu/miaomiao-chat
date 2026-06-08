/**
 * mobile-overflow-menu.js 移动端溢出菜单测试
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
    initMobileOverflowMenu,
    updateMobileHeaderTitle
} from '../../js/ui/mobile-overflow-menu.js';

describe('mobile-overflow-menu', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        document.body.innerHTML = '';
    });

    afterEach(() => {
        document.body.innerHTML = '';
    });

    // ========== initMobileOverflowMenu ==========
    describe('initMobileOverflowMenu', () => {
        it('元素不存在静默返回', () => {
            expect(() => initMobileOverflowMenu()).not.toThrow();
        });

        it('按钮点击切换 open class', () => {
            document.body.innerHTML = `
                <button id="mobile-overflow-btn"></button>
                <div id="mobile-overflow-menu"></div>
            `;
            initMobileOverflowMenu();

            const btn = document.getElementById('mobile-overflow-btn');
            const menu = document.getElementById('mobile-overflow-menu');

            btn.click();
            expect(menu.classList.contains('open')).toBe(true);

            btn.click();
            expect(menu.classList.contains('open')).toBe(false);
        });

        it('菜单项点击触发 target 按钮', () => {
            const spy = vi.fn();
            document.body.innerHTML = `
                <button id="mobile-overflow-btn"></button>
                <div id="mobile-overflow-menu">
                    <div class="mobile-overflow-item" data-target="target-btn"></div>
                </div>
                <button id="target-btn"></button>
            `;
            document.getElementById('target-btn').addEventListener('click', spy);
            initMobileOverflowMenu();

            const menu = document.getElementById('mobile-overflow-menu');
            menu.classList.add('open');

            document.querySelector('.mobile-overflow-item').click();
            expect(spy).toHaveBeenCalled();
            expect(menu.classList.contains('open')).toBe(false);
        });

        it('点击外部关闭菜单', () => {
            document.body.innerHTML = `
                <button id="mobile-overflow-btn"></button>
                <div id="mobile-overflow-menu"></div>
                <div id="outside"></div>
            `;
            initMobileOverflowMenu();

            const menu = document.getElementById('mobile-overflow-menu');
            menu.classList.add('open');

            document.getElementById('outside').click();
            expect(menu.classList.contains('open')).toBe(false);
        });

        it('ESC 关闭菜单', () => {
            document.body.innerHTML = `
                <button id="mobile-overflow-btn"></button>
                <div id="mobile-overflow-menu"></div>
            `;
            initMobileOverflowMenu();

            const menu = document.getElementById('mobile-overflow-menu');
            menu.classList.add('open');

            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
            expect(menu.classList.contains('open')).toBe(false);
        });

        it('菜单关闭时 ESC 不影响', () => {
            document.body.innerHTML = `
                <button id="mobile-overflow-btn"></button>
                <div id="mobile-overflow-menu"></div>
            `;
            initMobileOverflowMenu();

            const menu = document.getElementById('mobile-overflow-menu');
            expect(menu.classList.contains('open')).toBe(false);

            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
            expect(menu.classList.contains('open')).toBe(false);
        });
    });

    // ========== updateMobileHeaderTitle ==========
    describe('updateMobileHeaderTitle', () => {
        it('更新标题', () => {
            document.body.innerHTML = '<div id="mobile-header-title"></div>';
            updateMobileHeaderTitle('GPT-4');
            expect(document.getElementById('mobile-header-title').textContent).toBe('GPT-4');
        });

        it('空值清空标题', () => {
            document.body.innerHTML = '<div id="mobile-header-title">old</div>';
            updateMobileHeaderTitle('');
            expect(document.getElementById('mobile-header-title').textContent).toBe('');
        });

        it('元素不存在不抛错', () => {
            expect(() => updateMobileHeaderTitle('test')).not.toThrow();
        });
    });
});
