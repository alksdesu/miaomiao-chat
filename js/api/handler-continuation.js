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
import { requestTaskRegistry } from '../core/request-task-registry.js';

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

function isTaskForeground(task, sessionId) {
    return (
        sessionId === state.currentSessionId &&
        (!task ||
            (!task.isDetached &&
                (requestTaskRegistry.owns(task) || requestStateMachine.owns(task))))
    );
}

/**
 * @param {HTMLElement|null} assistantMessageEl - 要复用的助手消息元素
 */
export async function resendWithToolResults(assistantMessageEl = null, task = null) {
    logger.info('[Handler] 发送工具结果消息...');
    const sessionId = task?.sessionId || state.currentSessionId;

    if (task && requestTaskRegistry.owns(task)) {
        task.isSavingContinuation = true;
        task.isToolCallPending = false;
        requestTaskRegistry.setPhase(task, RequestState.CONTINUATION);
    }
    if (isTaskForeground(task, sessionId)) {
        state.isToolCallPending = false;
        if (assistantMessageEl) setToolCallContinuation(assistantMessageEl, sessionId);
    }

    if (task) {
        requestStateMachine.transitionFor(task, RequestState.CONTINUATION, { assistantMessageEl });
    } else if (requestStateMachine.canTransition(RequestState.CONTINUATION)) {
        requestStateMachine.transition(RequestState.CONTINUATION, { assistantMessageEl });
    }

    // lazy import 打破循环依赖：handler.js → handler-continuation.js → handler.js
    const { sendToAPI } = await import('./handler.js');

    try {
        await sendToAPI(task ? { task } : undefined);
        logger.debug('[Handler] Continuation 请求完成');
    } catch (error) {
        // sendToAPI 内部 dispatchErrorHandler 已处理常规错误（含状态机 transition→ERROR），
        // 此 catch 仅兜底「handler 自身抛二次异常」等极端情况
        logger.error('[Handler] Continuation 请求失败:', error);
        if (task && requestTaskRegistry.owns(task)) task.isToolCallPending = false;
        if (isTaskForeground(task, sessionId)) state.isToolCallPending = false;
        if (isTaskForeground(task, sessionId)) {
            appendContinuationErrorNode(assistantMessageEl, error.message);
        }
        throw error;
    } finally {
        if (task && requestTaskRegistry.owns(task)) task.isSavingContinuation = false;
        if (isTaskForeground(task, sessionId)) state.isSavingContinuation = false;

        if (!task?.isToolCallPending && isTaskForeground(task, sessionId)) {
            removeLoadingIndicators(assistantMessageEl);
        } else if (task?.isToolCallPending) {
            logger.debug('[Handler] 检测到新的工具调用，保留 loading 等待下一轮工具执行');
        }
        // sendButton / cancelButton / isLoading 由状态机 _updateUI hook 接管
    }
}
