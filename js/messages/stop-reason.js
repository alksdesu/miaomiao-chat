/**
 * 回复结束原因：各家 stop_reason / finish_reason / finishReason / blockReason 归一后写入 msg.meta.stop
 * 只在内容可能不完整、被拦截或被拒答时向用户提示，正常结束与工具调用不提示
 */

export const StopKind = Object.freeze({
    END: 'end',
    TOOL_USE: 'tool_use',
    PAUSE: 'pause',
    MAX_TOKENS: 'max_tokens',
    CONTEXT_OVERFLOW: 'context_overflow',
    SAFETY: 'safety',
    PROMPT_BLOCKED: 'prompt_blocked',
    REFUSAL: 'refusal',
    RECITATION: 'recitation',
    MALFORMED_TOOL_CALL: 'malformed_tool_call',
    CONTINUATION: 'continuation',
    OTHER: 'other'
});

/**
 * @typedef {Object} StopInfo
 * @property {string} kind     StopKind
 * @property {string} reason   服务端原始取值
 * @property {string} [detail] 服务端附带的说明（拒答解释、拦截说明等）
 */

function createStopInfo(kind, reason, detail = null) {
    const info = { kind, reason: String(reason) };
    if (typeof detail === 'string' && detail.trim()) info.detail = detail.trim();
    return info;
}

// ========== Claude ==========

const CLAUDE_STOP_KINDS = Object.freeze({
    end_turn: StopKind.END,
    stop_sequence: StopKind.END,
    tool_use: StopKind.TOOL_USE,
    pause_turn: StopKind.PAUSE,
    max_tokens: StopKind.MAX_TOKENS,
    model_context_window_exceeded: StopKind.CONTEXT_OVERFLOW,
    refusal: StopKind.REFUSAL
});

/**
 * @param {string|null|undefined} stopReason
 * @param {{ category?: string, explanation?: string }|null} [stopDetails] refusal 时附带
 * @returns {StopInfo|null}
 */
export function normalizeClaudeStop(stopReason, stopDetails = null) {
    if (!stopReason) return null;
    return createStopInfo(
        CLAUDE_STOP_KINDS[stopReason] || StopKind.OTHER,
        stopReason,
        stopDetails?.explanation || stopDetails?.category || null
    );
}

// ========== OpenAI ==========

const OPENAI_CHAT_STOP_KINDS = Object.freeze({
    stop: StopKind.END,
    tool_calls: StopKind.TOOL_USE,
    function_call: StopKind.TOOL_USE,
    length: StopKind.MAX_TOKENS,
    content_filter: StopKind.SAFETY
});

/**
 * 拒答文本已作为正文展示，这里只标记原因
 * @param {string|null|undefined} finishReason
 * @param {{ refused?: boolean }} [options]
 * @returns {StopInfo|null}
 */
export function normalizeOpenAIChatStop(finishReason, { refused = false } = {}) {
    if (refused) return createStopInfo(StopKind.REFUSAL, 'refusal');
    if (!finishReason) return null;
    return createStopInfo(OPENAI_CHAT_STOP_KINDS[finishReason] || StopKind.OTHER, finishReason);
}

const RESPONSES_INCOMPLETE_KINDS = Object.freeze({
    max_output_tokens: StopKind.MAX_TOKENS,
    content_filter: StopKind.SAFETY
});

/**
 * @param {{ status?: string, incomplete_details?: { reason?: string } }|null|undefined} response
 * @param {{ refused?: boolean }} [options]
 * @returns {StopInfo|null}
 */
export function normalizeResponsesStop(response, { refused = false } = {}) {
    if (refused) return createStopInfo(StopKind.REFUSAL, 'refusal');
    if (!response?.status) return null;
    if (response.status === 'incomplete') {
        const reason = response.incomplete_details?.reason || 'incomplete';
        return createStopInfo(RESPONSES_INCOMPLETE_KINDS[reason] || StopKind.OTHER, reason);
    }
    if (response.status === 'completed') return createStopInfo(StopKind.END, 'completed');
    return null;
}

// ========== Gemini ==========

const GEMINI_FINISH_KINDS = Object.freeze({
    STOP: StopKind.END,
    MAX_TOKENS: StopKind.MAX_TOKENS,
    SAFETY: StopKind.SAFETY,
    BLOCKLIST: StopKind.SAFETY,
    PROHIBITED_CONTENT: StopKind.SAFETY,
    SPII: StopKind.SAFETY,
    IMAGE_SAFETY: StopKind.SAFETY,
    IMAGE_PROHIBITED_CONTENT: StopKind.SAFETY,
    RECITATION: StopKind.RECITATION,
    IMAGE_RECITATION: StopKind.RECITATION,
    MALFORMED_FUNCTION_CALL: StopKind.MALFORMED_TOOL_CALL,
    UNEXPECTED_TOOL_CALL: StopKind.MALFORMED_TOOL_CALL,
    TOO_MANY_TOOL_CALLS: StopKind.MALFORMED_TOOL_CALL,
    CONTINUATION: StopKind.CONTINUATION
});

