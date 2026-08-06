/**
 * 代码块增强模块
 * 负责代码块的语法高亮、折叠、复制、下载、编辑、Mermaid 图表、表格导出等后处理
 */

import { elements } from '../core/elements.js';
import { eventBus } from '../core/events.js';
import { updateMessageTextAt } from '../core/state-mutations.js';
import { state } from '../core/state.js';
import { escapeHtml } from '../utils/helpers.js';
import { downloadImage } from '../utils/images.js';
import {
    getCurrentMermaidTheme,
    renderMermaidBlock,
    setMermaidSourcePanelVisible
} from '../utils/mermaid.js';
import { PartType, filterParts } from './schema.js';
import { enhanceThinkingBlocks } from './render-thinking.js';
import { logger } from '../utils/logger.js';
import { HLJS_MAX_CODE_LENGTH } from '../utils/constants.js';
import { updateMessageUiState } from './message-ui-state.js';

// 语言检测/标题提取正则只需开头样本即可判定，全文扫描是纯浪费
const LANG_DETECT_SAMPLE_LENGTH = 4096;

// 语言显示名称映射
const languageDisplayNames = {
    javascript: 'JavaScript',
    typescript: 'TypeScript',
    python: 'Python',
    java: 'Java',
    cpp: 'C++',
    c: 'C',
    csharp: 'C#',
    go: 'Go',
    rust: 'Rust',
    php: 'PHP',
    ruby: 'Ruby',
    bash: 'Shell',
    sql: 'SQL',
    html: 'HTML',
    css: 'CSS',
    json: 'JSON',
    yaml: 'YAML',
    markdown: 'Markdown',
    text: 'Text'
};

/**
 * 增强代码块（添加语言标签和复制按钮）
 * 入口函数，同时增强思维链块、表格、图片
 * @param {HTMLElement} container - 容器元素
 */
export function enhanceCodeBlocks(container = null) {
    const target = container || elements.messagesArea;
    const codeBlocks = target.querySelectorAll('pre code');

    codeBlocks.forEach((codeBlock) => {
        const pre = codeBlock.parentElement;

        if (pre.classList.contains('code-block-enhanced') || pre.closest('.code-collapse-content'))
            return;

        const codeText = codeBlock.textContent;
        const lineCount = codeText.split('\n').length;

        const languageClass = Array.from(codeBlock.classList).find((cls) =>
            cls.startsWith('language-')
        );
        const hintedLang = languageClass ? languageClass.replace('language-', '') : null;

        if (hintedLang === 'mermaid') {
            if (hasStreamingCursor(pre)) {
                return;
            }
            createMermaidBlock(pre, codeText);
            return;
        }

        // 流式态跳过 hljs/collapsible/复制按钮：避免每个 token 重建 DOM 与重跑高亮
        // 走 escapeHtml 占位样式，待 finalize 经 highlightWithIdleScheduler 分块升级
        if (isStreamingContext(pre)) {
            pre.classList.add('streaming-code-placeholder');
            return;
        }

        const detectedLang = detectCodeLanguage(codeText, hintedLang);
        const defaultCollapsed = lineCount > 20;
        createCollapsibleCodeBlock(
            pre,
            codeBlock,
            detectedLang,
            codeText,
            lineCount,
            defaultCollapsed
        );

        pre.classList.add('code-block-enhanced');
    });

    enhanceThinkingBlocks(target, enhanceCodeBlocks);
    enhanceTables(target);
    bindImageClickEvents(target);
}

/**
 * 检测 target 是否处于流式上下文
 * 条件：自身或祖先含 .generating class，或包含 .typing-cursor 节点
 * @param {HTMLElement} target - 待检测元素
 * @returns {boolean}
 */
function isStreamingContext(target) {
    if (!target) return false;
    if (target.closest?.('.generating')) return true;
    return target.closest?.('.message-content')?.querySelector('.typing-cursor') != null;
}

