/**
 * Network 请求记录存储
 */

import { eventBus } from '../core/events.js';

const MAX_RECORDS = 50;
const MAX_SSE_CHUNKS = 5000;
let records = [];
let nextId = 1;

// 跨窗口同步（主窗口广播 → 子窗口接收）
// 协议：
//   replica-ready：子窗口启动时发起，主窗口收到立即推一份当前快照
//   records-sync：主窗口推送 records 数组给子窗口
const channel = new BroadcastChannel('network-panel-sync');
let isReplica = false;

function handleChannelMessage(e) {
    const type = e.data?.type;
    if (type === 'records-sync' && isReplica) {
        records = e.data.records;
        eventBus.emit('network:store-changed', records);
    } else if (type === 'replica-ready' && !isReplica) {
        // 子窗口请求快照：立即推一次当前 records，避免子窗口空等下一次变化才能拿到历史
        broadcastToReplicas();
    }
}

// 主窗口和子窗口共用同一个 handler，由 isReplica 标志决定如何响应
channel.onmessage = handleChannelMessage;

export function setReplicaMode(enabled) {
    isReplica = enabled;
    if (enabled) {
        // 通知主窗口"我准备好了，请把当前 records 推过来"
        try {
            channel.postMessage({ type: 'replica-ready' });
        } catch {
            /* 序列化或通道异常时忽略，下次 records 变化仍会自动同步 */
        }
    }
}

// 节流通知：SSE 流式期间高频 appendSSEChunk，避免每行都触发 UI 刷新
let notifyTimer = null;
const NOTIFY_THROTTLE_MS = 100;

export function createRecord(partial) {
    const record = {
        id: nextId++,
        startTime: performance.now(),
        endTime: null,
        method: 'POST',
        url: '',
        status: null,
        duration: null,
        size: null,
        requestHeaders: {},
        requestBody: null,
        responseHeaders: {},
        responseBody: null,
        sseChunks: [],
        isStream: false,
        state: 'pending',
        error: null,
        ...partial
    };
    records.push(record);
    if (records.length > MAX_RECORDS) records.shift();
    notifyImmediate();
    return record;
}

export function updateRecord(id, patch) {
    const record = records.find((r) => r.id === id);
    if (!record) return;
    Object.assign(record, patch);
    notifyImmediate();
    return record;
}

export function appendSSEChunk(id, chunk) {
    const record = records.find((r) => r.id === id);
    if (!record) return;
    if (record.sseChunks.length >= MAX_SSE_CHUNKS) {
        record.truncated = true;
        return;
    }
    record.sseChunks.push(chunk);
    record.size = (record.size || 0) + chunk.length;
    notifyThrottled();
}

export function getRecords() {
    return records;
}

export function clearRecords() {
    records = [];
    notifyImmediate();
}

export function subscribe(fn) {
    return eventBus.on('network:store-changed', fn);
}

function notifyImmediate() {
    if (notifyTimer) {
        clearTimeout(notifyTimer);
        notifyTimer = null;
    }
    eventBus.emit('network:store-changed', records);
    broadcastToReplicas();
}

function notifyThrottled() {
    if (notifyTimer) return;
    notifyTimer = setTimeout(() => {
        notifyTimer = null;
        eventBus.emit('network:store-changed', records);
        broadcastToReplicas();
    }, NOTIFY_THROTTLE_MS);
}

function broadcastToReplicas() {
    if (isReplica) return;
    try {
        channel.postMessage({ type: 'records-sync', records });
    } catch {
        /* 序列化失败时忽略 */
    }
}

export function sanitizeHeaderValue(key, value) {
    const sensitiveKeys = ['authorization', 'x-api-key', 'api-key', 'x-goog-api-key'];
    if (sensitiveKeys.includes(key.toLowerCase()) && value) {
        return value.length > 8 ? '***...' + value.slice(-4) : '***';
    }
    return value;
}
