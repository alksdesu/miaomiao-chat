/**
 * enhancements.js 测试
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../js/core/state.js', () => ({
    state: {
        customHeaders: []
    }
}));

vi.mock('../../js/core/events.js', () => ({
    eventBus: { emit: vi.fn(), on: vi.fn(), off: vi.fn() }
}));

vi.mock('../../js/state/config.js', () => ({
    saveCurrentConfig: vi.fn()
}));

vi.mock('../../js/utils/helpers.js', () => ({
    escapeHtml: vi.fn((s) => {
        if (!s) return '';
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    })
}));

vi.mock('../../js/utils/logger.js', () => ({
    logger: { warn: vi.fn(), debug: vi.fn(), error: vi.fn(), info: vi.fn() }
}));

import { state } from '../../js/core/state.js';
import {
    initPasswordToggles,
    renderCustomHeaders,
    initCustomHeaders,
    initRippleEffects
} from '../../js/ui/enhancements.js';

describe('enhancements', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
        state.customHeaders = [];
    });

    afterEach(() => {
        document.body.innerHTML = '';
    });

    // ========== initPasswordToggles ==========
    describe('initPasswordToggles', () => {
        it('不抛错', () => {
            expect(() => initPasswordToggles()).not.toThrow();
        });

        it('初始化 aria-label', () => {
            document.body.innerHTML = `
                <input type="password" id="test-input">
                <button class="password-toggle" data-target="test-input"></button>
            `;
            initPasswordToggles();
            const btn = document.querySelector('.password-toggle');
            expect(btn.getAttribute('aria-label')).toBe('显示密码');
            expect(btn.getAttribute('role')).toBe('button');
        });

        it('点击切换密码可见性', () => {
            document.body.innerHTML = `
                <input type="password" id="test-input">
                <button class="password-toggle" data-target="test-input"></button>
            `;
            initPasswordToggles();
            const btn = document.querySelector('.password-toggle');
            const input = document.getElementById('test-input');
            btn.click();
            expect(input.type).toBe('text');
            expect(btn.classList.contains('visible')).toBe(true);
            expect(btn.getAttribute('aria-label')).toBe('隐藏密码');
        });

        it('再次点击恢复密码', () => {
            document.body.innerHTML = `
                <input type="password" id="test-input">
                <button class="password-toggle" data-target="test-input"></button>
            `;
            initPasswordToggles();
            const btn = document.querySelector('.password-toggle');
            const input = document.getElementById('test-input');
            btn.click();
            btn.click();
            expect(input.type).toBe('password');
        });

        it('目标不存在不抛错', () => {
            document.body.innerHTML = `
                <button class="password-toggle" data-target="nonexistent"></button>
            `;
            initPasswordToggles();
            const btn = document.querySelector('.password-toggle');
            expect(() => btn.click()).not.toThrow();
        });
    });

    // ========== renderCustomHeaders ==========
    describe('renderCustomHeaders', () => {
        it('无容器不抛错', () => {
            expect(() => renderCustomHeaders()).not.toThrow();
        });

        it('有容器但空 headers', () => {
            document.body.innerHTML = '<div id="custom-headers-list"></div>';
            state.customHeaders = [];
            renderCustomHeaders();
            const container = document.getElementById('custom-headers-list');
            expect(container.innerHTML).toBe('');
        });

        it('渲染已有 headers', () => {
            document.body.innerHTML = '<div id="custom-headers-list"></div>';
            state.customHeaders = [{ key: 'X-Custom', value: 'test' }];
            renderCustomHeaders();
            const container = document.getElementById('custom-headers-list');
            const rows = container.querySelectorAll('.custom-header-row');
            expect(rows.length).toBe(1);
            const keyInput = rows[0].querySelector('.header-key');
            expect(keyInput.value).toBe('X-Custom');
        });

        it('多个 headers 全部渲染', () => {
            document.body.innerHTML = '<div id="custom-headers-list"></div>';
            state.customHeaders = [
                { key: 'A', value: '1' },
                { key: 'B', value: '2' },
                { key: 'C', value: '3' }
            ];
            renderCustomHeaders();
            const rows = document.querySelectorAll('.custom-header-row');
            expect(rows.length).toBe(3);
        });
    });

    // ========== initCustomHeaders ==========
    describe('initCustomHeaders', () => {
        it('无按钮不抛错', () => {
            expect(() => initCustomHeaders()).not.toThrow();
        });

        it('有按钮和容器时初始化', () => {
            document.body.innerHTML = `
                <button id="add-custom-header"></button>
                <div id="custom-headers-list"></div>
            `;
            expect(() => initCustomHeaders()).not.toThrow();
        });

        it('点击添加按钮创建新行', async () => {
            document.body.innerHTML = `
                <button id="add-custom-header"></button>
                <div id="custom-headers-list"></div>
            `;
            state.customHeaders = [];
            initCustomHeaders();
            document.getElementById('add-custom-header').click();
            const rows = document.querySelectorAll('.custom-header-row');
            expect(rows.length).toBe(1);
            expect(state.customHeaders.length).toBe(1);
        });
    });

    // ========== initRippleEffects ==========
    describe('initRippleEffects', () => {
        it('不抛错', () => {
            expect(() => initRippleEffects()).not.toThrow();
        });

        it('注册 click 事件到 document', () => {
            const spy = vi.spyOn(document, 'addEventListener');
            initRippleEffects();
            expect(spy).toHaveBeenCalledWith('click', expect.any(Function));
            spy.mockRestore();
        });
    });
});
