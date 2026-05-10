/**
 * 代码编辑器核心逻辑
 * 文本编辑、行号同步、代码分析、预览生成
 */

import { escapeHtml } from '../utils/helpers.js';
import { logger } from '../utils/logger.js';

/**
 * 生成语言选项
 * @param {string} currentLang - 当前语言
 * @returns {string} options HTML
 */
export function generateLanguageOptions(currentLang) {
    const languages = [
        'javascript',
        'typescript',
        'python',
        'java',
        'cpp',
        'c',
        'csharp',
        'go',
        'rust',
        'php',
        'ruby',
        'bash',
        'sql',
        'html',
        'css',
        'json',
        'yaml',
        'markdown',
        'text'
    ];

    return languages
        .map(
            (lang) =>
                `<option value="${lang}" ${lang === currentLang ? 'selected' : ''}>${lang.toUpperCase()}</option>`
        )
        .join('');
}

/**
 * 初始化代码编辑器
 * @param {HTMLElement} modal - 模态框元素
 * @param {HTMLElement} textarea - 文本编辑器
 * @param {string} language - 语言
 */
export function initCodeEditor(modal, textarea, language) {
    const wrapper = textarea.parentElement;
    const lineNumbers = wrapper.querySelector('.code-line-numbers');

    // 更新行号
    const updateLineNumbers = () => {
        const lines = textarea.value.split('\n').length;
        // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
        lineNumbers.innerHTML = Array.from(
            { length: lines },
            (_, i) => `<div class="line-number">${i + 1}</div>`
        ).join('');

        // 同步滚动
        lineNumbers.scrollTop = textarea.scrollTop;
    };

    // 初始化和监听
    updateLineNumbers();

    // 注意: textarea 的事件监听器会在元素被移除时自动清理,无需手动管理
    textarea.addEventListener('input', updateLineNumbers);
    textarea.addEventListener('scroll', () => {
        lineNumbers.scrollTop = textarea.scrollTop;
    });

    // Tab键支持（插入4个空格）
    textarea.addEventListener('keydown', (e) => {
        if (e.key === 'Tab') {
            e.preventDefault();
            const start = textarea.selectionStart;
            const end = textarea.selectionEnd;
            textarea.value =
                textarea.value.substring(0, start) + '    ' + textarea.value.substring(end);
            textarea.selectionStart = textarea.selectionEnd = start + 4;
            updateLineNumbers();
            updateCodePreview(modal, textarea.value, language);
        }
    });

    // 自动更新预览
    let previewTimer;
    textarea.addEventListener('input', () => {
        clearTimeout(previewTimer);
        previewTimer = setTimeout(() => {
            const currentLang = modal.querySelector('#editor-language-selector')?.value || language;
            updateCodePreview(modal, textarea.value, currentLang);
        }, 500);
    });

    // 初始预览
    updateCodePreview(modal, textarea.value, language);
}

/**
 * 更新代码预览（右侧面板的实时预览）
 * @param {HTMLElement} modal - 模态框元素
 * @param {string} code - 代码内容
 * @param {string} language - 语言
 */
export function updateCodePreview(modal, code, language) {
    const iframe = modal.querySelector('#code-preview-iframe');
    if (!iframe) {
        return;
    }

    // 根据语言类型生成预览内容
    const previewHTML = buildPreviewHTML(code, language);

    // 写入 iframe
    iframe.srcdoc = previewHTML;
}

/**
 * 运行实时预览
 * @param {HTMLElement} modal - 模态框元素
 * @param {string} code - 代码内容
 * @param {string} language - 语言
 */
export function runLivePreview(modal, code, language) {
    const iframe = modal.querySelector('#live-preview-iframe');
    const consoleContent = modal.querySelector('#preview-console-content');

    if (!iframe || !consoleContent) {
        logger.error('[实时预览] 找不到 iframe 或控制台元素');
        return;
    }

    // 清空控制台
    // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
    consoleContent.innerHTML = '';

    // 根据语言类型生成预览内容
    const previewHTML = buildPreviewHTML(code, language);

    // 写入 iframe
    iframe.srcdoc = previewHTML;
}

