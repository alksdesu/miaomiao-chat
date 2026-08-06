/**
 * 启动时数据格式迁移门控
 *
 * 检查 preferences 中的 schema_version，如果低于当前版本，
 * 遍历所有会话将旧三格式消息转换为新 parts[] 格式，
 * 并显示全屏进度遮罩。
 */

import { SCHEMA_VERSION } from '../messages/schema.js';
import { validateMigration } from '../messages/migration.js';
import { normalizeSessionRecord } from '../messages/compat/gateway.js';
import { CompatibilityStatus } from '../messages/compat/result.js';
import { validateMessages } from '../messages/schema.js';
import {
    loadAllSessionsFromDB,
    loadSessionMessages,
    saveSessionMessages,
    savePreference,
    loadPreference
} from './storage.js';
import { logger } from '../utils/logger.js';

const PREF_KEY = 'message_schema_version';
const LOCK_NAME = 'webchat-schema-migration';

/**
 * 如果需要，执行数据迁移。在 init() 中 loadSessions() 之前调用。
 * 使用 navigator.locks 防止多 tab 并发迁移。
 */
export async function runMigrationIfNeeded() {
    const result = { migrated: false, count: 0, errors: [] };

    let currentVersion;
    try {
        currentVersion = await loadPreference(PREF_KEY);
    } catch {
        currentVersion = null;
    }

    if (currentVersion >= SCHEMA_VERSION) {
        return result;
    }

    // 跨 tab 并发锁（30 秒超时防止卡死）
    if (navigator.locks) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 30000);
        try {
            return await navigator.locks.request(LOCK_NAME, { signal: controller.signal }, () =>
                doMigration(result)
            );
        } catch (e) {
            if (e.name === 'AbortError') {
                logger.warn('[migration-gate] 等待锁超时（30s），直接执行迁移');
                return doMigration(result);
            }
            throw e;
        } finally {
            clearTimeout(timer);
        }
    }
    return doMigration(result);
}

async function doMigration(result) {
    // 锁内再次检查（另一个 tab 可能已完成迁移）
    let currentVersion;
    try {
        currentVersion = await loadPreference(PREF_KEY);
    } catch {
        currentVersion = null;
    }
    if (currentVersion >= SCHEMA_VERSION) {
        return result;
    }

    let sessions;
    try {
        sessions = await loadAllSessionsFromDB();
    } catch (err) {
        logger.error('[migration-gate] 无法加载会话列表:', err);
        result.errors.push({ sessionId: null, error: err.message });
        return result;
    }

    if (!sessions || sessions.length === 0) {
        try {
            await savePreference(PREF_KEY, SCHEMA_VERSION);
        } catch (e) {
            logger.warn('[migration-gate] 版本号保存失败:', e);
        }
        return result;
    }

    const overlay = createProgressOverlay();
    document.body.appendChild(overlay);

    let completed = 0;
    const total = sessions.length;
    let fatalErrors = 0; // 致命错误（迁移/保存失败），阻止版本号更新

    for (const session of sessions) {
        completed++;
        // 每 10 个 session 顶部主动 yield：跳过分支（已迁移/空）也需让出主线程，
        // pref 写失败后启动重跑场景下 1000 个会话 continue 跳过 yield 仍会冻结
        if (completed % 10 === 0) {
            await yieldToMain();
        }
        updateProgress(overlay, completed, total, session.name || session.id);

        try {
            let msgData = await loadSessionMessages(session.id);

            // 兼容 v3 未迁移数据：messages store 为空时回退到 session._pendingMessages
            if (
                (!msgData || !msgData.messages || msgData.messages.length === 0) &&
                session._pendingMessages
            ) {
                msgData = { messages: session._pendingMessages };
            }

            if (!msgData || !msgData.messages || msgData.messages.length === 0) {
                continue;
            }

            const compatibility = normalizeSessionRecord(
                {
                    sessionId: session.id,
                    messages: msgData.messages,
                    geminiContents: msgData.geminiContents || [],
                    claudeContents: msgData.claudeContents || [],
                    messageSchemaVersion: msgData.messageSchemaVersion
                },
                { source: 'startup-migration' }
            );
            if (compatibility.status === CompatibilityStatus.FAILED) {
                throw new Error(`会话 ${session.id} 迁移后仍不符合标准消息结构`);
            }
            if (!compatibility.writeBackRequired) continue;

            const countCheck = validateMigration(
                msgData.messages.length,
                compatibility.messages.length,
                compatibility.toolMessageCount
            );

            if (!countCheck.valid) {
                logger.warn(`[migration-gate] 会话 ${session.id} 数量校验失败:`, countCheck.error);
            }

            const validation = validateMessages(compatibility.messages);
            if (!validation.valid) {
                logger.warn(
                    `[migration-gate] 会话 ${session.id} 有 ${validation.errors.length} 条消息校验警告`
                );
                // 校验 warning 记录但不阻止版本号更新
            }

            await saveSessionMessages(session.id, {
                messages: compatibility.messages,
                messageSchemaVersion: compatibility.targetVersion
            });

            result.count++;

            if (compatibility.errors.length > 0) {
                result.errors.push({
                    sessionId: session.id,
                    errors: compatibility.errors
                });
                // 单条消息的降级恢复不是致命错误
            }

            // 每个会话后让出主线程
            await yieldToMain();
        } catch (err) {
            logger.error(`[migration-gate] 会话 ${session.id} 迁移失败:`, err);
            result.errors.push({ sessionId: session.id, error: err.message });
            fatalErrors++;
        }
    }

    // 只有致命错误（迁移/保存异常）才阻止版本号更新
    // 校验 warning 和降级处理不阻止，否则每次启动都重复迁移
    if (fatalErrors === 0) {
        try {
            await savePreference(PREF_KEY, SCHEMA_VERSION);
        } catch (e) {
            logger.warn('[migration-gate] 版本号保存失败，下次启动将重新迁移:', e);
        }
    } else {
        logger.warn(`[migration-gate] ${fatalErrors} 个会话迁移失败，不更新版本号，下次启动将重试`);
    }

    overlay.remove();

    result.migrated = true;
    logger.debug(
        `[migration-gate] 迁移完成: ${result.count}/${total} 个会话，${result.errors.length} 个错误`
    );

    return result;
}

