/**
 * state-mutations.js 测试
 * 测试消息数组的增删改查操作
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// mock state（含 messageStore 旁路封装 + Proxy.set 拦截 messages 整体替换走 store.replaceAll）
// 模拟生产 state.js Proxy 行为，让测试 fixture `state.messages = [...]` 自动转 store.replaceAll
vi.mock('../../js/core/state.js', async () => {
    const { MessageStore } = await import('../../js/core/message-store.js');
    const messagesArr = [];
    const messageStore = new MessageStore(messagesArr);
    const target = {
        messages: messagesArr,
        messageStore,
        messageIdMap: messageStore.idMap,
        sessionDirty: false,
        currentSessionId: null
    };
    return {
        state: new Proxy(target, {
            set(t, prop, value) {
                if (prop === 'messages' && Array.isArray(value) && t.messageStore) {
                    t.messageStore.replaceAll(value);
                    return true;
                }
                t[prop] = value;
                return true;
            }
        })
    };
});

// mock events
vi.mock('../../js/core/events.js', () => ({
    eventBus: {
        emit: vi.fn(),
        on: vi.fn()
    }
}));

// mock helpers
vi.mock('../../js/utils/helpers.js', () => {
    let counter = 0;
    return {
        generateMessageId: () => `msg_auto_${++counter}`
    };
});

// mock schema（只用到 PartType 和 hasParts）
vi.mock('../../js/messages/schema.js', () => ({
    PartType: {
        TEXT: 'text',
        THINKING: 'thinking',
        MEDIA: 'media',
        TOOL_CALL: 'tool_call',
        FILE: 'file'
    },
    hasParts: (msg) => Array.isArray(msg?.parts) && msg.parts.length > 0,
    isNewFormat: (msg) => msg?._schemaVersion >= 1
}));

// replaceAllMessages 的 gateway 编排由兼容层测试覆盖，这里只测试 store 变更
vi.mock('../../js/messages/compat/gateway.js', () => ({
    normalizeSessionRecord: ({ messages }) => ({
        messages: [...messages],
        status: 'unchanged',
        changed: false,
        writeBackRequired: false
    })
}));

import { state } from '../../js/core/state.js';
import { eventBus } from '../../js/core/events.js';
import {
    pushMessage,
    removeMessageAt,
    removeMessageById,
    removeMessagesAfter,
    removeMessagesAfterId,
    updateMessageAt,
    updateMessageById,
    replaceAllMessages,
    popLastAssistantMessage,
    updateMessageTextAt,
    updateMessageTextById,
    ensureMessageIds,
    rebuildMessageIdMap,
    setState
} from '../../js/core/state-mutations.js';

describe('messageId mutators', () => {
    beforeEach(() => {
        state.messages = [
            { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'one' }] },
            { id: 'm2', role: 'assistant', parts: [{ type: 'text', text: 'two' }] },
            { id: 'm3', role: 'user', parts: [{ type: 'text', text: 'three' }] }
        ];
        rebuildMessageIdMap();
        state.sessionDirty = false;
    });

    it('按 ID 更新、更新文本和删除消息', () => {
        expect(updateMessageById('m2', { role: 'user' })).toBe(true);
        expect(updateMessageTextById('m2', 'updated')).toBe(true);
        expect(state.messageStore.findById('m2')).toMatchObject({ role: 'user' });
        expect(state.messageStore.findById('m2').parts[0].text).toBe('updated');
        expect(removeMessageById('m1')).toBe(true);
        expect(state.messageStore.findById('m1')).toBeUndefined();
    });

    it('按 ID 截断并对不存在 ID 返回 false', () => {
        expect(removeMessagesAfterId('m1')).toBe(true);
        expect(state.messages.map((message) => message.id)).toEqual(['m1']);
        expect(updateMessageById('missing', {})).toBe(false);
        expect(removeMessageById('missing')).toBe(false);
    });
});

beforeEach(() => {
    // 通过 store.clear() 清空保持引用稳定（不能 state.messages = []，会丢失 store 同步）
    state.messageStore.clear();
    state.sessionDirty = false;
    vi.clearAllMocks();
});

// ========== pushMessage ==========

describe('pushMessage', () => {
    it('添加消息到数组末尾', () => {
        const msg = { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] };
        const index = pushMessage(msg);
        expect(index).toBe(0);
        expect(state.messages).toHaveLength(1);
        expect(state.messages[0]).toBe(msg);
    });

    it('返回正确的索引', () => {
        pushMessage({ id: 'm1', role: 'user', parts: [] });
        const index = pushMessage({ id: 'm2', role: 'assistant', parts: [] });
        expect(index).toBe(1);
    });

    it('更新 messageIdMap', () => {
        pushMessage({ id: 'm1', role: 'user', parts: [] });
        expect(state.messageIdMap.get('m1')).toBe(0);
    });

    it('无 id 的消息自动补 id 进入 map（store 契约：无 id 不允许入库）', () => {
        pushMessage({ role: 'user', parts: [] });
        // store.push 缺 id 时自动 generateMessageId，入库后 idMap 必有该 id
        expect(state.messageIdMap.size).toBe(1);
        expect(state.messages[0].id).toMatch(/^msg_auto_/);
    });

    it('设置 sessionDirty', () => {
        pushMessage({ id: 'm1', role: 'user', parts: [] });
        expect(state.sessionDirty).toBe(true);
    });
});

// ========== removeMessageAt ==========

describe('removeMessageAt', () => {
    beforeEach(() => {
        state.messages = [
            { id: 'm1', role: 'user', parts: [] },
            { id: 'm2', role: 'assistant', parts: [] },
            { id: 'm3', role: 'user', parts: [] }
        ];
        rebuildMessageIdMap();
        state.sessionDirty = false;
    });

    it('删除指定索引的消息', () => {
        removeMessageAt(1);
        expect(state.messages).toHaveLength(2);
        expect(state.messages[0].id).toBe('m1');
        expect(state.messages[1].id).toBe('m3');
    });

    it('从 map 中移除已删除消息', () => {
        removeMessageAt(1);
        expect(state.messageIdMap.has('m2')).toBe(false);
    });

    it('重建后续消息的 map 索引', () => {
        removeMessageAt(0);
        expect(state.messageIdMap.get('m2')).toBe(0);
        expect(state.messageIdMap.get('m3')).toBe(1);
    });

    it('无效索引不操作', () => {
        removeMessageAt(-1);
        expect(state.messages).toHaveLength(3);
        removeMessageAt(10);
        expect(state.messages).toHaveLength(3);
    });

    it('设置 sessionDirty', () => {
        removeMessageAt(0);
        expect(state.sessionDirty).toBe(true);
    });
});

// ========== removeMessagesAfter ==========

describe('removeMessagesAfter', () => {
    beforeEach(() => {
        state.messages = [
            { id: 'm1', role: 'user', parts: [] },
            { id: 'm2', role: 'assistant', parts: [] },
            { id: 'm3', role: 'user', parts: [] }
        ];
        rebuildMessageIdMap();
        state.sessionDirty = false;
    });

    it('删除指定索引后的所有消息', () => {
        removeMessagesAfter(0);
        expect(state.messages).toHaveLength(1);
        expect(state.messages[0].id).toBe('m1');
    });

    it('从 map 中移除已删除消息', () => {
        removeMessagesAfter(0);
        expect(state.messageIdMap.has('m2')).toBe(false);
        expect(state.messageIdMap.has('m3')).toBe(false);
    });

    it('最后一条后面没有消息时不操作', () => {
        removeMessagesAfter(2);
        expect(state.messages).toHaveLength(3);
    });

    it('负数索引不操作', () => {
        removeMessagesAfter(-1);
        expect(state.messages).toHaveLength(3);
    });
});

// 截断后必须通知依赖消息总数的订阅方
describe('removeMessagesAfter event emission', () => {
    beforeEach(() => {
        state.messages = [
            { id: 'm1', role: 'user', parts: [] },
            { id: 'm2', role: 'assistant', parts: [] },
            { id: 'm3', role: 'user', parts: [] }
        ];
        rebuildMessageIdMap();
        state.sessionDirty = false;
        // 清空因 rebuildMessageIdMap 等同步初始化可能产生的 emit 记录
        eventBus.emit.mockClear();
    });

    it('emits state:messages-replaced after slice with newLength payload', () => {
        // fromIndex=0 → 保留 m1 一条，截断 m2/m3
        removeMessagesAfter(0);

        expect(eventBus.emit).toHaveBeenCalledWith('state:messages-replaced', { newLength: 1 });
        // 严格只 emit 一次该事件
        const replacedCalls = eventBus.emit.mock.calls.filter(
            ([evt]) => evt === 'state:messages-replaced'
        );
        expect(replacedCalls).toHaveLength(1);
    });

    it('does not emit when removeCount === 0 (early return path)', () => {
        // fromIndex 指向最后一条，没有可删消息 → 走 line 78 早返
        removeMessagesAfter(2);

        expect(eventBus.emit).not.toHaveBeenCalledWith(
            'state:messages-replaced',
            expect.anything()
        );
    });
});

// ========== updateMessageAt ==========

describe('updateMessageAt', () => {
    beforeEach(() => {
        state.messages = [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'old' }] }];
        rebuildMessageIdMap();
        state.sessionDirty = false;
    });

    it('合并更新（默认模式）', () => {
        updateMessageAt(0, { parts: [{ type: 'text', text: 'new' }] });
        expect(state.messages[0].id).toBe('m1'); // 保留原有字段
        expect(state.messages[0].parts[0].text).toBe('new');
    });

    it('完整替换模式', () => {
        const newMsg = { id: 'm2', role: 'assistant', parts: [] };
        updateMessageAt(0, newMsg, true);
        expect(state.messages[0]).toEqual(newMsg);
        expect(state.messageIdMap.has('m1')).toBe(false);
        expect(state.messageIdMap.get('m2')).toBe(0);
    });

    it('无效索引不操作', () => {
        updateMessageAt(-1, { parts: [] });
        updateMessageAt(10, { parts: [] });
        expect(state.messages[0].parts[0].text).toBe('old');
    });

    it('设置 sessionDirty', () => {
        updateMessageAt(0, { parts: [] });
        expect(state.sessionDirty).toBe(true);
    });
});

// ========== replaceAllMessages ==========

describe('replaceAllMessages', () => {
    it('替换所有消息', () => {
        state.messages = [{ id: 'old', role: 'user', parts: [] }];
        const newMsgs = [
            { id: 'n1', role: 'user', parts: [] },
            { id: 'n2', role: 'assistant', parts: [] }
        ];
        replaceAllMessages(newMsgs);
        expect(state.messages).toHaveLength(2);
        expect(state.messages[0].id).toBe('n1');
    });

    it('重建 messageIdMap', () => {
        replaceAllMessages([
            { id: 'a', role: 'user', parts: [] },
            { id: 'b', role: 'assistant', parts: [] }
        ]);
        expect(state.messageIdMap.get('a')).toBe(0);
        expect(state.messageIdMap.get('b')).toBe(1);
    });

    it('sessionDirty 设为 false', () => {
        state.sessionDirty = true;
        replaceAllMessages([]);
        expect(state.sessionDirty).toBe(false);
    });

    it('触发 state:messages-replaced 事件', () => {
        replaceAllMessages([{ id: 'a', role: 'user', parts: [] }]);
        expect(eventBus.emit).toHaveBeenCalledWith('state:messages-replaced', { newLength: 1 });
    });

    it('不修改原数组', () => {
        const orig = [{ id: 'a', role: 'user', parts: [] }];
        replaceAllMessages(orig);
        orig.push({ id: 'b', role: 'user', parts: [] });
        expect(state.messages).toHaveLength(1);
    });
});

// ========== popLastAssistantMessage ==========

describe('popLastAssistantMessage', () => {
    it('弹出最后一条 assistant 消息', () => {
        state.messages = [
            { id: 'm1', role: 'user', parts: [] },
            { id: 'm2', role: 'assistant', parts: [] }
        ];
        rebuildMessageIdMap();
        const popped = popLastAssistantMessage();
        expect(popped.id).toBe('m2');
        expect(state.messages).toHaveLength(1);
        expect(state.messageIdMap.has('m2')).toBe(false);
    });

    it('最后一条不是 assistant 返回 null', () => {
        state.messages = [{ id: 'm1', role: 'user', parts: [] }];
        expect(popLastAssistantMessage()).toBeNull();
    });

    it('空数组返回 null', () => {
        expect(popLastAssistantMessage()).toBeNull();
    });

    it('设置 sessionDirty', () => {
        state.messages = [{ id: 'm1', role: 'assistant', parts: [] }];
        rebuildMessageIdMap();
        state.sessionDirty = false;
        popLastAssistantMessage();
        expect(state.sessionDirty).toBe(true);
    });
});

// ========== updateMessageTextAt ==========

describe('updateMessageTextAt', () => {
    it('更新新格式消息的文本', () => {
        state.messages = [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'old' }] }];
        updateMessageTextAt(0, 'new');
        expect(state.messages[0].parts[0].text).toBe('new');
    });

    it('新格式无文本 part 时添加', () => {
        state.messages = [
            { id: 'm1', role: 'assistant', parts: [{ type: 'thinking', text: '思考' }] }
        ];
        updateMessageTextAt(0, '回答');
        expect(state.messages[0].parts).toHaveLength(2);
        expect(state.messages[0].parts[1].type).toBe('text');
        expect(state.messages[0].parts[1].text).toBe('回答');
    });

    it('旧格式消息创建 parts', () => {
        state.messages = [{ id: 'm1', role: 'user', content: 'old' }];
        updateMessageTextAt(0, 'new');
        expect(state.messages[0].parts).toHaveLength(1);
        expect(state.messages[0].parts[0].text).toBe('new');
    });

    it('无效索引不操作', () => {
        state.messages = [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'old' }] }];
        updateMessageTextAt(-1, 'new');
        updateMessageTextAt(10, 'new');
        expect(state.messages[0].parts[0].text).toBe('old');
    });

    it('设置 sessionDirty', () => {
        state.messages = [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'old' }] }];
        state.sessionDirty = false;
        updateMessageTextAt(0, 'new');
        expect(state.sessionDirty).toBe(true);
    });
});

// ========== ensureMessageIds ==========

describe('ensureMessageIds', () => {
    it('为缺少 ID 的消息生成 ID', () => {
        state.messages = [
            { role: 'user', parts: [] },
            { id: 'm1', role: 'assistant', parts: [] },
            { role: 'user', parts: [] }
        ];
        const count = ensureMessageIds();
        expect(count).toBe(2);
        expect(state.messages[0].id).toBeTruthy();
        expect(state.messages[2].id).toBeTruthy();
    });

    it('所有消息有 ID 时返回 0', () => {
        state.messages = [
            { id: 'm1', role: 'user', parts: [] },
            { id: 'm2', role: 'assistant', parts: [] }
        ];
        const count = ensureMessageIds();
        expect(count).toBe(0);
    });

    it('有变更时重建 map 并设置 dirty', () => {
        state.messages = [{ role: 'user', parts: [] }];
        state.sessionDirty = false;
        ensureMessageIds();
        expect(state.sessionDirty).toBe(true);
        expect(state.messageIdMap.size).toBe(1);
    });

    it('空数组返回 0', () => {
        expect(ensureMessageIds()).toBe(0);
    });
});

// ========== rebuildMessageIdMap ==========

describe('rebuildMessageIdMap', () => {
    it('重建完整的 map', () => {
        state.messages = [
            { id: 'a', role: 'user', parts: [] },
            { id: 'b', role: 'assistant', parts: [] }
        ];
        // 注意：messageStore.replaceAll 内部已重建 idMap，rebuildMessageIdMap 调用是幂等的
        rebuildMessageIdMap();
        expect(state.messageIdMap).toBeInstanceOf(Map);
        expect(state.messageIdMap.get('a')).toBe(0);
        expect(state.messageIdMap.get('b')).toBe(1);
    });

    it('rebuild 后旧 id 被清除（store 内部 clear+重建）', () => {
        state.messages = [{ id: 'old', role: 'user', parts: [] }];
        // 直接 mutate 数组（绕过 store）触发 divergence，然后 rebuild 修复
        state.messageStore.messages.splice(0, 1, { id: 'new', role: 'user', parts: [] });
        rebuildMessageIdMap();
        expect(state.messageIdMap.has('old')).toBe(false);
        expect(state.messageIdMap.get('new')).toBe(0);
    });
});

// ========== setState ==========

describe('setState', () => {
    it('设置任意 state 属性', () => {
        setState('customField', 'value');
        expect(state.customField).toBe('value');
    });
});
