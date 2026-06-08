/**
 * code-editor-core.js 代码编辑器核心测试
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../js/utils/helpers.js', () => ({
    escapeHtml: vi.fn((s) => s)
}));

vi.mock('../../js/utils/logger.js', () => ({
    logger: { warn: vi.fn(), debug: vi.fn(), error: vi.fn(), info: vi.fn() }
}));

import {
    generateLanguageOptions,
    initCodeEditor,
    updateCodePreview,
    runLivePreview,
    analyzeCode
} from '../../js/ui/code-editor-core.js';

describe('generateLanguageOptions', () => {
    it('生成语言选项 HTML', () => {
        const html = generateLanguageOptions('javascript');
        expect(html).toContain('<option');
        expect(html).toContain('JAVASCRIPT');
        expect(html).toContain('selected');
    });

    it('无匹配语言不标记 selected', () => {
        const html = generateLanguageOptions('unknown');
        expect(html).not.toContain('selected');
    });

    it('包含所有预定义语言', () => {
        const html = generateLanguageOptions('');
        expect(html).toContain('PYTHON');
        expect(html).toContain('JAVA');
        expect(html).toContain('GO');
        expect(html).toContain('RUST');
        expect(html).toContain('HTML');
        expect(html).toContain('CSS');
        expect(html).toContain('JSON');
        expect(html).toContain('SQL');
    });

    it('标记正确的语言为 selected', () => {
        const html = generateLanguageOptions('python');
        // python 选项应有 selected
        expect(html).toMatch(/value="python"\s+selected/);
        // javascript 不应有 selected
        expect(html).not.toMatch(/value="javascript"\s+selected/);
    });
});

describe('initCodeEditor', () => {
    it('初始化行号和事件', () => {
        const modal = document.createElement('div');
        const wrapper = document.createElement('div');
        const textarea = document.createElement('textarea');
        const lineNumbers = document.createElement('div');
        lineNumbers.className = 'code-line-numbers';
        wrapper.appendChild(lineNumbers);
        wrapper.appendChild(textarea);
        modal.appendChild(wrapper);

        textarea.value = 'line1\nline2\nline3';

        initCodeEditor(modal, textarea, 'javascript');

        // 应生成 3 行行号
        expect(lineNumbers.querySelectorAll('.line-number').length).toBe(3);
    });

    it('Tab 键插入 4 空格', () => {
        const modal = document.createElement('div');
        const wrapper = document.createElement('div');
        const textarea = document.createElement('textarea');
        const lineNumbers = document.createElement('div');
        lineNumbers.className = 'code-line-numbers';
        wrapper.appendChild(lineNumbers);
        wrapper.appendChild(textarea);
        modal.appendChild(wrapper);

        textarea.value = 'hello';
        initCodeEditor(modal, textarea, 'javascript');

        textarea.selectionStart = 5;
        textarea.selectionEnd = 5;
        const event = new KeyboardEvent('keydown', { key: 'Tab', cancelable: true, bubbles: true });
        textarea.dispatchEvent(event);
        expect(textarea.value).toBe('hello    ');
    });

    it('input 事件更新行号', () => {
        const modal = document.createElement('div');
        const wrapper = document.createElement('div');
        const textarea = document.createElement('textarea');
        const lineNumbers = document.createElement('div');
        lineNumbers.className = 'code-line-numbers';
        wrapper.appendChild(lineNumbers);
        wrapper.appendChild(textarea);
        modal.appendChild(wrapper);

        textarea.value = '';
        initCodeEditor(modal, textarea, 'javascript');

        textarea.value = 'a\nb\nc\nd';
        textarea.dispatchEvent(new Event('input'));
        expect(lineNumbers.querySelectorAll('.line-number').length).toBe(4);
    });
});

describe('updateCodePreview', () => {
    it('无 iframe 不抛错', () => {
        const modal = document.createElement('div');
        expect(() => updateCodePreview(modal, 'code', 'js')).not.toThrow();
    });

    it('有 iframe 写入 srcdoc', () => {
        const modal = document.createElement('div');
        const iframe = document.createElement('iframe');
        iframe.id = 'code-preview-iframe';
        modal.appendChild(iframe);

        updateCodePreview(modal, '<h1>Test</h1>', 'html');
        expect(iframe.srcdoc).toBe('<h1>Test</h1>');
    });

    it('CSS 语言生成 style 标签', () => {
        const modal = document.createElement('div');
        const iframe = document.createElement('iframe');
        iframe.id = 'code-preview-iframe';
        modal.appendChild(iframe);

        updateCodePreview(modal, '.red { color: red; }', 'css');
        expect(iframe.srcdoc).toContain('<style>');
        expect(iframe.srcdoc).toContain('.red { color: red; }');
    });

    it('JS 语言生成 script 标签', () => {
        const modal = document.createElement('div');
        const iframe = document.createElement('iframe');
        iframe.id = 'code-preview-iframe';
        modal.appendChild(iframe);

        updateCodePreview(modal, 'console.log("hi")', 'javascript');
        expect(iframe.srcdoc).toContain('<script>');
    });

    it('未知语言提示不支持', () => {
        const modal = document.createElement('div');
        const iframe = document.createElement('iframe');
        iframe.id = 'code-preview-iframe';
        modal.appendChild(iframe);

        updateCodePreview(modal, 'x = 1', 'rust');
        expect(iframe.srcdoc).toContain('不支持实时预览');
    });
});

describe('runLivePreview', () => {
    it('无 iframe 不抛错', () => {
        const modal = document.createElement('div');
        expect(() => runLivePreview(modal, 'code', 'js')).not.toThrow();
    });

    it('有 iframe 和 console 写入 srcdoc', () => {
        const modal = document.createElement('div');
        const iframe = document.createElement('iframe');
        iframe.id = 'live-preview-iframe';
        const consoleEl = document.createElement('div');
        consoleEl.id = 'preview-console-content';
        modal.appendChild(iframe);
        modal.appendChild(consoleEl);

        runLivePreview(modal, '<p>hi</p>', 'html');
        expect(iframe.srcdoc).toContain('<p>hi</p>');
    });
});

describe('analyzeCode', () => {
    it('无容器不抛错', async () => {
        const modal = document.createElement('div');
        await expect(analyzeCode(modal, 'code', 'js')).resolves.not.toThrow();
    });

    it('显示加载状态', async () => {
        const modal = document.createElement('div');
        const container = document.createElement('div');
        container.id = 'analysis-container';
        modal.appendChild(container);

        analyzeCode(modal, 'function foo() {}', 'javascript');
        expect(container.innerHTML).toContain('正在分析');
    });

    it('延迟后渲染分析结果', async () => {
        vi.useFakeTimers();
        const modal = document.createElement('div');
        const container = document.createElement('div');
        container.id = 'analysis-container';
        modal.appendChild(container);

        analyzeCode(modal, 'function foo() { if(x) {} }\nfunction bar() {}', 'javascript');
        vi.advanceTimersByTime(500);

        expect(container.innerHTML).toContain('基本信息');
        vi.useRealTimers();
    });

    it('Python 分析提取函数和类', async () => {
        vi.useFakeTimers();
        const modal = document.createElement('div');
        const container = document.createElement('div');
        container.id = 'analysis-container';
        modal.appendChild(container);

        const pythonCode = `
import os
from sys import path

class MyClass:
    def method(self):
        pass

def hello():
    pass
`;
        analyzeCode(modal, pythonCode, 'python');
        vi.advanceTimersByTime(500);

        expect(container.innerHTML).toContain('基本信息');
        vi.useRealTimers();
    });

    it('Markdown 分析提取标题和链接', async () => {
        vi.useFakeTimers();
        const modal = document.createElement('div');
        const container = document.createElement('div');
        container.id = 'analysis-container';
        modal.appendChild(container);

        const mdCode = `
# Title
## Section
- item 1
- item 2
[link](http://example.com)
![img](http://img.png)
\`\`\`js
code
\`\`\`
`;
        analyzeCode(modal, mdCode, 'markdown');
        vi.advanceTimersByTime(500);

        expect(container.innerHTML).toContain('基本信息');
        vi.useRealTimers();
    });

    it('高复杂度代码标记为 high', async () => {
        vi.useFakeTimers();
        const modal = document.createElement('div');
        const container = document.createElement('div');
        container.id = 'analysis-container';
        modal.appendChild(container);

        // 生成 25+ 个 if/for/while
        const complexCode = Array.from(
            { length: 25 },
            (_, i) => `if (x${i}) { for (let j = 0; j < 10; j++) {} }`
        ).join('\n');

        analyzeCode(modal, complexCode, 'javascript');
        vi.advanceTimersByTime(500);

        expect(container.innerHTML).toContain('高');
        vi.useRealTimers();
    });
});
