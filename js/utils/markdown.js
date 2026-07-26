/**
 * Markdown 解析和处理
 * 依赖全局的 marked.js 库
 */

import { logger } from './logger.js';
import { escapeHtml, extractBase64Images, restoreBase64Images } from './helpers.js';
import { MAX_MARKDOWN_LENGTH } from './constants.js';
import { ALLOWED_URI_REGEXP } from './uri.js';
import remend from '../vendor/remend.js';

// 性能优化：DOMPurify 配置常量（避免每次创建对象）
const DOMPURIFY_CONFIG = {
    ALLOWED_TAGS: [
        'p',
        'br',
        'strong',
        'em',
        'code',
        'pre',
        'a',
        'ul',
        'ol',
        'li',
        'blockquote',
        'h1',
        'h2',
        'h3',
        'h4',
        'h5',
        'h6',
        'table',
        'thead',
        'tbody',
        'tr',
        'th',
        'td',
        'img',
        'hr',
        'del',
        'span',
        'div',
        'sup',
        'sub',
        'mark',
        'small',
        'kbd',
        'b',
        'i',
        'u',
        's',
        // KaTeX MathML 支持（数学公式渲染）
        'math',
        'semantics',
        'mrow',
        'mi',
        'mn',
        'mo',
        'mfrac',
        'msup',
        'msub',
        'munder',
        'mover',
        'munderover',
        'msqrt',
        'mroot',
        'mtext',
        'mspace',
        'mtable',
        'mtr',
        'mtd',
        'annotation',
        'annotation-xml',
        // SVG 支持（图标、图形渲染）
        'svg',
        'path',
        'circle',
        'rect',
        'line',
        'polyline',
        'polygon',
        'ellipse',
        'g',
        'defs',
        'use',
        'symbol',
        'marker',
        'clipPath',
        'linearGradient',
        'radialGradient',
        'stop',
        'text',
        'tspan'
    ],
    ALLOWED_ATTR: [
        'href',
        'src',
        'alt',
        'title',
        'class',
        'id',
        'data-*',
        'aria-*',
        'role',
        'target',
        'rel',
        // KaTeX 需要的 MathML 属性
        'xmlns',
        'encoding',
        'mathvariant',
        'mathsize',
        'mathcolor',
        'mathbackground',
        'displaystyle',
        'scriptlevel',
        // SVG 需要的属性
        'viewBox',
        'width',
        'height',
        'fill',
        'stroke',
        'stroke-width',
        'stroke-linecap',
        'stroke-linejoin',
        'stroke-dasharray',
        'd',
        'cx',
        'cy',
        'r',
        'rx',
        'ry',
        'x',
        'y',
        'x1',
        'y1',
        'x2',
        'y2',
        'points',
        'transform',
        'opacity',
        'fill-opacity',
        'stroke-opacity',
        'gradientUnits',
        'gradientTransform',
        'offset',
        'stop-color'
    ],
    // URI 协议白名单：只放行 http/https/mailto/tel/callto + 锚点/相对路径；data: 由独立 hook 仅放图片
    // 拒绝 javascript:/vbscript:/data:text/html 等任意脚本协议
    // 与 utils/uri.js 共享同一份正则，确保 DOMPurify sanitize 与运行时 isSafeHref 校验一致
    ALLOWED_URI_REGEXP,
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'style', 'form', 'input', 'button'],
    // 禁掉所有事件处理器（on*）和 style 属性，style 可承载 background:url(javascript:...) 注入
    FORBID_ATTR: [
        'style',
        'onerror',
        'onclick',
        'onload',
        'onmouseover',
        'onfocus',
        'onblur',
        'oninput',
        'onchange',
        'onmouseenter',
        'onmouseleave',
        'onkeydown',
        'onkeyup',
        'onkeypress',
        'onsubmit',
        'onreset',
        'onscroll',
        'ondrag',
        'ondrop',
        'onanimationend',
        'onanimationstart',
        'ontransitionend'
    ],
    ALLOW_DATA_ATTR: true,
    ALLOW_ARIA_ATTR: true
};

