/**
 * 请求状态机
 * 统一管理请求的所有状态转换，防止状态泄漏
 */

import { eventBus } from './events.js';
import { EVENTS } from './events-registry.js';
import { elements } from './elements.js';
import { state } from './state.js';
import { logger } from '../utils/logger.js';

/**
 * 请求状态枚举
 */
export const RequestState = {
    IDLE: 'idle', // 空闲状态
    SENDING: 'sending', // 正在发送用户消息
    STREAMING: 'streaming', // 正在接收流式响应
    TOOL_CALLING: 'tool_calling', // 正在执行工具调用
    CONTINUATION: 'continuation', // 工具调用后的续写
    COMPLETED: 'completed', // 请求完成（临时状态，会立即转回 IDLE）
    ERROR: 'error', // 请求错误（临时状态，会立即转回 IDLE）
    CANCELLED: 'cancelled' // 请求取消（临时状态，会立即转回 IDLE）
};

/**
 * 状态转换规则
 * 定义哪些状态可以转换到哪些状态
 */
const VALID_TRANSITIONS = {
    [RequestState.IDLE]: [RequestState.SENDING],
    [RequestState.SENDING]: [
        RequestState.STREAMING,
        RequestState.ERROR,
        RequestState.CANCELLED,
        RequestState.COMPLETED
    ],
    [RequestState.STREAMING]: [
        RequestState.TOOL_CALLING,
        RequestState.COMPLETED,
        RequestState.ERROR,
        RequestState.CANCELLED
    ],
    [RequestState.TOOL_CALLING]: [
        RequestState.CONTINUATION,
        RequestState.COMPLETED,
        RequestState.ERROR,
        RequestState.CANCELLED
    ],
    [RequestState.CONTINUATION]: [
        RequestState.SENDING,
        RequestState.STREAMING,
        RequestState.TOOL_CALLING,
        RequestState.COMPLETED,
        RequestState.ERROR,
        RequestState.CANCELLED
    ],
    [RequestState.COMPLETED]: [RequestState.IDLE],
    [RequestState.ERROR]: [RequestState.IDLE],
    [RequestState.CANCELLED]: [RequestState.IDLE]
};

/**
 * 请求状态机类
 */
export class RequestStateMachine {
    constructor() {
        this.state = RequestState.IDLE;
        this.abortController = null;
        this.assistantMessageEl = null;
        this.sessionId = null;
        this.sendLockTimeout = null;
        this._autoIdleTimer = null;
        this.stateHistory = []; // 用于调试
        this.maxHistorySize = 20;
    }

    /**
     * 获取当前状态
     */
    getState() {
        return this.state;
    }

    /**
     * 检查是否可以转换到新状态
     */
    canTransition(newState) {
        const validStates = VALID_TRANSITIONS[this.state] || [];
        return validStates.includes(newState);
    }

    /**
     * 状态转换
     */
    transition(newState, metadata = {}) {
        // 验证转换是否合法
        if (!this.canTransition(newState)) {
            logger.error(`[StateMachine] 非法状态转换: ${this.state} -> ${newState}`);
            logger.error('[StateMachine] 当前状态:', this.state);
            logger.error('[StateMachine] 允许的转换:', VALID_TRANSITIONS[this.state]);
            // 不抛出错误，而是记录日志，防止阻塞正常流程
            return false;
        }

        // 清理上一次的自动回 IDLE 定时器
        if (this._autoIdleTimer) {
            clearTimeout(this._autoIdleTimer);
            this._autoIdleTimer = null;
        }

        const oldState = this.state;
        this.state = newState;

        // 记录状态历史（精简 metadata，避免存储大对象）
        const metaSummary = metadata
            ? { type: typeof metadata, keys: Object.keys(metadata).join(',') }
            : null;
        this.stateHistory.push({
            from: oldState,
            to: newState,
            timestamp: Date.now(),
            meta: metaSummary
        });
        if (this.stateHistory.length > this.maxHistorySize) {
            this.stateHistory.shift();
        }

        logger.debug(`[StateMachine] 状态转换: ${oldState} -> ${newState}`, metadata);

        // 同步旧版标志位
        state.isLoading = !![
            RequestState.SENDING,
            RequestState.STREAMING,
            RequestState.TOOL_CALLING,
            RequestState.CONTINUATION
        ].includes(newState);
        state.isSending = !!(newState === RequestState.SENDING);

        // 执行状态进入钩子
        this._onEnterState(newState, metadata);

        // 自动转换临时状态
        if (
            [RequestState.COMPLETED, RequestState.ERROR, RequestState.CANCELLED].includes(newState)
        ) {
            // 短暂延迟后转回 IDLE（确保 UI 更新完成）
            this._autoIdleTimer = setTimeout(() => {
                this._autoIdleTimer = null;
                if (this.state === newState) {
                    this.transition(RequestState.IDLE);
                }
            }, 100);
        }

        return true;
    }