/**
 * finalize 路径专用：分块高亮所有未增强的 pre 代码块
 * 用 requestIdleCallback 切片（每 idle slot 处理 1-2 个 pre），避免单帧 200-500ms 卡顿
 * 不支持 requestIdleCallback 的环境降级为 setTimeout(0)
 * @param {HTMLElement} container - 容器元素
 */
export function highlightWithIdleScheduler(container = null) {
    const target = container || elements.messagesArea;
    if (!target) return;

    const queue = Array.from(target.querySelectorAll('pre.streaming-code-placeholder')).filter(
        (pre) => pre.isConnected && !pre.classList.contains('code-block-enhanced')
    );
    if (queue.length === 0) return;

    const schedule =
        typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function'
            ? (cb) => window.requestIdleCallback(cb, { timeout: 200 })
            : (cb) => setTimeout(cb, 0);

    const processSlot = () => {
        // 每个 idle slot 处理至多 2 个，保留预算给其他 idle 任务
        const SLOT_SIZE = 2;
        let processed = 0;
        while (queue.length > 0 && processed < SLOT_SIZE) {
            const pre = queue.shift();
            if (!pre.isConnected || pre.classList.contains('code-block-enhanced')) {
                continue;
            }
            processed += 1;
            try {
                upgradeStreamingPlaceholder(pre);
            } catch (err) {
                logger.error('[highlightWithIdleScheduler] 升级占位代码块失败:', err);
            }
        }
        if (queue.length > 0) {
            schedule(processSlot);
        }
    };

    schedule(processSlot);
}

/**
 * 把流式占位 pre 升级为 collapsible 代码块（finalize 阶段调用）
 * @param {HTMLElement} pre - 占位 pre 元素
 */
function upgradeStreamingPlaceholder(pre) {
    const codeBlock = pre.querySelector('code');
    if (!codeBlock) return;

    pre.classList.remove('streaming-code-placeholder');

    const codeText = codeBlock.textContent;
    const lineCount = codeText.split('\n').length;
    const languageClass = Array.from(codeBlock.classList).find((cls) =>
        cls.startsWith('language-')
    );
    const hintedLang = languageClass ? languageClass.replace('language-', '') : null;
    const detectedLang = detectCodeLanguage(codeText, hintedLang);
    const defaultCollapsed = lineCount > 20;

    createCollapsibleCodeBlock(pre, codeBlock, detectedLang, codeText, lineCount, defaultCollapsed);
    pre.classList.add('code-block-enhanced');
}

/**
 * 为图片绑定点击和下载事件
 * @param {HTMLElement} container - 容器元素
 */
export function bindImageClickEvents(container) {
    // 懒加载图片的 src 是占位 SVG，真实 URL 在 data-src
    const resolveImageUrl = (img) => img.dataset.src || img.src;

    const images = container.querySelectorAll('.image-wrapper img');
    images.forEach((img) => {
        img.style.cursor = 'pointer';
        img.onclick = () => {
            eventBus.emit('ui:open-image-viewer', { url: resolveImageUrl(img) });
        };
    });

    const downloadBtns = container.querySelectorAll('.download-image-btn');
    downloadBtns.forEach((btn) => {
        const imgWrapper = btn.closest('.image-wrapper');
        const img = imgWrapper?.querySelector('img');
        if (img) {
            btn.onclick = (e) => {
                e.stopPropagation();
                const url = resolveImageUrl(img);
                const match = url.match(/^data:image\/(\w+);/);
                const ext = match ? match[1] : 'png';
                downloadImage(url, `image-${Date.now()}.${ext}`);
            };
        }
    });
}

function hasStreamingCursor(pre) {
    return pre.closest('.message-content')?.querySelector('.typing-cursor') != null;
}

// Mermaid 图表块

