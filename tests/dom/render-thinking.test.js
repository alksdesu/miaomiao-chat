// @vitest-environment jsdom
/**
 * render-thinking.js jsdom 测试
 * 测试思维链渲染的 HTML 输出和交互
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// mock markdown 解析
vi.mock('../../js/utils/markdown.js', () => ({
    safeMarkedParse: vi.fn((text) => `<p>${text}</p>`)
}));

import {
    renderThinkingBlock,
    clearThinkingCache,
    enhanceThinkingBlocks
} from '../../js/messages/render-thinking.js';

describe('renderThinkingBlock (jsdom)', () => {
    beforeEach(() => {
        clearThinkingCache();
    });

    // ========== 空值处理 ==========

    it('空内容返回空字符串', () => {
        expect(renderThinkingBlock('')).toBe('');
        expect(renderThinkingBlock(null)).toBe('');
        expect(renderThinkingBlock(undefined)).toBe('');
    });

    // ========== 单块渲染 ==========

    it('单块生成 thinking-block 容器', () => {
        const html = renderThinkingBlock('思考内容');
        expect(html).toContain('class="thinking-block');
    });

    it('单块默认折叠状态', () => {
        const html = renderThinkingBlock('思考内容');
        expect(html).toContain('collapsed');
    });

    it('单块包含默认标签"思考过程"', () => {
        const html = renderThinkingBlock('思考内容');
        expect(html).toContain('思考过程');
    });

    it('单块包含 header 和 content 区域', () => {
        const html = renderThinkingBlock('内容');
        expect(html).toContain('thinking-header');
        expect(html).toContain('thinking-content');
    });

    it('非流式单块 content 区域为空（惰性渲染）', () => {
        const html = renderThinkingBlock('内容');
        const div = document.createElement('div');
        div.innerHTML = html;
        const content = div.querySelector('.thinking-content');
        expect(content.innerHTML.trim()).toBe('');
    });

    it('非流式单块设置 data-thinking-id', () => {
        const html = renderThinkingBlock('内容');
        const div = document.createElement('div');
        div.innerHTML = html;
        const content = div.querySelector('.thinking-content');
        expect(content.dataset.thinkingId).toMatch(/^t_\d+$/);
    });

    // ========== 流式渲染 ==========

    it('流式模式添加 streaming 类', () => {
        const html = renderThinkingBlock('streaming content', true);
        expect(html).toContain('streaming');
    });

    it('流式模式立即渲染 Markdown 内容', () => {
        const html = renderThinkingBlock('streaming content', true);
        expect(html).toContain('<p>streaming content</p>');
    });

    it('流式模式不设置 data-thinking-id', () => {
        const html = renderThinkingBlock('streaming', true);
        const div = document.createElement('div');
        div.innerHTML = html;
        const content = div.querySelector('.thinking-content');
        expect(content.dataset.thinkingId).toBeUndefined();
    });

    // ========== 多块渲染 ==========

    it('多块用分隔符分隔', () => {
        const content = '块1\n\n---\n\n块2\n\n---\n\n块3';
        const html = renderThinkingBlock(content);
        const div = document.createElement('div');
        div.innerHTML = html;
        const blocks = div.querySelectorAll('.thinking-block');
        expect(blocks.length).toBe(3);
    });

    it('多块标签为"思考阶段 N"', () => {
        const content = '块1\n\n---\n\n块2';
        const html = renderThinkingBlock(content);
        expect(html).toContain('思考阶段 1');
        expect(html).toContain('思考阶段 2');
    });

    it('多块只有最后一个块有 streaming 类', () => {
        const content = '块1\n\n---\n\n块2';
        const html = renderThinkingBlock(content, true);
        const div = document.createElement('div');
        div.innerHTML = html;
        const blocks = div.querySelectorAll('.thinking-block');
        expect(blocks[0].classList.contains('streaming')).toBe(false);
        expect(blocks[1].classList.contains('streaming')).toBe(true);
    });

    it('空块被过滤', () => {
        const content = '块1\n\n---\n\n\n\n---\n\n块2';
        const html = renderThinkingBlock(content);
        const div = document.createElement('div');
        div.innerHTML = html;
        const blocks = div.querySelectorAll('.thinking-block');
        expect(blocks.length).toBe(2);
    });

    // ========== 无障碍 ==========

    it('header 有 role=button 和 tabindex', () => {
        const html = renderThinkingBlock('内容');
        const div = document.createElement('div');
        div.innerHTML = html;
        const header = div.querySelector('.thinking-header');
        expect(header.getAttribute('role')).toBe('button');
        expect(header.getAttribute('tabindex')).toBe('0');
    });

    it('header 初始 aria-expanded=false', () => {
        const html = renderThinkingBlock('内容');
        const div = document.createElement('div');
        div.innerHTML = html;
        const header = div.querySelector('.thinking-header');
        expect(header.getAttribute('aria-expanded')).toBe('false');
    });

    it('header 包含图标和切换箭头', () => {
        const html = renderThinkingBlock('内容');
        expect(html).toContain('thinking-icon');
        expect(html).toContain('thinking-toggle-icon');
    });
});

describe('enhanceThinkingBlocks (jsdom)', () => {
    beforeEach(() => {
        clearThinkingCache();
    });

    it('点击 header 展开/折叠思维块', () => {
        const html = renderThinkingBlock('惰性内容');
        const container = document.createElement('div');
        container.innerHTML = html;
        document.body.appendChild(container);

        enhanceThinkingBlocks(container);

        const header = container.querySelector('.thinking-header');
        const block = container.querySelector('.thinking-block');

        // 初始折叠
        expect(block.classList.contains('collapsed')).toBe(true);

        // 点击展开
        header.click();
        expect(block.classList.contains('collapsed')).toBe(false);
        expect(header.getAttribute('aria-expanded')).toBe('true');

        // 再次点击折叠
        header.click();
        expect(block.classList.contains('collapsed')).toBe(true);
        expect(header.getAttribute('aria-expanded')).toBe('false');

        document.body.removeChild(container);
    });

    it('展开时惰性渲染 Markdown 内容', () => {
        const html = renderThinkingBlock('惰性内容');
        const container = document.createElement('div');
        container.innerHTML = html;
        document.body.appendChild(container);

        enhanceThinkingBlocks(container);

        const content = container.querySelector('.thinking-content');
        // 展开前无内容
        expect(content.innerHTML.trim()).toBe('');

        // 展开
        container.querySelector('.thinking-header').click();
        // safeMarkedParse mock 返回 <p>惰性内容</p>
        expect(content.innerHTML).toContain('<p>惰性内容</p>');

        // data-thinking-id 被清除
        expect(content.dataset.thinkingId).toBeUndefined();

        document.body.removeChild(container);
    });

    it('切换图标文字 ▶/▼', () => {
        const html = renderThinkingBlock('内容');
        const container = document.createElement('div');
        container.innerHTML = html;
        document.body.appendChild(container);

        enhanceThinkingBlocks(container);

        const icon = container.querySelector('.thinking-toggle-icon');
        expect(icon.textContent).toBe('▶');

        container.querySelector('.thinking-header').click();
        expect(icon.textContent).toBe('▼');

        container.querySelector('.thinking-header').click();
        expect(icon.textContent).toBe('▶');

        document.body.removeChild(container);
    });

    it('keyboard Enter/Space 也能触发折叠', () => {
        const html = renderThinkingBlock('键盘测试');
        const container = document.createElement('div');
        container.innerHTML = html;
        document.body.appendChild(container);

        enhanceThinkingBlocks(container);

        const header = container.querySelector('.thinking-header');
        const block = container.querySelector('.thinking-block');

        // Enter 展开
        header.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        expect(block.classList.contains('collapsed')).toBe(false);

        // Space 折叠
        header.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
        expect(block.classList.contains('collapsed')).toBe(true);

        document.body.removeChild(container);
    });

    it('不会重复增强同一个 header', () => {
        const html = renderThinkingBlock('重复测试');
        const container = document.createElement('div');
        container.innerHTML = html;
        document.body.appendChild(container);

        enhanceThinkingBlocks(container);
        enhanceThinkingBlocks(container);

        const header = container.querySelector('.thinking-header');
        expect(header.dataset.enhanced).toBe('true');

        // 点击一次只切换一次
        const block = container.querySelector('.thinking-block');
        header.click();
        expect(block.classList.contains('collapsed')).toBe(false);

        document.body.removeChild(container);
    });

    it('enhanceCodeBlocksFn 回调在展开时被调用', () => {
        const html = renderThinkingBlock('代码增强');
        const container = document.createElement('div');
        container.innerHTML = html;
        document.body.appendChild(container);

        const mockEnhance = vi.fn();
        enhanceThinkingBlocks(container, mockEnhance);

        container.querySelector('.thinking-header').click();
        expect(mockEnhance).toHaveBeenCalledOnce();
        expect(mockEnhance).toHaveBeenCalledWith(container.querySelector('.thinking-block'));

        document.body.removeChild(container);
    });
});

describe('clearThinkingCache', () => {
    it('清除缓存后展开不渲染旧内容', () => {
        const html = renderThinkingBlock('缓存内容');
        const container = document.createElement('div');
        container.innerHTML = html;
        document.body.appendChild(container);

        // 清除缓存
        clearThinkingCache();

        enhanceThinkingBlocks(container);
        container.querySelector('.thinking-header').click();

        // data-thinking-id 还在但 Map 中已无数据，所以不会渲染
        const content = container.querySelector('.thinking-content');
        // 内容保持空
        expect(content.innerHTML.trim()).toBe('');

        document.body.removeChild(container);
    });
});
