/**
 * 流式渲染辅助函数
 * 处理流式消息的实时更新和最终渲染
 */

import { logger } from '../utils/logger.js';
import { state, elements } from '../core/state.js';
import { safeMarkedParse } from '../utils/markdown.js';
import {
    renderThinkingBlock,
    enhanceCodeBlocks,
    enhanceThinkingBlocks
} from '../messages/renderer.js';
import { renderSearchGrounding } from '../messages/render-search.js';
import { isVideoUrl } from '../utils/media.js';
import { renderMediaCard } from '../ui/media-cards.js';
import {
    RENDER_THROTTLE_CHARS,
    RENDER_THROTTLE_MS,
    SCROLL_FOLLOW_THRESHOLD_PX,
    THINKING_HEAVY_THRESHOLD_CHARS,
    THINKING_HEAVY_RENDER_THROTTLE_MS
} from '../utils/constants.js';

// 合并同帧渲染（避免每个 token 都触发重绘）
let pendingRenderData = null;
let rafId = null;

// 阈值节流状态：字符增量未到 RENDER_THROTTLE_CHARS 且时间未到 RENDER_THROTTLE_MS 时跳过 doRender
let lastRenderedLen = 0;
let lastRenderedTs = 0;

// user-scrolled 锁：基于位置的跟随锁，用户上翻即停止自动 scrollToBottom，
// 只有用户主动滚回底部（距底小于 SCROLL_FOLLOW_THRESHOLD_PX）才恢复跟随
let userScrolledUp = false;
// 程序 smooth 滚动进行中标记：中间帧距底仍大于阈值，不能被 onScroll 误判为用户上翻
let autoScrollPending = false;
let scrollListenerAttached = false;

/**
 * lazy 挂载 user-scrolled 探测监听器（passive，避免阻塞滚动）
 * wheel/touchmove/keydown(PageUp/PageDown/Up/Down) 触发即上锁；scroll 拉回底部即解锁
 */
function ensureScrollListener() {
    if (scrollListenerAttached) return;
    const area = elements.messagesArea;
    if (!area) return;

    const lockUp = () => {
        userScrolledUp = true;
        // 用户手势会中断浏览器 smooth 滚动，标记随之失效
        autoScrollPending = false;
    };

    let lastScrollTop = 0;
    const onScroll = () => {
        const distance = area.scrollHeight - area.scrollTop - area.clientHeight;
        // 程序 smooth 滚动只向下；向上位移是拖动滚动条的可靠信号（wheel/touch 不覆盖该输入），
        // 4px 容差防 scroll anchoring 舍入抖动
        const movedUp = area.scrollTop < lastScrollTop - 4;
        lastScrollTop = area.scrollTop;
        if (distance < SCROLL_FOLLOW_THRESHOLD_PX) {
            // 拉回底部视为重新跟随
            userScrolledUp = false;
            autoScrollPending = false;
        } else if (!autoScrollPending || movedUp) {
            userScrolledUp = true;
            autoScrollPending = false;
        }
    };

    const onKey = (e) => {
        // 仅响应可能改变滚动位置的按键
        if (
            e.key === 'PageUp' ||
            e.key === 'PageDown' ||
            e.key === 'ArrowUp' ||
            e.key === 'ArrowDown' ||
            e.key === 'Home' ||
            e.key === 'End'
        ) {
            lockUp();
        }
    };

    area.addEventListener('wheel', lockUp, { passive: true });
    area.addEventListener('touchmove', lockUp, { passive: true });
    area.addEventListener('keydown', onKey, { passive: true });
    area.addEventListener('scroll', onScroll, { passive: true });
    scrollListenerAttached = true;
}

/**
 * 滚动到底部（用户上翻期间不抢位，直到用户主动回到底部）
 */
function scrollToBottom() {
    if (userScrolledUp) return;
    autoScrollPending = true;
    elements.messagesArea.scrollTo({
        top: elements.messagesArea.scrollHeight,
        behavior: 'smooth'
    });
}

// 流式 markdown 前缀缓存：以最后一个空行为界，稳定前缀只 parse 一次并缓存 HTML，
// 每帧仅对尾部增量 parse；finalize 走全文完整 parse 校正分段累计误差
let textPrefixCache = { text: '', html: '' };
let thinkingPrefixCache = { text: '', html: '' };
let activeRenderContext = null;
let activeAssistantTarget = null;
const renderContexts = new WeakMap();

