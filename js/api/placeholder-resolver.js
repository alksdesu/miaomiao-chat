/**
 * Placeholder 解析器：sendToAPI 启动期 DOM 三分支收口。
 *
 * 三分支语义：
 *   A. continuation 模式：工具执行完毕后续轮——复用原 assistant 元素，
 *      保留 tool_call UI，追加 continuation-loading dots，标记 dataset.isContinuation
 *   B. image-retry 模式：图片压缩失败后无感重试——复用原 assistant 元素，
 *      清空内容只留 thinking-dots
 *   C. new 模式：常规新请求——createAssistantMessagePlaceholder 新挂
 *
 * 跨会话守卫：continuation 元素若来自其他会话（用户工具执行期间切走），
 * 复用过期 DOM 会污染新会话，丢弃 continuation 标记走 C 分支。
 *
 * 副作用：state.currentAssistantMessage 必须在 querySelectorAll
 * 清 dots 之前赋值——它是后续 stream helper 的写入锚点。
 */

import { state, elements } from '../core/state.js';
import { clearToolCallContinuation, clearImageRetry } from '../core/state-mutations.js';
import { createAssistantMessagePlaceholder } from '../messages/placeholder.js';
import { createContinuationLoading, createThinkingDots } from './handler-loading-dots.js';
import { requestTaskRegistry } from '../core/request-task-registry.js';
import { logger } from '../utils/logger.js';

/**
 * 把欢迎消息从 messages 区移除（三分支共用前置）
 */
function removeWelcomeMessageIfAny() {
    const welcome = elements.messagesArea?.querySelector('.welcome-message');
    if (welcome) welcome.remove();
}

/**
 * 标记续作复用的消息：流式渲染读 .message-content 上的标记判断追加，出错拆分读 .message 上的标记
 * 只靠工具卡片或 loading 判断时，没有客户端工具调用的 pause_turn 续作会覆盖上一轮内容
 * @param {HTMLElement} messageEl - .message 元素
 */
export function markContinuationElement(messageEl) {
    messageEl.dataset.isContinuation = 'true';
    const messageContent = messageEl.querySelector('.message-content');
    if (messageContent) messageContent.dataset.isContinuation = 'true';
}

/**
 * 分支 A：工具调用 continuation
 * @returns {HTMLElement} 复用的 assistantMessageEl
 */
function resolveContinuation() {
    const assistantMessageEl = state.toolCallContinuationElement;
    const messageContent = assistantMessageEl.querySelector('.message-content');

    // 必须先赋值 state.currentAssistantMessage 再清 dots——它是 stream helper
    // 的写入锚点；颠倒顺序会让残留 dots 清不掉
    state.currentAssistantMessage = messageContent;
    if (messageContent) {
        messageContent.querySelectorAll('.thinking-dots').forEach((el) => el.remove());
        messageContent.appendChild(createContinuationLoading());
    }

    // dataset 标记给流式与 finalRender 流程识别 continuation 模式，
    // 与流式渲染移除 thinking-dots 时机解耦
    markContinuationElement(assistantMessageEl);
    state.isSavingContinuation = true;
    clearToolCallContinuation();
    return assistantMessageEl;
}

/**
 * 分支 B：图片压缩重试复用
 * @returns {HTMLElement} 复用的 assistantMessageEl
 */
function resolveImageRetry() {
    const assistantMessageEl = state.imageRetryMessageElement;
    const messageContent = assistantMessageEl.querySelector('.message-content');
    state.currentAssistantMessage = messageContent;
    if (messageContent) {
        messageContent.replaceChildren(createThinkingDots());
    }
    clearImageRetry();
    return assistantMessageEl;
}

/**
 * 分支 C：全新 placeholder
 * @returns {HTMLElement} 新建的 assistantMessageEl
 */
function resolveNew() {
    const assistantMessageEl = createAssistantMessagePlaceholder();
    elements.messagesArea.appendChild(assistantMessageEl);
    state.currentAssistantMessage = assistantMessageEl.querySelector('.message-content');
    return assistantMessageEl;
}

/**
 * 续作轮出错时错误单独成条：复用元素去掉本轮的流式残留回到续作前的样子，
 * 错误渲染到紧随其后新建的占位元素，与落库后"原消息 + 错误消息"的顺序一致
 * @param {HTMLElement|null} assistantMessageEl - 续作复用的助手消息元素（或其 .message-content）
 * @returns {HTMLElement|null} 新建的占位元素；不是续作复用元素或已脱离文档时返回 null
 */
