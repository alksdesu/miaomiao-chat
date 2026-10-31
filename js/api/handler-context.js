/**
 * HandlerContext：sendToAPI 启动时一次性捕获的不可变快照。
 *
 * 所有子函数（resolvePlaceholder / classifyError / 各 error-handler / cleanup）
 * 共享同一个 ctx。endpoint / apiKey / model 在 ctx 构建时锁定，
 * multi-stream 与 single-stream 都用快照值——用户在请求往返期间切 provider
 * 不会污染当前请求；sessionId 锁定后续跨会话守卫的基准。
 *
 * isContinuationMode / isImageRetryMode 拆为两个独立布尔：
 *   - isContinuationMode 控制 streamStats 是否重置（continuation 累计统计）
 *   - isImageRetryMode   控制 DOM placeholder 复用语义（与 streamStats 重置无关）
 * 两者历史上挤在同一个 isContinuationMode 单一布尔里语义混淆，本次拆开。
 */

import { state } from '../core/state.js';
import {
    getCurrentEndpoint,
    getCurrentApiKey,
    getCurrentModel,
    getCurrentProvider
} from './current.js';
import { getAdapter } from './adapters/index.js';
import { captureRequestProfile } from './request-pipeline.js';
import { applyToolResultsToMessages } from '../messages/tool-results.js';

/**
 * @typedef {Object} HandlerContext
 * @property {string} endpoint                - 锁定的端点
 * @property {string} apiKey                  - 锁定的 API 密钥
 * @property {string} model                   - 锁定的模型
 * @property {string} requestFormat           - 锁定的 apiFormat（决定 parser 分支与 openclaw 特判）
 * @property {object} adapter                 - 锁定的 FormatAdapter（决定请求体格式 + streamParser）
 * @property {AbortController} abortController- 本次请求的 AbortController
 * @property {string} sessionId               - 锁定的发起会话 ID
 * @property {number} timeoutMs               - 锁定的请求超时（生成 timeout 错误提示文案用）
 * @property {number|null} timeoutId          - setTimeout 注册后填入；error/cleanup 路径据此清理
 * @property {HTMLElement|null} assistantMessageEl - resolvePlaceholder 填入
 * @property {boolean} isContinuationMode     - resolvePlaceholder 填入：工具调用 continuation 复用（影响 streamStats）
 * @property {boolean} isImageRetryMode       - resolvePlaceholder 填入：图片压缩重试复用（仅复用 DOM，不影响 streamStats）
 * @property {Error|null} setupError          - 请求快照构造失败的原因；非空时请求不会发出，sendToAPI 按请求错误处理
 */

/**
 * 不会抛错：快照构造失败时返回带 setupError 的上下文，交给 sendToAPI 的统一错误处理展示与落库
 * @returns {HandlerContext}
 */
export function createHandlerContext(task = null) {
    const sessionId = task?.sessionId || state.currentSessionId;
    const base = {
        abortController: new AbortController(),
        sessionId,
        timeoutId: null,
        assistantMessageEl: null,
        isContinuationMode: false,
        isImageRetryMode: false,
        task,
        setupError: null
    };
    try {
        return { ...base, ...captureRequestSnapshot(task, sessionId) };
    } catch (error) {
        return { ...base, ...createFailedSnapshot(task, error) };
    }
}

function captureRequestSnapshot(task, sessionId) {
    // requestFormat/adapter 与 endpoint/apiKey/model 一同快照：请求往返期间用户切 provider 时，
    // 响应侧仍用发起时锁定的 adapter 解析，避免 Claude 流被 OpenAI parser 解成空流
    const origin = task?.requestOrigin || null;
    const requestFormat = origin?.requestFormat || getCurrentProvider()?.apiFormat || 'openai';
    const adapter = origin?.adapter || getAdapter(requestFormat);
    const endpoint = origin?.endpoint || getCurrentEndpoint();
    const apiKey = origin?.apiKey ?? getCurrentApiKey();
    const model = origin?.model || getCurrentModel();
    const requestProfile = task?.requestProfile || captureRequestProfile(adapter, model);
    let sourceMessages =
        task?.retryMessages ||
        (sessionId === state.currentSessionId && !task?.isDetached
            ? state.messageStore?.toArray?.() || [...(state.messages || [])]
            : null);
    if (Array.isArray(sourceMessages) && task?.pendingToolResults) {
        sourceMessages = applyToolResultsToMessages(
            sourceMessages,
            task.pendingToolResults
        ).messages;
    }
    return {
        endpoint,
        apiKey,
        model,
        requestFormat,
        adapter,
        timeoutMs: requestProfile.state?.requestTimeout ?? state.requestTimeout,
        requestProfile,
        sourceMessages,
        streamEnabled: requestProfile.streamEnabled,
        // 工具续作只需要一个回复：多回复的并发流不执行工具调用，额外的回复只会白白多发请求
        replyCount: task?.isSavingContinuation === true ? 1 : requestProfile.replyCount
    };
}

function readOrDefault(read, fallback) {
    try {
        return read() ?? fallback;
    } catch {
        return fallback;
    }
}

/**
 * 快照构造失败时只保留错误处理与清理会读到的字段，请求本身不会发出
 */
function createFailedSnapshot(task, error) {
    const origin = task?.requestOrigin || null;
    const model = origin?.model || readOrDefault(getCurrentModel, '');
    return {
        endpoint: origin?.endpoint || '',
        apiKey: origin?.apiKey ?? '',
        model,
        requestFormat: origin?.requestFormat || null,
        adapter: origin?.adapter || null,
        timeoutMs: state.requestTimeout,
        requestProfile: task?.requestProfile || {
            state: { requestTimeout: state.requestTimeout },
            modelDisplayName: model,
            providerName: readOrDefault(() => getCurrentProvider()?.name, '')
        },
        sourceMessages: null,
        streamEnabled: false,
        replyCount: 1,
        setupError: error
    };
}
