/**
 * sendToAPI finally 清理：
 *   - clearTimeout（避免请求成功后还触发 timeout abort）
 *   - 后台任务表清理 + 跨会话完成/失败通知
 *   - per-sessionId image-retry 锁释放
 *   - 同会话且工具未挂起时清 currentAssistantMessage
 */

import { state } from '../core/state.js';
import { eventBus } from '../core/events.js';
import { resetAllImageRetryState } from './image-retry.js';
import { clearStreamSnapshot } from '../state/stream-snapshot.js';
import { requestTaskRegistry } from '../core/request-task-registry.js';
import { RequestState } from '../core/request-state-machine.js';

/**
 * 后台任务清理 + 跨会话完成通知
 */
function finishTask(task, requestSucceeded) {
    if (!task || !requestTaskRegistry.owns(task) || task.isToolCallPending) return;

    const sessionId = task.sessionId;
    const wasDetached = task.isDetached || sessionId !== state.currentSessionId;
    const phase = requestSucceeded
        ? RequestState.COMPLETED
        : task.abortController?.signal?.aborted
          ? RequestState.CANCELLED
          : RequestState.ERROR;
    requestTaskRegistry.finish(task, phase);

    if (!wasDetached) return;

    const session = state.sessions.find((s) => s.id === sessionId);
    const sessionName = session?.name || '会话';
    eventBus.emit('ui:notification', {
        message: requestSucceeded
            ? `「${sessionName}」的 AI 回复已完成`
            : `「${sessionName}」的 AI 回复失败`,
        type: requestSucceeded ? 'success' : 'error',
        duration: 5000
    });
}

/**
 * @param {import('./handler-context.js').HandlerContext} ctx
 * @param {boolean} requestSucceeded
 */
export function cleanupAfterSend(ctx, requestSucceeded) {
    const { sessionId, timeoutId, task } = ctx;
    if (timeoutId) clearTimeout(timeoutId);

    const wasForeground =
        sessionId === state.currentSessionId &&
        (!task || (requestTaskRegistry.owns(task) && !task.isDetached));

    if (task && requestTaskRegistry.owns(task)) task.isSavingContinuation = false;
    finishTask(task, requestSucceeded);

    resetAllImageRetryState(sessionId, task);

    // sink.commit 未执行的异常路径（parse 冒泡到 handler）会残留流式快照，此处兜底清理
    clearStreamSnapshot(sessionId, task?.id || null);

    if (wasForeground && !task?.isToolCallPending) {
        state.currentAssistantMessage = null;
    }
}