    /**
     * 状态进入钩子
     */
    _onEnterState(state, metadata) {
        switch (state) {
            case RequestState.IDLE:
                this._onIdle();
                break;
            case RequestState.SENDING:
                this._onSending(metadata);
                break;
            case RequestState.STREAMING:
                this._onStreaming(metadata);
                break;
            case RequestState.TOOL_CALLING:
                this._onToolCalling(metadata);
                break;
            case RequestState.CONTINUATION:
                this._onContinuation(metadata);
                break;
            case RequestState.COMPLETED:
                this._onCompleted();
                break;
            case RequestState.ERROR:
                this._onError(metadata);
                break;
            case RequestState.CANCELLED:
                this._onCancelled();
                break;
        }
    }

    /**
     * IDLE 状态钩子
     */
    _onIdle() {
        // 清理所有状态
        this.abortController = null;
        this.assistantMessageEl = null;
        this.sessionId = null;

        // 清理发送锁
        if (this.sendLockTimeout) {
            clearTimeout(this.sendLockTimeout);
            this.sendLockTimeout = null;
        }

        // 更新 UI
        this._updateUI({
            sendButtonDisabled: false,
            sendButtonVisible: true,
            cancelButtonVisible: false
        });

        // 通知 provider-sync 等待者：本轮流式/工具/续写已彻底结束，可以安全清 cross-provider 元数据
        eventBus.emit(EVENTS.STREAM_COMPLETE);

        logger.debug('[StateMachine] 已进入 IDLE 状态，所有资源已清理');
    }

    /**
     * SENDING 状态钩子
     */
    _onSending(metadata) {
        const { abortController, sessionId } = metadata;

        this.abortController = abortController;
        this.sessionId = sessionId;

        // 发送锁兜底必须晚于 fetch 超时（state.requestTimeout）触发，
        // 否则无 reason 的 abort 会被 classifyError 误判为用户取消
        const sendLockMs = Math.max((state.requestTimeout || 0) + 30000, 240000);
        if (this.sendLockTimeout) {
            clearTimeout(this.sendLockTimeout);
        }
        this.sendLockTimeout = setTimeout(() => {
            logger.warn(`[StateMachine] 请求超时（${Math.round(sendLockMs / 1000)}秒），强制释放`);
            if (this.state !== RequestState.IDLE) {
                if (this.abortController && !this.abortController.signal.aborted) {
                    try {
                        this.abortController.abort(
                            new DOMException('Request timeout', 'TimeoutError')
                        );
                    } catch (_error) {
                        // 忽略 abort 错误
                    }
                }
                this.forceReset();
            }
        }, sendLockMs);

        // 更新 UI
        this._updateUI({
            sendButtonDisabled: true,
            sendButtonVisible: false,
            cancelButtonVisible: true
        });
    }

    /**
     * STREAMING 状态钩子
     */
    _onStreaming(metadata) {
        const { assistantMessageEl } = metadata;

        if (assistantMessageEl) {
            this.assistantMessageEl = assistantMessageEl;
        }

        // 清除发送锁超时（已成功建立连接）
        if (this.sendLockTimeout) {
            clearTimeout(this.sendLockTimeout);
            this.sendLockTimeout = null;
        }

        // 保持 UI loading 状态
        this._updateUI({
            sendButtonDisabled: true,
            sendButtonVisible: false,
            cancelButtonVisible: true
        });
    }

    /**
     * TOOL_CALLING 状态钩子
     */
    _onToolCalling(_metadata) {
        // 保持 UI loading 状态
        this._updateUI({
            sendButtonDisabled: true,
            sendButtonVisible: false,
            cancelButtonVisible: true
        });
    }

    /**
     * CONTINUATION 状态钩子
     */
    _onContinuation(metadata) {
        const { assistantMessageEl } = metadata;

        if (assistantMessageEl) {
            this.assistantMessageEl = assistantMessageEl;
        }

        // 保持 UI loading 状态
        this._updateUI({
            sendButtonDisabled: true,
            sendButtonVisible: false,
            cancelButtonVisible: true
        });
    }

    /**
     * COMPLETED 状态钩子
     */
    _onCompleted() {
        logger.debug('[StateMachine] 请求完成');

        // 立即重置 UI 按钮状态
        this._updateUI({
            sendButtonDisabled: false,
            sendButtonVisible: true,
            cancelButtonVisible: false
        });
    }

    /**
     * ERROR 状态钩子
     */
    _onError(metadata) {
        const { error } = metadata || {};
        logger.error('[StateMachine] 请求错误:', error);

        // 立即重置 UI 按钮状态，不依赖 auto-idle 定时器
        this._updateUI({
            sendButtonDisabled: false,
            sendButtonVisible: true,
            cancelButtonVisible: false
        });
    }

