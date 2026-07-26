/**
 * 流解析器输出 sink — BaseStreamParser 通过 sink 与外界通信。
 *
 * 单流路径（handler.js → adapter.streamParser → DefaultSink）走全局 state.currentAssistantMessage
 * + saveAssistantMessage 写入会话；多流路径（multi-stream.js → adapter.parserClass + BufferedSink）
 * 由外层统一收集 N 个 reply 后一次性渲染 + 写入 state，本 sink 静音底层 UI / 不调 commit。
 */

import { logger } from '../utils/logger.js';
import { state } from '../core/state.js';
import { eventBus } from '../core/events.js';
import {
    updateStreamingMessage,
    renderFinalContentWithThinking,
    renderFinalTextWithThinking
} from './helpers.js';
import { appendStreamStats } from './stats.js';
import { saveStreamSnapshotThrottled, clearStreamSnapshot } from '../state/stream-snapshot.js';
import { saveAssistantMessage } from '../messages/sync.js';
import { setCurrentMessageIndex } from '../messages/dom-sync.js';
import { handleToolCallStream, startPauseTurnContinuation } from '../tools/orchestrator.js';
import { requestStateMachine, RequestState } from '../core/request-state-machine.js';

/**
 * Sink 接口契约（用 JSDoc 描述，运行时由 DefaultSink / BufferedSink 实现）
 *
 * @typedef {Object} StreamSink
 * @property {() => boolean} isBackground - true 表示当前流不应触发前台 UI 渲染
 * @property {(text: string, thinking: string) => void} streamingUpdate - 流式增量 UI 更新
 * @property {(contentParts: Array, thinking: string, grounding?: Object) => void} renderFinalContent
 * @property {(text: string, thinking: string, grounding?: Object) => void} renderFinalText
 * @property {(errorHtml: string) => void} renderError - 错误 HTML 渲染到 DOM（BufferedSink no-op）
 * @property {(stats: import('./stats.js').StreamStats) => void} appendStats
 * @property {(parts: Array, meta: Object, opts: Object) => number} commit - 返回写入后的 messageIndex，-1 表示未写入
 * @property {(parts: Array, meta: Object, opts: Object, errorInfo: Object) => number} commitError
 * @property {(toolCalls: Array) => void} triggerToolCalls - 触发工具调用执行 + 状态机转换
 * @property {(assistantMessageEl: HTMLElement) => void} triggerPauseTurnResend - 触发 Claude pause_turn 继续请求（BufferedSink 仅 warn）
 */

/**
 * 单流路径默认 sink — 行为与重构前 BaseStreamParser 直接调用底层一致。
 *
 * isBackground 由 sessionId 与 state.currentSessionId 比较决定（与原代码语义等价）。
 */
export class DefaultSink {
    constructor(sessionId = null) {
        this.sessionId = sessionId;
        this._snapshotSessionId = null;
    }

    isBackground() {
        return !!this.sessionId && this.sessionId !== state.currentSessionId;
    }

    streamingUpdate(text, thinking) {
        // sessionId 缺省的调用方在首帧锁定当前会话，保证写入与 commit 清理用同一个 key
        if (!this._snapshotSessionId) {
            this._snapshotSessionId = this.sessionId || state.currentSessionId;
        }
        saveStreamSnapshotThrottled(this._snapshotSessionId, text, thinking);
        if (this.isBackground()) return;
        updateStreamingMessage(text, thinking);
    }

    renderFinalContent(contentParts, thinking, grounding = null) {
        if (this.isBackground()) return;
        renderFinalContentWithThinking(contentParts, thinking, grounding);
    }

    renderFinalText(text, thinking, grounding = null) {
        if (this.isBackground()) return;
        renderFinalTextWithThinking(text, thinking, grounding);
    }

    renderError(errorHtml) {
        if (this.isBackground()) return;
        const currentMsg = document.querySelector('.message.assistant:last-child');
        if (!currentMsg) return;
        const contentDiv = currentMsg.querySelector('.message-content');
        if (!contentDiv) return;
        // errorHtml 由 renderHumanizedError 生成 + 静态 stream-error-partial-save 拼接，内容已转义
        // eslint-disable-next-line no-restricted-syntax -- 已审计：errorHtml = renderHumanizedError + 静态 stream-error-partial-save，内容已转义
        contentDiv.insertAdjacentHTML('beforeend', errorHtml);
    }

    appendStats(stats) {
        if (this.isBackground()) return;
        stats.syncToGlobal();
        appendStreamStats();
    }

    commit(parts, meta, opts = {}) {
        const idx = saveAssistantMessage(parts, meta, { ...opts, sessionId: this.sessionId });
        setCurrentMessageIndex(idx);
        clearStreamSnapshot(this._snapshotSessionId);
        return idx;
    }