/**
 * 根据语言生成预览 HTML（updateCodePreview 和 runLivePreview 共用）
 * @param {string} code - 代码内容
 * @param {string} language - 语言
 * @returns {string} HTML 字符串
 */
function buildPreviewHTML(code, language) {
    if (language === 'html') {
        return code;
    }

    if (language === 'css') {
        return `
            <!DOCTYPE html>
            <html>
            <head>
                <style>${code}</style>
            </head>
            <body>
                <div class="preview-sample">
                    <h1>CSS 预览</h1>
                    <p>这是一个示例段落。</p>
                    <button>按钮</button>
                </div>
            </body>
            </html>
        `;
    }

    if (language === 'javascript' || language === 'js') {
        return `
            <!DOCTYPE html>
            <html>
            <head>
                <style>
                    body { font-family: monospace; padding: 20px; }
                </style>
            </head>
            <body>
                <div id="output"></div>
                <script>
                    const output = document.getElementById('output');
                    const originalLog = console.log;
                    console.log = function(...args) {
                        const message = args.map(arg =>
                            typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)
                        ).join(' ');
                        const div = document.createElement('div');
                        div.textContent = message;
                        div.style.borderBottom = '1px solid #ddd';
                        div.style.padding = '8px 0';
                        output.appendChild(div);
                        originalLog.apply(console, args);
                    };

                    try {
                        ${code}
                    } catch (error) {
                        const errorDiv = document.createElement('div');
                        errorDiv.style.color = 'red';
                        errorDiv.textContent = 'Error: ' + error.message;
                        output.appendChild(errorDiv);
                    }
                </script>
            </body>
            </html>
        `;
    }

    if (language === 'markdown' || language === 'md') {
        const htmlContent = typeof marked !== 'undefined' ? marked.parse(code) : escapeHtml(code);
        return `
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="UTF-8">
                <style>
                    body {
                        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
                        line-height: 1.6;
                        color: #333;
                        max-width: 900px;
                        margin: 0 auto;
                        padding: 20px;
                        background: white;
                    }
                    h1, h2, h3, h4, h5, h6 {
                        margin-top: 24px;
                        margin-bottom: 16px;
                        font-weight: 600;
                        line-height: 1.25;
                    }
                    h1 { font-size: 2em; border-bottom: 1px solid #eaecef; padding-bottom: 0.3em; }
                    h2 { font-size: 1.5em; border-bottom: 1px solid #eaecef; padding-bottom: 0.3em; }
                    h3 { font-size: 1.25em; }
                    p { margin-bottom: 16px; }
                    code {
                        background: #f6f8fa;
                        padding: 0.2em 0.4em;
                        border-radius: 3px;
                        font-family: 'Consolas', 'Monaco', monospace;
                        font-size: 85%;
                    }
                    pre {
                        background: #f6f8fa;
                        padding: 16px;
                        border-radius: 6px;
                        overflow-x: auto;
                    }
                    pre code {
                        background: none;
                        padding: 0;
                    }
                    blockquote {
                        margin: 0;
                        padding: 0 1em;
                        color: #6a737d;
                        border-left: 0.25em solid #dfe2e5;
                    }
                    ul, ol {
                        padding-left: 2em;
                        margin-bottom: 16px;
                    }
                    table {
                        border-collapse: collapse;
                        width: 100%;
                        margin-bottom: 16px;
                    }
                    table th, table td {
                        padding: 6px 13px;
                        border: 1px solid #dfe2e5;
                    }
                    table th {
                        background: #f6f8fa;
                        font-weight: 600;
                    }
                    img {
                        max-width: 100%;
                    }
                    a {
                        color: #0366d6;
                        text-decoration: none;
                    }
                    a:hover {
                        text-decoration: underline;
                    }
                </style>
            </head>
            <body>
                ${htmlContent}
            </body>
            </html>
        `;
    }

    return `
        <!DOCTYPE html>
        <html>
        <body style="padding: 20px; color: #333; line-height: 1.6; font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', '微软雅黑', sans-serif;">
            <p>该语言 (${language}) 不支持实时预览</p>
        </body>
        </html>
    `;
}

/**
 * 执行代码分析
 * @param {HTMLElement} modal - 模态框元素
 * @param {string} code - 代码内容
 * @param {string} language - 语言
 */
