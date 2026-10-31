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