function getAssistantTarget() {
    return activeAssistantTarget || state.currentAssistantMessage;
}

function getRenderContext(renderKey) {
    const key =
        renderKey && (typeof renderKey === 'object' || typeof renderKey === 'function')
            ? renderKey
            : getAssistantTarget();
    if (!key) return null;
    let context = renderContexts.get(key);
    if (!context) {
        context = {
            pendingRenderData: null,
            rafId: null,
            lastRenderedLen: 0,
            lastRenderedTs: 0,
            textPrefixCache: { text: '', html: '' },
            thinkingPrefixCache: { text: '', html: '' }
        };
        renderContexts.set(key, context);
    }
    return context;
}

function runWithRenderContext(context, target, callback) {
    if (!context || !target) return undefined;
    const previousTarget = activeAssistantTarget;
    const previousContext = activeRenderContext;
    const previous = {
        pendingRenderData,
        rafId,
        lastRenderedLen,
        lastRenderedTs,
        textPrefixCache,
        thinkingPrefixCache
    };
    pendingRenderData = context.pendingRenderData;
    rafId = context.rafId;
    lastRenderedLen = context.lastRenderedLen;
    lastRenderedTs = context.lastRenderedTs;
    textPrefixCache = context.textPrefixCache;
    thinkingPrefixCache = context.thinkingPrefixCache;
    activeRenderContext = context;
    activeAssistantTarget = target;
    try {
        return callback();
    } finally {
        context.pendingRenderData = pendingRenderData;
        context.rafId = rafId;
        context.lastRenderedLen = lastRenderedLen;
        context.lastRenderedTs = lastRenderedTs;
        context.textPrefixCache = textPrefixCache;
        context.thinkingPrefixCache = thinkingPrefixCache;
        pendingRenderData = previous.pendingRenderData;
        rafId = previous.rafId;
        lastRenderedLen = previous.lastRenderedLen;
        lastRenderedTs = previous.lastRenderedTs;
        textPrefixCache = previous.textPrefixCache;
        thinkingPrefixCache = previous.thinkingPrefixCache;
        activeRenderContext = previousContext;
        activeAssistantTarget = previousTarget;
    }
}

function resetPrefixCache(cache) {
    cache.text = '';
    cache.html = '';
}

/**
 * fence 未闭合的段落边界不可作为稳定前缀（代码块被空行拦腰截断会渲染错乱）
 * @param {string} segment - 待推进的前缀增量
 * @returns {boolean}
 */
