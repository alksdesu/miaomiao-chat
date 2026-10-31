/**
 * 取消信号工具：中止一律抛 AbortError，调用方按 name 识别"用户停止"
 */

/**
 * @param {string} [message]
 * @returns {DOMException}
 */
export function createAbortError(message = 'Tool execution aborted') {
    return new DOMException(message, 'AbortError');
}

/**
 * signal 已中止时抛出 AbortError
 * 不用 signal.throwIfAborted()：它抛 abort(reason) 的 reason，超时等原因会被当成普通失败
 * @param {AbortSignal|null|undefined} signal
 */
export function throwIfAborted(signal) {
    if (signal?.aborted) throw createAbortError();
}

/**
 * 动作开始前检查 signal：已中止时抛出的 AbortError 带 notExecuted 标记，界面与回复模型的文字据此说明"未执行"
 * @param {AbortSignal|null|undefined} signal
 */
export function throwIfAbortedBeforeRun(signal) {
    if (!signal?.aborted) return;
    const error = createAbortError();
    error.notExecuted = true;
    throw error;
}

/**
 * 派生一个子信号：父 signal 中止时随之中止（reason 相同），超过 timeoutMs 时以 TimeoutError 中止
 * 并发请求各自计时用：一路超时只中止这一路，用户停止经父 signal 中止全部
 * @param {AbortSignal|null|undefined} parentSignal
 * @param {Object} [options]
 * @param {number} [options.timeoutMs] 非正数或缺省时不计时
 * @returns {{ signal: AbortSignal, stopTimer: () => void, dispose: () => void }}
 *   stopTimer 只清计时器（流式响应头到达后仍要随父 signal 中止）；dispose 同时解除与父 signal 的关联
 */
export function linkAbortSignal(parentSignal, { timeoutMs } = {}) {
    const controller = new AbortController();
    const abortFromParent = () => controller.abort(parentSignal.reason);
    if (parentSignal?.aborted) {
        abortFromParent();
    } else {
        parentSignal?.addEventListener('abort', abortFromParent, { once: true });
    }
    const timeoutId =
        Number.isFinite(timeoutMs) && timeoutMs > 0
            ? setTimeout(
                  () => controller.abort(new DOMException('Request timeout', 'TimeoutError')),
                  timeoutMs
              )
            : null;
    const stopTimer = () => clearTimeout(timeoutId);
    return {
        signal: controller.signal,
        stopTimer,
        dispose() {
            stopTimer();
            parentSignal?.removeEventListener('abort', abortFromParent);
        }
    };
}
