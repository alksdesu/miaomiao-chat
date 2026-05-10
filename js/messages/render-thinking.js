/**
 * 思维链渲染模块
 * 负责思维链块的 HTML 构建、惰性渲染、折叠展开交互
 */

import { safeMarkedParse } from '../utils/markdown.js';

// 思维链块分隔符
const THINKING_BLOCK_SEPARATOR = '\n\n---\n\n';

// 惰性渲染缓存：thinkingId -> rawText
const thinkingRawContentMap = new Map();
let thinkingIdCounter = 0;

/** 清理思维链惰性渲染缓存（会话切换时调用） */
export function clearThinkingCache() {
    thinkingRawContentMap.clear();
}

/**
 * 渲染思维链块（支持多块分段显示）
 *
 * 多思考块支持：
 * - Gemini 思维链：多个 thought parts 通过分隔符连接
 * - OpenAI o系列：推理过程可能分为多个阶段
 * - Claude Extended Thinking：长思维链自动分段
 *
 * 分隔符格式：`\n\n---\n\n`
 *
 * @param {string} thinkingContent - 思维链内容（可能包含多个块）
 * @param {boolean} isStreaming - 是否流式渲染
 * @returns {string} 渲染后的 HTML
 */
export function renderThinkingBlock(thinkingContent, isStreaming = false) {
    if (!thinkingContent) return '';

    const streamingClass = isStreaming ? 'streaming' : '';
    const blocks = thinkingContent.split(THINKING_BLOCK_SEPARATOR).filter((b) => b.trim());

    if (blocks.length <= 1) {
        return renderSingleThinkingBlock(thinkingContent, '思考过程', streamingClass);
    }

    return blocks
        .map((block, index) => {
            const label = `思考阶段 ${index + 1}`;
            const isLast = index === blocks.length - 1;
            return renderSingleThinkingBlock(block, label, isLast ? streamingClass : '');
        })
        .join('');
}

/**
 * 渲染单个思维链块
 */
function renderSingleThinkingBlock(content, label, streamingClass = '') {
    const isStreaming = streamingClass.includes('streaming');
    const contentHtml = isStreaming ? safeMarkedParse(content || '') : '';

    // 折叠状态下不解析 Markdown，存储原始文本到 JS Map
    let lazyAttr = '';
    if (!isStreaming && content) {
        const tid = `t_${++thinkingIdCounter}`;
        thinkingRawContentMap.set(tid, content);
        lazyAttr = ` data-thinking-id="${tid}"`;
    }

    return `
        <div class="thinking-block collapsed ${streamingClass}">
            <div class="thinking-header"
                 role="button"
                 tabindex="0"
                 aria-expanded="false"
                 aria-label="${label} - 点击展开或收起">
                <span class="thinking-icon" aria-hidden="true">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M12 2a7 7 0 0 1 7 7c0 2.38-1.19 4.47-3 5.74V17a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1v-2.26C6.19 13.47 5 11.38 5 9a7 7 0 0 1 7-7z"/>
                        <path d="M9 21h6"/>
                        <path d="M10 21v-1a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1"/>
                    </svg>
                </span>
                <span class="thinking-label">${label}</span>
                <span class="thinking-toggle-icon" aria-hidden="true">▶</span>
            </div>
            <div class="thinking-content"${lazyAttr}>
                ${contentHtml}
            </div>
        </div>
    `;
}

/**
 * 增强思维链块（添加折叠/展开功能）
 * @param {HTMLElement} container - 容器元素
 * @param {Function} enhanceCodeBlocksFn - 代码块增强回调（避免循环依赖）
 */
export function enhanceThinkingBlocks(container, enhanceCodeBlocksFn) {
    const headers = container.querySelectorAll('.thinking-header');

    headers.forEach((header) => {
        if (header.dataset.enhanced === 'true') return;
        header.dataset.enhanced = 'true';

        const block = header.closest('.thinking-block');
        if (!block) return;

        const toggleThinking = () => {
            const isCollapsed = block.classList.toggle('collapsed');
            header.setAttribute('aria-expanded', !isCollapsed);

            // 惰性渲染：首次展开时从 Map 取原始文本并解析 Markdown
            if (!isCollapsed) {
                const contentDiv = block.querySelector('.thinking-content');
                const tid = contentDiv?.dataset.thinkingId;
                if (tid && thinkingRawContentMap.has(tid)) {
                    // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
                    contentDiv.innerHTML = safeMarkedParse(thinkingRawContentMap.get(tid));
                    thinkingRawContentMap.delete(tid);
                    delete contentDiv.dataset.thinkingId;
                    if (enhanceCodeBlocksFn) enhanceCodeBlocksFn(block);
                }
            }

            const icon = header.querySelector('.thinking-toggle-icon');
            if (icon) {
                icon.textContent = isCollapsed ? '▶' : '▼';
            }
        };

        header.addEventListener('click', toggleThinking);
        header.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                toggleThinking();
            }
        });
    });
}