export function splitContinuationErrorPlaceholder(assistantMessageEl) {
    const messageEl = assistantMessageEl?.closest?.('.message') || null;
    if (!messageEl?.isConnected || messageEl.dataset.isContinuation !== 'true') return null;

    const messageContent = messageEl.querySelector('.message-content');
    messageContent
        ?.querySelectorAll('.continuation-content, .continuation-loading, .thinking-dots')
        .forEach((el) => el.remove());
    delete messageEl.dataset.isContinuation;
    if (messageContent) delete messageContent.dataset.isContinuation;

    const errorMessageEl = createAssistantMessagePlaceholder();
    messageEl.after(errorMessageEl);
    state.currentAssistantMessage = errorMessageEl.querySelector('.message-content');
    return errorMessageEl;
}

/**
 * 请求出错时错误块的写入目标：前台续作轮改写到新建的占位元素，不覆盖复用元素里已有的工具调用与正文
 * @param {import('./handler-context.js').HandlerContext} ctx
 * @returns {HTMLElement|null} .message-content
 */
export function resolveErrorTarget(ctx) {
    if (ctx.isContinuationMode) {
        const errorMessageEl = splitContinuationErrorPlaceholder(ctx.assistantMessageEl);
        if (errorMessageEl) {
            ctx.assistantMessageEl = errorMessageEl;
            if (ctx.task) requestTaskRegistry.setAssistantElement(ctx.task, errorMessageEl);
        }
    }
    return ctx.assistantMessageEl?.querySelector?.('.message-content') || null;
}

/**
 * 解析并装配 ctx 的 placeholder 字段。原地写入 ctx，便于 sendToAPI 主体直接读 ctx。
 * @param {import('./handler-context.js').HandlerContext} ctx
 */
export function resolvePlaceholder(ctx) {
    removeWelcomeMessageIfAny();

    const continuationStaleByCrossSession =
        state.isToolCallContinuation &&
        state.toolCallContinuationSessionId &&
        state.toolCallContinuationSessionId !== ctx.sessionId;

    if (continuationStaleByCrossSession) {
        logger.warn(
            `[PlaceholderResolver] continuation 跨会话漂移 (${state.toolCallContinuationSessionId} → ${ctx.sessionId})，丢弃 continuation 元素`
        );
        clearToolCallContinuation();
    }

    // 切走再切回后旧元素已随重渲染脱离页面，复用会把后续内容写进看不见的节点
    const continuationDetached =
        state.isToolCallContinuation && state.toolCallContinuationElement?.isConnected === false;
    if (continuationDetached) {
        logger.warn('[PlaceholderResolver] continuation 元素已脱离页面，改用新占位符');
        clearToolCallContinuation();
    }

    if (
        !continuationStaleByCrossSession &&
        !continuationDetached &&
        state.isToolCallContinuation &&
        state.toolCallContinuationElement
    ) {
        ctx.assistantMessageEl = resolveContinuation();
        ctx.isContinuationMode = true;
        return;
    }

    // image-retry 同样需要跨会话守卫：用户触发 retry 后立即切走会话，
    // imageRetryMessageElement 已脱离 messagesArea（switchToSession 会清空），
    // 复用会让 stream 写入找不到锚点；漂移则丢弃走 resolveNew
    const imageRetryStaleByCrossSession =
        state.isImageCompressionRetry &&
        state.imageRetrySessionId &&
        state.imageRetrySessionId !== ctx.sessionId;

    if (imageRetryStaleByCrossSession) {
        logger.warn(
            `[PlaceholderResolver] image-retry 跨会话漂移 (${state.imageRetrySessionId} → ${ctx.sessionId})，丢弃 retry 元素`
        );
        clearImageRetry();
    }

    const imageRetryDetached =
        state.isImageCompressionRetry && state.imageRetryMessageElement?.isConnected === false;
    if (imageRetryDetached) {
        logger.warn('[PlaceholderResolver] image-retry 元素已脱离页面，改用新占位符');
        clearImageRetry();
    }

    if (
        !imageRetryStaleByCrossSession &&
        !imageRetryDetached &&
        state.isImageCompressionRetry &&
        state.imageRetryMessageElement
    ) {
        ctx.assistantMessageEl = resolveImageRetry();
        ctx.isImageRetryMode = true;
        return;
    }

    ctx.assistantMessageEl = resolveNew();
}