/**
 * promptFeedback.blockReason 表示请求本身被拦截，优先于候选的 finishReason
 * @param {Object} [signals]
 * @param {string} [signals.finishReason]
 * @param {string} [signals.finishMessage]
 * @param {string} [signals.blockReason]
 * @param {string} [signals.blockReasonMessage]
 * @returns {StopInfo|null}
 */
export function normalizeGeminiStop({
    finishReason,
    finishMessage,
    blockReason,
    blockReasonMessage
} = {}) {
    if (blockReason) {
        return createStopInfo(StopKind.PROMPT_BLOCKED, blockReason, blockReasonMessage);
    }
    if (!finishReason || finishReason === 'FINISH_REASON_UNSPECIFIED') return null;
    return createStopInfo(
        GEMINI_FINISH_KINDS[finishReason] || StopKind.OTHER,
        finishReason,
        finishMessage
    );
}

// ========== 提示文案 ==========

// 同一句文案既用于正文末尾的提示条，也用于没有任何内容时的错误块
const STOP_NOTICES = Object.freeze({
    [StopKind.MAX_TOKENS]: '回复达到最大输出长度，已被截断。可以调大最大输出 token 后重新生成。',
    [StopKind.CONTEXT_OVERFLOW]: '对话超出模型上下文窗口，回复被截断。可以删减历史消息或新开会话。',
    [StopKind.SAFETY]: '回复被安全策略拦截，后续内容没有生成。',
    [StopKind.PROMPT_BLOCKED]: '请求被安全策略拦截，模型没有生成内容。',
    [StopKind.REFUSAL]: '模型拒绝回答这个请求。',
    [StopKind.RECITATION]: '回复疑似大段引用受版权保护的内容，已被中止。',
    [StopKind.MALFORMED_TOOL_CALL]: '模型生成的工具调用不合法，回复已中止。',
    [StopKind.CONTINUATION]: '回复达到单次输出上限，后续内容没有续写。',
    [StopKind.OTHER]: '回复提前结束。'
});

/**
 * @param {StopInfo|null|undefined} stop
 * @returns {{ title: string, reason: string, detail: string|null }|null} 无需提示时返回 null
 */
export function describeStop(stop) {
    const title = stop ? STOP_NOTICES[stop.kind] : null;
    if (!title) return null;
    return { title, reason: stop.reason, detail: stop.detail || null };
}

export const EMPTY_REPLY_CODE = 'empty_reply';

// 正文末尾提示条的文案以已有部分内容为前提，回复里一个字都没有时改用这组说明
const EMPTY_REPLY_NOTICES = Object.freeze({
    [StopKind.MAX_TOKENS]:
        '还没输出正文就达到了最大输出长度，通常是思考过程用完了输出额度。可以调大最大输出 token 或降低思考强度后重新生成。',
    [StopKind.CONTEXT_OVERFLOW]:
        '对话超出模型上下文窗口，模型没有生成任何内容。可以删减历史消息或新开会话。',
    [StopKind.SAFETY]: '回复被安全策略拦截，模型没有生成任何内容。可以调整提示词后重新生成。',
    [StopKind.PROMPT_BLOCKED]: '请求被安全策略拦截，模型没有生成内容。可以修改消息后重新发送。',
    [StopKind.REFUSAL]: '模型拒绝回答这个请求，没有生成任何内容。',
    [StopKind.RECITATION]: '回复疑似大段引用受版权保护的内容，在输出正文前已被中止。',
    [StopKind.MALFORMED_TOOL_CALL]:
        '模型生成的工具调用不合法，回复在输出正文前已中止。可以重新生成。',
    [StopKind.CONTINUATION]: '回复达到单次输出上限，没有生成任何内容。可以重新生成。',
    [StopKind.OTHER]: '回复提前结束，模型没有生成任何内容。可以重新生成。'
});

/**
 * 没有任何正文的回复按错误落库：既说明原因，也不让空回复进入后续请求的上下文
 * code 取 StopKind，正常结束却没有内容时取 EMPTY_REPLY_CODE，与 utils/errors.js 的错误标题一一对应
 * @param {StopInfo|null|undefined} stop
 * @returns {{ code: string, message: string }}
 */
export function buildEmptyReplyError(stop) {
    const notice = stop ? EMPTY_REPLY_NOTICES[stop.kind] : null;
    if (notice) {
        const summary = `${notice}（${stop.reason}）`;
        return {
            code: stop.kind,
            message: stop.detail ? `${summary}\n${stop.detail}` : summary
        };
    }
    if (stop?.kind === StopKind.TOOL_USE) {
        return {
            code: EMPTY_REPLY_CODE,
            message: `模型表示要调用工具（${stop.reason}），但响应里没有可执行的工具调用。可以重新生成，或检查代理是否完整转发了工具调用。`
        };
    }
    return {
        code: EMPTY_REPLY_CODE,
        message: stop
            ? `模型结束了回复（${stop.reason}），但没有生成任何内容。可以重新生成，或检查提示词与预填充设置。`
            : '服务端没有返回任何内容。可以重新生成，或检查代理与端点设置。'
    };
}