function hasBalancedFences(segment) {
    const fences = segment.match(/^ {0,3}(```|~~~)/gm);
    return !fences || fences.length % 2 === 0;
}

/**
 * 流式增量 markdown 解析：稳定前缀命中缓存，仅 parse 最后一个空行之后的尾部
 * @param {string} content - 累积全文
 * @param {{ text: string, html: string }} cache - 前缀缓存（text/thinking 各一份）
 * @returns {string} 前缀缓存 HTML + 尾部增量 HTML
 */
function parseStreamingMarkdown(content, cache) {
    if (!content) return '';
    // 内容不再以缓存前缀开头（新消息 / 重发）→ 缓存作废
    if (!content.startsWith(cache.text)) resetPrefixCache(cache);

    const boundary = content.lastIndexOf('\n\n');
    if (boundary >= cache.text.length) {
        const segment = content.slice(cache.text.length, boundary + 2);
        if (segment && hasBalancedFences(segment)) {
            cache.text += segment;
            cache.html += safeMarkedParse(segment, { isStreaming: true });
        }
    }

    if (!cache.text) return safeMarkedParse(content, { isStreaming: true });
    const tail = content.slice(cache.text.length);
    return cache.html + (tail ? safeMarkedParse(tail, { isStreaming: true }) : '');
}

/**
 * 立即同步渲染所有待处理数据，并清掉 RAF / pending 缓冲
 * finalize 路径必须先调用此函数，确保流式最后一帧不被节流吞掉
 */
function flushPendingRenderInternal() {
    if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = null;
    }
    if (pendingRenderData) {
        const { textContent, thinkingContent } = pendingRenderData;
        pendingRenderData = null;
        doRender(textContent, thinkingContent);
    }
}

export function flushPendingRender(target = getAssistantTarget(), renderKey = target) {
    const context = getRenderContext(renderKey);
    return runWithRenderContext(context, target, flushPendingRenderInternal);
}

/**
 * 清理残留的流式状态
 * 确保流结束后移除所有流式相关的 class 和元素
 * @param {HTMLElement} container - 消息容器
 */
function cleanupStreamingState(container) {
    if (!container) return;

    // 移除所有 .streaming class（思维链流式动画）
    const streamingBlocks = container.querySelectorAll('.thinking-block.streaming');
    streamingBlocks.forEach((block) => {
        block.classList.remove('streaming');
    });

    // 移除所有打字光标
    const typingCursors = container.querySelectorAll('.typing-cursor');
    typingCursors.forEach((cursor) => {
        cursor.remove();
    });

    // 移除残留的 continuation-loading
    const continuationLoading = container.querySelectorAll('.continuation-loading');
    continuationLoading.forEach((loading) => {
        loading.remove();
    });

    // 移除残留的 continuation-content 容器
    const continuationContent = container.querySelectorAll('.continuation-content');
    continuationContent.forEach((content) => {
        content.remove();
    });

    // 清除 continuation 标记
    delete container.dataset.isContinuation;

    // 重置流式节流状态：下一条流式消息从干净基线起算，避免上一条残留计数把首帧吞掉
    lastRenderedLen = 0;
    lastRenderedTs = 0;
    userScrolledUp = false;
    autoScrollPending = false;
    resetPrefixCache(textPrefixCache);
    resetPrefixCache(thinkingPrefixCache);
}

/**
 * 实际的渲染函数
 * @param {string} textContent - 文本内容
 * @param {string} thinkingContent - 思维链内容
 */
function doRender(textContent, thinkingContent) {
    if (!getAssistantTarget()) return;

    // 检测是否是 continuation 模式（有工具调用 UI 或持久标记）
    const hasToolCallUI = getAssistantTarget().querySelector('.tool-calls-group');
    const hasContinuationLoading = getAssistantTarget().querySelector('.continuation-loading');
    const isContinuation = getAssistantTarget().dataset.isContinuation === 'true';

    if (hasToolCallUI || hasContinuationLoading || isContinuation) {
        // Continuation 模式：只更新 continuation 部分
        logger.debug('[doRender] Continuation 流式模式：更新追加内容');

        // 移除之前的 continuation-content（如果存在）
        const oldContinuation = getAssistantTarget().querySelector('.continuation-content');
        if (oldContinuation) {
            oldContinuation.remove();
        }

        // 移除 continuation-loading 提示
        if (hasContinuationLoading) {
            hasContinuationLoading.remove();
        }

        // 创建 continuation 容器
        const continuationDiv = document.createElement('div');
        continuationDiv.className = 'continuation-content';

        let html = '';

        // 渲染思维链（流式中显示）
        if (thinkingContent) {
            html += renderThinkingBlock(thinkingContent, true);
        }

        // 渲染文本内容
        if (textContent) {
            html += parseStreamingMarkdown(textContent, textPrefixCache);
        }

        // 添加打字光标
        html += '<span class="typing-cursor"></span>';

        // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
        continuationDiv.innerHTML = html;
        getAssistantTarget().appendChild(continuationDiv);

        // 重新绑定思维链事件监听器
        if (thinkingContent) {
            enhanceThinkingBlocks(getAssistantTarget().parentElement, enhanceCodeBlocks);
        }

        // 增强代码块（流式渲染时折叠）
        enhanceCodeBlocks(continuationDiv);
    } else {
        // 正常模式：优先增量更新，避免 DOM 重建
        const existingThinkingBlock = getAssistantTarget().querySelector('.thinking-block');

        // 🔧 增量更新思考链（避免滚动重置）
        if (existingThinkingBlock && thinkingContent) {
            const thinkingContentEl = existingThinkingBlock.querySelector('.thinking-content');

            if (thinkingContentEl) {
                // 保存当前滚动位置
                const currentScrollTop = thinkingContentEl.scrollTop;
                const isScrolledToBottom =
                    thinkingContentEl.scrollHeight - thinkingContentEl.scrollTop <=
                    thinkingContentEl.clientHeight + 10;

                // 只更新内容，不重建 DOM
                // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
                thinkingContentEl.innerHTML = parseStreamingMarkdown(
                    thinkingContent,
                    thinkingPrefixCache
                );

                // 恢复滚动位置（如果用户在查看，保持位置；如果在底部，跟随新内容）
                if (isScrolledToBottom) {
                    thinkingContentEl.scrollTop = thinkingContentEl.scrollHeight;
                } else {
                    thinkingContentEl.scrollTop = currentScrollTop;
                }
            }

            // 更新文本内容部分（移除旧的文本和光标）
            const nodes = Array.from(getAssistantTarget().childNodes);
            nodes.forEach((node) => {
                if (node !== existingThinkingBlock) {
                    node.remove();
                }
            });

            // 添加新的文本内容
            if (textContent) {
                const textDiv = document.createElement('div');
                // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
                textDiv.innerHTML = parseStreamingMarkdown(textContent, textPrefixCache);
                getAssistantTarget().appendChild(textDiv);
            }

            // 添加打字光标
            const cursor = document.createElement('span');
            cursor.className = 'typing-cursor';
            getAssistantTarget().appendChild(cursor);

            // 增强代码块（流式渲染时折叠）
            enhanceCodeBlocks(getAssistantTarget());
        } else {
            // 首次渲染或无思考链：使用完整渲染
            // 保存思维链展开状态和滚动位置
            const expandedStates = [];
            const scrollPositions = [];
            if (thinkingContent) {
                const existingBlocks = getAssistantTarget().querySelectorAll('.thinking-block');
                existingBlocks.forEach((block, index) => {
                    expandedStates[index] = !block.classList.contains('collapsed');
                    const content = block.querySelector('.thinking-content');
                    scrollPositions[index] = content ? content.scrollTop : 0;
                });
            }

            let html = '';

            // 渲染思维链（流式中显示）
            if (thinkingContent) {
                html += renderThinkingBlock(thinkingContent, true);
            }

            // 渲染文本内容
            if (textContent) {
                html += parseStreamingMarkdown(textContent, textPrefixCache);
            }

            // 添加打字光标
            html += '<span class="typing-cursor"></span>';

            // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
            getAssistantTarget().innerHTML = html;

            // 重新绑定思维链事件监听器（innerHTML 会销毁原有监听器）
            if (thinkingContent) {
                enhanceThinkingBlocks(getAssistantTarget().parentElement, enhanceCodeBlocks);

                // 恢复展开状态和滚动位置
                const newBlocks = getAssistantTarget().querySelectorAll('.thinking-block');
                newBlocks.forEach((block, index) => {
                    if (expandedStates[index]) {
                        block.classList.remove('collapsed');
                        const header = block.querySelector('.thinking-header');
                        if (header) {
                            header.setAttribute('aria-expanded', 'true');
                            const icon = header.querySelector('.thinking-toggle-icon');
                            if (icon) {
                                icon.textContent = '▼';
                            }
                        }

                        // 恢复滚动位置
                        const content = block.querySelector('.thinking-content');
                        if (content && scrollPositions[index]) {
                            content.scrollTop = scrollPositions[index];
                        }
                    }
                });
            }

            // 增强代码块（流式渲染时折叠）
            enhanceCodeBlocks(getAssistantTarget());
        }
    }

    // 更新节流计数器（doRender 真正执行了才记 baseline）
    lastRenderedLen = (textContent || '').length;
    lastRenderedTs = performance.now();

    scrollToBottom();
}

/**
 * 实时更新流式消息内容
 * 三层节流：阈值守卫（字符增量 + 时间间隔）→ RAF 合帧 → doRender 写 baseline
 * @param {string} textContent - 文本内容
 * @param {string} thinkingContent - 思维链内容
 */
function updateStreamingMessageInternal(textContent, thinkingContent) {
    // 首次调用时挂滚动监听（element 此时已就绪）
    ensureScrollListener();

    // 阈值守卫：字符增量 + 时间间隔同时不够则跳过本次渲染，但保留最新数据供下次或 flush 用
    // thinking 重负载（>5k 字符）下整段 reparse 单帧 100-200ms，时间间隔放宽到 1.5s 让浏览器有空闲
    const nowTs = performance.now();
    const newLen = (textContent || '').length;
    const thinkingLen = (thinkingContent || '').length;
    const isHeavyThinking = thinkingLen > THINKING_HEAVY_THRESHOLD_CHARS;
    const throttleMs = isHeavyThinking ? THINKING_HEAVY_RENDER_THROTTLE_MS : RENDER_THROTTLE_MS;
    if (newLen - lastRenderedLen < RENDER_THROTTLE_CHARS && nowTs - lastRenderedTs < throttleMs) {
        pendingRenderData = { textContent, thinkingContent };
        return;
    }

    // 保存最新的渲染数据
    pendingRenderData = { textContent, thinkingContent };

    // 取消之前的 RAF
    if (rafId) {
        cancelAnimationFrame(rafId);
    }

    // 使用 requestAnimationFrame 在下一帧渲染（60fps 限制）
    const context = activeRenderContext;
    const target = getAssistantTarget();
    rafId = requestAnimationFrame(() => {
        runWithRenderContext(context, target, () => {
            if (pendingRenderData && target.isConnected !== false) {
                doRender(pendingRenderData.textContent, pendingRenderData.thinkingContent);
                pendingRenderData = null;
            }
            rafId = null;
        });
    });
}

export function updateStreamingMessage(
    textContent,
    thinkingContent,
    target = getAssistantTarget(),
    renderKey = target
) {
    const context = getRenderContext(renderKey);
    return runWithRenderContext(context, target, () =>
        updateStreamingMessageInternal(textContent, thinkingContent)
    );
}

/**
 * 渲染最终的文本和思维链内容
 * @param {string} textContent - 文本内容
 * @param {string} thinkingContent - 思维链内容
 * @param {Object} groundingMetadata - 搜索结果元数据（可选）
 */
function renderFinalTextWithThinkingInternal(
    textContent,
    thinkingContent,
    groundingMetadata = null
) {
    // 先把还在 pending 缓冲里的最后一帧刷掉，避免被阈值节流吞掉
    flushPendingRenderInternal();

    if (!getAssistantTarget()) return;

    // 检测是否是 continuation 模式（有工具调用 UI 或持久标记）
    const hasToolCallUI = getAssistantTarget().querySelector('.tool-calls-group');
    const hasContinuationLoading = getAssistantTarget().querySelector('.continuation-loading');
    const isContinuation = getAssistantTarget().dataset.isContinuation === 'true';

    if (hasToolCallUI || hasContinuationLoading || isContinuation) {
        // Continuation 模式：追加新内容，保留现有内容
        logger.debug('[renderFinalTextWithThinking] Continuation 模式：追加内容');

        // 移除 continuation-loading 提示
        if (hasContinuationLoading) {
            hasContinuationLoading.remove();
        }

        // 移除流式 continuation 容器（如果存在）
        const continuationContent = getAssistantTarget().querySelector('.continuation-content');
        if (continuationContent) {
            continuationContent.remove();
        }

        // 获取之前保存的思维链（从DOM或state中恢复）
        // 检查是否已有思维链块
        const existingThinkingBlocks = getAssistantTarget().querySelectorAll('.thinking-block');

        let html = '';

        // 只有当没有现有思维链时，才渲染新的思维链
        // 或者，如果有新的思维链，则追加为新的阶段
        if (thinkingContent) {
            if (existingThinkingBlocks.length > 0) {
                // 已有思维链，追加新的思维链为新阶段
                logger.debug('[renderFinalTextWithThinking] 检测到已有思维链，追加新阶段');
                html += renderThinkingBlock(thinkingContent, false);
            } else {
                // 没有现有思维链，正常渲染
                html += renderThinkingBlock(thinkingContent, false);
            }
        }

        if (textContent) {
            html += safeMarkedParse(textContent);
        }

        if (groundingMetadata) {
            html += renderSearchGrounding(groundingMetadata);
        }

        // 使用 insertAdjacentHTML 追加内容（而不是覆盖）
        // eslint-disable-next-line no-restricted-syntax -- 已审计：html 由 renderThinkingBlock + safeMarkedParse + renderSearchGrounding + renderMediaCard 组合，与同函数下方 innerHTML 分支同源
        getAssistantTarget().insertAdjacentHTML('beforeend', html);

        // 清除 continuation 标记
        delete getAssistantTarget().dataset.isContinuation;
    } else {
        // 正常模式：覆盖整个内容
        let html = '';

        if (thinkingContent) {
            html += renderThinkingBlock(thinkingContent, false);
        }

        if (textContent) {
            html += safeMarkedParse(textContent);
        }

        if (groundingMetadata) {
            html += renderSearchGrounding(groundingMetadata);
        }

        // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
        getAssistantTarget().innerHTML = html;
    }

    // 清理残留的流式状态（防止状态未重置）
    cleanupStreamingState(getAssistantTarget());

    enhanceCodeBlocks(getAssistantTarget());
    scrollToBottom();
}

export function renderFinalTextWithThinking(
    textContent,
    thinkingContent,
    groundingMetadata = null,
    target = getAssistantTarget(),
    renderKey = target
) {
    const context = getRenderContext(renderKey);
    return runWithRenderContext(context, target, () =>
        renderFinalTextWithThinkingInternal(textContent, thinkingContent, groundingMetadata)
    );
}

/**
 * 渲染包含图片的最终内容
 * @param {Array} contentParts - 运行时变量，非旧格式字段
 * @param {string} thinkingContent - 运行时变量，非旧格式字段
 * @param {Object} groundingMetadata - 搜索结果元数据（可选）
 */
function renderFinalContentWithThinkingInternal(
    contentParts,
    thinkingContent,
    groundingMetadata = null
) {
    // 先把还在 pending 缓冲里的最后一帧刷掉，避免被阈值节流吞掉
    flushPendingRenderInternal();

    if (!getAssistantTarget()) return;

    // 检测是否是 continuation 模式（有工具调用 UI 或持久标记）
    const hasToolCallUI = getAssistantTarget().querySelector('.tool-calls-group');
    const hasContinuationLoading = getAssistantTarget().querySelector('.continuation-loading');
    const isContinuation = getAssistantTarget().dataset.isContinuation === 'true';

    let html = '';

    // 检查 contentParts 中是否有 thinking 类型
    const hasInlineThinking = contentParts.some((p) => p.type === 'thinking');

    if (hasInlineThinking) {
        // 新模式：按 contentParts 顺序渲染（thinking 内联）
        for (const part of contentParts) {
            if (part.type === 'thinking') {
                html += renderThinkingBlock(part.text, false);
            } else if (part.type === 'text') {
                html += safeMarkedParse(part.text);
            } else if (part.type === 'video_url' && part.complete) {
                html += renderMediaCard(part.url, 'video', part.mimeType || part.mime_type);
            } else if (part.type === 'audio_url' && part.complete) {
                html += renderMediaCard(part.url, 'audio', part.mimeType || part.mime_type);
            } else if (part.type === 'image_url' && part.complete) {
                const mediaType = isVideoUrl(part.url, part.mimeType || part.mime_type)
                    ? 'video'
                    : 'image';
                html += renderMediaCard(part.url, mediaType, part.mimeType || part.mime_type);
            }
        }
    } else {
        // 检查是否已有思维链块（continuation 模式下）
        const existingThinkingBlocks = getAssistantTarget().querySelectorAll('.thinking-block');

        // 旧模式（向后兼容）：thinking 在顶部，然后是 contentParts
        // 但是在 continuation 模式下，只有当没有现有思维链时才渲染新的
        if (thinkingContent) {
            if (hasToolCallUI && existingThinkingBlocks.length > 0) {
                // Continuation 模式且已有思维链，追加新的思维链为新阶段
                logger.debug('[renderFinalContentWithThinking] 检测到已有思维链，追加新阶段');
                html += renderThinkingBlock(thinkingContent, false);
            } else {
                // 正常模式或没有现有思维链
                html += renderThinkingBlock(thinkingContent, false);
            }
        }

        for (const part of contentParts) {
            if (part.type === 'text') {
                html += safeMarkedParse(part.text);
            } else if (part.type === 'video_url' && part.complete) {
                html += renderMediaCard(part.url, 'video', part.mimeType || part.mime_type);
            } else if (part.type === 'audio_url' && part.complete) {
                html += renderMediaCard(part.url, 'audio', part.mimeType || part.mime_type);
            } else if (part.type === 'image_url' && part.complete) {
                const mediaType = isVideoUrl(part.url, part.mimeType || part.mime_type)
                    ? 'video'
                    : 'image';
                html += renderMediaCard(part.url, mediaType, part.mimeType || part.mime_type);
            }
        }
    }

    if (groundingMetadata) {
        html += renderSearchGrounding(groundingMetadata);
    }

    if (hasToolCallUI || hasContinuationLoading || isContinuation) {
        // Continuation 模式：追加新内容，保留现有内容
        logger.debug('[renderFinalContentWithThinking] Continuation 模式：追加内容');

        // 移除 continuation-loading 提示
        if (hasContinuationLoading) {
            hasContinuationLoading.remove();
        }

        // 移除流式 continuation 容器（如果存在）
        const continuationContent = getAssistantTarget().querySelector('.continuation-content');
        if (continuationContent) {
            continuationContent.remove();
        }

        // 使用 insertAdjacentHTML 追加内容（而不是覆盖）
        // eslint-disable-next-line no-restricted-syntax -- 已审计：html 由 renderThinkingBlock + safeMarkedParse + renderSearchGrounding + renderMediaCard 组合，与同函数下方 innerHTML 分支同源
        getAssistantTarget().insertAdjacentHTML('beforeend', html);

        // 清除 continuation 标记
        delete getAssistantTarget().dataset.isContinuation;
    } else {
        // 正常模式：覆盖整个内容
        // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
        getAssistantTarget().innerHTML = html;
    }

    // 清理残留的流式状态（防止状态未重置）
    cleanupStreamingState(getAssistantTarget());

    enhanceCodeBlocks(getAssistantTarget());
    scrollToBottom();
}

export function renderFinalContentWithThinking(
    contentParts,
    thinkingContent,
    groundingMetadata = null,
    target = getAssistantTarget(),
    renderKey = target
) {
    const context = getRenderContext(renderKey);
    return runWithRenderContext(context, target, () =>
        renderFinalContentWithThinkingInternal(contentParts, thinkingContent, groundingMetadata)
    );
}

export function disposeStreamRenderSession(renderKey) {
    if (!renderKey || (typeof renderKey !== 'object' && typeof renderKey !== 'function')) return;
    const context = renderContexts.get(renderKey);
    if (!context) return;
    if (context.rafId) cancelAnimationFrame(context.rafId);
    renderContexts.delete(renderKey);
}

/**
 * 清理所有未完成的图片（流结束时调用）
 * @param {Array} contentParts - 内容部分数组
 */
export function cleanupAllIncompleteImages(_contentParts) {
    // 清理图片缓冲区，释放内存
    if (state.imageBuffers) {
        state.imageBuffers.clear();
    }
}

/**
 * 处理 content 数组（文本 + 图片）
 * @param {Array} deltaContentArray - delta 内容数组
 * @param {Array} contentParts - 内容部分数组
 * @returns {number} 添加的字符数（用于长度限制检查）
 */
export async function handleContentArray(deltaContentArray, contentParts) {
    // 处理文本和完整媒体（图片/视频），跳过分块图片
    let addedLength = 0;

    for (const part of deltaContentArray) {
        if (part.type === 'text') {
            // 查找或创建文本部分
            let lastTextPart = contentParts.find((p) => p.type === 'text' && !p.complete);
            if (!lastTextPart) {
                lastTextPart = { type: 'text', text: '' };
                contentParts.push(lastTextPart);
            }
            lastTextPart.text += part.text;
            addedLength += part.text.length; // 计数文本长度
        } else if (part.type === 'image_url') {
            const imageUrl = part.image_url?.url;
            if (imageUrl && !part.image_url?.partial) {
                const mediaType = isVideoUrl(
                    imageUrl,
                    part.image_url?.mime_type || part.image_url?.mimeType
                )
                    ? 'video_url'
                    : 'image_url';
                contentParts.push({
                    type: mediaType,
                    url: imageUrl,
                    complete: true,
                    mimeType: part.image_url?.mime_type || part.image_url?.mimeType || ''
                });

                // 计数 base64 数据长度（防止超长）
                // 如果是 data URL，提取 base64 部分的长度
                const base64Match = imageUrl.match(/^data:[^;]+;base64,(.+)$/);
                if (base64Match) {
                    addedLength += base64Match[1].length;
                }
            }
        } else if (part.type === 'video_url') {
            const videoUrl = part.video_url?.url || part.url;
            const isPartial = part.video_url?.partial || part.partial;
            if (videoUrl && !isPartial) {
                contentParts.push({
                    type: 'video_url',
                    url: videoUrl,
                    complete: true,
                    mimeType:
                        part.video_url?.mime_type || part.video_url?.mimeType || part.mimeType || ''
                });
                const base64Match = videoUrl.match(/^data:[^;]+;base64,(.+)$/);
                if (base64Match) {
                    addedLength += base64Match[1].length;
                }
            }
        }
    }

    return addedLength;
}