    /**
     * CANCELLED 状态钩子
     */
    _onCancelled() {
        logger.debug('[StateMachine] 请求已取消');

        // 限定 scope 到当前 assistantMessageEl 内，避免未来引入并发请求时全局清干扰其他流
        // 与 handler.removeLoadingIndicators 行为对齐
        const root =
            this.assistantMessageEl?.querySelector('.message-content') ||
            document.querySelector('.message.assistant:last-child .message-content');
        if (!root) return;
        const allLoadingElements = root.querySelectorAll(
            '.thinking-dots, .continuation-loading, .retry-loading'
        );
        if (allLoadingElements.length > 0) {
            allLoadingElements.forEach((el) => {
                logger.debug('[StateMachine] 移除 loading 元素:', el.className);
                el.remove();
            });
        }
    }

    /**
     * 更新 UI 状态
     */
    _updateUI({ sendButtonDisabled, sendButtonVisible, cancelButtonVisible }) {
        if (elements.sendButton) {
            elements.sendButton.disabled = sendButtonDisabled;
            elements.sendButton.style.display = sendButtonVisible ? 'inline-flex' : 'none';
        }
        if (elements.cancelRequestButton) {
            elements.cancelRequestButton.style.display = cancelButtonVisible
                ? 'inline-flex'
                : 'none';
        }
    }

    /**
     * 强制重置到 IDLE 状态（用于异常恢复）
     * @param {Object} options - 选项
     * @param {boolean} options.skipAbort - 是否跳过 abort（用于后台任务提升场景）
     * @param {boolean} options.silent - 是否静默（不显示通知）
     */
    forceReset({ skipAbort = false, silent = false } = {}) {
        logger.warn('[StateMachine] 强制重置到 IDLE 状态', skipAbort ? '(保留请求)' : '');

        // 清理自动回 IDLE 定时器
        if (this._autoIdleTimer) {
            clearTimeout(this._autoIdleTimer);
            this._autoIdleTimer = null;
        }

        // 取消当前请求（忽略所有错误）
        if (!skipAbort && this.abortController) {
            try {
                if (!this.abortController.signal.aborted) {
                    this.abortController.abort();
                }
            } catch (_error) {
                // 忽略 abort 错误
            }
        }

        // 清理 loading 元素：限定 scope 到当前 assistantMessageEl
        const cleanupRoot =
            this.assistantMessageEl?.querySelector('.message-content') ||
            document.querySelector('.message.assistant:last-child .message-content');
        if (cleanupRoot) {
            const allLoadingElements = cleanupRoot.querySelectorAll(
                '.thinking-dots, .continuation-loading, .retry-loading'
            );
            if (allLoadingElements.length > 0) {
                allLoadingElements.forEach((el) => el.remove());
            }
        }

        // 强制设置为 IDLE 状态（跳过状态验证）
        const oldState = this.state;
        this.state = RequestState.IDLE;
        this._onIdle();

        // 记录历史
        this.stateHistory.push({
            from: oldState,
            to: RequestState.IDLE,
            timestamp: Date.now(),
            meta: { type: 'object', keys: skipAbort ? 'forced-keep-request' : 'forced' }
        });
        if (this.stateHistory.length > this.maxHistorySize) {
            this.stateHistory.shift();
        }

        if (!silent) {
            eventBus.emit('ui:notification', {
                message: '已强制重置请求状态',
                type: 'success'
            });
        }
    }

    /**
     * 取消当前请求
     */
    cancel() {
        logger.debug('[StateMachine] 取消请求');

        // 检查当前状态是否允许取消
        if (this.state === RequestState.IDLE) {
            logger.warn('[StateMachine] 当前为 IDLE 状态，无需取消');
            return false;
        }

        // 取消请求
        if (this.abortController) {
            this.abortController.abort();
        }

        // 转换到 CANCELLED 状态
        this.transition(RequestState.CANCELLED);

        return true;
    }

    /**
     * 清除发送锁超时定时器
     * 供外部模块（如 sessions.js）在会话切换时调用
     */
    clearSendLockTimeout() {
        if (this.sendLockTimeout) {
            clearTimeout(this.sendLockTimeout);
            this.sendLockTimeout = null;
        }
    }

    /**
     * 检查是否正忙（不是 IDLE 状态）
     */
    isBusy() {
        return this.state !== RequestState.IDLE;
    }

    /**
     * 获取状态历史（用于调试）
     */
    getStateHistory() {
        return [...this.stateHistory];
    }

    /**
     * 打印状态历史（用于调试）
     */
    printHistory() {
        logger.debug('[StateMachine] 状态历史:');
        this.stateHistory.forEach((record, index) => {
            const time = new Date(record.timestamp).toLocaleTimeString();
            logger.debug(`  ${index + 1}. [${time}] ${record.from} -> ${record.to}`, record.meta);
        });
    }
}

// 创建全局单例
export const requestStateMachine = new RequestStateMachine();

// 暴露到 window 用于调试
if (typeof window !== 'undefined') {
    window.__requestStateMachine = requestStateMachine;
}
