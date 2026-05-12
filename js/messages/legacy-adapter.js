/**
 * 旧格式 → 新格式 运行时适配器
 *
 * migration.js 只在 v3→v4 跑一次；之后导入旧导出 / 漏迁的边缘数据仍可能是旧格式。
 * 此模块在 replaceAllMessages 入口统一升级，让运行时各层免去"hasParts 兜底"判断。
 */

import { isNewFormat, hasParts } from './schema.js';
import { migrateSession } from './migration.js';
import { logger } from '../utils/logger.js';
import { eventBus } from '../core/events.js';

// 单次升级达到此条数才弹通知，避免会话切换时少量升级的频繁打扰
const NOTIFY_THRESHOLD = 10;

/**
 * 把单条消息升级为新格式（已是新格式则原样返回）
 */
export function normalizeMessage(msg) {
    if (!msg || typeof msg !== 'object') return msg;
    if (isNewFormat(msg) || hasParts(msg)) return msg;

    try {
        const result = migrateSession([msg]);
        // tool 消息单独切片会被吞掉（合并到 assistant），无法单独升级时保持原样
        return result.messages.length > 0 ? result.messages[0] : msg;
    } catch (err) {
        logger.error('[legacy-adapter] normalizeMessage 失败:', err);
        return msg;
    }
}

/**
 * 批量 in-place 升级数组，返回升级数量
 */
export function normalizeAllMessages(messages) {
    if (!Array.isArray(messages)) return 0;

    let upgraded = 0;
    for (let i = 0; i < messages.length; i++) {
        const m = messages[i];
        if (!m || isNewFormat(m) || hasParts(m)) continue;

        const newMsg = normalizeMessage(m);
        if (newMsg !== m) {
            messages[i] = newMsg;
            upgraded++;
        }
    }

    if (upgraded > 0) {
        logger.info(`[legacy-adapter] 已升级 ${upgraded}/${messages.length} 条旧格式消息`);
        if (upgraded >= NOTIFY_THRESHOLD) {
            eventBus.emit('ui:notification', {
                message: `已自动升级 ${upgraded} 条旧格式消息`,
                type: 'info',
                duration: 5000
            });
        }
    }
    return upgraded;
}