// data: URI 仅在 <img src> 上限定为 image/* MIME，禁止 data:text/html 跨 frame XSS
// 必须在 DOMPurify 加载完成后注册（main.js 启动早期检查），重复注册无害（DOMPurify 内部 dedup hook）
let _dompurifyHookRegistered = false;
function ensureDOMPurifyImageDataUriHook() {
    if (_dompurifyHookRegistered) return;
    if (typeof DOMPurify === 'undefined' || typeof DOMPurify.addHook !== 'function') return;
    _dompurifyHookRegistered = true;
    DOMPurify.addHook('uponSanitizeAttribute', (_node, data) => {
        if (data.attrName === 'src' && /^data:/i.test(data.attrValue)) {
            if (!/^data:image\/(png|jpe?g|gif|webp|svg\+xml|bmp);/i.test(data.attrValue)) {
                data.keepAttr = false;
            }
        }
    });
}

// 性能优化：简单的 LRU 缓存（缓存最近解析的结果）
class MarkdownCache {
    constructor(maxSize = 50) {
        this.cache = new Map();
        this.maxSize = maxSize;
    }

    get(key) {
        if (!this.cache.has(key)) return null;
        // LRU：访问时移到最后
        const value = this.cache.get(key);
        this.cache.delete(key);
        this.cache.set(key, value);
        return value;
    }

    set(key, value) {
        // 如果已存在，先删除（更新顺序）
        if (this.cache.has(key)) {
            this.cache.delete(key);
        }
        // 如果超出大小，删除最老的项（Map 第一项）
        else if (this.cache.size >= this.maxSize) {
            const firstKey = this.cache.keys().next().value;
            this.cache.delete(firstKey);
        }
        this.cache.set(key, value);
    }

    clear() {
        this.cache.clear();
    }

    getStats() {
        return {
            size: this.cache.size,
            maxSize: this.maxSize
        };
    }
}

const markdownCache = new MarkdownCache(300);

function djb2Hash(text) {
    let hash = 5381;
    for (let i = 0; i < text.length; i++) {
        hash = (hash << 5) + hash + text.charCodeAt(i);
        hash = hash & hash; // 转32位整数
    }
    return hash >>> 0;
}

function sdbmHash(text) {
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
        hash = text.charCodeAt(i) + (hash << 6) + (hash << 16) - hash;
        hash = hash & hash;
    }
    return hash >>> 0;
}

/**
 * 生成缓存键
 * 单 32 位哈希在缓存量大时存在生日碰撞风险，碰撞会把另一条消息的 HTML 渲染出来，
 * 因此用长度 + 双独立哈希 + 首尾切片组合，把碰撞概率压到可忽略
 * @param {string} text - 文本内容
 * @returns {string} 缓存键
 */
function generateCacheKey(text) {
    if (text.length <= 200) return text;
    const head = text.slice(0, 24);
    const tail = text.slice(-24);
    return `h_${text.length}_${djb2Hash(text).toString(36)}_${sdbmHash(text).toString(36)}|${head}|${tail}`;
}

/**
 * 安全地解析 Markdown
 * 支持 LaTeX 数学公式渲染
 * @param {string} text - Markdown 文本
 * @param {Object} [options] - 解析选项
 * @param {boolean} [options.isStreaming=false] - 是否流式态（流式态走预补全 + 单块 + 不污染稳定缓存）
 * @returns {string} HTML 字符串
 */