function createMermaidBlock(pre, codeText) {
    pre.className = 'mermaid-block code-block-enhanced';
    // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
    pre.innerHTML = '';
    pre.dataset.mermaidSource = codeText;
    pre.dataset.mermaidTheme = getCurrentMermaidTheme();
    pre.dataset.mermaidStatus = 'idle';
    pre.dataset.mermaidRequestId = '0';
    delete pre.dataset.mermaidDiagramType;
    delete pre.dataset.actionsBound;
    delete pre.dataset.mermaidNeedsThemeRefresh;
    delete pre.dataset.mermaidPendingTheme;

    const status = document.createElement('span');
    status.className = 'mermaid-status';
    status.setAttribute('aria-live', 'polite');

    const statusText = document.createElement('span');
    statusText.className = 'mermaid-status-text';
    statusText.textContent = '正在生成图表…';
    status.appendChild(statusText);

    const header = document.createElement('span');
    header.className = 'mermaid-header';

    const titleWrap = document.createElement('span');
    titleWrap.className = 'mermaid-title-wrap';

    const icon = document.createElement('span');
    icon.className = 'mermaid-icon';
    icon.textContent = '◆';

    const title = document.createElement('span');
    title.className = 'mermaid-title';
    title.textContent = 'Mermaid 图表';

    titleWrap.appendChild(icon);
    titleWrap.appendChild(title);

    const actions = document.createElement('span');
    actions.className = 'mermaid-actions';

    const toggleSourceButton = document.createElement('button');
    toggleSourceButton.type = 'button';
    toggleSourceButton.className = 'mermaid-action-btn mermaid-toggle-source';
    toggleSourceButton.textContent = '源码';
    toggleSourceButton.setAttribute('aria-expanded', 'false');

    const copySourceButton = document.createElement('button');
    copySourceButton.type = 'button';
    copySourceButton.className = 'mermaid-action-btn mermaid-copy-source';
    copySourceButton.dataset.defaultLabel = '复制';
    copySourceButton.textContent = '复制';

    actions.appendChild(toggleSourceButton);
    actions.appendChild(copySourceButton);

    header.appendChild(titleWrap);
    header.appendChild(actions);

    const retryButton = document.createElement('button');
    retryButton.type = 'button';
    retryButton.className = 'mermaid-action-btn mermaid-retry-render';
    retryButton.textContent = '重试';
    retryButton.hidden = true;
    status.appendChild(retryButton);

    const canvas = document.createElement('span');
    canvas.className = 'mermaid-canvas';

    const sourcePanel = document.createElement('span');
    sourcePanel.className = 'mermaid-source-panel';
    sourcePanel.hidden = true;

    const sourceText = document.createElement('span');
    sourceText.className = 'mermaid-source-text';
    sourceText.textContent = codeText;
    sourcePanel.appendChild(sourceText);

    pre.appendChild(header);
    pre.appendChild(status);
    pre.appendChild(canvas);
    pre.appendChild(sourcePanel);

    bindMermaidActions(pre);
    void renderMermaidBlock(pre, { force: false, reason: 'initial' });
}

function bindMermaidActions(pre) {
    if (pre.dataset.actionsBound === 'true') {
        return;
    }
    pre.dataset.actionsBound = 'true';

    const actions = pre.querySelector('.mermaid-actions');
    actions?.addEventListener('click', (event) => {
        event.stopPropagation();
    });

    const toggleSourceButton = pre.querySelector('.mermaid-toggle-source');
    toggleSourceButton?.addEventListener('click', () => {
        const sourcePanel = pre.querySelector('.mermaid-source-panel');
        setMermaidSourcePanelVisible(pre, Boolean(sourcePanel?.hidden));
    });

    const copySourceButton = pre.querySelector('.mermaid-copy-source');
    copySourceButton?.addEventListener('click', () => {
        const source = pre.dataset.mermaidSource || '';
        const originalLabel = copySourceButton.dataset.defaultLabel || '复制';

        navigator.clipboard
            .writeText(source)
            .then(() => {
                copySourceButton.textContent = '已复制';
                copySourceButton.classList.add('copied');

                setTimeout(() => {
                    copySourceButton.textContent = originalLabel;
                    copySourceButton.classList.remove('copied');
                }, 2000);
            })
            .catch((error) => {
                logger.error('复制失败:', error);
                copySourceButton.textContent = originalLabel;
                copySourceButton.classList.remove('copied');
                eventBus.emit('ui:notification', { message: '复制失败', type: 'error' });
            });
    });

    const retryButton = pre.querySelector('.mermaid-retry-render');
    retryButton?.addEventListener('click', () => {
        void renderMermaidBlock(pre, { force: true, reason: 'manual-retry' });
    });
}

