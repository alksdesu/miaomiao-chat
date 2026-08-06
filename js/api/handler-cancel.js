/**
 * 请求取消编排
 *
 * 三类场景统一收口：
 *   1. 状态机非 IDLE 的正常 cancel（走 stateMachine.cancel()）
 *   2. 状态机 IDLE 但 UI loading 的状态泄漏（强制重置 + 后台任务 abort）
 *   3. 工具执行中（abortToolExecution 让 orchestrator 内部 controller 也 abort）
 *
 * 单飞守卫：_cancelInFlight 防止同步重入造成双通知 / 双 forceReset 竞态。
 * 释放走 microtask 而非 setTimeout(0)——更早释放且不依赖事件循环。
 */

import { state, elements } from '../core/state.js';
import { requestStateMachine, RequestState } from '../core/request-state-machine.js';
import { clearToolCallContinuation, clearImageRetry } from '../core/state-mutations.js';
import { abortToolExecution } from '../tools/orchestrator.js';
import { logger } from '../utils/logger.js';
import { requestTaskRegistry } from '../core/request-task-registry.js';

let _cancelInFlight = false;

export function cancelCurrentRequest() {
    if (_cancelInFlight) {
        logger.debug('[Handler] cancelCurrentRequest 重入抑制');
        return false;
    }
    _cancelInFlight = true;
    try {
        return _doCancel();
    } finally {
        // 下一 microtask 释放，避免同步重入；用 Promise.resolve 而非 queueMicrotask
        // （后者在某些 Electron renderer 旧环境下可能未定义）
        Promise.resolve().then(() => {
            _cancelInFlight = false;
        });
    }
}

function _doCancel() {
    logger.debug('[Handler] 取消按钮被点击, 当前状态:', requestStateMachine.getState());

    try {
        abortToolExecution(requestTaskRegistry.getBySession(state.currentSessionId));
    } catch (err) {
        logger.error('[Handler] 通知工具执行取消失败:', err);
    }

    const isCancelButtonVisible =
        elements.cancelRequestButton &&
        elements.cancelRequestButton.style.display !== 'none' &&
        elements.cancelRequestButton.style.display !== '';
    const currentState = requestStateMachine.getState();
    const registeredTask = requestTaskRegistry.getBySession(state.currentSessionId);
    const currentTask = requestTaskRegistry.isActive(registeredTask) ? registeredTask : null;

    if (currentTask) {
        if (!requestStateMachine.owns(currentTask)) {
            requestStateMachine.attach(currentTask, currentTask.assistantMessageEl);
        }
        if (requestStateMachine.owns(currentTask)) requestStateMachine.cancel();
        requestTaskRegistry.abort(currentTask);
        requestTaskRegistry.setPhase(currentTask, RequestState.CANCELLED);
        currentTask.isToolCallPending = false;
        state.isToolCallPending = false;
        clearToolCallContinuation();
        clearImageRetry();
        logger.debug(`[Handler] 已取消请求任务 ${currentTask.id}`);
        return true;
    }

    if (
        [RequestState.COMPLETED, RequestState.ERROR, RequestState.CANCELLED].includes(currentState)
    ) {
        logger.debug('[Handler] 请求已进入结束状态，等待状态机自动回到 IDLE');
        return false;
    }

    // 场景 1：状态机非 IDLE，走正常 cancel
    if (currentState !== RequestState.IDLE) {
        const cancelled = requestStateMachine.cancel();
        if (cancelled) {
            logger.debug('[Handler] 请求已取消');
            return true;
        }
    }

    // 场景 2：状态泄漏（IDLE 但按钮可见），强制重置 + 后台任务 abort
    if (currentState === RequestState.IDLE && isCancelButtonVisible) {
        logger.warn('[Handler] 检测到状态泄漏（UI loading 但状态机 IDLE），强制重置');

        state.isLoading = false;
        state.isSending = false;
        state.isToolCallPending = false;
        state.currentAssistantMessage = null;
        clearToolCallContinuation();
        clearImageRetry();
        requestStateMachine.forceReset();
        return true;
    }

    logger.warn('[Handler] 没有检测到需要取消的请求');
    return false;
}
