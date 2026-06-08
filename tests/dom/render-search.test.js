// @vitest-environment jsdom
/**
 * render-search.js jsdom 测试
 * 测试搜索引用渲染的 HTML 输出和 XSS 防护
 */
import { describe, it, expect, vi } from 'vitest';

// mock escapeHtml
vi.mock('../../js/utils/helpers.js', () => ({
    escapeHtml: vi.fn((text) => {
        if (text == null) return '';
        return String(text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    })
}));

import { renderSearchGrounding } from '../../js/messages/render-search.js';
import { escapeHtml } from '../../js/utils/helpers.js';

describe('renderSearchGrounding (jsdom)', () => {
    // ========== 空值/无效输入 ==========

    it('null 输入返回空字符串', () => {
        expect(renderSearchGrounding(null)).toBe('');
    });

    it('undefined 输入返回空字符串', () => {
        expect(renderSearchGrounding(undefined)).toBe('');
    });

    it('空对象返回空字符串', () => {
        expect(renderSearchGrounding({})).toBe('');
    });

    it('无 groundingChunks 且无 webSearchQueries 返回空字符串', () => {
        expect(renderSearchGrounding({ other: 'data' })).toBe('');
    });

    it('空 groundingChunks 数组返回空字符串', () => {
        expect(renderSearchGrounding({ groundingChunks: [] })).toBe('');
    });

    it('groundingChunks 无 web 属性返回空字符串', () => {
        const metadata = {
            groundingChunks: [{ text: 'no web' }]
        };
        expect(renderSearchGrounding(metadata)).toBe('');
    });

    // ========== 正常渲染 ==========

    it('渲染单个搜索引用', () => {
        const metadata = {
            groundingChunks: [{ web: { uri: 'https://example.com', title: 'Example' } }]
        };
        const html = renderSearchGrounding(metadata);
        const div = document.createElement('div');
        div.innerHTML = html;

        expect(div.querySelector('.search-grounding')).not.toBeNull();
        expect(div.querySelector('.grounding-header')).not.toBeNull();
        const links = div.querySelectorAll('.grounding-sources a');
        expect(links.length).toBe(1);
        expect(links[0].getAttribute('href')).toBe('https://example.com');
        expect(links[0].textContent).toBe('Example');
    });

    it('渲染多个搜索引用', () => {
        const metadata = {
            groundingChunks: [
                { web: { uri: 'https://a.com', title: 'A' } },
                { web: { uri: 'https://b.com', title: 'B' } },
                { web: { uri: 'https://c.com', title: 'C' } }
            ]
        };
        const html = renderSearchGrounding(metadata);
        const div = document.createElement('div');
        div.innerHTML = html;

        const links = div.querySelectorAll('.grounding-sources a');
        expect(links.length).toBe(3);
    });

    it('链接使用 target=_blank 和 rel=noopener', () => {
        const metadata = {
            groundingChunks: [{ web: { uri: 'https://example.com', title: 'Test' } }]
        };
        const html = renderSearchGrounding(metadata);
        const div = document.createElement('div');
        div.innerHTML = html;

        const link = div.querySelector('a');
        expect(link.getAttribute('target')).toBe('_blank');
        expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    });

    it('无 title 时使用 uri 作为显示文本', () => {
        const metadata = {
            groundingChunks: [{ web: { uri: 'https://example.com' } }]
        };
        const html = renderSearchGrounding(metadata);
        expect(html).toContain('https://example.com');
    });

    // ========== XSS 防护 ==========

    it('URL 中的特殊字符被转义', () => {
        const metadata = {
            groundingChunks: [
                { web: { uri: 'https://evil.com/"><script>alert(1)</script>', title: 'Safe' } }
            ]
        };
        renderSearchGrounding(metadata);
        expect(escapeHtml).toHaveBeenCalledWith('https://evil.com/"><script>alert(1)</script>');
    });

    it('title 中的特殊字符被转义', () => {
        const metadata = {
            groundingChunks: [{ web: { uri: 'https://safe.com', title: '<img onerror=alert(1)>' } }]
        };
        renderSearchGrounding(metadata);
        expect(escapeHtml).toHaveBeenCalledWith('<img onerror=alert(1)>');
    });

    // ========== 混合数据 ==========

    it('过滤掉非 web 类型的 chunks', () => {
        const metadata = {
            groundingChunks: [
                { web: { uri: 'https://a.com', title: 'A' } },
                { text: 'not web' },
                { web: { uri: 'https://b.com', title: 'B' } }
            ]
        };
        const html = renderSearchGrounding(metadata);
        const div = document.createElement('div');
        div.innerHTML = html;
        const links = div.querySelectorAll('.grounding-sources a');
        expect(links.length).toBe(2);
    });

    it('有 webSearchQueries 但无 chunks 仍返回空字符串', () => {
        const metadata = {
            webSearchQueries: ['query1'],
            groundingChunks: []
        };
        expect(renderSearchGrounding(metadata)).toBe('');
    });

    // ========== HTML 结构 ==========

    it('包含 grounding-header 标签', () => {
        const metadata = {
            groundingChunks: [{ web: { uri: 'https://example.com', title: 'Test' } }]
        };
        const html = renderSearchGrounding(metadata);
        expect(html).toContain('grounding-header');
    });

    it('使用 ul/li 列表结构', () => {
        const metadata = {
            groundingChunks: [{ web: { uri: 'https://example.com', title: 'Test' } }]
        };
        const html = renderSearchGrounding(metadata);
        const div = document.createElement('div');
        div.innerHTML = html;
        expect(div.querySelector('ul.grounding-sources')).not.toBeNull();
        expect(div.querySelectorAll('li').length).toBe(1);
    });
});
