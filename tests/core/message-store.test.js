/**
 * MessageStore 单元测试（Stage 5b C3）
 *
 * 覆盖：构造/push/pop/splice/replaceAt/updateAt/removeRangeAfter/clear/replaceAll/
 *      findById/findIndexById/findByEl/rebuildIdMap/toArray/toJSON/devThrow
 *
 * 重点验证：内部数组引用稳定性（replaceAll/clear 不替换实例）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../js/utils/helpers.js', () => {
    let counter = 0;
    return {
        generateMessageId: () => `msg_auto_${++counter}`
    };
});

import { MessageStore } from '../../js/core/message-store.js';

const mkMsg = (id, role = 'user', text = '') => ({
    id,
    role,
    parts: text ? [{ type: 'text', text }] : []
});

describe('MessageStore', () => {
    let arr;
    let store;

    beforeEach(() => {
        arr = [];
        store = new MessageStore(arr);
    });

    describe('constructor', () => {
        it('接收外部数组引用且持有同一引用', () => {
            const ext = [mkMsg('a'), mkMsg('b')];
            const s = new MessageStore(ext);
            expect(s.messages).toBe(ext); // 同一引用
            expect(s.length).toBe(2);
        });

        it('非数组抛 TypeError', () => {
            expect(() => new MessageStore(null)).toThrow(TypeError);
            expect(() => new MessageStore({})).toThrow(TypeError);
            expect(() => new MessageStore('str')).toThrow(TypeError);
        });

        it('初始 idMap 全量建立', () => {
            const ext = [mkMsg('a'), mkMsg('b'), mkMsg('c')];
            const s = new MessageStore(ext);
            expect(s.findIndexById('a')).toBe(0);
            expect(s.findIndexById('b')).toBe(1);
            expect(s.findIndexById('c')).toBe(2);
        });
    });

    describe('push', () => {
        it('追加消息并返回 index', () => {
            expect(store.push(mkMsg('a'))).toBe(0);
            expect(store.push(mkMsg('b'))).toBe(1);
            expect(store.length).toBe(2);
            expect(store.findIndexById('a')).toBe(0);
            expect(store.findIndexById('b')).toBe(1);
        });

        it('无 id 自动补 id', () => {
            const msg = { role: 'user', parts: [] };
            store.push(msg);
            expect(msg.id).toMatch(/^msg_auto_/);
            expect(store.findIndexById(msg.id)).toBe(0);
        });

        it('null/非对象抛 TypeError', () => {
            expect(() => store.push(null)).toThrow(TypeError);
            expect(() => store.push('str')).toThrow(TypeError);
        });

        it('外部数组同步反映 push', () => {
            store.push(mkMsg('a'));
            expect(arr.length).toBe(1);
            expect(arr[0].id).toBe('a');
        });
    });

    describe('pop', () => {
        it('弹出末尾且清 idMap', () => {
            store.push(mkMsg('a'));
            store.push(mkMsg('b'));
            const popped = store.pop();
            expect(popped.id).toBe('b');
            expect(store.length).toBe(1);
            expect(store.findIndexById('b')).toBe(-1);
            expect(store.findIndexById('a')).toBe(0);
        });

        it('空数组 pop 返 undefined', () => {
            expect(store.pop()).toBeUndefined();
        });
    });

    describe('splice', () => {
        beforeEach(() => {
            store.push(mkMsg('a'));
            store.push(mkMsg('b'));
            store.push(mkMsg('c'));
            store.push(mkMsg('d'));
        });

        it('中间删除：移除项 idMap 清除，后续项 index 重建', () => {
            const removed = store.splice(1, 2);
            expect(removed.map((m) => m.id)).toEqual(['b', 'c']);
            expect(store.findIndexById('b')).toBe(-1);
            expect(store.findIndexById('c')).toBe(-1);
            expect(store.findIndexById('a')).toBe(0);
            expect(store.findIndexById('d')).toBe(1); // 从 3 移到 1
        });

        it('插入：新项 idMap 建立，后续项 index 重建', () => {
            store.splice(1, 0, mkMsg('x'), mkMsg('y'));
            expect(store.length).toBe(6);
            expect(store.findIndexById('a')).toBe(0);
            expect(store.findIndexById('x')).toBe(1);
            expect(store.findIndexById('y')).toBe(2);
            expect(store.findIndexById('b')).toBe(3); // 从 1 移到 3
            expect(store.findIndexById('d')).toBe(5);
        });
    });

    describe('replaceAt', () => {
        it('删除旧 id，建立新 id 映射', () => {
            store.push(mkMsg('a'));
            store.push(mkMsg('b'));
            store.replaceAt(0, mkMsg('a2'));
            expect(store.findIndexById('a')).toBe(-1);
            expect(store.findIndexById('a2')).toBe(0);
            expect(store.findIndexById('b')).toBe(1);
        });

        it('越界 index 静默忽略', () => {
            store.push(mkMsg('a'));
            store.replaceAt(5, mkMsg('x'));
            expect(store.length).toBe(1);
            expect(store.findIndexById('x')).toBe(-1);
        });
    });

    describe('updateAt', () => {
        it('id 不变时 idMap 不动', () => {
            store.push(mkMsg('a', 'user', 'old'));
            store.updateAt(0, { parts: [{ type: 'text', text: 'new' }] });
            expect(store.findIndexById('a')).toBe(0);
            expect(store.messages[0].parts[0].text).toBe('new');
        });

        it('id 变更时 delete+set', () => {
            store.push(mkMsg('a'));
            store.updateAt(0, { id: 'a2' });
            expect(store.findIndexById('a')).toBe(-1);
            expect(store.findIndexById('a2')).toBe(0);
        });

        it('partial spread merge 保留其他字段', () => {
            store.push({ id: 'a', role: 'user', meta: { model: 'gpt-4' }, parts: [] });
            store.updateAt(0, { role: 'assistant' });
            expect(store.messages[0].role).toBe('assistant');
            expect(store.messages[0].meta.model).toBe('gpt-4');
        });
    });

    describe('removeRangeAfter', () => {
        beforeEach(() => {
            ['a', 'b', 'c', 'd'].forEach((id) => store.push(mkMsg(id)));
        });

        it('保留 fromIndex 本身，清除之后所有', () => {
            store.removeRangeAfter(1);
            expect(store.length).toBe(2);
            expect(store.findIndexById('a')).toBe(0);
            expect(store.findIndexById('b')).toBe(1);
            expect(store.findIndexById('c')).toBe(-1);
            expect(store.findIndexById('d')).toBe(-1);
        });

        it('fromIndex 为末尾时 noop', () => {
            store.removeRangeAfter(3);
            expect(store.length).toBe(4);
        });

        it('fromIndex 负数静默返回', () => {
            store.removeRangeAfter(-1);
            expect(store.length).toBe(4);
        });
    });

    describe('clear', () => {
        it('清空但保持数组引用不变（关键！）', () => {
            store.push(mkMsg('a'));
            store.push(mkMsg('b'));
            const refBefore = store.messages;
            store.clear();
            expect(store.length).toBe(0);
            expect(store.messages).toBe(refBefore); // 同一引用
            expect(store.findIndexById('a')).toBe(-1);
            expect(arr.length).toBe(0); // 外部数组同步清空
        });
    });

    describe('replaceAll', () => {
        it('整体替换但保持数组引用不变', () => {
            store.push(mkMsg('a'));
            const refBefore = store.messages;
            store.replaceAll([mkMsg('x'), mkMsg('y'), mkMsg('z')]);
            expect(store.messages).toBe(refBefore); // 同一引用
            expect(store.length).toBe(3);
            expect(store.findIndexById('a')).toBe(-1);
            expect(store.findIndexById('x')).toBe(0);
            expect(store.findIndexById('z')).toBe(2);
        });

        it('外部数组同步反映', () => {
            store.push(mkMsg('a'));
            store.replaceAll([mkMsg('x')]);
            expect(arr.length).toBe(1);
            expect(arr[0].id).toBe('x');
        });

        it('非数组抛 TypeError', () => {
            expect(() => store.replaceAll(null)).toThrow(TypeError);
            expect(() => store.replaceAll({})).toThrow(TypeError);
        });
    });

    describe('loadFixture', () => {
        it('等价 replaceAll', () => {
            store.loadFixture([mkMsg('x'), mkMsg('y')]);
            expect(store.length).toBe(2);
            expect(store.findIndexById('x')).toBe(0);
        });
    });

    describe('findById / findIndexById', () => {
        beforeEach(() => {
            ['a', 'b', 'c'].forEach((id) => store.push(mkMsg(id)));
        });

        it('findById 返回完整 msg 对象', () => {
            const msg = store.findById('b');
            expect(msg.id).toBe('b');
            expect(msg).toBe(store.messages[1]);
        });

        it('findById 未找到返 undefined', () => {
            expect(store.findById('zzz')).toBeUndefined();
            expect(store.findById('')).toBeUndefined();
            expect(store.findById(null)).toBeUndefined();
        });

        it('findIndexById 未找到返 -1', () => {
            expect(store.findIndexById('zzz')).toBe(-1);
            expect(store.findIndexById('')).toBe(-1);
        });

        it('idMap 不一致时 fallback 自愈', () => {
            // 模拟 divergence：直接 mutate idMap 删除 'b'
            store.idMap.delete('b');
            expect(store.findIndexById('b')).toBe(1); // fallback 走 findIndex
            expect(store.idMap.has('b')).toBe(true); // 自愈写回
        });

        it('devThrow=true 时 fallback 命中抛错', () => {
            const ext = [mkMsg('a'), mkMsg('b')];
            const s = new MessageStore(ext, { devThrow: true });
            s.idMap.delete('b');
            expect(() => s.findIndexById('b')).toThrow(/divergence/);
        });
    });

    describe('findByEl', () => {
        beforeEach(() => {
            ['a', 'b', 'c'].forEach((id) => store.push(mkMsg(id)));
        });

        it('优先用 dataset.messageId', () => {
            const el = { dataset: { messageId: 'b' } };
            const result = store.findByEl(el);
            expect(result.index).toBe(1);
            expect(result.msg.id).toBe('b');
        });

        it('fallback 用 dataset.messageIndex 并校验 id 一致', () => {
            const el = { dataset: { messageIndex: '2' } };
            const result = store.findByEl(el);
            expect(result.index).toBe(2);
            expect(result.msg.id).toBe('c');
        });

        it('dataset.messageId 与 messageIndex 冲突时走 DOM 兜底', () => {
            // messageId 找不到时不能信 messageIndex（可能脏）
            const el = {
                dataset: { messageId: 'stale-id', messageIndex: '0' }
            };
            // findIndexById('stale-id') = -1，messageIndex 0 但 msg.id='a' 不等于 'stale-id' → 降级
            const result = store.findByEl(el, { messagesArea: null });
            // 没有 messagesArea 且 fallback 失败 → null
            expect(result).toBeNull();
        });

        it('messageEl 为 null 返 null', () => {
            expect(store.findByEl(null)).toBeNull();
        });
    });

    describe('rebuildIdMap', () => {
        it('全量重建', () => {
            arr.push(mkMsg('a'));
            arr.push(mkMsg('b'));
            // 此时 store 不知道，idMap 仍为空
            expect(store.findIndexById('a')).toBe(0); // findIndex 自愈写回
            // 显式重建确认行为
            store.idMap.clear();
            store.rebuildIdMap();
            expect(store.findIndexById('a')).toBe(0);
            expect(store.findIndexById('b')).toBe(1);
        });

        it('跳过无 id 的项', () => {
            arr.push({ role: 'user' }); // 无 id
            arr.push(mkMsg('b'));
            store.rebuildIdMap();
            expect(store.findIndexById('b')).toBe(1);
            expect(store.idMap.size).toBe(1);
        });
    });

    describe('toArray / toJSON', () => {
        beforeEach(() => {
            store.push(mkMsg('a'));
            store.push(mkMsg('b'));
        });

        it('toArray 返浅拷贝（不同引用，元素相同）', () => {
            const copy = store.toArray();
            expect(copy).not.toBe(store.messages);
            expect(copy.length).toBe(2);
            expect(copy[0]).toBe(store.messages[0]); // 元素仍是同一引用
        });

        it('JSON.stringify 走 toJSON', () => {
            const json = JSON.stringify(store);
            const parsed = JSON.parse(json);
            expect(parsed.length).toBe(2);
            expect(parsed[0].id).toBe('a');
        });
    });

    describe('引用稳定性（关键不变量）', () => {
        it('clear / replaceAll / push / splice / pop 全程内部数组引用不变', () => {
            const ref = store.messages;
            store.push(mkMsg('a'));
            expect(store.messages).toBe(ref);
            store.push(mkMsg('b'));
            expect(store.messages).toBe(ref);
            store.splice(0, 1);
            expect(store.messages).toBe(ref);
            store.pop();
            expect(store.messages).toBe(ref);
            store.replaceAll([mkMsg('x'), mkMsg('y')]);
            expect(store.messages).toBe(ref);
            store.clear();
            expect(store.messages).toBe(ref);
        });

        it('外部缓存的数组引用始终与 store.messages 同步', () => {
            const externalRef = arr; // beforeEach 时持有的外部引用
            store.push(mkMsg('a'));
            store.replaceAll([mkMsg('x')]);
            expect(externalRef).toBe(store.messages); // 外部引用永不悬空
            expect(externalRef[0].id).toBe('x');
        });
    });
});
