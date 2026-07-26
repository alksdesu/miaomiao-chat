/**
 * 思维链渲染模块
 * 负责思维链块的 HTML 构建、惰性渲染、折叠展开交互
 */

import { safeMarkedParse } from '../utils/markdown.js';
import { state } from '../core/state.js';
import { getThinkingContent } from './schema.js';

// 思维链块分隔符
const THINKING_BLOCK_SEPARATOR = '\n\n---\n\n';

// 惰性渲染缓存：thinkingId -> rawText
// LRU 上限：100k thinking 多次重渲累积百份副本可达 GB 级，需主动淘汰最老条目
const THINKING_CACHE_MAX_ENTRIES = 200;
const thinkingRawContentMap = new Map();
let thinkingIdCounter = 0;

function setThinkingCacheEntry(tid, content) {
    if (thinkingRawContentMap.has(tid)) {
        thinkingRawContentMap.delete(tid);
    } else if (thinkingRawContentMap.size >= THINKING_CACHE_MAX_ENTRIES) {
        // 淘汰最老一条（Map.keys() 按插入顺序）
        const oldest = thinkingRawContentMap.keys().next().value;
        if (oldest !== undefined) thinkingRawContentMap.delete(oldest);
    }
    thinkingRawContentMap.set(tid, content);
}

/** 清理思维链惰性渲染缓存（会话切换时调用） */
export function clearThinkingCache() {
    thinkingRawContentMap.clear();
}

/**
 * LRU 淘汰后的兜底：经消息 DOM 定位 state.messages 里的原始 thinking 内容
 * @param {HTMLElement} block - thinking-block 元素
 * @returns {string|null} 该 block 对应的 thinking 原文，找不到返回 null
 */
function resolveThinkingFromState(block) {
    const messageEl = block.closest('.message');
    if (!messageEl) return null;

    let msg = null;
    const idx = parseInt(messageEl.dataset.messageIndex, 10);
    if (Number.isInteger(idx) && state.messages[idx]) {
        msg = state.messages[idx];
    }
    if (!msg && messageEl.dataset.messageId) {
        msg = state.messages.find((m) => m?.id === messageEl.dataset.messageId) || null;
    }
    if (!msg) return null;

    let full = getThinkingContent(msg);
    if (!full) {
        // 多回复消息的 thinking 可能只落在选中 reply 上
        const all = msg.replies?.all;
        if (Array.isArray(all) && all.length > 0) {
            const selected = all[msg.replies.selected ?? 0] || all[0];
            if (selected) full = getThinkingContent(selected);
        }
    }
    if (!full) return null;

    const textBlocks = full.split(THINKING_BLOCK_SEPARATOR).filter((b) => b.trim());
    if (textBlocks.length <= 1) return full;

    // 多块场景按 block 在容器内的位置索引对齐 split 结果
    const container = block.closest('.message-content') || messageEl;
    const domBlocks = Array.from(container.querySelectorAll('.thinking-block'));
    const blockIdx = domBlocks.indexOf(block);
    return textBlocks[blockIdx] ?? full;
}

/**
 * 惰性渲染 thinking-content：优先取 LRU 缓存，miss 时回退 state.messages 原文
 * @param {HTMLElement} block - thinking-block 元素
 * @param {HTMLElement} contentDiv - thinking-content 元素
 * @param {Function} [enhanceCodeBlocksFn] - 渲染后按需触发代码块增强
 */
function renderLazyThinkingContent(block, contentDiv, enhanceCodeBlocksFn) {
    const tid = contentDiv?.dataset.thinkingId;
    if (!tid) return;

    let raw = null;
    if (thinkingRawContentMap.has(tid)) {
        raw = thinkingRawContentMap.get(tid);
        thinkingRawContentMap.delete(tid);
    } else {
        raw = resolveThinkingFromState(block);
    }
    delete contentDiv.dataset.thinkingId;

    if (raw) {
        // eslint-disable-next-line no-restricted-syntax -- 已审计：safeMarkedParse 输出
        contentDiv.innerHTML = safeMarkedParse(raw);
        if (enhanceCodeBlocksFn) enhanceCodeBlocksFn(block);
    } else {
        contentDiv.textContent = '思维链内容不可用（缓存已回收且消息数据缺失）';
    }
}

/**
 * 主动清理指定 DOM 节点内的所有 thinking-id 缓存
 * 用于 rerenderMessageContent / renderReplyWithSelector 重渲前避免旧 tid 永久泄漏
 */
export function purgeThinkingCacheInElement(el) {
    if (!el || typeof el.querySelectorAll !== 'function') return;
    el.querySelectorAll('[data-thinking-id]').forEach((node) => {
        const tid = node.dataset.thinkingId;
        if (tid) thinkingRawContentMap.delete(tid);
    });
}

/**
 * 捕获指定容器内所有 thinking-block 的展开状态（按位置索引）
 * thinkingId 每次渲染都是新临时值不能持久化，按 block 在容器内的位置索引识别即可对齐
 * @param {HTMLElement} el
 * @returns {number[]} 当前已展开的 block 索引数组
 */
export function captureExpandedThinkingState(el) {
    if (!el || typeof el.querySelectorAll !== 'function') return [];
    const blocks = el.querySelectorAll('.thinking-block');
    const expanded = [];
    blocks.forEach((block, idx) => {
        if (!block.classList.contains('collapsed')) expanded.push(idx);
    });
    return expanded;
}

/**
 * 还原 thinking-block 展开状态（位置索引匹配）
 * rerender 后调用：把 captureExpandedThinkingState 拿到的索引集合还原到新 block 上，
 * 让用户展开的思维链不会因重渲被强制折叠
 * @param {HTMLElement} el
 * @param {number[]} expanded - captureExpandedThinkingState 返回值
 * @param {Function} [enhanceCodeBlocksFn] - 展开时按需触发代码块增强
 */
export function restoreExpandedThinkingState(el, expanded, enhanceCodeBlocksFn) {
    if (!el || !Array.isArray(expanded) || expanded.length === 0) return;
    const blocks = el.querySelectorAll('.thinking-block');
    expanded.forEach((idx) => {
        const block = blocks[idx];
        if (!block) return;
        block.classList.remove('collapsed');
        const header = block.querySelector('.thinking-header');
        header?.setAttribute('aria-expanded', 'true');
        const icon = header?.querySelector('.thinking-toggle-icon');
        if (icon) icon.textContent = '▼';

        // 走和 toggleThinking 展开分支一样的惰性渲染路径，避免还原后展开仍是空白
        const contentDiv = block.querySelector('.thinking-content');
        if (contentDiv) {
            renderLazyThinkingContent(block, contentDiv, enhanceCodeBlocksFn);
        }
    });
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

    // 折叠状态下不解析 Markdown，存储原始文本到 JS Map（带 LRU 淘汰）
    let lazyAttr = '';
    if (!isStreaming && content) {
        const tid = `t_${++thinkingIdCounter}`;
        setThinkingCacheEntry(tid, content);
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

            // 惰性渲染：首次展开时从 Map 取原始文本并解析 Markdown，miss 时回退 state 原文
            if (!isCollapsed) {
                const contentDiv = block.querySelector('.thinking-content');
                if (contentDiv) {
                    renderLazyThinkingContent(block, contentDiv, enhanceCodeBlocksFn);
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
