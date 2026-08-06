import { describe, expect, it, vi } from 'vitest';
import {
    MESSAGE_PAGE_SIZE,
    paginateMessages,
    putMessagePages
} from '../../js/state/message-page-repository.js';
import { SCHEMA_VERSION } from '../../js/messages/schema.js';

describe('message-page-repository', () => {
    it('按固定大小分页且不修改原数组', () => {
        const messages = Array.from({ length: MESSAGE_PAGE_SIZE * 2 + 7 }, (_, index) => ({
            id: `m${index}`
        }));
        const pages = paginateMessages(messages);

        expect(pages.map((page) => page.length)).toEqual([MESSAGE_PAGE_SIZE, MESSAGE_PAGE_SIZE, 7]);
        pages[0].pop();
        expect(messages).toHaveLength(MESSAGE_PAGE_SIZE * 2 + 7);
    });

    it('在同一事务写入页面和 complete manifest', () => {
        const pageStore = { put: vi.fn() };
        const manifestStore = { put: vi.fn() };
        const transaction = {
            objectStore: vi.fn((name) => (name === 'messagePages' ? pageStore : manifestStore))
        };
        const messages = Array.from({ length: 205 }, (_, index) => ({ id: `m${index}` }));

        const manifest = putMessagePages(transaction, 'session-1', messages, {
            updatedAt: 123,
            pageSize: 100
        });

        expect(pageStore.put).toHaveBeenCalledTimes(3);
        expect(pageStore.put.mock.calls[2][0]).toMatchObject({
            sessionId: 'session-1',
            pageIndex: 2,
            start: 200,
            messages: messages.slice(200),
            messageSchemaVersion: SCHEMA_VERSION
        });
        expect(manifest).toMatchObject({
            sessionId: 'session-1',
            messageCount: 205,
            pageCount: 3,
            state: 'complete',
            messageSchemaVersion: SCHEMA_VERSION,
            migration: null
        });
        expect(manifestStore.put).toHaveBeenCalledWith(manifest);
    });

    it('分页写入前迁移旧消息', () => {
        const pageStore = { put: vi.fn() };
        const manifestStore = { put: vi.fn() };
        const transaction = {
            objectStore: vi.fn((name) => (name === 'messagePages' ? pageStore : manifestStore))
        };

        putMessagePages(
            transaction,
            'legacy-session',
            [{ role: 'user', content: 'legacy', timestamp: 10 }],
            { updatedAt: 123 }
        );

        const stored = pageStore.put.mock.calls[0][0].messages[0];
        expect(stored).toMatchObject({
            role: 'user',
            ts: 10,
            _schemaVersion: SCHEMA_VERSION
        });
        expect(stored.parts[0]).toMatchObject({ type: 'text', text: 'legacy' });
        expect(stored.content).toBeUndefined();
    });
});
