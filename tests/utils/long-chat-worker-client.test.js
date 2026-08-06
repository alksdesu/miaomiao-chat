import { describe, expect, it } from 'vitest';
import {
    buildSearchIndexInWorker,
    estimateTokensInWorker,
    segmentTextInWorker
} from '../../js/utils/long-chat-worker-client.js';

describe('long-chat-worker-client fallback', () => {
    it('构建与同步实现等价的搜索条目', async () => {
        const result = await buildSearchIndexInWorker([
            { id: 'm1', role: 'USER', parts: [{ type: 'text', text: '  hello   world ' }] },
            { id: 'm2', role: 'assistant', parts: [{ type: 'thinking', text: 'hidden' }] }
        ]);

        expect(result).toMatchObject({ version: 1, messageCount: 2 });
        expect(result.entries).toEqual([{ id: 'm1', index: 0, role: 'user', text: 'hello world' }]);
    });

    it('在线程不可用时仍可估算 token 和分段', async () => {
        expect(await estimateTokensInWorker('你好abcd')).toBe(3);
        expect(await segmentTextInWorker('abcdefgh', 3)).toEqual(['abc', 'def', 'gh']);
    });
});
