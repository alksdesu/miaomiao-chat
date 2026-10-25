/**
 * api/handler-non-stream.js 非流式回复的空回复处理、结束原因与多回复默认选中测试
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../js/core/state.js', () => ({
    state: {
        currentSessionId: 'session-1',
        currentReplies: [],
        selectedReplyIndex: 0
    }
}));

vi.mock('../../js/api/request-pipeline.js', () => ({ executeRequest: vi.fn() }));
vi.mock('../../js/stream/stats.js', () => ({ appendStreamStats: vi.fn() }));
vi.mock('../../js/messages/sync.js', () => ({
    saveAssistantMessageAsync: vi.fn(async () => 0)
}));
vi.mock('../../js/api/current.js', () => ({
    getCurrentProvider: vi.fn(() => ({ name: 'Provider' })),
    getModelDisplayName: vi.fn((id) => id || '')
}));
vi.mock('../../js/messages/dom-sync.js', () => ({ setCurrentMessageIndex: vi.fn() }));
vi.mock('../../js/stream/helpers.js', () => ({
    renderFinalTextWithThinking: vi.fn(),
    renderFinalContentWithThinking: vi.fn()
}));
vi.mock('../../js/messages/renderer.js', () => ({ renderReplyWithSelector: vi.fn() }));
vi.mock('../../js/tools/orchestrator.js', () => ({
    handleToolCallStream: vi.fn(),
    startPauseTurnContinuation: vi.fn()
}));
vi.mock('../../js/utils/helpers.js', () => ({ safeSetHTML: vi.fn() }));
vi.mock('../../js/utils/logger.js', () => ({
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));
vi.mock('../../js/core/request-task-registry.js', () => ({
    requestTaskRegistry: { owns: vi.fn(() => true) }
}));
vi.mock('../../js/messages/render-stop-notice.js', () => ({ appendStopNotice: vi.fn() }));

import { handleNonStreamResponse } from '../../js/api/handler-non-stream.js';
import { state } from '../../js/core/state.js';
import { executeRequest } from '../../js/api/request-pipeline.js';
import { saveAssistantMessageAsync } from '../../js/messages/sync.js';
import { renderFinalTextWithThinking } from '../../js/stream/helpers.js';
import { renderReplyWithSelector } from '../../js/messages/renderer.js';
import { startPauseTurnContinuation } from '../../js/tools/orchestrator.js';
import { appendStopNotice } from '../../js/messages/render-stop-notice.js';

const maxTokensStop = { kind: 'max_tokens', reason: 'length' };

function jsonResponse(data) {
    return { json: async () => data };
}

// parseResponse 原样返回响应里预置的 reply，便于逐个请求控制解析结果
function makeCtx({ replies, replyCount = replies.length, task = null } = {}) {
    const assistantMessageEl = document.createElement('div');
    const contentEl = document.createElement('div');
    contentEl.className = 'message-content';
    assistantMessageEl.appendChild(contentEl);

    const [first, ...rest] = replies;
    executeRequest.mockReset();
    for (const reply of rest) {
        executeRequest.mockResolvedValueOnce(jsonResponse({ reply }));
    }

    return {
        response: jsonResponse({ reply: first }),
        contentEl,
        ctx: {
            adapter: {
                parseResponse: vi.fn((data) => data.reply ?? null),
                signatureFormat: null
            },
            endpoint: 'http://api.test',
            apiKey: 'key',
            model: 'model',
            sessionId: 'session-1',
            assistantMessageEl,
            abortController: new AbortController(),
            replyCount,
            task,
            requestProfile: {
                modelDisplayName: 'model',
                providerName: 'Provider',
                isXmlMode: false
            }
        }
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    state.currentSessionId = 'session-1';
    state.currentReplies = [];
    state.selectedReplyIndex = 0;
});

describe('handleNonStreamResponse - 单回复', () => {
    it('有正文时正常落库，记录结束原因并在正文末尾提示', async () => {
        const { response, ctx, contentEl } = makeCtx({
            replies: [{ content: '被截断的回', stop: maxTokensStop }]
        });

        await handleNonStreamResponse(response, ctx);

        const [parts, meta, opts] = saveAssistantMessageAsync.mock.calls[0];
        expect(parts).toEqual([expect.objectContaining({ type: 'text', text: '被截断的回' })]);
        expect(meta.stop).toEqual(maxTokensStop);
        expect(opts.selectedReplyIndex).toBe(0);
        expect(renderFinalTextWithThinking).toHaveBeenCalled();
        expect(appendStopNotice).toHaveBeenCalledWith(contentEl, maxTokensStop);
    });

    it('拒答且没有正文时按错误抛出，不落空消息', async () => {
        const { response, ctx } = makeCtx({
            replies: [
                {
                    content: '',
                    stop: { kind: 'refusal', reason: 'refusal', detail: '涉及攻击' }
                }
            ]
        });

        await expect(handleNonStreamResponse(response, ctx)).rejects.toEqual({
            error: {
                type: 'refusal',
                message: expect.stringContaining('涉及攻击')
            }
        });
        expect(saveAssistantMessageAsync).not.toHaveBeenCalled();
    });

    it('正常结束却没有正文时按空回复抛出', async () => {
        const { response, ctx } = makeCtx({
            replies: [{ content: '', stop: { kind: 'end', reason: 'end_turn' } }]
        });

        await expect(handleNonStreamResponse(response, ctx)).rejects.toEqual({
            error: { type: 'empty_reply', message: expect.stringContaining('end_turn') }
        });
    });

    it('解析不出回复时按空回复抛出', async () => {
        const { response, ctx } = makeCtx({ replies: [null] });

        await expect(handleNonStreamResponse(response, ctx)).rejects.toEqual({
            error: { type: 'empty_reply', message: expect.any(String) }
        });
    });

    it('续作轮次没有正文时并入原消息，不按错误处理', async () => {
        const { response, ctx } = makeCtx({
            replies: [{ content: '', stop: maxTokensStop }],
            task: { isSavingContinuation: true }
        });

        await handleNonStreamResponse(response, ctx);

        const [, meta, opts] = saveAssistantMessageAsync.mock.calls[0];
        expect(opts.isContinuation).toBe(true);
        expect(meta.stop).toEqual(maxTokensStop);
    });

    it('pause_turn 没有正文时继续发起续作', async () => {
        const { response, ctx } = makeCtx({
            replies: [
                { content: '', pauseTurn: true, stop: { kind: 'pause', reason: 'pause_turn' } }
            ]
        });

        await handleNonStreamResponse(response, ctx);

        expect(saveAssistantMessageAsync).toHaveBeenCalled();
        expect(startPauseTurnContinuation).toHaveBeenCalled();
    });
});

describe('handleNonStreamResponse - 多回复', () => {
    it('第一个回复为空时默认选中成功的回复', async () => {
        const { response, ctx } = makeCtx({
            replies: [
                { content: '', stop: { kind: 'safety', reason: 'content_filter' } },
                { content: '第二个回复', stop: maxTokensStop }
            ]
        });

        await handleNonStreamResponse(response, ctx);

        expect(state.selectedReplyIndex).toBe(1);
        const [parts, meta, opts] = saveAssistantMessageAsync.mock.calls[0];
        expect(parts).toEqual([expect.objectContaining({ type: 'text', text: '第二个回复' })]);
        expect(meta.stop).toEqual(maxTokensStop);
        expect(opts.selectedReplyIndex).toBe(1);
        expect(opts.allReplies[0].error).toEqual(expect.objectContaining({ type: 'safety' }));
        expect(renderReplyWithSelector).toHaveBeenCalledWith(
            expect.any(Array),
            1,
            ctx.assistantMessageEl
        );
    });

    it('全部回复都没有正文时汇总原因抛出', async () => {
        const { response, ctx } = makeCtx({
            replies: [
                { content: '', stop: { kind: 'safety', reason: 'content_filter' } },
                { content: '', stop: { kind: 'end', reason: 'stop' } }
            ]
        });

        await expect(handleNonStreamResponse(response, ctx)).rejects.toEqual({
            error: {
                type: 'safety',
                message: expect.stringContaining('content_filter'),
                allErrors: [
                    expect.objectContaining({ request: 1, type: 'safety' }),
                    expect.objectContaining({ request: 2, type: 'empty_reply' })
                ]
            }
        });
        expect(saveAssistantMessageAsync).not.toHaveBeenCalled();
    });
});
