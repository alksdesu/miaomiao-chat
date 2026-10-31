/**
 * 流式快照：流式生成期间把 partial 内容节流写入 IndexedDB，
 * 刷新/崩溃后启动时转成「已中断」错误消息追加回原会话，避免整条回复丢失。
 */

import { state } from '../core/state.js';
import { logger } from '../utils/logger.js';
import {
    STORES,
    getDB,
    saveToStore,
    deleteFromStore,
    loadAllFromStore,
    withDBLock
} from './indexeddb.js';
import { getCurrentProvider, getModelDisplayName } from '../api/current.js';
import { getTabId, probeTabs } from './tab-sync.js';

const SNAPSHOT_INTERVAL_MS = 4000;
const HEARTBEAT_INTERVAL_MS = 20000;
// 后台标签页的定时器可能被节流到每分钟一次，超出这个窗口的心跳才视为写入者已退出
const HEARTBEAT_STALE_MS = 3 * 60 * 1000;
const RECOVERY_LOCK_NAME = 'webchat-stream-snapshot-recovery';

// 每会话独立节流时间戳；写失败也计入间隔，warn 日志天然限频
const _lastWriteTs = new Map();
const _pendingWrites = new Map();
const _closedSnapshotKeys = new Set();
// 本页仍在写的快照，心跳定时器据此重写
const _openPayloads = new Map();
let _heartbeatTimer = null;
const MAX_CLOSED_KEYS = 512;

function closeSnapshotKey(snapshotKey) {
    _closedSnapshotKeys.add(snapshotKey);
    if (_closedSnapshotKeys.size > MAX_CLOSED_KEYS) {
        _closedSnapshotKeys.delete(_closedSnapshotKeys.values().next().value);
    }
}

function trackSnapshotWrite(snapshotKey, promise) {
    let pending = _pendingWrites.get(snapshotKey);
    if (!pending) {
        pending = new Set();
        _pendingWrites.set(snapshotKey, pending);
    }
    pending.add(promise);
    promise.finally(() => {
        pending.delete(promise);
        if (pending.size === 0) _pendingWrites.delete(snapshotKey);
    });
}

function hasSnapshotStore() {
    const db = getDB();
    return !!db && db.objectStoreNames.contains(STORES.STREAM_SNAPSHOTS);
}

function writeSnapshot(snapshotKey, payload) {
    const writePromise = saveToStore(STORES.STREAM_SNAPSHOTS, snapshotKey, payload).catch((e) => {
        logger.warn('[StreamSnapshot] 快照写入失败:', e);
    });
    trackSnapshotWrite(snapshotKey, writePromise);
}

/**
 * 流式停顿（服务端工具执行、长时间无新 token）时没有快照写入，定时补写心跳证明写入者仍在
 */
function refreshHeartbeats() {
    const now = Date.now();
    for (const [snapshotKey, payload] of _openPayloads) {
        if (now - (_lastWriteTs.get(snapshotKey) || 0) < HEARTBEAT_INTERVAL_MS) continue;
        _lastWriteTs.set(snapshotKey, now);
        writeSnapshot(snapshotKey, { ...payload, heartbeatAt: now });
    }
}

