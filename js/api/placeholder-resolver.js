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
import { logger } from '../utils/logger.js';

/**
 * 把欢迎消息从 messages 区移除（三分支共用前置）
 */
function removeWelcomeMessageIfAny() {
    const welcome = elements.messagesArea?.querySelector('.welcome-message');
    if (welcome) welcome.remove();
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

    // dataset 标记给 finalRender 流程识别 continuation 模式，
    // 与流式渲染移除 thinking-dots 时机解耦
    assistantMessageEl.dataset.isContinuation = 'true';
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

    if (
        !continuationStaleByCrossSession &&
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

    if (
        !imageRetryStaleByCrossSession &&
        state.isImageCompressionRetry &&
        state.imageRetryMessageElement
    ) {
        ctx.assistantMessageEl = resolveImageRetry();
        ctx.isImageRetryMode = true;
        return;
    }

    ctx.assistantMessageEl = resolveNew();
}
