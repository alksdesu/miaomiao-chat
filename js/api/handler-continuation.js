/**
 * 工具结果回写后的 continuation 轮
 *
 * 工具结果已由 orchestrator.writeToolResultsBackToState 写回 state.messages
 * 中对应 tool_call part 的 result/state，本函数只需标记 continuation 并复用
 * state.messages 重发——adapter.partsToAPIMessages 自然展开 tool_use/tool_result。
 *
 * sendToAPI 通过 lazy import 打破循环依赖：handler.js → 本文件 → handler.js。
 */

import { state } from '../core/state.js';
import { requestStateMachine, RequestState } from '../core/request-state-machine.js';
import { setToolCallContinuation } from '../core/state-mutations.js';
import { logger } from '../utils/logger.js';

/**
 * 清理 loading 指示元素（thinking-dots / continuation-loading / retry-loading）
 * 优先在指定消息元素内查找；否则在最后一条助手消息中查找
 */
function removeLoadingIndicators(messageEl) {
    const root = messageEl
        ? messageEl.querySelector('.message-content')
        : document.querySelector('.message.assistant:last-child .message-content');
    if (!root) return;
    root.querySelectorAll('.thinking-dots, .continuation-loading, .retry-loading').forEach((el) =>
        el.remove()
    );
}

/**
 * 在 continuation 失败时给 assistant 消息追加错误提示（不用 innerHTML +=
 * 避免重解析子树破坏思维链/代码块/Mermaid 的 click listener）
 */
function appendContinuationErrorNode(assistantMessageEl, errorMessage) {
    if (!assistantMessageEl || !assistantMessageEl.isConnected) return;
    const contentDiv = assistantMessageEl.querySelector('.message-content');
    if (!contentDiv) return;

    const errEl = document.createElement('div');
    errEl.className = 'error-message continuation-error';
    errEl.textContent = `工具调用后续请求失败: ${errorMessage}`;
    contentDiv.appendChild(errEl);
}

/**
 * @param {HTMLElement|null} assistantMessageEl - 要复用的助手消息元素
 */
export async function resendWithToolResults(assistantMessageEl = null) {
    logger.info('[Handler] 发送工具结果消息...');
    const sessionId = state.currentSessionId;

    // 标记 continuation 并绑定要复用的元素 + 当前会话 ID（跨会话守卫见 placeholder-resolver）
    setToolCallContinuation(assistantMessageEl, sessionId);

    // 状态机：TOOL_CALLING → CONTINUATION（必须在 sendToAPI 之前转换，否则状态非法）
    if (requestStateMachine.canTransition(RequestState.CONTINUATION)) {
        requestStateMachine.transition(RequestState.CONTINUATION, { assistantMessageEl });
    }

    // lazy import 打破循环依赖：handler.js → handler-continuation.js → handler.js
    const { sendToAPI } = await import('./handler.js');

    try {
        await sendToAPI();
        logger.debug('[Handler] Continuation 请求完成');
    } catch (error) {
        // sendToAPI 内部 dispatchErrorHandler 已处理常规错误（含状态机 transition→ERROR），
        // 此 catch 仅兜底「handler 自身抛二次异常」等极端情况
        logger.error('[Handler] Continuation 请求失败:', error);
        state.isToolCallPending = false;
        if (state.currentSessionId === sessionId) {
            appendContinuationErrorNode(assistantMessageEl, error.message);
        }
        throw error;
    } finally {
        state.isSavingContinuation = false;

        if (!state.isToolCallPending) {
            removeLoadingIndicators(assistantMessageEl);
        } else {
            logger.debug('[Handler] 检测到新的工具调用，保留 loading 等待下一轮工具执行');
        }
        // sendButton / cancelButton / isLoading 由状态机 _updateUI hook 接管
    }
}