function ensureHeartbeatTimer() {
    if (_heartbeatTimer || _openPayloads.size === 0) return;
    _heartbeatTimer = setInterval(refreshHeartbeats, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeatTimerIfIdle() {
    if (!_heartbeatTimer || _openPayloads.size > 0) return;
    clearInterval(_heartbeatTimer);
    _heartbeatTimer = null;
}

/**
 * 节流写入流式快照（leading-edge：首帧立即写，之后每 SNAPSHOT_INTERVAL_MS 一次）。
 * 快照失败绝不能打断流式渲染，整体 try-catch 静默降级。
 * @param {string} sessionId - 流绑定的会话 ID
 * @param {string} textContent - 已累积正文
 * @param {string} thinkingContent - 已累积思维链
 */
export function saveStreamSnapshotThrottled(
    sessionId,
    textContent,
    thinkingContent,
    requestId = null,
    requestProfile = null
) {
    try {
        if (!sessionId || !hasSnapshotStore()) return;
        if (!textContent && !thinkingContent) return;
        const now = Date.now();
        const snapshotKey = requestId ? `${sessionId}:${requestId}` : sessionId;
        if (_closedSnapshotKeys.has(snapshotKey)) return;
        const last = _lastWriteTs.get(snapshotKey) || 0;
        if (now - last < SNAPSHOT_INTERVAL_MS) return;
        _lastWriteTs.set(snapshotKey, now);

        const provider = requestProfile ? null : getCurrentProvider();
        const payload = {
            streaming: true,
            sessionId,
            textContent: textContent || '',
            thinkingContent: thinkingContent || '',
            requestId,
            model:
                requestProfile?.modelDisplayName ||
                getModelDisplayName(state.selectedModel || '', provider),
            provider: requestProfile?.providerName || provider?.name || '',
            ts: now,
            ownerTabId: getTabId(),
            heartbeatAt: now
        };
        _openPayloads.set(snapshotKey, payload);
        ensureHeartbeatTimer();
        writeSnapshot(snapshotKey, payload);
    } catch (e) {
        logger.warn('[StreamSnapshot] 快照构建失败:', e);
    }
}

/**
 * 删除会话的流式快照（正常落库 / 错误落库 / 请求生命周期结束时调用）。
 * 仅当本 tab 写过该会话快照才发 IDB delete；启动残留由 recoverStreamSnapshots 负责。
 * @param {string|null} sessionId
 */
export function clearStreamSnapshot(sessionId, requestId = null) {
    if (!sessionId) return;
    const snapshotKey = requestId ? `${sessionId}:${requestId}` : sessionId;
    if (requestId) closeSnapshotKey(snapshotKey);
    _openPayloads.delete(snapshotKey);
    stopHeartbeatTimerIfIdle();
    const hadWrite = _lastWriteTs.delete(snapshotKey);
    if (!hadWrite || !hasSnapshotStore()) return;
    const pending = [...(_pendingWrites.get(snapshotKey) || [])];
    Promise.allSettled(pending)
        .then(() => deleteFromStore(STORES.STREAM_SNAPSHOTS, snapshotKey))
        .catch((e) => {
            logger.warn('[StreamSnapshot] 快照清理失败:', e);
        });
}

function isHeartbeatFresh(snap, now) {
    return now - (snap?.heartbeatAt || 0) < HEARTBEAT_STALE_MS;
}

/**
 * 对心跳仍在窗口内的其他标签页发一次存活探测
 * @returns {Promise<Set<string>|null>} 存活的写入者；null 表示无法探测，只能按心跳判断
 */
async function probeSnapshotWriters(records, now) {
    const candidates = new Set();
    for (const record of records) {
        const snap = record?.value;
        if (snap?.ownerTabId && snap.ownerTabId !== getTabId() && isHeartbeatFresh(snap, now)) {
            candidates.add(snap.ownerTabId);
        }
    }
    if (candidates.size === 0) return new Set();
    try {
        return await probeTabs([...candidates]);
    } catch (e) {
        logger.warn('[StreamSnapshot] 快照写入者存活探测失败:', e);
        return null;
    }
}

/**
 * 快照写入者是否仍在生成；没有写入者信息的旧快照按遗留快照处理
 */
function isWriterAlive(record, aliveTabs, now) {
    const snap = record?.value;
    const ownerTabId = snap?.ownerTabId;
    if (!ownerTabId) return false;
    if (ownerTabId === getTabId()) return _openPayloads.has(record.key);
    if (!isHeartbeatFresh(snap, now)) return false;
    return aliveTabs ? aliveTabs.has(ownerTabId) : true;
}

/**
 * 启动时恢复遗留快照：转为带「已中断（应用关闭）」错误标记的 assistant 消息
 * 追加到对应会话（IDB 路径，先于 switchToSession 执行），随后删除快照；
 * 写入者仍存活的快照原样保留，会话已不存在时直接丢弃。所有失败路径只 warn，不阻断会话加载。
 * 恢复写入走后台会话保存，保存后会广播 session-updated 让其他标签页刷新。
 */
export async function recoverStreamSnapshots() {
    try {
        if (!hasSnapshotStore()) return;
        // 多个标签页同时启动时串行恢复，后进入的读不到已删除的快照，避免重复追加中断消息
        await withDBLock(RECOVERY_LOCK_NAME, recoverOrphanedSnapshots);
    } catch (e) {
        logger.warn('[StreamSnapshot] 遗留快照恢复流程异常:', e);
    }
}

async function recoverOrphanedSnapshots() {
    let records;
    try {
        records = await loadAllFromStore(STORES.STREAM_SNAPSHOTS);
    } catch (e) {
        logger.warn('[StreamSnapshot] 遗留快照读取失败:', e);
        return;
    }
    if (!records || records.length === 0) return;

    const now = Date.now();
    const aliveTabs = await probeSnapshotWriters(records, now);
    const orphaned = records.filter((record) => !isWriterAlive(record, aliveTabs, now));
    if (orphaned.length < records.length) {
        logger.info(`[StreamSnapshot] 跳过 ${records.length - orphaned.length} 个仍在生成的快照`);
    }
    if (orphaned.length === 0) return;

    // 静态 import 会构成 stream-snapshot → sync → sessions → stream-snapshot 环，动态断开
    const [
        { saveAssistantMessageToBackground },
        { buildPartsFromStreamingState },
        { createMeta },
        { renderHumanizedError }
    ] = await Promise.all([
        import('../messages/sync.js'),
        import('../messages/parts-builder.js'),
        import('../messages/schema.js'),
        import('../utils/errors.js')
    ]);

    for (const record of orphaned) {
        const snapshotKey = record?.key;
        const snap = record?.value;
        const sessionId = snap?.sessionId || snapshotKey;
        if (!sessionId) continue;
        try {
            const hasContent = !!(snap?.streaming && (snap.textContent || snap.thinkingContent));
            if (hasContent && state.sessions.some((s) => s.id === sessionId)) {
                const parts = buildPartsFromStreamingState({
                    textContent: snap.textContent,
                    thinkingContent: snap.thinkingContent
                });
                const meta = createMeta({
                    model: snap.model || '',
                    provider: snap.provider || ''
                });
                const errorMessage = '已中断（应用关闭）';
                const errorHtml =
                    renderHumanizedError(
                        {
                            code: 'stream_interrupted',
                            message: errorMessage,
                            type: 'stream_interrupted'
                        },
                        null,
                        true
                    ) +
                    `<div class="stream-error-partial-save">\u{1F4BE} 已保存部分接收的内容</div>`;
                await saveAssistantMessageToBackground(sessionId, parts, meta, {
                    ts: snap.ts || Date.now(),
                    isError: true,
                    errorData: { code: 'stream_interrupted', message: errorMessage },
                    errorHtml
                });
                logger.info(`[StreamSnapshot] 已恢复中断的流式回复到会话 ${sessionId}`);
            }
        } catch (e) {
            logger.warn('[StreamSnapshot] 遗留快照恢复失败:', e);
        }
        try {
            await deleteFromStore(STORES.STREAM_SNAPSHOTS, snapshotKey);
        } catch (e) {
            logger.warn('[StreamSnapshot] 遗留快照删除失败:', e);
        }
    }
}