export function safeMarkedParse(text, options = {}) {
    // 防 null：options 可能被显式传 null
    const { isStreaming = false } = options || {};

    // 如果 marked 未加载，降级为纯文本
    if (typeof marked === 'undefined') {
        return escapeHtml(text).replace(/\n/g, '<br>');
    }

    // 性能优化：检查缓存
    // 流式态加 __s 后缀隔离，防止半成品 HTML 污染稳定态 LRU
    const baseKey = generateCacheKey(text);
    const cacheKey = isStreaming ? baseKey + '__s' : baseKey + '__f';
    const cached = markdownCache.get(cacheKey);
    if (cached) {
        return cached;
    }

    try {
        // 1. 先提取 LaTeX 公式（避免被 marked 解析）
        const { text: textWithoutLatex, formulas } = extractLatexFormulas(text);

        // 2. 然后提取 base64 图片
        const { text: extractedText, images } = extractBase64Images(textWithoutLatex);
        let cleanText = extractedText;

        // 3. 流式态：在 marked.parse 之前用 remend 预补全未闭合的 markdown 标记
        // htmlTags:false 保护 <think>/<tool_use> 这类业务自定义标签，images:false 避免 base64 占位符被处理
        if (isStreaming) {
            cleanText = remend(cleanText, { htmlTags: false, images: false });
        }

        let html;

        // 如果内容过大，分块处理；但流式态强制走单块，分块会破坏跨边界的 $$..$$ 公式
        if (cleanText.length > MAX_MARKDOWN_LENGTH && !isStreaming) {
            logger.warn(`内容过大 (${cleanText.length} 字符)，分块解析 Markdown`);
            const chunks = [];
            let remaining = cleanText;

            while (remaining.length > 0) {
                // 尝试在段落边界分割
                let splitIndex = MAX_MARKDOWN_LENGTH;
                const nearestNewline = remaining.lastIndexOf('\n\n', MAX_MARKDOWN_LENGTH);
                if (nearestNewline > MAX_MARKDOWN_LENGTH / 2) {
                    splitIndex = nearestNewline + 2;
                }

                const chunk = remaining.substring(0, splitIndex);
                remaining = remaining.substring(splitIndex);

                try {
                    // 优化：先解析，再统一净化（避免重复 sanitize）
                    const chunkHtml = marked.parse(chunk);
                    chunks.push(chunkHtml);
                } catch (_error) {
                    // 单块解析失败，使用纯文本
                    chunks.push(`<pre>${escapeHtml(chunk)}</pre>`);
                }
            }
            // 优化：合并后统一净化，而不是每块都净化
            html = chunks.join('');
        } else {
            html = marked.parse(cleanText);
        }

        // ⚠️ 关键安全措施：使用 DOMPurify 净化 HTML，防止 XSS 攻击
        // 性能优化：使用预定义的配置常量
        if (typeof DOMPurify !== 'undefined') {
            ensureDOMPurifyImageDataUriHook();
            html = DOMPurify.sanitize(html, DOMPURIFY_CONFIG);
            // 快照第 1 次 sanitize 移除的节点：流式态半成品移除属正常，记 debug；
            // 非流式态出现移除意味着 LLM 真在尝试输出危险节点，记 warn 便于上报
            const removedFirst = (DOMPurify.removed || []).slice();
            if (removedFirst.length > 0) {
                if (isStreaming) {
                    logger.debug('DOMPurify 移除节点（流式）:', removedFirst.length, removedFirst);
                } else {
                    logger.warn('DOMPurify 移除节点（稳定态）:', removedFirst.length, removedFirst);
                }
            }
        } else {
            // DOMPurify 不可用时降级为纯文本，防止未净化的 HTML 导致 XSS
            logger.warn('DOMPurify 未加载，降级为纯文本输出');
            return escapeHtml(text);
        }

        // 3. 还原 LaTeX 公式（在还原图片之前）
        if (formulas.length > 0) {
            html = restoreLatexFormulas(html, formulas);
        }

        // 4. 还原 base64 图片
        if (images.length > 0) {
            html = restoreBase64Images(html, images);
        }

        // 二次净化：restore 操作可能引入未经净化的 HTML（如 KaTeX 输出、img 标签）
        // 移除潜在的事件处理器属性，防止通过 alt/formula 注入 XSS
        if (typeof DOMPurify !== 'undefined') {
            ensureDOMPurifyImageDataUriHook();
            html = DOMPurify.sanitize(html, DOMPURIFY_CONFIG);
        }

        // 性能优化：将结果存入缓存
        // 流式态半成品不写 LRU，防止挤掉稳定态条目；稳定态结束帧重新走分支才落缓存
        if (!isStreaming) {
            markdownCache.set(cacheKey, html);
        }

        return html;
    } catch (e) {
        logger.error('Markdown 解析失败:', e);
        // 降级为纯文本显示
        return `<pre>${escapeHtml(text)}</pre>`;
    }
}

