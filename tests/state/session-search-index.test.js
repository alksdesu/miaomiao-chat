/**
 * session-search-index.js 会话搜索索引测试
 */
import { describe, it, expect } from 'vitest';

import {
    extractMessageSearchText,
    buildSessionSearchIndex,
    isSessionSearchIndexUsable,
    createSessionSearchIndexRecord,
    SESSION_SEARCH_INDEX_VERSION
} from '../../js/state/session-search-index.js';

// ========== extractMessageSearchText ==========

describe('extractMessageSearchText', () => {
    it('null 返回空', () => {
        expect(extractMessageSearchText(null)).toBe('');
    });

    it('undefined 返回空', () => {
        expect(extractMessageSearchText(undefined)).toBe('');
    });

    it('新格式消息提取 text parts', () => {
        const msg = {
            _schemaVersion: 1,
            parts: [
                { type: 'text', text: 'hello' },
                { type: 'thinking', text: 'thinking...' },
                { type: 'text', text: 'world' }
            ]
        };
        expect(extractMessageSearchText(msg)).toBe('hello world');
    });

    it('新格式消息跳过非 text 且无 text 属性的 part', () => {
        const msg = {
            _schemaVersion: 1,
            parts: [
                { type: 'text', text: 'hello' },
                { type: 'media', url: 'data:...' }
            ]
        };
        expect(extractMessageSearchText(msg)).toBe('hello');
    });

    it('不在搜索层读取旧格式 content', () => {
        expect(extractMessageSearchText({ content: 'hello world' })).toBe('');
    });

    it('空白字符合并', () => {
        const msg = {
            parts: [{ type: 'text', text: '  hello   world  ' }]
        };
        expect(extractMessageSearchText(msg)).toBe('hello world');
    });

    it('没有 content 或 parts 返回空', () => {
        expect(extractMessageSearchText({})).toBe('');
    });

    it('忽略没有标准 type 的原始 part', () => {
        const msg = { parts: [{ text: 'fallback text' }] };
        expect(extractMessageSearchText(msg)).toBe('');
    });
});

// ========== buildSessionSearchIndex ==========

describe('buildSessionSearchIndex', () => {
    it('空数组返回空索引', () => {
        const index = buildSessionSearchIndex([]);
        expect(index.version).toBe(SESSION_SEARCH_INDEX_VERSION);
        expect(index.entries).toHaveLength(0);
        expect(index.messageCount).toBe(0);
    });

    it('非数组返回空索引', () => {
        const index = buildSessionSearchIndex(null);
        expect(index.entries).toHaveLength(0);
    });

    it('构建正常索引', () => {
        const messages = [
            { id: 'msg1', role: 'user', parts: [{ type: 'text', text: 'hello' }] },
            { id: 'msg2', role: 'assistant', parts: [{ type: 'text', text: 'hi there' }] }
        ];
        const index = buildSessionSearchIndex(messages);
        expect(index.entries).toHaveLength(2);
        expect(index.entries[0]).toEqual({ id: 'msg1', index: 0, role: 'user', text: 'hello' });
        expect(index.entries[1]).toEqual({
            id: 'msg2',
            index: 1,
            role: 'assistant',
            text: 'hi there'
        });
        expect(index.messageCount).toBe(2);
    });

    it('跳过无文本内容的消息', () => {
        const messages = [
            { id: 'msg1', role: 'user', parts: [{ type: 'text', text: 'hello' }] },
            { id: 'msg2', role: 'assistant', parts: [] }
        ];
        const index = buildSessionSearchIndex(messages);
        expect(index.entries).toHaveLength(1);
        expect(index.messageCount).toBe(2);
    });

    it('无 id 时生成占位 id', () => {
        const messages = [{ role: 'user', parts: [{ type: 'text', text: 'test' }] }];
        const index = buildSessionSearchIndex(messages);
        expect(index.entries[0].id).toBe('msg_0');
    });

    it('role 规范化', () => {
        const messages = [
            { id: 'm1', role: 'USER', parts: [{ type: 'text', text: 'test' }] },
            { id: 'm2', role: '', parts: [{ type: 'text', text: 'test2' }] },
            { id: 'm3', parts: [{ type: 'text', text: 'test3' }] }
        ];
        const index = buildSessionSearchIndex(messages);
        expect(index.entries[0].role).toBe('user');
        expect(index.entries[1].role).toBe('unknown');
        expect(index.entries[2].role).toBe('unknown');
    });

    it('包含 updatedAt 时间戳', () => {
        const before = Date.now();
        const index = buildSessionSearchIndex([]);
        expect(index.updatedAt).toBeGreaterThanOrEqual(before);
    });
});

// ========== isSessionSearchIndexUsable ==========

describe('isSessionSearchIndexUsable', () => {
    it('null 不可用', () => {
        expect(isSessionSearchIndexUsable(null)).toBe(false);
    });

    it('非对象不可用', () => {
        expect(isSessionSearchIndexUsable('string')).toBe(false);
    });

    it('版本不匹配不可用', () => {
        expect(isSessionSearchIndexUsable({ version: 999, entries: [] })).toBe(false);
    });

    it('无 entries 不可用', () => {
        expect(isSessionSearchIndexUsable({ version: SESSION_SEARCH_INDEX_VERSION })).toBe(false);
    });

    it('有效索引可用', () => {
        expect(
            isSessionSearchIndexUsable({
                version: SESSION_SEARCH_INDEX_VERSION,
                entries: []
            })
        ).toBe(true);
    });

    it('messageCount 不匹配时不可用', () => {
        expect(
            isSessionSearchIndexUsable(
                {
                    version: SESSION_SEARCH_INDEX_VERSION,
                    entries: [],
                    messageCount: 5
                },
                10
            )
        ).toBe(false);
    });

    it('messageCount 匹配时可用', () => {
        expect(
            isSessionSearchIndexUsable(
                {
                    version: SESSION_SEARCH_INDEX_VERSION,
                    entries: [],
                    messageCount: 5
                },
                5
            )
        ).toBe(true);
    });

    it('expectedMessageCount 为 null 时不检查', () => {
        expect(
            isSessionSearchIndexUsable(
                {
                    version: SESSION_SEARCH_INDEX_VERSION,
                    entries: [],
                    messageCount: 100
                },
                null
            )
        ).toBe(true);
    });
});

// ========== createSessionSearchIndexRecord ==========

describe('createSessionSearchIndexRecord', () => {
    it('使用提供的 searchIndex', () => {
        const idx = {
            version: SESSION_SEARCH_INDEX_VERSION,
            updatedAt: 12345,
            messageCount: 1,
            entries: [{ id: 'm1', index: 0, role: 'user', text: 'test' }]
        };
        const record = createSessionSearchIndexRecord(
            's1',
            [{ parts: [{ type: 'text', text: 'test' }] }],
            idx
        );
        expect(record.sessionId).toBe('s1');
        expect(record.entries).toHaveLength(1);
    });

    it('searchIndex 不可用时重建', () => {
        const record = createSessionSearchIndexRecord(
            's1',
            [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hello' }] }],
            null
        );
        expect(record.sessionId).toBe('s1');
        expect(record.entries).toHaveLength(1);
        expect(record.entries[0].text).toBe('hello');
    });

    it('messages 为 null 时安全处理', () => {
        const record = createSessionSearchIndexRecord('s1', null, null);
        expect(record.entries).toHaveLength(0);
    });
});
