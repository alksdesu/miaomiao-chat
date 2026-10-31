/**
 * messages/parts-builder.js 结束原因写入与多回复默认选中测试
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../js/api/current.js', () => ({
    getCurrentProvider: vi.fn(() => ({ name: 'Provider' })),
    getModelDisplayName: vi.fn((id) => id || '')
}));

import {
    buildPartsFromStreamingState,
    buildMetaFromStreamingState,
    buildMetaFromReply,
    buildCanonicalReply,
    hasReplyOutput,
    pickInitialReplyIndex
} from '../../js/messages/parts-builder.js';

const stop = { kind: 'max_tokens', reason: 'length' };

describe('meta.stop', () => {
    it('buildMetaFromStreamingState 写入结束原因', () => {
        expect(buildMetaFromStreamingState({ stop }).stop).toEqual(stop);
    });

    it('没有结束原因时不写入字段', () => {
        expect(buildMetaFromStreamingState({})).not.toHaveProperty('stop');
    });

    it('buildMetaFromReply 写入结束原因', () => {
        expect(buildMetaFromReply({ content: 'hi', stop }).stop).toEqual(stop);
        expect(buildMetaFromReply({ content: 'hi' })).not.toHaveProperty('stop');
    });

    it('多回复的规范化回复保留结束原因', () => {
        expect(buildCanonicalReply({ content: 'hi', stop }).meta.stop).toEqual(stop);
    });
});

describe('hasReplyOutput', () => {
    it.each([
        [{ content: 'hi' }, true],
        [{ thinkingContent: 'think' }, true],
        [{ contentParts: [{ type: 'image_url', url: 'x' }] }, true],
        [{ content: '', contentParts: [] }, false],
        [{ content: '', contentParts: null }, false],
        [null, false],
        [undefined, false]
    ])('%j → %s', (reply, expected) => {
        expect(hasReplyOutput(reply)).toBe(expected);
    });
});

describe('pickInitialReplyIndex', () => {
    it('优先第一个成功的回复', () => {
        expect(
            pickInitialReplyIndex([
                { isError: true, content: '' },
                { content: 'ok' },
                { content: 'ok2' }
            ])
        ).toBe(1);
    });

    it('全部失败时选第一个带部分内容的回复', () => {
        expect(
            pickInitialReplyIndex([
                { isError: true, content: '' },
                { isError: true, content: '部分' }
            ])
        ).toBe(1);
    });

    it('全部失败且没有内容时返回 -1', () => {
        expect(pickInitialReplyIndex([{ isError: true, content: '' }])).toBe(-1);
        expect(pickInitialReplyIndex([])).toBe(-1);
    });
});

describe('思考块落库', () => {
    it('文本为空但带签名的思考块保留（Claude 不返回思考摘要时），redacted 一并保留', () => {
        const parts = buildPartsFromStreamingState({
            thinkingItems: [
                { type: 'thinking', text: '', signature: 'sig-omitted' },
                { type: 'redacted_thinking', data: 'ENC' },
                { type: 'thinking', text: '', signature: '' }
            ],
            toolCalls: [{ id: 'toolu_1', name: 'search', arguments: {} }],
            signatureFormat: 'claude'
        });
        expect(parts.filter((p) => p.type === 'thinking')).toEqual([
            { type: 'thinking', text: '', signature: 'sig-omitted', signatureFormat: 'claude' },
            { type: 'thinking', text: '', redacted: true, data: 'ENC' }
        ]);
    });

    it('非流式 Claude 回复以 contentParts 为准：带签名的思考与 redacted 按原顺序落库，不与 thinkingItems 重复', () => {
        const parts = buildPartsFromStreamingState({
            contentParts: [
                { type: 'thinking', text: 'plan', signature: 'sig-1' },
                { type: 'redacted_thinking', data: 'ENC' },
                { type: 'text', text: 'answer' }
            ],
            thinkingItems: [
                { type: 'thinking', text: 'plan', signature: 'sig-1' },
                { type: 'redacted_thinking', data: 'ENC' }
            ],
            signatureFormat: 'claude'
        });
        expect(parts).toEqual([
            { type: 'thinking', text: 'plan', signature: 'sig-1', signatureFormat: 'claude' },
            { type: 'thinking', text: '', redacted: true, data: 'ENC' },
            { type: 'text', text: 'answer' }
        ]);
    });

    it('Gemini 的消息级签名挂到 contentParts 里最后一段思考上', () => {
        const parts = buildPartsFromStreamingState({
            contentParts: [
                { type: 'thinking', text: 'a' },
                { type: 'text', text: 'mid' },
                { type: 'thinking', text: 'b' },
                { type: 'text', text: 'end' }
            ],
            thinkingContent: 'ab',
            thoughtSignature: 'gem-sig',
            signatureFormat: 'gemini'
        });
        const thinking = parts.filter((p) => p.type === 'thinking');
        expect(thinking[0].signature).toBeUndefined();
        expect(thinking[1]).toEqual({
            type: 'thinking',
            text: 'b',
            signature: 'gem-sig',
            signatureFormat: 'gemini'
        });
    });

    it('备选回复同样保留空文本签名与 redacted', () => {
        const reply = buildCanonicalReply({
            content: 'x',
            thinkingItems: [
                { type: 'thinking', text: '', signature: 'sig-r' },
                { type: 'redacted_thinking', data: 'ENC' }
            ],
            signatureFormat: 'claude'
        });
        expect(reply.parts.slice(0, 2)).toEqual([
            { type: 'thinking', text: '', signature: 'sig-r', signatureFormat: 'claude' },
            { type: 'thinking', text: '', redacted: true, data: 'ENC' }
        ]);
    });
});