// 语言检测

/**
 * 智能检测代码语言
 * @param {string} code - 代码内容
 * @param {string} hintedLang - marked.js 提示的语言
 * @returns {string} 检测到的语言
 */
function detectCodeLanguage(code, hintedLang) {
    if (hintedLang && hintedLang !== 'text' && hintedLang !== 'plaintext') {
        return hintedLang;
    }

    const sample =
        code.length > LANG_DETECT_SAMPLE_LENGTH ? code.slice(0, LANG_DETECT_SAMPLE_LENGTH) : code;
    const trimmed = sample.trim();

    // JSON.parse 需要完整文本，超样本长度时截断必失败，直接跳过走正则检测
    if (
        code.length <= LANG_DETECT_SAMPLE_LENGTH &&
        ((trimmed.startsWith('{') && trimmed.endsWith('}')) ||
            (trimmed.startsWith('[') && trimmed.endsWith(']')))
    ) {
        try {
            JSON.parse(trimmed);
            return 'json';
        } catch (_e) {
            // 不是有效的 JSON
        }
    }

    if (/<(!DOCTYPE html|html|head|body|div|span|p|a|img|script|style)/i.test(sample))
        return 'html';
    if (/[.#][\w-]+\s*\{[^}]*\}/.test(sample) || /@(media|keyframes|import)/.test(sample))
        return 'css';
    if (/^(def |class |import |from |if __name__|print\()/m.test(sample)) return 'python';

    if (/\b(function|const|let|var|=>|async|await|class|interface|type)\b/.test(sample)) {
        if (/:\s*(string|number|boolean|any|void|unknown|never)\b|interface |type /.test(sample)) {
            return 'typescript';
        }
        return 'javascript';
    }

    if (
        /\b(public |private |protected |class |interface |extends |implements |package |import java\.)/m.test(
            sample
        )
    )
        return 'java';
    if (/#include\s*<|using namespace |std::|cout|cin|vector</.test(sample)) return 'cpp';
    if (/#include\s*<stdio\.h>|#include\s*<stdlib\.h>|int main\(|printf\(|scanf\(/.test(sample))
        return 'c';
    if (
        /\b(using System;|namespace |class |public static void Main|Console\.WriteLine)/m.test(
            sample
        )
    )
        return 'csharp';
    if (/^package |func |import \(|fmt\.Print/.test(sample)) return 'go';
    if (/\b(fn |let mut |impl |use |pub |struct |enum |match )\b/.test(sample)) return 'rust';
    if (/^<\?php|\$[a-zA-Z_]|->|::|echo |function /.test(sample)) return 'php';
    if (/\b(def |end\b|class |module |puts |require )\b/.test(sample)) return 'ruby';
    if (
        /^#!\/bin\/(bash|sh)|^\s*(if |for |while |case |function |echo |export |cd |ls |grep )/m.test(
            sample
        )
    )
        return 'bash';
    if (/\b(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|FROM|WHERE|JOIN|TABLE)\b/i.test(sample))
        return 'sql';
    if (/^[\w-]+:\s*$|^ {2}[\w-]+:\s/m.test(sample) && !/[{}[\]]/.test(sample)) return 'yaml';
    if (/^#{1,6}\s|^\*\*|^- |^\d+\. |^\[.+\]\(.+\)/.test(sample)) return 'markdown';

    return 'text';
}

// 代码块折叠

/**
 * 智能生成代码块标题
 */
function generateCodeTitle(code, language) {
    const sample =
        code.length > LANG_DETECT_SAMPLE_LENGTH ? code.slice(0, LANG_DETECT_SAMPLE_LENGTH) : code;
    const firstLine = sample.trim().split('\n')[0].trim();

    if (firstLine.startsWith('//') || firstLine.startsWith('#')) {
        const title = firstLine.replace(/^[//#]+\s*/, '').trim();
        if (title.length > 0 && title.length < 60) {
            return title;
        }
    }

    const patterns = {
        javascript: /(?:function|class|const|let)\s+([a-zA-Z_$][\w$]*)/,
        typescript: /(?:function|class|const|let|interface|type)\s+([a-zA-Z_$][\w$]*)/,
        python: /(?:def|class)\s+([a-zA-Z_][\w]*)/,
        java: /(?:public|private|protected)?\s*(?:static)?\s*(?:class|interface)\s+([A-Z][\w]*)/,
        cpp: /(?:class|struct|namespace)\s+([a-zA-Z_][\w]*)/,
        go: /func\s+([a-zA-Z_][\w]*)/,
        rust: /(?:fn|struct|enum|trait)\s+([a-zA-Z_][\w]*)/
    };

    const pattern = patterns[language];
    if (pattern) {
        const match = sample.match(pattern);
        if (match) {
            return `${match[1]} - ${languageDisplayNames[language] || language}`;
        }
    }

    const fileMatch = sample.match(/\/([a-zA-Z0-9_-]+\.[a-z]+)/);
    if (fileMatch) {
        return fileMatch[1];
    }

    return `${languageDisplayNames[language] || language} 代码`;
}

/**
 * 创建可折叠代码块
 */
function createCollapsibleCodeBlock(
    pre,
    codeBlock,
    language,
    codeText,
    lineCount,
    defaultCollapsed = true
) {
    const title = generateCodeTitle(codeText, language);

    pre.className = defaultCollapsed
        ? 'code-block-collapsible collapsed'
        : 'code-block-collapsible';
    // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
    pre.innerHTML = '';

    const header = document.createElement('div');
    header.className = 'code-collapse-header';
    header.setAttribute('role', 'button');
    header.setAttribute('tabindex', '0');
    header.setAttribute('aria-expanded', defaultCollapsed ? 'false' : 'true');
    // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
    header.innerHTML = `
        <span class="code-icon" aria-hidden="true">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="16 18 22 12 16 6"></polyline>
                <polyline points="8 6 2 12 8 18"></polyline>
            </svg>
        </span>
        <span class="code-title">${escapeHtml(title)}</span>
        <span class="code-meta">
            <span class="code-language-badge">${escapeHtml(language.toUpperCase())}</span>
            <span class="code-line-count">${lineCount} 行</span>
        </span>
        <span class="code-toggle-icon" aria-hidden="true">${defaultCollapsed ? '▶' : '▼'}</span>
    `;

    const actions = document.createElement('div');
    actions.className = 'code-collapse-actions';
    // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
    actions.innerHTML = `
        <button class="code-action-btn preview-code" title="预览代码" aria-label="预览代码">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
                <circle cx="12" cy="12" r="3"></circle>
            </svg>
        </button>
        <button class="code-action-btn edit-code" title="编辑代码" aria-label="编辑代码">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
            </svg>
        </button>
        <button class="code-action-btn copy-code" title="复制代码" aria-label="复制代码">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"></path>
            </svg>
        </button>
        <button class="code-action-btn download-code" title="下载代码" aria-label="下载代码">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/>
            </svg>
        </button>
    `;

    const contentWrapper = document.createElement('div');
    contentWrapper.className = 'code-collapse-content';

    const clonedCode = codeBlock.cloneNode(true);
    clonedCode.className = `language-${language}`;

    const newPre = document.createElement('pre');
    newPre.appendChild(clonedCode);
    contentWrapper.appendChild(newPre);

    pre.appendChild(header);
    pre.appendChild(actions);
    pre.appendChild(contentWrapper);

    bindCollapseEvents(pre, header);
    bindCodeBlockActions(pre, actions, codeText, language);

    highlightCodeElement(clonedCode, codeText.length);
}

/**
 * 带长度守卫的语法高亮：超长代码保持纯转义文本展示
 * @param {HTMLElement} codeEl - code 元素
 * @param {number} codeLength - 代码字符数
 */
function highlightCodeElement(codeEl, codeLength) {
    if (typeof hljs === 'undefined') return;
    if (codeLength > HLJS_MAX_CODE_LENGTH) {
        codeEl.title = '代码过长，已跳过语法高亮';
        return;
    }
    hljs.highlightElement(codeEl);
}

function bindCollapseEvents(pre, header) {
    const toggle = () => {
        const isCollapsed = pre.classList.toggle('collapsed');
        header.setAttribute('aria-expanded', !isCollapsed);

        const icon = header.querySelector('.code-toggle-icon');
        if (icon) {
            icon.textContent = isCollapsed ? '▶' : '▼';
        }

        const messageEl = pre.closest('.message[data-message-id]');
        if (messageEl) {
            updateMessageUiState(messageEl.dataset.messageId, {
                codeBlocksExpanded: captureExpandedCodeBlockState(messageEl)
            });
        }
    };

    header.addEventListener('click', toggle);
    header.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggle();
        }
    });
}

export function captureExpandedCodeBlockState(container) {
    if (!container || typeof container.querySelectorAll !== 'function') return [];
    const expanded = [];
    container.querySelectorAll('.code-block-collapsible').forEach((block, index) => {
        if (!block.classList.contains('collapsed')) expanded.push(index);
    });
    return expanded;
}

export function restoreExpandedCodeBlockState(container, expanded) {
    if (!container || !Array.isArray(expanded) || expanded.length === 0) return;
    const blocks = container.querySelectorAll('.code-block-collapsible');
    expanded.forEach((index) => {
        const block = blocks[index];
        if (!block) return;
        block.classList.remove('collapsed');
        const header = block.querySelector('.code-collapse-header');
        header?.setAttribute('aria-expanded', 'true');
        const icon = header?.querySelector('.code-toggle-icon');
        if (icon) icon.textContent = '▼';
    });
}

// 代码块操作按钮

function bindCodeBlockActions(pre, actions, codeText, language) {
    if (actions.dataset.eventsBound === 'true') {
        return;
    }
    actions.dataset.eventsBound = 'true';

    actions.addEventListener('click', (e) => {
        e.stopPropagation();
    });

    const getCurrentCode = () => {
        const collapsibleCode = pre.querySelector('.code-collapse-content code');
        if (collapsibleCode) {
            const code = collapsibleCode.textContent;
            const langMatch = collapsibleCode.className.match(/language-(\w+)/);
            const lang = langMatch ? langMatch[1] : 'text';
            return { code, language: lang };
        }

        const normalCode = pre.querySelector('code');
        if (normalCode) {
            const code = normalCode.textContent;
            const langMatch = normalCode.className.match(/language-(\w+)/);
            const lang = langMatch ? langMatch[1] : 'text';
            return { code, language: lang };
        }

        return { code: codeText, language: language };
    };

    // 复制
    const copyBtn = actions.querySelector('.copy-code');
    if (copyBtn) {
        copyBtn.addEventListener('click', () => {
            const { code } = getCurrentCode();
            navigator.clipboard
                .writeText(code)
                .then(() => {
                    const originalHTML = copyBtn.innerHTML;
                    // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
                    copyBtn.innerHTML = `
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polyline points="20 6 9 17 4 12"></polyline>
                    </svg>
                `;
                    copyBtn.classList.add('copied');
                    setTimeout(() => {
                        // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
                        copyBtn.innerHTML = originalHTML;
                        copyBtn.classList.remove('copied');
                    }, 2000);
                })
                .catch((err) => {
                    logger.error('复制失败:', err);
                    eventBus.emit('ui:notification', { message: '复制失败', type: 'error' });
                });
        });
    }

    // 下载
    const downloadBtn = actions.querySelector('.download-code');
    if (downloadBtn) {
        downloadBtn.addEventListener('click', () => {
            const { code, language: lang } = getCurrentCode();
            downloadCodeAsFile(code, lang);
        });
    }

    // 预览（只读模式）
    const previewBtn = actions.querySelector('.preview-code');
    if (previewBtn) {
        previewBtn.addEventListener('click', async () => {
            try {
                const messageEl = pre.closest('.message');
                if (!messageEl) {
                    logger.error('[预览代码] 找不到消息元素');
                    return;
                }
                const { openCodeEditorModal } = await import('../ui/code-editor-modal.js');
                const { code, language: lang } = getCurrentCode();
                openCodeEditorModal(code, lang, null, true);
            } catch (error) {
                logger.error('[预览代码] 错误:', error);
                eventBus.emit('ui:notification', {
                    message: '打开预览失败: ' + error.message,
                    type: 'error'
                });
            }
        });
    }

    // 编辑
    const editBtn = actions.querySelector('.edit-code');
    if (editBtn) {
        editBtn.addEventListener('click', async () => {
            try {
                const messageEl = pre.closest('.message');
                if (!messageEl) {
                    logger.error('[编辑代码] 找不到消息元素');
                    return;
                }
                const { openCodeEditorModal } = await import('../ui/code-editor-modal.js');
                const { code, language: lang } = getCurrentCode();
                openCodeEditorModal(code, lang, (newCode, newLanguage) => {
                    updateCodeBlockInMessage(messageEl, pre, newCode, newLanguage);
                });
            } catch (_error) {
                logger.error('[编辑代码] 错误:', _error);
                eventBus.emit('ui:notification', {
                    message: '打开编辑器失败: ' + _error.message,
                    type: 'error'
                });
            }
        });
    }
}

// 下载和导出

function downloadCodeAsFile(code, language) {
    const extensions = {
        javascript: 'js',
        typescript: 'ts',
        python: 'py',
        java: 'java',
        cpp: 'cpp',
        c: 'c',
        csharp: 'cs',
        go: 'go',
        rust: 'rs',
        php: 'php',
        ruby: 'rb',
        bash: 'sh',
        sql: 'sql',
        html: 'html',
        css: 'css',
        json: 'json',
        yaml: 'yaml',
        markdown: 'md',
        text: 'txt'
    };

    const ext = extensions[language] || 'txt';
    const filename = `code-${Date.now()}.${ext}`;

    const blob = new Blob([code], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);

    eventBus.emit('ui:notification', { message: `已下载为 ${filename}`, type: 'success' });
}

// 表格增强

function enhanceTables(container = null) {
    const target = container || elements.messagesArea;
    const tables = target.querySelectorAll('table');

    tables.forEach((table) => {
        if (table.dataset.enhanced === 'true') return;
        table.dataset.enhanced = 'true';

        const rows = table.querySelectorAll('tr');
        if (rows.length === 0) return;

        const wrapper = document.createElement('div');
        wrapper.className = 'table-wrapper';
        table.parentNode.insertBefore(wrapper, table);
        wrapper.appendChild(table);

        const toolbar = document.createElement('div');
        toolbar.className = 'table-toolbar';
        // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
        toolbar.innerHTML = `
            <button class="table-export-btn" title="导出为 CSV">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
                    <polyline points="7 10 12 15 17 10"/>
                    <line x1="12" y1="15" x2="12" y2="3"/>
                </svg>
                <span>导出 CSV</span>
            </button>
            <span class="table-info">${rows.length} 行</span>
        `;

        wrapper.insertBefore(toolbar, table);

        toolbar.querySelector('.table-export-btn').addEventListener('click', () => {
            exportTableAsCSV(table);
        });
    });
}

function exportTableAsCSV(table) {
    const rows = Array.from(table.querySelectorAll('tr'));

    const csv = rows
        .map((row) => {
            const cells = Array.from(row.querySelectorAll('th, td'));
            return cells
                .map((cell) => {
                    let text = cell.textContent.trim();
                    if (text.includes(',') || text.includes('"') || text.includes('\n')) {
                        text = `"${text.replace(/"/g, '""')}"`;
                    }
                    return text;
                })
                .join(',');
        })
        .join('\n');

    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `table-${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);

    eventBus.emit('ui:notification', { message: '表格已导出为 CSV', type: 'success' });
}

// 代码块内容更新

/**
 * 更新消息中的代码块
 * @param {HTMLElement} messageEl - 消息元素
 * @param {HTMLElement} pre - pre元素
 * @param {string} newCode - 新代码
 * @param {string} newLanguage - 新语言
 */
export function updateCodeBlockInMessage(messageEl, pre, newCode, newLanguage) {
    const hit = state.messageStore.findByEl(messageEl, { messagesArea: elements.messagesArea });
    if (!hit) {
        logger.error('[更新代码块] 找不到消息索引');
        return;
    }
    const { index } = hit;

    let originalMarkdown = getMessageMarkdown(index);
    if (!originalMarkdown) {
        logger.error('[更新代码块] 找不到原始 Markdown');
        return;
    }

    const codeBlocks = originalMarkdown.match(/```[\s\S]*?```/g) || [];
    const preIndex = getCodeBlockIndex(messageEl, pre);

    if (preIndex < 0 || preIndex >= codeBlocks.length) {
        logger.error('[更新代码块] 代码块索引无效');
        eventBus.emit('ui:notification', {
            message: '当前代码块暂不支持直接编辑',
            type: 'warning'
        });
        return;
    }

    const oldBlock = codeBlocks[preIndex];
    const newBlock = `\`\`\`${newLanguage}\n${newCode}\n\`\`\``;
    originalMarkdown = originalMarkdown.replace(oldBlock, newBlock);

    updateMessageMarkdown(index, originalMarkdown);
    updateSingleCodeBlock(pre, newCode, newLanguage);

    eventBus.emit('messages:changed', { action: 'code_block_updated', index });
}

function updateSingleCodeBlock(pre, newCode, newLanguage) {
    const isCollapsible = pre.classList.contains('code-block-collapsible');

    if (isCollapsible) {
        const contentWrapper = pre.querySelector('.code-collapse-content');
        const codeBlock = contentWrapper?.querySelector('code');

        if (codeBlock) {
            codeBlock.textContent = newCode;
            codeBlock.className = `language-${newLanguage}`;
            highlightCodeElement(codeBlock, newCode.length);
        }

        const langBadge = pre.querySelector('.code-language-badge');
        if (langBadge) {
            langBadge.textContent = newLanguage.toUpperCase();
        }

        const lineCount = newCode.split('\n').length;
        const lineCountSpan = pre.querySelector('.code-line-count');
        if (lineCountSpan) {
            lineCountSpan.textContent = `${lineCount} 行`;
        }
    } else {
        const codeBlock = pre.querySelector('code');
        if (codeBlock) {
            codeBlock.textContent = newCode;
            codeBlock.className = `language-${newLanguage}`;
            highlightCodeElement(codeBlock, newCode.length);
        }

        const langSelector = pre.querySelector('.code-language-selector');
        if (langSelector) {
            langSelector.value = newLanguage;
        }
    }
}

function getMessageFencePres(messageEl) {
    return Array.from(messageEl.querySelectorAll('pre')).filter((pre) => {
        if (pre.closest('.code-collapse-content') || pre.closest('.thinking-block')) {
            return false;
        }
        if (pre.classList.contains('mermaid-block')) {
            return false;
        }
        return !pre.parentElement?.closest('pre');
    });
}

function getCodeBlockIndex(messageEl, pre) {
    return getMessageFencePres(messageEl).indexOf(pre);
}

function getMessageMarkdown(index) {
    const message = state.messages[index];
    if (!message) return '';

    if (Array.isArray(message.parts)) {
        const textParts = filterParts(message.parts, PartType.TEXT);
        if (textParts.length > 0) {
            return textParts.map((p) => p.text).join('\n');
        }
    }
    return '';
}

function updateMessageMarkdown(index, newMarkdown) {
    updateMessageTextAt(index, newMarkdown);

    eventBus.emit('messages:changed', { action: 'updated', index });
}