function yieldToMain() {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

function createProgressOverlay() {
    const overlay = document.createElement('div');
    overlay.id = 'migration-overlay';
    // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
    overlay.innerHTML = `
        <style>
            #migration-overlay {
                position: fixed;
                inset: 0;
                z-index: 99999;
                display: flex;
                align-items: center;
                justify-content: center;
                background: rgba(0, 0, 0, 0.85);
                font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', '微软雅黑', sans-serif;
            }
            #migration-overlay .migration-card {
                background: #1a1a2e;
                border-radius: 16px;
                padding: 40px 48px;
                text-align: center;
                max-width: 420px;
                width: 90%;
                box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
            }
            #migration-overlay .migration-title {
                color: #e0e0e0;
                font-size: 20px;
                font-weight: 600;
                margin: 0 0 8px;
            }
            #migration-overlay .migration-subtitle {
                color: #888;
                font-size: 14px;
                margin: 0 0 24px;
            }
            #migration-overlay .migration-progress-bar {
                width: 100%;
                height: 6px;
                background: #2a2a3e;
                border-radius: 3px;
                overflow: hidden;
                margin-bottom: 12px;
            }
            #migration-overlay .migration-progress-fill {
                height: 100%;
                background: linear-gradient(90deg, #9168c0, #a8c7fa);
                border-radius: 3px;
                transition: width 0.3s ease;
                width: 0%;
            }
            #migration-overlay .migration-status {
                color: #aaa;
                font-size: 13px;
                margin: 0;
            }
        </style>
        <div class="migration-card">
            <p class="migration-title">数据格式升级中</p>
            <p class="migration-subtitle">请勿关闭页面</p>
            <div class="migration-progress-bar">
                <div class="migration-progress-fill"></div>
            </div>
            <p class="migration-status">准备中...</p>
        </div>
    `;
    return overlay;
}

function updateProgress(overlay, current, total, sessionName) {
    const fill = overlay.querySelector('.migration-progress-fill');
    const status = overlay.querySelector('.migration-status');

    if (fill) {
        fill.style.width = `${Math.round((current / total) * 100)}%`;
    }
    if (status) {
        const name = sessionName.length > 20 ? sessionName.slice(0, 20) + '...' : sessionName;
        status.textContent = `${current} / ${total} — ${name}`;
    }
}