export async function analyzeCode(modal, code, language) {
    const container = modal.querySelector('#analysis-container');
    if (!container) {
        logger.error('[代码分析] 找不到分析容器');
        return;
    }

    // 显示加载状态
    // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
    container.innerHTML = `
        <div class="analysis-loading">
            <div class="spinner"></div>
            <p>正在分析代码...</p>
        </div>
    `;

    // 延迟执行分析（模拟异步）
    setTimeout(() => {
        const analysis = performStaticAnalysis(code, language);
        renderAnalysisResult(analysis, container);
    }, 300);
}

/**
 * 执行静态代码分析
 */
function performStaticAnalysis(code, language) {
    const lines = code.split('\n');

    // 限制分析的代码行数，避免大文件卡顿
    const MAX_LINES_FOR_ANALYSIS = 2000;
    const shouldLimitAnalysis = lines.length > MAX_LINES_FOR_ANALYSIS;
    const analysisCode = shouldLimitAnalysis
        ? lines.slice(0, MAX_LINES_FOR_ANALYSIS).join('\n')
        : code;

    const analysis = {
        basicInfo: {
            lines: lines.length,
            characters: code.length,
            language: language,
            isLimited: shouldLimitAnalysis
        },
        functions: [],
        classes: [],
        imports: [],
        complexity: 'low'
    };

    // 提取函数（JavaScript/TypeScript）
    if (['javascript', 'typescript', 'js', 'ts'].includes(language)) {
        const functionRegex =
            /(?:function\s+(\w+)|const\s+(\w+)\s*=\s*(?:async\s+)?\(|(\w+)\s*:\s*(?:async\s+)?\()/g;
        let match;
        let matchCount = 0;
        while ((match = functionRegex.exec(analysisCode)) !== null) {
            const funcName = match[1] || match[2] || match[3];
            if (funcName) analysis.functions.push(funcName);
            matchCount++;
            if (matchCount > 1000) break;
        }

        // 提取类
        const classRegex = /class\s+(\w+)/g;
        matchCount = 0;
        while ((match = classRegex.exec(analysisCode)) !== null) {
            analysis.classes.push(match[1]);
            matchCount++;
            if (matchCount > 1000) break;
        }

        // 提取导入
        const importRegex = /import\s+(?:{[^}]+}|\w+)\s+from\s+['"]([^'"]+)['"]/g;
        matchCount = 0;
        while ((match = importRegex.exec(analysisCode)) !== null) {
            analysis.imports.push(match[1]);
            matchCount++;
            if (matchCount > 1000) break;
        }
    }

    // 提取函数（Python）
    if (language === 'python') {
        const functionRegex = /def\s+(\w+)\s*\(/g;
        let match;
        let matchCount = 0;
        while ((match = functionRegex.exec(analysisCode)) !== null) {
            analysis.functions.push(match[1]);
            matchCount++;
            if (matchCount > 1000) break;
        }

        const classRegex = /class\s+(\w+)/g;
        matchCount = 0;
        while ((match = classRegex.exec(analysisCode)) !== null) {
            analysis.classes.push(match[1]);
            matchCount++;
            if (matchCount > 1000) break;
        }

        const importRegex = /(?:from\s+(\S+)\s+)?import\s+([^#\n]+)/g;
        matchCount = 0;
        while ((match = importRegex.exec(analysisCode)) !== null) {
            const module = match[1] || match[2].split(',')[0].trim();
            analysis.imports.push(module);
            matchCount++;
            if (matchCount > 1000) break;
        }
    }

    // 提取 Markdown 元素
    if (language === 'markdown' || language === 'md') {
        // 提取标题
        const headingRegex = /^(#{1,6})\s+(.+)$/gm;
        let match;
        let matchCount = 0;
        const headings = [];
        while ((match = headingRegex.exec(analysisCode)) !== null) {
            headings.push({
                level: match[1].length,
                text: match[2]
            });
            matchCount++;
            if (matchCount > 1000) break;
        }
        analysis.headings = headings;

        // 统计链接
        const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
        matchCount = 0;
        const links = [];
        while ((match = linkRegex.exec(analysisCode)) !== null) {
            links.push({
                text: match[1],
                url: match[2]
            });
            matchCount++;
            if (matchCount > 1000) break;
        }
        analysis.links = links;

        // 统计代码块
        const codeBlockRegex = /```(\w*)\n([\s\S]*?)```/g;
        matchCount = 0;
        const codeBlocks = [];
        while ((match = codeBlockRegex.exec(analysisCode)) !== null) {
            codeBlocks.push({
                language: match[1] || 'plain',
                lines: match[2].split('\n').length
            });
            matchCount++;
            if (matchCount > 1000) break;
        }
        analysis.codeBlocks = codeBlocks;

        // 统计列表项
        const listItemCount = (analysisCode.match(/^[\s]*[-*+]\s+/gm) || []).length;
        const orderedListItemCount = (analysisCode.match(/^[\s]*\d+\.\s+/gm) || []).length;
        analysis.listItems = listItemCount + orderedListItemCount;

        // 统计图片
        const imageCount = (analysisCode.match(/!\[([^\]]*)\]\(([^)]+)\)/g) || []).length;
        analysis.images = imageCount;

        // Markdown 复杂度基于内容丰富度
        const totalElements =
            headings.length +
            links.length +
            codeBlocks.length +
            analysis.listItems +
            analysis.images;
        if (totalElements > 50) {
            analysis.complexity = 'high';
        } else if (totalElements > 20) {
            analysis.complexity = 'medium';
        }
    } else {
        // 计算复杂度（简单估算）
        const complexityIndicators = (analysisCode.match(/\b(if|for|while|switch|catch)\b/g) || [])
            .length;
        if (complexityIndicators > 20) {
            analysis.complexity = 'high';
        } else if (complexityIndicators > 10) {
            analysis.complexity = 'medium';
        }
    }

    return analysis;
}

/**
 * 渲染分析结果
 */
function renderAnalysisResult(analysis, container) {
    const {
        basicInfo,
        functions,
        classes,
        imports,
        complexity,
        headings,
        links,
        codeBlocks,
        listItems,
        images
    } = analysis;

    const complexityClass = `complexity-${complexity}`;
    const complexityText = { low: '低', medium: '中', high: '高' }[complexity];
    const isMarkdown = basicInfo.language === 'markdown' || basicInfo.language === 'md';

    // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
    container.innerHTML = `
        ${
            basicInfo.isLimited
                ? `
        <div class="analysis-section" style="background: rgba(255, 193, 7, 0.1); border-left: 3px solid #ffc107;">
            <p style="margin: 0; color: #f57c00; font-size: 13px;">
                ⚠️ ${isMarkdown ? '文档' : '代码文件'}较大（${basicInfo.lines} 行），分析结果仅基于前 2000 行
            </p>
        </div>
        `
                : ''
        }

        <!-- 基本信息 -->
        <div class="analysis-section">
            <h3>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                    <polyline points="14 2 14 8 20 8"></polyline>
                </svg>
                基本信息
            </h3>
            <div class="analysis-stats">
                <div class="stat-item">
                    <span class="stat-label">${isMarkdown ? '文档行数' : '代码行数'}</span>
                    <span class="stat-value">${basicInfo.lines}</span>
                </div>
                <div class="stat-item">
                    <span class="stat-label">字符数</span>
                    <span class="stat-value">${basicInfo.characters}</span>
                </div>
                <div class="stat-item">
                    <span class="stat-label">格式</span>
                    <span class="stat-value">${escapeHtml(basicInfo.language.toUpperCase())}</span>
                </div>
                <div class="stat-item">
                    <span class="stat-label">复杂度</span>
                    <span class="stat-value ${complexityClass}">${complexityText}</span>
                </div>
            </div>
        </div>

        ${
            isMarkdown
                ? `
            ${
                headings && headings.length > 0
                    ? `
            <!-- 文档结构 -->
            <div class="analysis-section">
                <h3>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M4 6h16M4 12h16M4 18h16"></path>
                    </svg>
                    文档结构 (${headings.length} 个标题)
                </h3>
                <ul class="analysis-list">
                    ${headings
                        .slice(0, 15)
                        .map(
                            (h) => `
                        <li style="padding-left: ${(h.level - 1) * 16}px; opacity: ${1 - (h.level - 1) * 0.15}">
                            ${'#'.repeat(h.level)} ${escapeHtml(h.text)}
                        </li>
                    `
                        )
                        .join('')}
                    ${headings.length > 15 ? `<li>... 还有 ${headings.length - 15} 个标题</li>` : ''}
                </ul>
            </div>
            `
                    : ''
            }

            ${
                codeBlocks && codeBlocks.length > 0
                    ? `
            <!-- 代码块 -->
            <div class="analysis-section">
                <h3>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polyline points="16 18 22 12 16 6"></polyline>
                        <polyline points="8 6 2 12 8 18"></polyline>
                    </svg>
                    代码块 (${codeBlocks.length})
                </h3>
                <ul class="analysis-list">
                    ${codeBlocks
                        .slice(0, 10)
                        .map(
                            (cb) => `
                        <li>${escapeHtml(cb.language || 'plain')} (${cb.lines} 行)</li>
                    `
                        )
                        .join('')}
                    ${codeBlocks.length > 10 ? `<li>... 还有 ${codeBlocks.length - 10} 个代码块</li>` : ''}
                </ul>
            </div>
            `
                    : ''
            }

            ${
                links && links.length > 0
                    ? `
            <!-- 链接 -->
            <div class="analysis-section">
                <h3>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path>
                        <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path>
                    </svg>
                    链接 (${links.length})
                </h3>
                <ul class="analysis-list">
                    ${links
                        .slice(0, 10)
                        .map(
                            (link) => `
                        <li title="${escapeHtml(link.url)}">${escapeHtml(link.text)}</li>
                    `
                        )
                        .join('')}
                    ${links.length > 10 ? `<li>... 还有 ${links.length - 10} 个链接</li>` : ''}
                </ul>
            </div>
            `
                    : ''
            }

            <div class="analysis-section">
                <h3>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <circle cx="12" cy="12" r="10"></circle>
                    </svg>
                    其他元素
                </h3>
                <div class="analysis-stats">
                    <div class="stat-item">
                        <span class="stat-label">列表项</span>
                        <span class="stat-value">${listItems || 0}</span>
                    </div>
                    <div class="stat-item">
                        <span class="stat-label">图片</span>
                        <span class="stat-value">${images || 0}</span>
                    </div>
                </div>
            </div>
        `
                : `
            ${
                functions.length > 0
                    ? `
            <!-- 函数列表 -->
            <div class="analysis-section">
                <h3>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <circle cx="12" cy="12" r="10"></circle>
                        <path d="M8 14s1.5 2 4 2 4-2 4-2"></path>
                        <line x1="9" y1="9" x2="9.01" y2="9"></line>
                        <line x1="15" y1="9" x2="15.01" y2="9"></line>
                    </svg>
                    函数 (${functions.length})
                </h3>
                <ul class="analysis-list">
                    ${functions.map((fn) => `<li>${escapeHtml(fn)}</li>`).join('')}
                </ul>
            </div>
            `
                    : ''
            }

            ${
                classes.length > 0
                    ? `
            <!-- 类列表 -->
            <div class="analysis-section">
                <h3>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                        <line x1="9" y1="3" x2="9" y2="21"></line>
                    </svg>
                    类 (${classes.length})
                </h3>
                <ul class="analysis-list">
                    ${classes.map((cls) => `<li>${escapeHtml(cls)}</li>`).join('')}
                </ul>
            </div>
            `
                    : ''
            }

            ${
                imports.length > 0
                    ? `
            <!-- 依赖导入 -->
            <div class="analysis-section">
                <h3>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path>
                        <polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline>
                        <line x1="12" y1="22.08" x2="12" y2="12"></line>
                    </svg>
                    依赖导入 (${imports.length})
                </h3>
                <ul class="analysis-list">
                    ${imports
                        .slice(0, 10)
                        .map((imp) => `<li>${escapeHtml(imp)}</li>`)
                        .join('')}
                    ${imports.length > 10 ? `<li>... 还有 ${imports.length - 10} 个依赖</li>` : ''}
                </ul>
            </div>
            `
                    : ''
            }
        `
        }
    `;
}
