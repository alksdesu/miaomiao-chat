/**
 * MessageStore — state.messages 旁路封装（experimental，Stage 5b C3 引入）
 *
 * 包住外部传入的数组引用 + 私有 #idMap，提供 O(1) findById/findIndexById/findByEl
 * 等 store API。所有写方法保持内部数组引用稳定（splice 原地改），让外部 state.messages
 * 持有的同一引用永远有效，避免双源 divergence。
 *
 * 暂未接入 state.js，仅文件存在 + 单测覆盖；C4 commit 才会让 state-mutations 内部
 * 转发到 store。
 */

import { generateMessageId } from '../utils/helpers.js';

export class MessageStore {
    #arr;
    #idMap;
    #devThrow;

    /**
     * @param {Array} initialArr - 必传：外部数组引用，store 全程 mutate 这一份
     * @param {Object} [options]
     * @param {boolean} [options.devThrow=false] - findIndexById fallback 命中时是否 throw
     */
    constructor(initialArr = [], { devThrow = false } = {}) {
        if (!Array.isArray(initialArr)) {
            throw new TypeError('MessageStore: initialArr 必须是 Array');
        }
        this.#arr = initialArr;
        this.#idMap = new Map();
        this.#devThrow = !!devThrow;
        this.rebuildIdMap();
    }

    // ========== 只读 ==========

    /** 返回内部数组引用（与外部持有的 state.messages 同一引用，绝不替换） */
    get messages() {
        return this.#arr;
    }

    get length() {
        return this.#arr.length;
    }

    /** 私有 idMap 只读 view —— 双轨期暴露给 state.messageIdMap alias */
    get idMap() {
        return this.#idMap;
    }

    // ========== 写入 ==========

    /**
     * 追加消息，返回新 index
     * 缺 id 时调 generateMessageId 自动补，避免无 id 消息进 store 永久找不到
     */
    push(msg) {
        if (!msg || typeof msg !== 'object') {
            throw new TypeError('MessageStore.push: msg 必须是对象');
        }
        if (!msg.id) msg.id = generateMessageId();
        this.#arr.push(msg);
        const index = this.#arr.length - 1;
        this.#idMap.set(msg.id, index);
        return index;
    }

    /** 弹出末尾消息，自动清 idMap */
    pop() {
        const msg = this.#arr.pop();
        if (msg?.id) this.#idMap.delete(msg.id);
        return msg;
    }

    /**
     * splice 包装：维护受影响区间 idMap
     * 注意：本签名禁用第 4+ 参数（避免任意 reshape 让 idMap 难维护）
     */
    splice(start, deleteCount = 0, ...items) {
        const removed = this.#arr.splice(start, deleteCount, ...items);
        // 删除项清 idMap
        for (const m of removed) {
            if (m?.id) this.#idMap.delete(m.id);
        }
        // 受影响区间（start 到末尾）整段重建（位置可能整体移位）
        this.#rebuildRange(start);
        return removed;
    }

