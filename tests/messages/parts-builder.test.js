/**
 * messages/parts-builder.js 结束原因写入与多回复默认选中测试
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../js/api/current.js', () => ({
    getCurrentProvider: vi.fn(() => ({ name: 'Provider' })),
    getModelDisplayName: vi.fn((id) => id || '')
}));

import {
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
