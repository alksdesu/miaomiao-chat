/**
 * message-location.js 测试
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.hoisted 让 fixtureIdMap 在 vi.mock factory hoisting 之前就初始化
const { fixtureIdMap } = vi.hoisted(() => ({ fixtureIdMap: new Map() }));

vi.mock('../../js/core/state.js', () => ({
    state: {
        messages: [],
        messageIdMap: fixtureIdMap,
        messageStore: {
            findIndexById: (id) => (fixtureIdMap.has(id) ? fixtureIdMap.get(id) : -1)
        }
    },
    elements: {
        messagesArea: null
    }
}));

vi.mock('../../js/ui/virtual-scroll.js', () => ({
    scrollToMessage: vi.fn()
}));

import { state, elements } from '../../js/core/state.js';
import { resolveMessageIndex, locateMessageByReference } from '../../js/ui/message-location.js';

describe('message-location', () => {
    beforeEach(() => {
        state.messages = [];
        fixtureIdMap.clear();
        elements.messagesArea = null;
        document.body.innerHTML = '';
    });

    // ========== resolveMessageIndex ==========
    describe('resolveMessageIndex', () => {
        it('无参数返回 -1', () => {
            expect(resolveMessageIndex()).toBe(-1);
        });

        it('空参数返回 -1', () => {
            expect(resolveMessageIndex({})).toBe(-1);
        });

        it('messageId 在 store 中时返回映射值', () => {
            fixtureIdMap.set('msg_abc', 5);
            expect(resolveMessageIndex({ messageId: 'msg_abc' })).toBe(5);
        });

        it('messageId 不在 store 中使用 fallbackIndex', () => {
            expect(resolveMessageIndex({ messageId: 'missing', fallbackIndex: 3 })).toBe(3);
        });

        it('仅 fallbackIndex', () => {
            expect(resolveMessageIndex({ fallbackIndex: 7 })).toBe(7);
        });

        it('fallbackIndex 为负数仍返回', () => {
            expect(resolveMessageIndex({ fallbackIndex: -1 })).toBe(-1);
        });

        it('messageId 优先于 fallbackIndex', () => {
            fixtureIdMap.set('id1', 10);
            expect(resolveMessageIndex({ messageId: 'id1', fallbackIndex: 5 })).toBe(10);
        });

        it('messageId 为空字符串使用 fallbackIndex', () => {
            expect(resolveMessageIndex({ messageId: '', fallbackIndex: 2 })).toBe(2);
        });
    });

    // ========== locateMessageByReference ==========
    describe('locateMessageByReference', () => {
        it('messagesArea 为 null 返回 false', async () => {
            elements.messagesArea = null;
            const result = await locateMessageByReference({ fallbackIndex: 0 });
            expect(result).toBe(false);
        });

        it('index 超出范围返回 false', async () => {
            elements.messagesArea = document.createElement('div');
            state.messages = [{ content: 'only one' }];
            const result = await locateMessageByReference({ fallbackIndex: 5 });
            expect(result).toBe(false);
        });

        it('index 为负数返回 false', async () => {
            elements.messagesArea = document.createElement('div');
            state.messages = [{ content: 'msg' }];
            const result = await locateMessageByReference({ fallbackIndex: -1 });
            expect(result).toBe(false);
        });

        it('index 有效但元素不存在返回 false', async () => {
            const area = document.createElement('div');
            elements.messagesArea = area;
            document.body.appendChild(area);
            state.messages = [{ content: 'msg' }];
            // 不添加 message 元素到 DOM
            const result = await locateMessageByReference({ fallbackIndex: 0 });
            expect(result).toBe(false);
        });
    });
});