    /** 替换指定索引（delete oldId, set newId） */
    replaceAt(index, newMsg) {
        if (index < 0 || index >= this.#arr.length) return;
        if (!newMsg || typeof newMsg !== 'object') {
            throw new TypeError('MessageStore.replaceAt: newMsg 必须是对象');
        }
        const old = this.#arr[index];
        if (old?.id) this.#idMap.delete(old.id);
        if (!newMsg.id) newMsg.id = generateMessageId();
        this.#arr[index] = newMsg;
        this.#idMap.set(newMsg.id, index);
    }

    /**
     * 部分字段合并更新；若 id 变更则 delete+set
     * 与 state-mutations.updateMessageAt 契约一致（spread merge）
     */
    updateAt(index, partial) {
        if (index < 0 || index >= this.#arr.length) return;
        const old = this.#arr[index];
        const merged = { ...old, ...partial };
        if (old.id !== merged.id) {
            if (old.id) this.#idMap.delete(old.id);
            if (!merged.id) merged.id = generateMessageId();
            this.#idMap.set(merged.id, index);
        }
        this.#arr[index] = merged;
    }

    /** 删除 fromIndex 之后的所有消息（fromIndex 本身保留） */
    removeRangeAfter(fromIndex) {
        if (fromIndex < 0) return;
        const removeCount = Math.max(0, this.#arr.length - fromIndex - 1);
        if (removeCount === 0) return;
        // 收集要删的 id 后 splice
        for (let i = fromIndex + 1; i < this.#arr.length; i++) {
            const id = this.#arr[i]?.id;
            if (id) this.#idMap.delete(id);
        }
        this.#arr.splice(fromIndex + 1, removeCount);
    }

    /** 清空数组与 idMap，保持引用不变 */
    clear() {
        this.#arr.length = 0;
        this.#idMap.clear();
    }

    /**
     * 整体替换：原地 splice + 全量重建 idMap，保持引用不变（避免外部缓存悬空）
     * @param {Array} newArr
     */
    replaceAll(newArr) {
        if (!Array.isArray(newArr)) {
            throw new TypeError('MessageStore.replaceAll: newArr 必须是 Array');
        }
        // splice(0, length, ...newArr) 原地 reset 并赋新值
        this.#arr.splice(0, this.#arr.length, ...newArr);
        this.rebuildIdMap();
    }

    /** 测试专用：等价 replaceAll 但语义化标记 fixture 加载 */
    loadFixture(arr) {
        this.replaceAll(arr);
    }

    // ========== 查询 ==========

    /**
     * O(1) id → message
     * @param {string} id
     * @returns {Object|undefined}
     */
    findById(id) {
        if (!id) return undefined;
        const idx = this.findIndexById(id);
        return idx >= 0 ? this.#arr[idx] : undefined;
    }

    /**
     * O(1) id → index；缺失时 fallback findIndex 自愈 + 可选 throw
     * @param {string} id
     * @returns {number} -1 表示未找到
     */
    findIndexById(id) {
        if (!id) return -1;
        if (this.#idMap.has(id)) return this.#idMap.get(id);

        // fallback：扫数组，命中则自愈写回 idMap
        const idx = this.#arr.findIndex((m) => m?.id === id);
        if (idx >= 0) {
            this.#idMap.set(id, idx);
            if (this.#devThrow) {
                throw new Error(
                    `MessageStore: idMap 与 messages 数组 divergence（id=${id}，fallback 命中 index=${idx}），上游可能漏调 mutator`
                );
            }
        }
        return idx;
    }

    /**
     * 三处 resolveMessageIndex 统一入口：DOM element → {msg, index}
     *
     * 优先级：messageId (dataset.messageId) → messageIndex (dataset.messageIndex)
     * → DOM 在 messagesArea 中的位置（最后兜底）
     *
     * @param {HTMLElement} messageEl
     * @param {Object} [opts]
     * @param {HTMLElement} [opts.messagesArea] - DOM fallback 时的容器，默认 #chat
     * @returns {{msg: Object, index: number} | null}
     */
    findByEl(messageEl, { messagesArea } = {}) {
        if (!messageEl) return null;

        // 1. dataset.messageId
        const messageId = messageEl.dataset?.messageId;
        if (messageId) {
            const idx = this.findIndexById(messageId);
            if (idx >= 0) return { msg: this.#arr[idx], index: idx };
        }

        // 2. dataset.messageIndex（注意可能脏，需对比 id 验证一次）
        const indexAttr = messageEl.dataset?.messageIndex;
        if (indexAttr !== undefined) {
            const parsed = parseInt(indexAttr, 10);
            if (!Number.isNaN(parsed) && parsed >= 0 && parsed < this.#arr.length) {
                const msg = this.#arr[parsed];
                // 若 dataset.messageId 存在且与 msg.id 不符（删除/重排后 dataset 未更新），降级走 DOM
                if (!messageId || msg?.id === messageId) {
                    return { msg, index: parsed };
                }
            }
        }

        // 3. DOM 位置兜底（非浏览器环境如 vitest node 默认下 document 不存在，防御性兜底）
        // 默认容器 id 与 index.html '#messages' 对齐（旧 'chat' 是死链 bug）
        const area =
            messagesArea ||
            (typeof document !== 'undefined' ? document.getElementById('messages') : null);
        if (area) {
            const nodes = Array.from(area.querySelectorAll('.message'));
            const domIndex = nodes.indexOf(messageEl);
            if (domIndex >= 0 && domIndex < this.#arr.length) {
                return { msg: this.#arr[domIndex], index: domIndex };
            }
        }

        return null;
    }

    // ========== idMap 维护 ==========

    /** 全量重建 idMap（import / restore / 手动 fixture 加载用） */
    rebuildIdMap() {
        this.#idMap.clear();
        for (let i = 0; i < this.#arr.length; i++) {
            const id = this.#arr[i]?.id;
            if (id) this.#idMap.set(id, i);
        }
    }

    /** 内部：重建 fromIndex 起的区间 idMap（splice 后调用） */
    #rebuildRange(fromIndex) {
        for (let i = fromIndex; i < this.#arr.length; i++) {
            const id = this.#arr[i]?.id;
            if (id) this.#idMap.set(id, i);
        }
    }

    // ========== 序列化 ==========

    /** 返回内部数组浅拷贝（structuredClone / IDB put 入口用） */
    toArray() {
        return this.#arr.slice();
    }

    /** JSON.stringify(store) 走这里 */
    toJSON() {
        return this.#arr.slice();
    }
}
