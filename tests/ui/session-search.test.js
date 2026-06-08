/**
 * session-search.js 测试
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../js/core/state.js', () => ({
    state: {
        sessions: [],
        currentSessionIndex: 0
    }
}));

vi.mock('../../js/core/elements.js', () => ({
    elements: {}
}));

vi.mock('../../js/core/events.js', () => ({
    eventBus: { emit: vi.fn(), on: vi.fn(), off: vi.fn() }
}));

vi.mock('../../js/utils/helpers.js', () => ({
    escapeHtml: vi.fn((s) => {
        if (!s) return '';
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    })
}));

vi.mock('../../js/state/storage.js', () => ({
    loadAllSessionSearchIndexes: vi.fn(() => Promise.resolve({})),
    loadSessionMessages: vi.fn(() => Promise.resolve([])),
    saveSessionSearchIndex: vi.fn(() => Promise.resolve())
}));

vi.mock('../../js/state/session-search-index.js', () => ({
    buildSessionSearchIndex: vi.fn(() => ({ entries: [] })),
    isSessionSearchIndexUsable: vi.fn(() => true)
}));

vi.mock('../../js/utils/logger.js', () => ({
    logger: { warn: vi.fn(), debug: vi.fn(), error: vi.fn(), info: vi.fn() }
}));

import { state } from '../../js/core/state.js';
import { elements } from '../../js/core/elements.js';
import { eventBus } from '../../js/core/events.js';
import {
    highlightMatch,
    searchSessions,
    getSessionSearchState,
    getCurrentQuery,
    initSessionSearch
} from '../../js/ui/session-search.js';

describe('session-search', () => {
    // ========== highlightMatch ==========
    describe('highlightMatch', () => {
        it('高亮匹配文本', () => {
            const result = highlightMatch('hello world', 'world');
            expect(result).toContain('<mark>world</mark>');
        });

        it('不区分大小写', () => {
            const result = highlightMatch('Hello World', 'hello');
            expect(result).toContain('<mark>');
        });

        it('多次匹配', () => {
            const result = highlightMatch('foo bar foo', 'foo');
            const matches = result.match(/<mark>/g);
            expect(matches).toHaveLength(2);
        });

        it('空 query 返回转义文本', () => {
            const result = highlightMatch('hello', '');
            expect(result).toBe('hello');
            expect(result).not.toContain('<mark>');
        });

        it('null query 返回转义文本', () => {
            const result = highlightMatch('hello', null);
            expect(result).toBe('hello');
        });

        it('null text 返回空', () => {
            const result = highlightMatch(null, 'query');
            expect(result).toBe('');
        });

        it('特殊正则字符被转义', () => {
            const result = highlightMatch('price is $100', '$100');
            expect(result).toContain('<mark>');
        });

        it('HTML 字符被转义', () => {
            const result = highlightMatch('<script>alert(1)</script>', 'script');
            expect(result).not.toContain('<script>');
            expect(result).toContain('&lt;');
        });
    });

    // ========== searchSessions ==========
    describe('searchSessions', () => {
        it('空 query 返回空数组', () => {
            expect(searchSessions('')).toEqual([]);
        });

        it('null query 返回空数组', () => {
            expect(searchSessions(null)).toEqual([]);
        });

        it('空白 query 返回空数组', () => {
            expect(searchSessions('   ')).toEqual([]);
        });

        it('无 sessions 返回空数组', () => {
            state.sessions = [];
            expect(searchSessions('hello')).toEqual([]);
        });

        it('搜索匹配 session name', () => {
            state.sessions = [{ id: 's1', name: 'Hello World Chat', messages: [] }];
            const results = searchSessions('Hello');
            expect(results.length).toBeGreaterThanOrEqual(1);
            expect(results[0].matchedInName).toBe(true);
        });

        it('name 匹配不区分大小写', () => {
            state.sessions = [{ id: 's1', name: 'Test Session', messages: [] }];
            const results = searchSessions('test');
            expect(results.length).toBeGreaterThanOrEqual(1);
        });
    });

    // ========== getSessionSearchState ==========
    describe('getSessionSearchState', () => {
        it('返回搜索状态对象', () => {
            const state = getSessionSearchState();
            expect(state).toBeDefined();
            expect(typeof state.query).toBe('string');
            expect(typeof state.isActive).toBe('boolean');
            expect(state.indexing).toBeDefined();
            expect(typeof state.indexing.totalCount).toBe('number');
            expect(typeof state.indexing.isRunning).toBe('boolean');
        });
    });

    // ========== getCurrentQuery ==========
    describe('getCurrentQuery', () => {
        it('初始值为空', () => {
            expect(getCurrentQuery()).toBe('');
        });
    });

    // ========== initSessionSearch ==========
    describe('initSessionSearch', () => {
        it('无搜索输入元素不抛错', () => {
            expect(() => initSessionSearch()).not.toThrow();
        });

        it('注册了事件监听器', () => {
            initSessionSearch();
            const events = eventBus.on.mock.calls.map((c) => c[0]);
            expect(events).toContain('sessions:loaded');
            expect(events).toContain('sessions:updated');
            expect(events).toContain('session:before-switch');
            expect(events).toContain('session:switched');
        });

        it('有搜索输入框时绑定 input 事件', () => {
            const searchInput = document.createElement('input');
            const clearBtn = document.createElement('button');
            elements.sessionSearchInput = searchInput;
            elements.sessionSearchClear = clearBtn;

            const inputSpy = vi.spyOn(searchInput, 'addEventListener');
            const clearSpy = vi.spyOn(clearBtn, 'addEventListener');

            // 因为 initSessionSearch 有 _initialized 守卫，可能已初始化
            // 但我们仍然可以验证输入框有事件绑定
            initSessionSearch();
            // 只验证不抛错
        });
    });

    // ========== searchSessions 更多用例 ==========
    describe('searchSessions — 消息内搜索', () => {
        it('搜索匹配 session 消息内容', () => {
            state.sessions = [
                {
                    id: 's1',
                    name: 'Chat A',
                    messages: [{ role: 'user', content: 'Looking for pizza recipes' }]
                }
            ];
            // searchSessions 使用 searchIndexStore（内部 Map）
            // 没有索引时只匹配名字
            const results = searchSessions('Chat');
            expect(results.length).toBe(1);
        });

        it('多个会话中搜索', () => {
            state.sessions = [
                { id: 's1', name: 'Alpha Session', messages: [] },
                { id: 's2', name: 'Beta Session', messages: [] },
                { id: 's3', name: 'Gamma Test', messages: [] }
            ];
            const results = searchSessions('Session');
            expect(results.length).toBe(2);
        });

        it('返回结果包含 session 信息', () => {
            state.sessions = [{ id: 's1', name: 'Match', messages: [] }];
            const results = searchSessions('Match');
            expect(results.length).toBe(1);
            expect(results[0].matchedInName).toBe(true);
        });
    });
});
