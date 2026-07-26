/**
 * 流式快照：流式生成期间把 partial 内容节流写入 IndexedDB，
 * 刷新/崩溃后启动时转成「已中断」错误消息追加回原会话，避免整条回复丢失。
 */

import { state } from '../core/state.js';
import { logger } from '../utils/logger.js';
import { STORES, getDB, saveToStore, deleteFromStore, loadAllFromStore } from './indexeddb.js';
import { getCurrentProvider, getModelDisplayName } from '../api/current.js';

const SNAPSHOT_INTERVAL_MS = 4000;

// 每会话独立节流时间戳；写失败也计入间隔，warn 日志天然限频
const _lastWriteTs = new Map();

function hasSnapshotStore() {
    const db = getDB();
    return !!db && db.objectStoreNames.contains(STORES.STREAM_SNAPSHOTS);
}

/**
 * 节流写入流式快照（leading-edge：首帧立即写，之后每 SNAPSHOT_INTERVAL_MS 一次）。
 * 快照失败绝不能打断流式渲染，整体 try-catch 静默降级。
 * @param {string} sessionId - 流绑定的会话 ID
 * @param {string} textContent - 已累积正文
 * @param {string} thinkingContent - 已累积思维链
 */
export function saveStreamSnapshotThrottled(sessionId, textContent, thinkingContent) {
    try {
        if (!sessionId || !hasSnapshotStore()) return;
        if (!textContent && !thinkingContent) return;
        const now = Date.now();
        const last = _lastWriteTs.get(sessionId) || 0;
        if (now - last < SNAPSHOT_INTERVAL_MS) return;
        _lastWriteTs.set(sessionId, now);

        const provider = getCurrentProvider();
        const payload = {
            streaming: true,
            sessionId,
            textContent: textContent || '',
            thinkingContent: thinkingContent || '',
            model: getModelDisplayName(state.selectedModel || '', provider),
            provider: provider?.name || '',
            ts: now
        };
        saveToStore(STORES.STREAM_SNAPSHOTS, sessionId, payload).catch((e) => {
            logger.warn('[StreamSnapshot] 快照写入失败:', e);
        });
    } catch (e) {
        logger.warn('[StreamSnapshot] 快照构建失败:', e);
    }
}

/**
 * 删除会话的流式快照（正常落库 / 错误落库 / 请求生命周期结束时调用）。
 * 仅当本 tab 写过该会话快照才发 IDB delete；启动残留由 recoverStreamSnapshots 负责。
 * @param {string|null} sessionId
 */
export function clearStreamSnapshot(sessionId) {
    if (!sessionId) return;
    const hadWrite = _lastWriteTs.delete(sessionId);
    if (!hadWrite || !hasSnapshotStore()) return;
    deleteFromStore(STORES.STREAM_SNAPSHOTS, sessionId).catch((e) => {
        logger.warn('[StreamSnapshot] 快照清理失败:', e);
    });
}

/**
 * 启动时恢复遗留快照：转为带「已中断（应用关闭）」错误标记的 assistant 消息
 * 追加到对应会话（IDB 路径，先于 switchToSession 执行），随后删除快照；
 * 会话已不存在时直接丢弃。所有失败路径只 warn，不阻断会话加载。
 */
export async function recoverStreamSnapshots() {
    try {
        if (!hasSnapshotStore()) return;
        let records;
        try {
            records = await loadAllFromStore(STORES.STREAM_SNAPSHOTS);
        } catch (e) {
            logger.warn('[StreamSnapshot] 遗留快照读取失败:', e);
            return;
        }
        if (!records || records.length === 0) return;

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

        for (const record of records) {
            const sessionId = record?.key;
            const snap = record?.value;
            if (!sessionId) continue;
            try {
                const hasContent = !!(
                    snap?.streaming &&
                    (snap.textContent || snap.thinkingContent)
                );
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
                await deleteFromStore(STORES.STREAM_SNAPSHOTS, sessionId);
            } catch (e) {
                logger.warn('[StreamSnapshot] 遗留快照删除失败:', e);
            }
        }
    } catch (e) {
        logger.warn('[StreamSnapshot] 遗留快照恢复流程异常:', e);
    }
}
