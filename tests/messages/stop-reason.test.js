/**
 * messages/stop-reason.js 结束原因归一与提示文案测试
 */
import { describe, it, expect } from 'vitest';
import {
    StopKind,
    EMPTY_REPLY_CODE,
    normalizeClaudeStop,
    normalizeOpenAIChatStop,
    normalizeResponsesStop,
    normalizeGeminiStop,
    describeStop,
    buildEmptyReplyError
} from '../../js/messages/stop-reason.js';

describe('normalizeClaudeStop', () => {
    it.each([
        ['end_turn', StopKind.END],
        ['stop_sequence', StopKind.END],
        ['tool_use', StopKind.TOOL_USE],
        ['pause_turn', StopKind.PAUSE],
        ['max_tokens', StopKind.MAX_TOKENS],
        ['model_context_window_exceeded', StopKind.CONTEXT_OVERFLOW],
        ['refusal', StopKind.REFUSAL]
    ])('%s → %s', (reason, kind) => {
        expect(normalizeClaudeStop(reason)).toEqual({ kind, reason });
    });

    it('未知取值归为 other 并保留原值', () => {
        expect(normalizeClaudeStop('brand_new_reason')).toEqual({
            kind: StopKind.OTHER,
            reason: 'brand_new_reason'
        });
    });

    it('缺省时返回 null', () => {
        expect(normalizeClaudeStop(null)).toBeNull();
        expect(normalizeClaudeStop(undefined)).toBeNull();
    });

    it('refusal 优先带上 stop_details.explanation', () => {
        expect(
            normalizeClaudeStop('refusal', { category: 'cyber', explanation: ' 请求涉及攻击 ' })
        ).toEqual({ kind: StopKind.REFUSAL, reason: 'refusal', detail: '请求涉及攻击' });
    });

    it('没有 explanation 时退回 category', () => {
        expect(normalizeClaudeStop('refusal', { category: 'cyber' }).detail).toBe('cyber');
    });
});

describe('normalizeOpenAIChatStop', () => {
    it.each([
        ['stop', StopKind.END],
        ['tool_calls', StopKind.TOOL_USE],
        ['function_call', StopKind.TOOL_USE],
        ['length', StopKind.MAX_TOKENS],
        ['content_filter', StopKind.SAFETY]
    ])('%s → %s', (reason, kind) => {
        expect(normalizeOpenAIChatStop(reason)).toEqual({ kind, reason });
    });

    it('拒答优先于 finish_reason', () => {
        expect(normalizeOpenAIChatStop('stop', { refused: true })).toEqual({
            kind: StopKind.REFUSAL,
            reason: 'refusal'
        });
    });

    it('缺省时返回 null', () => {
        expect(normalizeOpenAIChatStop(null)).toBeNull();
    });
});

describe('normalizeResponsesStop', () => {
    it('completed → end', () => {
        expect(normalizeResponsesStop({ status: 'completed' })).toEqual({
            kind: StopKind.END,
            reason: 'completed'
        });
    });

    it('incomplete 按 incomplete_details.reason 区分', () => {
        expect(
            normalizeResponsesStop({
                status: 'incomplete',
                incomplete_details: { reason: 'max_output_tokens' }
            })
        ).toEqual({ kind: StopKind.MAX_TOKENS, reason: 'max_output_tokens' });
        expect(
            normalizeResponsesStop({
                status: 'incomplete',
                incomplete_details: { reason: 'content_filter' }
            })
        ).toEqual({ kind: StopKind.SAFETY, reason: 'content_filter' });
    });

    it('incomplete 缺 reason 时归为 other', () => {
        expect(normalizeResponsesStop({ status: 'incomplete' })).toEqual({
            kind: StopKind.OTHER,
            reason: 'incomplete'
        });
    });

    it('拒答优先，进行中的状态返回 null', () => {
        expect(normalizeResponsesStop({ status: 'completed' }, { refused: true }).kind).toBe(
            StopKind.REFUSAL
        );
        expect(normalizeResponsesStop({ status: 'in_progress' })).toBeNull();
        expect(normalizeResponsesStop(null)).toBeNull();
    });
});

describe('normalizeGeminiStop', () => {
    it.each([
        ['STOP', StopKind.END],
        ['MAX_TOKENS', StopKind.MAX_TOKENS],
        ['SAFETY', StopKind.SAFETY],
        ['PROHIBITED_CONTENT', StopKind.SAFETY],
        ['IMAGE_SAFETY', StopKind.SAFETY],
        ['RECITATION', StopKind.RECITATION],
        ['MALFORMED_FUNCTION_CALL', StopKind.MALFORMED_TOOL_CALL],
        ['TOO_MANY_TOOL_CALLS', StopKind.MALFORMED_TOOL_CALL],
        ['CONTINUATION', StopKind.CONTINUATION],
        ['LANGUAGE', StopKind.OTHER]
    ])('%s → %s', (finishReason, kind) => {
        expect(normalizeGeminiStop({ finishReason })).toEqual({ kind, reason: finishReason });
    });

    it('blockReason 优先于 finishReason', () => {
        expect(
            normalizeGeminiStop({
                finishReason: 'STOP',
                blockReason: 'PROHIBITED_CONTENT',
                blockReasonMessage: '提示词被拦截'
            })
        ).toEqual({
            kind: StopKind.PROMPT_BLOCKED,
            reason: 'PROHIBITED_CONTENT',
            detail: '提示词被拦截'
        });
    });

    it('finishMessage 作为说明', () => {
        expect(
            normalizeGeminiStop({ finishReason: 'SAFETY', finishMessage: '命中安全策略' }).detail
        ).toBe('命中安全策略');
    });

    it('未结束或未指定时返回 null', () => {
        expect(normalizeGeminiStop({})).toBeNull();
        expect(normalizeGeminiStop()).toBeNull();
        expect(normalizeGeminiStop({ finishReason: 'FINISH_REASON_UNSPECIFIED' })).toBeNull();
    });
});