/**
 * 清除 Markdown 缓存（用于内存管理）
 */
export function clearMarkdownCache() {
    markdownCache.clear();
    logger.debug('Markdown 缓存已清除');
}

/**
 * 获取缓存统计信息
 */
export function getMarkdownCacheStats() {
    return markdownCache.getStats();
}

/**
 * 提取 LaTeX 公式（避免被 Markdown 解析器误处理）
 * 支持行内公式 $...$ 和块级公式 $$...$$
 * @param {string} text - 原始文本
 * @returns {Object} { text: 处理后的文本, formulas: 公式数组 }
 */
function extractLatexFormulas(text) {
    const formulas = [];
    let result = text;

    // 1. 提取块级公式 $$...$$ （必须在行内公式之前处理，支持多行）
    result = result.replace(/\$\$([\s\S]+?)\$\$/g, (match, formula) => {
        const index = formulas.length;
        formulas.push({ formula: formula.trim(), display: true });
        return `<span class="latex-placeholder" data-index="${index}"></span>`;
    });

    // 2. 提取行内公式 $...$
    // 确保 $ 前面不是 \ 或 $，用捕获组替代 lookbehind 以兼容旧版 Safari/WebView
    result = result.replace(
        /(?:^|([^\\$]))(\$(?:[^$\n\\]|\\.)+\$)(?=[^$]|$)/gm,
        (match, prefix, formulaWithDollar) => {
            const formula = formulaWithDollar.slice(1, -1);

            // 过滤货币符号：以数字开头的很可能是 $100 之类
            if (/^\d/.test(formula.trim())) {
                return match;
            }

            // 必须包含数学相关字符（字母、反斜杠、花括号、上下标等）
            if (!/[a-zA-Z\\{}^_=+\-*/<>]/.test(formula)) {
                return match;
            }

            const index = formulas.length;
            formulas.push({ formula: formula.trim(), display: false });

            return `${prefix || ''}<span class="latex-placeholder" data-index="${index}"></span>`;
        }
    );

    return { text: result, formulas };
}

/**
 * 还原 LaTeX 公式为渲染后的 HTML
 * 使用 KaTeX 渲染数学公式
 * @param {string} html - HTML 内容
 * @param {Array} formulas - 公式数组
 * @returns {string} 还原后的 HTML
 */
function restoreLatexFormulas(html, formulas) {
    if (typeof katex === 'undefined') {
        logger.warn('KaTeX 未加载，无法渲染数学公式');
        // 降级：还原原始公式文本
        formulas.forEach((item, index) => {
            const original = item.display ? `$$${item.formula}$$` : `$${item.formula}$`;
            const placeholder = `<span class="latex-placeholder" data-index="${index}"></span>`;
            html = html.replace(
                placeholder,
                `<code class="latex-fallback">${escapeHtml(original)}</code>`
            );
        });
        return html;
    }

    formulas.forEach((item, index) => {
        try {
            const rendered = katex.renderToString(item.formula, {
                displayMode: item.display,
                throwOnError: false,
                output: 'html',
                trust: false, // 安全：不信任 HTML/JavaScript
                strict: 'warn'
            });

            // 包装渲染结果
            const wrapper = item.display
                ? `<div class="katex-display-wrapper">${rendered}</div>`
                : `<span class="katex-inline-wrapper">${rendered}</span>`;

            const placeholder = `<span class="latex-placeholder" data-index="${index}"></span>`;
            html = html.replace(placeholder, wrapper);
        } catch (e) {
            logger.error('LaTeX 渲染失败:', e, '公式:', item.formula);
            // 降级：显示原始公式
            const original = item.display ? `$$${item.formula}$$` : `$${item.formula}$`;
            const placeholder = `<span class="latex-placeholder" data-index="${index}"></span>`;
            html = html.replace(
                placeholder,
                `<code class="latex-error" title="公式渲染失败: ${escapeHtml(e.message)}">${escapeHtml(original)}</code>`
            );
        }
    });

    return html;
}