    commitError(parts, meta, opts, errorInfo) {
        const idx = saveAssistantMessage(parts, meta, {
            ...opts,
            sessionId: this.sessionId,
            isError: true,
            errorData: { code: errorInfo.errorCode, message: errorInfo.errorMessage },
            errorHtml: errorInfo.errorHtml
        });
        setCurrentMessageIndex(idx);
        clearStreamSnapshot(this._snapshotSessionId);
        if (!this.isBackground()) {
            eventBus.emit('stream:error', {
                errorCode: errorInfo.errorCode,
                errorMessage: errorInfo.errorMessage,
                partialContent: errorInfo.partialContent
            });
        }
        return idx;
    }

    triggerToolCalls(toolCalls) {
        // 后台流（用户已切到其他会话）禁止触发全局状态机 + 客户端工具执行 —
        // requestStateMachine 是单例，会把新会话锁到 TOOL_CALLING 直到旧工具完成；
        // 同时 writeToolResultsBackToState 会从前台 state.messages 倒序找 assistant
        // 找不到匹配 part.id（已写到后台会话）触发 'tool_use without tool_result' 400
        if (this.isBackground()) {
            logger.warn(
                '[DefaultSink] 后台流（sessionId 已切换）跳过工具调用执行，避免污染前台状态机',
                { skippedToolCalls: toolCalls.length }
            );
            return;
        }
        requestStateMachine.transition(RequestState.TOOL_CALLING);
        state.isToolCallPending = true;
        // 上下文参数注入：现读现传，让 orchestrator 不再隐式读全局 state
        const assistantMessageEl = state.currentAssistantMessage?.closest('.message') ?? null;
        const sourceSessionId = state.currentSessionId;
        handleToolCallStream(toolCalls, { assistantMessageEl, sourceSessionId }).catch((error) => {
            logger.error('[Parser] 工具调用流程失败:', error);
            state.isToolCallPending = false;
            requestStateMachine.forceReset();
            eventBus.emit('ui:reset-input-buttons');
        });
    }

    triggerPauseTurnResend(assistantMessageEl) {
        // 后台流的 pause_turn continuation 同样会污染前台状态机
        if (this.isBackground()) {
            logger.warn('[DefaultSink] 后台流跳过 pause_turn continuation');
            return;
        }
        // 走统一 orchestrator 入口（合并原 sink/handler 两份重复编排）
        // sink.sessionId 是流启动时绑定的会话；与 sourceSessionId 守卫对齐
        startPauseTurnContinuation(assistantMessageEl, this.sessionId ?? state.currentSessionId);
    }
}

/**
 * 多流路径 sink — 把 commit / 渲染最终 / 工具调用全部静音，外层 multi-stream 从 parser 实例直接
 * 读取 textContent / thinkingContent / contentParts / 各种 signature 字段构建 reply 集合。
 *
 * showRealtime=true 时（多流第一个 reply）streamingUpdate 仍走全局 UI 让用户实时看到；
 * 其余并发流完全后台，不触发任何 DOM mutation。
 *
 * 多流模式不支持工具调用：触发 triggerToolCalls 只记 warn 不执行。
 */
export class BufferedSink {
    constructor({ showRealtime = false } = {}) {
        this.showRealtime = showRealtime;
        this.errorInfo = null;
        this.skippedToolCalls = null;
        this.skippedPauseTurn = false;
    }

    isBackground() {
        return !this.showRealtime;
    }

    streamingUpdate(text, thinking) {
        if (this.showRealtime) updateStreamingMessage(text, thinking);
    }

    // 多流最终渲染由 multi-stream 外层 renderReplyWithSelector 统一处理
    renderFinalContent() {}
    renderFinalText() {}
    renderError() {}

    // 多流 stats 在外层 saveAssistantMessage 时一次性 syncToGlobal
    appendStats() {}

    // 多流不直接写 state；外层用 reply0 一次性 saveAssistantMessage
    commit() {
        return -1;
    }

    commitError(_parts, _meta, _opts, errorInfo) {
        // 同一个 reply 上 finalizeStream + finalizeStreamWithError 可能被串行触发，
        // 首错才代表真实错因（如 Gemini 429 → cancel reader → onStreamEnd 二次正常完成），
        // 第二条调用保留首错信息不覆盖
        if (this.errorInfo) return -1;
        this.errorInfo = errorInfo;
        return -1;
    }

    triggerToolCalls(toolCalls) {
        this.skippedToolCalls = toolCalls;
        logger.warn(
            '[multi-stream] 多回复模式忽略工具调用:',
            toolCalls.map((tc) => tc.name).join(', ')
        );
    }

    triggerPauseTurnResend(_assistantMessageEl) {
        this.skippedPauseTurn = true;
        logger.warn('[multi-stream] 多回复模式忽略 Claude pause_turn 继续请求');
    }
}