describe('describeStop', () => {
    it('正常结束、工具调用、暂停不提示', () => {
        expect(describeStop({ kind: StopKind.END, reason: 'end_turn' })).toBeNull();
        expect(describeStop({ kind: StopKind.TOOL_USE, reason: 'tool_use' })).toBeNull();
        expect(describeStop({ kind: StopKind.PAUSE, reason: 'pause_turn' })).toBeNull();
        expect(describeStop(null)).toBeNull();
    });

    it('需要提示的原因都有文案', () => {
        const kinds = [
            StopKind.MAX_TOKENS,
            StopKind.CONTEXT_OVERFLOW,
            StopKind.SAFETY,
            StopKind.PROMPT_BLOCKED,
            StopKind.REFUSAL,
            StopKind.RECITATION,
            StopKind.MALFORMED_TOOL_CALL,
            StopKind.CONTINUATION,
            StopKind.OTHER
        ];
        for (const kind of kinds) {
            const notice = describeStop({ kind, reason: 'raw' });
            expect(notice.title).toEqual(expect.any(String));
            expect(notice.reason).toBe('raw');
            expect(notice.detail).toBeNull();
        }
    });

    it('透传说明', () => {
        expect(
            describeStop({ kind: StopKind.REFUSAL, reason: 'refusal', detail: '原因' }).detail
        ).toBe('原因');
    });
});

describe('buildEmptyReplyError', () => {
    it('需要提示的原因以 StopKind 作为错误码，消息带原始取值', () => {
        const error = buildEmptyReplyError({ kind: StopKind.MAX_TOKENS, reason: 'length' });
        expect(error.code).toBe('max_tokens');
        expect(error.message).toContain('（length）');
        expect(error.message).toContain('最大输出长度');
    });

    it('说明另起一行', () => {
        const error = buildEmptyReplyError({
            kind: StopKind.REFUSAL,
            reason: 'refusal',
            detail: '请求涉及攻击'
        });
        expect(error.code).toBe('refusal');
        expect(error.message.split('\n')).toEqual([
            expect.stringContaining('（refusal）'),
            '请求涉及攻击'
        ]);
    });

    it('正常结束却没有内容时归为空回复并带上原始取值', () => {
        const error = buildEmptyReplyError({ kind: StopKind.END, reason: 'end_turn' });
        expect(error.code).toBe(EMPTY_REPLY_CODE);
        expect(error.message).toContain('end_turn');
    });

    it('没有结束原因时归为空回复', () => {
        const error = buildEmptyReplyError(null);
        expect(error.code).toBe(EMPTY_REPLY_CODE);
        expect(error.message).toEqual(expect.any(String));
    });

    it.each([
        StopKind.MAX_TOKENS,
        StopKind.CONTEXT_OVERFLOW,
        StopKind.SAFETY,
        StopKind.PROMPT_BLOCKED,
        StopKind.REFUSAL,
        StopKind.RECITATION,
        StopKind.MALFORMED_TOOL_CALL,
        StopKind.CONTINUATION,
        StopKind.OTHER
    ])('%s 的空回复说明不沿用"已截断/后续内容"这类以已有内容为前提的措辞', (kind) => {
        const { code, message } = buildEmptyReplyError({ kind, reason: 'raw' });
        expect(code).toBe(kind);
        expect(message).toContain('（raw）');
        expect(message).not.toMatch(/截断|后续内容|后续/);
        expect(message).not.toBe(describeStop({ kind, reason: 'raw' }).title);
    });

    it('达到最大输出长度却没有正文时指向思考用完输出额度', () => {
        const { message } = buildEmptyReplyError({ kind: StopKind.MAX_TOKENS, reason: 'length' });
        expect(message).toContain('思考');
        expect(message).toContain('最大输出');
    });

    it('声明要调用工具却没有工具调用时单独说明', () => {
        const error = buildEmptyReplyError({ kind: StopKind.TOOL_USE, reason: 'tool_use' });
        expect(error.code).toBe(EMPTY_REPLY_CODE);
        expect(error.message).toContain('没有可执行的工具调用');
        expect(error.message).toContain('tool_use');
    });
});
