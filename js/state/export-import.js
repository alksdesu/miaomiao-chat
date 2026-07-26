/**
 * 配置和会话导出/导入模块
 * 处理数据的备份和恢复
 */

import { state } from '../core/state.js';
import { elements } from '../core/elements.js';
import {
    loadAllSessionsFromDB,
    saveSessionToDB,
    loadSessionMessages,
    saveSessionMessages,
    loadConfig as loadConfigFromDB,
    loadSavedConfigs as loadSavedConfigsFromDB,
    saveConfig as saveConfigToDB,
    saveSavedConfigs as saveSavedConfigsToDB,
    loadPreference,
    savePreference,
    STORES,
    loadAllFromStore
} from './storage.js';
import { loadSavedConfigs } from './config.js';
import { loadSessions, reloadCurrentSessionMessages } from './sessions.js';
import { showNotification } from '../ui/notifications.js';
import { populateModelSelect } from '../ui/models.js';
import { showConfirmDialog } from '../utils/dialogs.js';
import { sanitizeMessageForExport, ensureIdMap } from '../api/format-converter.js'; // 过滤私有字段 + 旧数据 idMap 补齐
import { categorizeFile } from '../utils/file-helpers.js';
import {
    SCHEMA_VERSION,
    isSchemaFormatParts,
    getTextContent,
    getThinkingContent,
    agePendingToolCallsInPlace,
    validateToolPairings
} from '../messages/schema.js';
import { migrateSession } from '../messages/migration.js';
import { logger } from '../utils/logger.js';
import { IMPORT_FILE_MAX_SIZE } from '../utils/constants.js';

/**
 * 标记导入消息中缺签名的 thinking part 为 _edited
 *
 * 导出走 sanitizeMessageForExport / EXPORT_SENSITIVE_KEYS 黑名单剥离了 signature 等私有字段；
 * 重新导入后 thinking part 缺 signature 在 Claude adapter 会被整块跳过 → thinking 文本丢失。
 * 标 _edited=true 让 adapter 走"用户编辑过"路径，按 redacted 之外的 fallback 保留文本但不下发
 * （Anthropic 推荐的处理方式：缺签名的 thinking block 不能回传 API 校验）
 */
function markStrippedThinkingAsEdited(messages) {
    if (!Array.isArray(messages)) return 0;
    let marked = 0;
    for (const msg of messages) {
        if (!Array.isArray(msg?.parts)) continue;
        for (const p of msg.parts) {
            if (p?.type !== 'thinking') continue;
            // redacted_thinking 走 data 字段路径，不需要 signature
            if (p.redacted) continue;
            // 同时清理可能残留的孤儿 signatureFormat / 跨家继承字段
            if (!p.signature || p.signature.length === 0) {
                p._edited = true;
                delete p.signatureFormat;
                marked++;
            }
        }
    }
    return marked;
}

/**
 * 主动补齐导入消息的 tool_call part.idMap 三槽（旧版本备份可能缺 idMap）。
 *
 * 拆分 ensureIdMap 入口后，请求路径上的 getMappedId 退化为纯 select，
 * 缺 idMap 时只返回临时派生 id 不写回 part；持久化补齐统一在导入入口完成
 * @returns {number} 实际补齐的 tool_call part 数量
 */
function backfillToolCallIdMap(messages) {
    if (!Array.isArray(messages)) return 0;
    let filled = 0;
    for (const msg of messages) {
        if (!Array.isArray(msg?.parts)) continue;
        for (const p of msg.parts) {
            if (p?.type === 'tool_call' && ensureIdMap(p)) filled++;
        }
    }
    return filled;
}

/**
 * 生成导出文件名
 * @param {string} type - 导出类型
 * @returns {string} 文件名
 */
function generateExportFilename(type) {
    const date = new Date().toISOString().slice(0, 10);
    return `webchat-${type}-${date}.json`;
}

/**
 * 下载 JSON 文件
 * @param {Object} data - 要导出的数据
 * @param {string} filename - 文件名
 */
function downloadJSON(data, filename) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

/**
 * 过滤运行时状态字段（不应该导出的字段）
 * @param {Object} config - 配置对象
 * @returns {Object} 过滤后的配置对象
 */
function filterRuntimeState(config) {
    if (!config) return null;

    const filteredConfig = { ...config };
    delete filteredConfig.selectedModel;
    return filteredConfig;
}

/**
 * 为导出的会话列表加载消息数据（v4 架构适配）
 * v3 未迁移的会话可能有 _pendingMessages，v4 从 messages store 加载
 * @param {Array} sessions - 会话元数据列表
 * @param {{loadFailed:number}} [stats] - 可选累加器，统计消息读取失败的会话数供调用方提示用户
 */
async function loadMessagesForSessions(sessions, stats = null) {
    const results = [];
    for (const session of sessions) {
        const merged = { ...session };
        // v3 未迁移数据：从 _pending 字段获取
        if (merged._pendingMessages) {
            merged.messages = merged._pendingMessages;
            delete merged._pendingMessages;
            delete merged._pendingGemini;
            delete merged._pendingClaude;
        }
        // v4：从 messages store 加载
        else if (!merged.messages && merged.id) {
            try {
                const msgData = await loadSessionMessages(merged.id);
                if (msgData) {
                    merged.messages = msgData.messages || [];
                }
            } catch (e) {
                logger.warn(`[Export] 加载会话 ${merged.id} 消息失败:`, e);
                if (stats) stats.loadFailed++;
            }
        }
        results.push(merged);
    }
    return results;
}

/**
 * 清理会话中的私有字段
 * @param {Object} session - 会话对象
 * @param {{sensitiveStripped:number}} [stats] - 可选累加器，导出路径用于统计剥离量提示用户
 * @returns {Object} 清理后的会话对象
 */
function sanitizeSession(session, stats = null) {
    if (!session) return null;

    // 深拷贝会话对象
    const cleaned = { ...session };

    // 清理 messages 数组
    if (Array.isArray(cleaned.messages)) {
        cleaned.messages = cleaned.messages.map((msg) => sanitizeMessageForExport(msg, stats));
    }

    return cleaned;
}

/**
 * 导出配置
 * 注意：导出数据包含 API 密钥（apiKey、apiKeys），用户需妥善保管导出文件
 */
export async function exportConfig() {
    try {
        // 导出前提醒用户数据包含敏感信息
        const confirmed = await showConfirmDialog(
            '导出的配置文件包含 API 密钥等敏感信息，请妥善保管导出文件，避免泄露。是否继续？',
            '导出配置'
        );
        if (!confirmed) return;

        // 从 IndexedDB 读取配置
        let currentConfig = null;
        let savedConfigs = [];

        if (state.storageMode !== 'localStorage') {
            currentConfig = await loadConfigFromDB();
            savedConfigs = (await loadSavedConfigsFromDB()) || [];
        }

        // 降级：从 localStorage 读取
        if (!currentConfig) {
            const configData = localStorage.getItem('geminiChatConfig');
            currentConfig = configData ? JSON.parse(configData) : null;
        }
        if (savedConfigs.length === 0) {
            const configs = localStorage.getItem('geminiChatConfigs');
            savedConfigs = configs ? JSON.parse(configs) : [];
        }

        // 过滤掉运行时状态（selectedModel）
        const filteredCurrentConfig = currentConfig ? filterRuntimeState(currentConfig) : null;
        const filteredSavedConfigs = savedConfigs.map(filterRuntimeState);

        // 导出工具启用状态
        let toolsEnabled = null;
        try {
            const toolsEnabledJson = await loadPreference('toolsEnabled');
            if (toolsEnabledJson) {
                toolsEnabled = JSON.parse(toolsEnabledJson);
            }
        } catch (error) {
            logger.warn('[Export] 读取工具状态失败:', error);
        }

        const exportData = {
            type: 'config',
            version: 1,
            exportDate: new Date().toISOString(),
            data: {
                currentConfig: filteredCurrentConfig,
                savedConfigs: filteredSavedConfigs,
                toolsEnabled: toolsEnabled // 包含工具状态
            }
        };

        downloadJSON(exportData, generateExportFilename('config'));
        showNotification('配置已导出', 'success');
    } catch (error) {
        logger.error('导出配置失败:', error);
        showNotification('导出配置失败: ' + error.message, 'error');
    }
}

/**
 * 导出会话记录
 */
export async function exportSessions() {
    try {
        const sessions = await loadAllSessionsFromDB();

        // v4: 从 messages store 加载每个会话的消息
        const loadStats = { loadFailed: 0 };
        const sessionsWithMessages = await loadMessagesForSessions(sessions, loadStats);

        // 清理会话中的私有字段
        const exportStats = { sensitiveStripped: 0 };
        const cleanedSessions = sessionsWithMessages.map((session) =>
            sanitizeSession(session, exportStats)
        );

        const folders = await loadAllFromStore(STORES.FOLDERS);

        const exportData = {
            type: 'sessions',
            version: 1,
            exportDate: new Date().toISOString(),
            totalSessions: cleanedSessions.length,
            sessions: cleanedSessions,
            folders
        };

        downloadJSON(exportData, generateExportFilename('sessions'));
        const strippedNote =
            exportStats.sensitiveStripped > 0
                ? `（已移除 ${exportStats.sensitiveStripped} 个服务端签名字段以保护隐私）`
                : '';
        if (loadStats.loadFailed > 0) {
            showNotification(
                `已导出 ${cleanedSessions.length} 个会话${strippedNote}，但 ${loadStats.loadFailed} 个会话消息读取失败未包含在备份中`,
                'warning',
                10000
            );
        } else {
            showNotification(`已导出 ${cleanedSessions.length} 个会话${strippedNote}`, 'success');
        }
    } catch (error) {
        logger.error('导出会话失败:', error);
        showNotification('导出会话失败: ' + error.message, 'error');
    }
}

/**
 * 导出全部数据（配置 + 会话）
 * 注意：导出数据包含 API 密钥（apiKey、apiKeys），用户需妥善保管导出文件
 */
export async function exportAllData() {
    try {
        // 导出前提醒用户数据包含敏感信息
        const confirmed = await showConfirmDialog(
            '导出的备份文件包含 API 密钥等敏感信息，请妥善保管导出文件，避免泄露。是否继续？',
            '导出全部数据'
        );
        if (!confirmed) return;

        // 从 IndexedDB 读取数据
        let currentConfig = null;
        let savedConfigs = [];
        const sessions = await loadAllSessionsFromDB();

        if (state.storageMode !== 'localStorage') {
            currentConfig = await loadConfigFromDB();
            savedConfigs = (await loadSavedConfigsFromDB()) || [];
        }

        // 降级：从 localStorage 读取
        if (!currentConfig) {
            const configData = localStorage.getItem('geminiChatConfig');
            currentConfig = configData ? JSON.parse(configData) : null;
        }
        if (savedConfigs.length === 0) {
            const configs = localStorage.getItem('geminiChatConfigs');
            savedConfigs = configs ? JSON.parse(configs) : [];
        }

        // 过滤掉运行时状态（selectedModel）
        const filteredCurrentConfig = currentConfig ? filterRuntimeState(currentConfig) : null;
        const filteredSavedConfigs = savedConfigs.map(filterRuntimeState);

        // 清理会话中的私有字段
        const loadStats = { loadFailed: 0 };
        const sessionsWithMessages = await loadMessagesForSessions(sessions, loadStats);
        const exportStats = { sensitiveStripped: 0 };
        const cleanedSessions = sessionsWithMessages.map((session) =>
            sanitizeSession(session, exportStats)
        );

        const folders = await loadAllFromStore(STORES.FOLDERS);

        const exportData = {
            type: 'full-backup',
            version: 1,
            exportDate: new Date().toISOString(),
            metadata: {
                totalConfigs: filteredSavedConfigs.length,
                totalSessions: cleanedSessions.length
            },
            config: {
                currentConfig: filteredCurrentConfig,
                savedConfigs: filteredSavedConfigs
            },
            sessions: cleanedSessions,
            folders
        };

        downloadJSON(exportData, generateExportFilename('backup'));
        const strippedNote =
            exportStats.sensitiveStripped > 0
                ? `（已移除 ${exportStats.sensitiveStripped} 个服务端签名字段以保护隐私）`
                : '';
        if (loadStats.loadFailed > 0) {
            showNotification(
                `已导出完整备份（${cleanedSessions.length} 个会话）${strippedNote}，但 ${loadStats.loadFailed} 个会话消息读取失败未包含在备份中`,
                'warning',
                10000
            );
        } else {
            showNotification(
                `已导出完整备份（${cleanedSessions.length} 个会话）${strippedNote}`,
                'success'
            );
        }
    } catch (error) {
        logger.error('导出失败:', error);
        showNotification('导出失败: ' + error.message, 'error');
    }
}

/**
 * 导入配置
 * @param {Object} data - 导入的数据
 */
async function importConfig(data) {
    if (!data.data) {
        throw new Error('配置数据格式错误');
    }

    try {
        // 导入当前配置（过滤掉运行时状态）
        if (data.data.currentConfig) {
            const filtered = filterRuntimeState(data.data.currentConfig);
            if (state.storageMode !== 'localStorage') {
                await saveConfigToDB(filtered);
            } else {
                localStorage.setItem('geminiChatConfig', JSON.stringify(filtered));
            }
        }

        // 导入保存的配置（过滤掉运行时状态）
        if (data.data.savedConfigs) {
            const filtered = data.data.savedConfigs.map(filterRuntimeState);
            if (state.storageMode !== 'localStorage') {
                await saveSavedConfigsToDB(filtered);
            } else {
                localStorage.setItem('geminiChatConfigs', JSON.stringify(filtered));
            }
        }

        // 导入工具启用状态
        if (data.data.toolsEnabled) {
            try {
                await savePreference('toolsEnabled', JSON.stringify(data.data.toolsEnabled));
                logger.debug('[Import] 工具状态已导入');
            } catch (error) {
                logger.warn('[Import] 导入工具状态失败:', error);
            }
        }

        // 重新加载配置列表
        loadSavedConfigs();

        // 新增：触发模型列表刷新
        try {
            populateModelSelect();
        } catch (err) {
            logger.warn('Failed to refresh model list:', err);
        }

        showNotification('配置已导入，请刷新页面应用更改', 'success');
    } catch (error) {
        logger.error('导入配置失败:', error);
        // 降级处理
        if (data.data.currentConfig) {
            const filtered = filterRuntimeState(data.data.currentConfig);
            localStorage.setItem('geminiChatConfig', JSON.stringify(filtered));
        }
        if (data.data.savedConfigs) {
            const filtered = data.data.savedConfigs.map(filterRuntimeState);
            localStorage.setItem('geminiChatConfigs', JSON.stringify(filtered));
        }
        throw error;
    }
}

/**
 * 白名单清理 folders 数组：剥离 __proto__/constructor 等危险 id + 字段类型校验
 * 防御恶意 JSON 文件污染文件夹列表 / 破坏 sort 比较函数
 */
const _FOLDER_DANGER_IDS = new Set(['__proto__', 'constructor', 'prototype']);
function sanitizeFolders(arr) {
    if (!Array.isArray(arr)) return [];
    return arr
        .filter(
            (f) =>
                f &&
                typeof f === 'object' &&
                typeof f.id === 'string' &&
                f.id.length > 0 &&
                !_FOLDER_DANGER_IDS.has(f.id) &&
                typeof f.name === 'string'
        )
        .map((f) => ({
            id: f.id,
            name: String(f.name).slice(0, 200),
            order: Number.isFinite(Number(f.order)) ? Number(f.order) : 0,
            collapsed: !!f.collapsed,
            createdAt: Number.isFinite(Number(f.createdAt)) ? Number(f.createdAt) : Date.now()
        }));
}

/**
 * 导入会话
 * @param {Object} data - 导入的数据
 */
async function importSessions(data) {
    if (!data.sessions || !Array.isArray(data.sessions)) {
        throw new Error('会话数据格式错误');
    }

    let importCount = 0;
    let totalOrphans = 0;
    const errors = [];

    // 每 K 个 session 后让出主线程，避免 50MB 大备份串行导入冻结整 tab
    const IMPORT_YIELD_EVERY = 5;
    let _sessionIndex = 0;

    for (const session of data.sessions) {
        if (_sessionIndex > 0 && _sessionIndex % IMPORT_YIELD_EVERY === 0) {
            await new Promise((r) => setTimeout(r, 0));
        }
        _sessionIndex++;
        try {
            // 检查会话是否已存在
            const existing = state.sessions.find((s) => s.id === session.id);
            if (existing) {
                // 询问是否覆盖
                const overwrite = await showConfirmDialog(
                    `会话 "${session.name}" 已存在，是否覆盖？`,
                    '确认覆盖'
                );
                if (!overwrite) continue;
            }

            // 分离消息数据，写入 messages store
            const { messages, geminiContents: _gc, claudeContents: _cc, ...sessionMeta } = session;
            await saveSessionToDB(sessionMeta);
            if (messages && messages.length > 0) {
                // 检查是否需要迁移旧格式消息
                // 如果消息已有有效的 schema parts，即使没有 _schemaVersion 也不需要迁移
                const firstMsg = messages[0];
                const hasValidParts =
                    firstMsg?.parts && isSchemaFormatParts(firstMsg.parts, firstMsg);
                const needsMigration =
                    !hasValidParts &&
                    (!firstMsg?._schemaVersion || firstMsg._schemaVersion < SCHEMA_VERSION);
                let finalMessages = messages;
                if (needsMigration) {
                    try {
                        const migrated = migrateSession(messages);
                        if (migrated.messages.length > 0) {
                            finalMessages = migrated.messages;
                            logger.debug(
                                `[Import] 迁移会话 ${session.id}: ${messages.length} → ${finalMessages.length} 条消息`
                            );
                        }
                    } catch (e) {
                        logger.warn(`[Import] 迁移失败，使用原始格式:`, e);
                    }
                }
                // 导出时已剥离 signature / signatureFormat / encryptedContent 等私有字段
                // (clearForeignSignatures 走 EXPORT_SENSITIVE_KEYS 黑名单)；
                // 没有 signature 的 thinking part 在 Claude adapter 会走 'signature 缺失则跳过'
                // 分支让整块 thinking 消失。改标 _edited=true 让 adapter 走编辑路径，
                // 行为语义等价于"用户编辑过推理"，Claude 不会校验 signature 也不报 400
                markStrippedThinkingAsEdited(finalMessages);
                // 旧版本备份的 tool_call part 可能缺 idMap 三槽，主动补齐避免请求路径上隐式触发
                backfillToolCallIdMap(finalMessages);
                // 跨设备/旧备份的 pending/running tool_call 在新设备上不可能等到结果，
                // 必须老化为 error 并校验配对；否则下次请求会带着孤儿 tool_call 触发 API 400
                let _agedCount = 0;
                let _orphanCount = 0;
                try {
                    _agedCount = agePendingToolCallsInPlace(finalMessages, { nowMs: Date.now() });
                    const v = validateToolPairings(finalMessages);
                    _orphanCount = v.orphans.length;
                    if (_agedCount > 0 || !v.valid) {
                        logger.warn(
                            `[Import] 会话 ${session.id} 老化 ${_agedCount} 个 pending tool_call, 剩余孤儿 ${_orphanCount}`
                        );
                    }
                } catch (e) {
                    logger.warn('[Import] 老化/校验失败:', e);
                }
                totalOrphans += _agedCount;
                await saveSessionMessages(session.id, {
                    messages: finalMessages
                });
            }
            importCount++;
        } catch (error) {
            logger.error(`导入会话 ${session.id} 失败:`, error);
            errors.push(session.name);
        }
    }

    // 导入 folders（白名单校验防恶意字段污染 + __proto__ 注入）
    if (Array.isArray(data.folders) && data.folders.length > 0) {
        try {
            const { loadFolders } = await import('./folders.js');
            const { getDB } = await import('./storage.js');
            const db = getDB();
            if (db) {
                const sanitized = sanitizeFolders(data.folders);
                const skipped = data.folders.length - sanitized.length;
                const tx = db.transaction([STORES.FOLDERS], 'readwrite');
                const store = tx.objectStore(STORES.FOLDERS);
                for (const folder of sanitized) {
                    store.put(folder);
                }
                await new Promise((resolve, reject) => {
                    tx.oncomplete = resolve;
                    tx.onerror = () => reject(tx.error);
                });
                if (skipped > 0) {
                    showNotification(`已跳过 ${skipped} 个非法文件夹条目`, 'warning');
                }
            }
            await loadFolders();
        } catch (e) {
            logger.warn('[Import] 导入 folders 失败:', e);
            showNotification(`导入文件夹失败：${e.message || e}`, 'warning');
        }
    }

    // 重新加载会话列表
    await loadSessions();

    // 若导入数据中含当前激活会话，loadSessions 内部对同 id 不重切，需主动 reload messages + 刷 baseline
    // 否则 UI 仍显示旧消息且下次保存触发乐观锁假冲突让用户被强制丢改动
    if (data.sessions.some((s) => s.id === state.currentSessionId)) {
        try {
            await reloadCurrentSessionMessages();
        } catch (e) {
            logger.warn('[Import] 覆盖当前会话后 reload 失败:', e);
        }
    }

    if (totalOrphans > 0) {
        showNotification(`导入完成, ${totalOrphans} 个工具调用孤儿已自动老化`, 'warning');
    }
    if (errors.length > 0) {
        showNotification(`已导入 ${importCount} 个会话，${errors.length} 个失败`, 'warning');
    } else {
        showNotification(`已导入 ${importCount} 个会话`, 'success');
    }
}

/**
 * 导入完整备份
 * @param {Object} data - 导入的数据
 */
async function importFullBackup(data) {
    if (!data.config || !data.sessions) {
        throw new Error('备份数据格式错误');
    }

    try {
        // 导入配置（过滤掉运行时状态）
        if (data.config.currentConfig) {
            const filtered = filterRuntimeState(data.config.currentConfig);
            if (state.storageMode !== 'localStorage') {
                await saveConfigToDB(filtered);
            } else {
                localStorage.setItem('geminiChatConfig', JSON.stringify(filtered));
            }
        }
        if (data.config.savedConfigs) {
            const filtered = data.config.savedConfigs.map(filterRuntimeState);
            if (state.storageMode !== 'localStorage') {
                await saveSavedConfigsToDB(filtered);
            } else {
                localStorage.setItem('geminiChatConfigs', JSON.stringify(filtered));
            }
        }

        // 导入会话
        let importCount = 0;
        let totalOrphans = 0;
        const FB_YIELD_EVERY = 5;
        let _fbIndex = 0;
        for (const session of data.sessions) {
            if (_fbIndex > 0 && _fbIndex % FB_YIELD_EVERY === 0) {
                await new Promise((r) => setTimeout(r, 0));
            }
            _fbIndex++;
            try {
                const {
                    messages,
                    geminiContents: _gc,
                    claudeContents: _cc,
                    ...sessionMeta
                } = session;
                await saveSessionToDB(sessionMeta);
                if (messages && messages.length > 0) {
                    // 检查是否需要迁移旧格式消息
                    const firstMsg = messages[0];
                    const hasValidParts =
                        firstMsg?.parts && isSchemaFormatParts(firstMsg.parts, firstMsg);
                    const needsMigration =
                        !hasValidParts &&
                        (!firstMsg?._schemaVersion || firstMsg._schemaVersion < SCHEMA_VERSION);
                    let finalMessages = messages;
                    if (needsMigration) {
                        try {
                            const migrated = migrateSession(messages);
                            if (migrated.messages.length > 0) {
                                finalMessages = migrated.messages;
                            }
                        } catch (e) {
                            logger.warn(`[Import] 迁移失败，使用原始格式:`, e);
                        }
                    }
                    markStrippedThinkingAsEdited(finalMessages);
                    backfillToolCallIdMap(finalMessages);
                    // 跨设备/旧备份的 pending/running tool_call 在新设备上不可能等到结果，
                    // 必须老化为 error 并校验配对；否则下次请求会带着孤儿 tool_call 触发 API 400
                    let _agedCount = 0;
                    let _orphanCount = 0;
                    try {
                        _agedCount = agePendingToolCallsInPlace(finalMessages, {
                            nowMs: Date.now()
                        });
                        const v = validateToolPairings(finalMessages);
                        _orphanCount = v.orphans.length;
                        if (_agedCount > 0 || !v.valid) {
                            logger.warn(
                                `[Import] 会话 ${session.id} 老化 ${_agedCount} 个 pending tool_call, 剩余孤儿 ${_orphanCount}`
                            );
                        }
                    } catch (e) {
                        logger.warn('[Import] 老化/校验失败:', e);
                    }
                    totalOrphans += _agedCount;
                    await saveSessionMessages(session.id, {
                        messages: finalMessages
                    });
                }
                importCount++;
            } catch (error) {
                logger.error(`导入会话 ${session.id} 失败:`, error);
            }
        }

        if (Array.isArray(data.folders)) {
            const { loadFolders } = await import('./folders.js');
            const { getDB } = await import('./storage.js');
            const db = getDB();
            if (db) {
                const sanitized = sanitizeFolders(data.folders);
                const skipped = data.folders.length - sanitized.length;
                const tx = db.transaction([STORES.FOLDERS], 'readwrite');
                const store = tx.objectStore(STORES.FOLDERS);
                for (const folder of sanitized) {
                    store.put(folder);
                }
                await new Promise((resolve, reject) => {
                    tx.oncomplete = resolve;
                    tx.onerror = () => reject(tx.error);
                });
                if (skipped > 0) {
                    showNotification(`完整备份已跳过 ${skipped} 个非法文件夹条目`, 'warning');
                }
            }
            await loadFolders();
        }

        // 重新加载配置和会话列表
        loadSavedConfigs();
        await loadSessions();

        // 与 importSessions 同款守卫：覆盖当前激活会话时主动 reload + 刷 baseline
        if (data.sessions.some((s) => s.id === state.currentSessionId)) {
            try {
                await reloadCurrentSessionMessages();
            } catch (e) {
                logger.warn('[Import] 覆盖当前会话后 reload 失败:', e);
            }
        }

        // 新增：触发模型列表刷新
        try {
            populateModelSelect();
        } catch (err) {
            logger.warn('Failed to refresh model list:', err);
        }

        if (totalOrphans > 0) {
            showNotification(`导入完成, ${totalOrphans} 个工具调用孤儿已自动老化`, 'warning');
        }
        showNotification(
            `已导入完整备份（${importCount} 个会话），请刷新页面应用配置更改`,
            'success'
        );
    } catch (error) {
        logger.error('导入完整备份失败:', error);
        // 降级处理
        if (data.config.currentConfig) {
            const filtered = filterRuntimeState(data.config.currentConfig);
            localStorage.setItem('geminiChatConfig', JSON.stringify(filtered));
        }
        if (data.config.savedConfigs) {
            const filtered = data.config.savedConfigs.map(filterRuntimeState);
            localStorage.setItem('geminiChatConfigs', JSON.stringify(filtered));
        }
        throw error;
    }
}

/**
 * 触发导入文件选择
 */
export function triggerImport() {
    elements.importFileInput.click();
}

/**
 * 处理导入文件
 * @param {Event} event - 文件输入事件
 */
export async function handleImportFile(event) {
    const file = event.target.files[0];
    if (!file) return;

    // size cap：用户误选大文件（含大量 base64 图）会直接 OOM 卡死 tab + 无救援路径
    if (file.size > IMPORT_FILE_MAX_SIZE) {
        const limitMb = (IMPORT_FILE_MAX_SIZE / 1024 / 1024).toFixed(0);
        showNotification(
            `导入文件过大（${(file.size / 1024 / 1024).toFixed(1)}MB），上限 ${limitMb}MB`,
            'error',
            8000
        );
        return;
    }

    try {
        const text = await file.text();
        const data = JSON.parse(text);

        if (!data.type || !data.version) {
            throw new Error('无效的备份文件格式');
        }

        switch (data.type) {
            case 'config':
                await importConfig(data);
                break;
            case 'sessions':
                await importSessions(data);
                break;
            case 'full-backup':
                await importFullBackup(data);
                break;
            default:
                throw new Error(`不支持的备份类型: ${data.type}`);
        }
    } catch (error) {
        logger.error('导入失败:', error);
        showNotification('导入失败: ' + error.message, 'error');
    } finally {
        // 清空文件输入
        event.target.value = '';
    }
}

/**
 * 初始化导出/导入功能
 */
export function initExportImport() {
    // 绑定导出按钮（使用正确的ID）
    const exportConfigBtn = document.getElementById('export-config');
    if (exportConfigBtn) {
        exportConfigBtn.addEventListener('click', exportConfig);
    }

    const exportSessionsBtn = document.getElementById('export-sessions');
    if (exportSessionsBtn) {
        exportSessionsBtn.addEventListener('click', exportSessions);
    }

    const exportAllBtn = document.getElementById('export-all');
    if (exportAllBtn) {
        exportAllBtn.addEventListener('click', exportAllData);
    }

    // 绑定导入按钮
    const importBtn = document.getElementById('import-data');
    if (importBtn) {
        importBtn.addEventListener('click', triggerImport);
    }

    // 绑定文件输入
    if (elements.importFileInput) {
        elements.importFileInput.addEventListener('change', handleImportFile);
    }

    // 将函数暴露到全局作用域供 HTML onclick 使用
    window.exportConfig = exportConfig;
    window.exportSessions = exportSessions;
    window.exportAllData = exportAllData;
    window.triggerImport = triggerImport;

    logger.debug('Export/Import initialized');
}

// ========== 会话 Markdown 导出 ==========

function getExportMessages(session) {
    if (Array.isArray(session?.messages) && session.messages.length > 0) {
        return session.messages;
    }
    return [];
}

function getSelectedReply(msg) {
    const repliesAll = msg?.replies?.all;
    if (!Array.isArray(repliesAll) || repliesAll.length === 0) {
        return null;
    }
    const selectedIndex =
        msg?.replies?.selected ??
        (Number.isInteger(msg?.selectedReplyIndex) ? msg.selectedReplyIndex : 0);
    return repliesAll[selectedIndex] || repliesAll[0] || null;
}

function getAttachmentMarker(part) {
    if (!part || typeof part !== 'object') return '';

    // 新格式 parts: type=media/file
    if (part.type === 'media') {
        if (part.media === 'video') return '[视频]';
        if (part.media === 'audio') return '[音频]';
        return '[图片]';
    }
    if (part.type === 'file') return '[文档]';

    // 旧格式
    if (part.type === 'image_url' || part.type === 'image') return '[图片]';
    if (part.type === 'video_url') return '[视频]';
    if (part.type === 'document') return '[文档]';

    const inlineData = part.inlineData || part.inline_data;
    if (inlineData) {
        const mimeType = inlineData.mimeType || inlineData.mime_type || '';
        const category = categorizeFile(mimeType);
        if (category === 'image') return '[图片]';
        if (category === 'video') return '[视频]';
        if (category === 'pdf' || category === 'text') return '[文档]';
        return '[附件]';
    }

    return '';
}

function extractTextFromParts(parts = []) {
    return parts
        .map((part) => {
            if (!part || typeof part !== 'object') return '';
            if (part.thought || part.type === 'thinking') return '';
            if (typeof part.text === 'string') return part.text;
            return getAttachmentMarker(part);
        })
        .filter(Boolean)
        .join('\n')
        .trim();
}

function extractThinkingContent(msg) {
    const selectedReply = getSelectedReply(msg);

    // 新格式优先：从 parts 提取
    const thinking = getThinkingContent(msg);
    if (thinking) return thinking;

    // selectedReply 可能有独立的 thinkingContent（通过 getThinkingContent 兜底）
    if (selectedReply) {
        const replyThinking = getThinkingContent(selectedReply);
        if (replyThinking) return replyThinking;
    }
    if (msg?.thought) {
        return msg.thought;
    }
    return '';
}

function extractMessageBody(msg) {
    const selectedReply = getSelectedReply(msg);

    if (selectedReply) {
        // 用 schema 工具函数提取（内部处理 parts + content 回退）
        const replyText = getTextContent(selectedReply);
        if (replyText) return replyText;
        if (Array.isArray(selectedReply.claudeContent) && selectedReply.claudeContent.length > 0) {
            return extractTextFromParts(selectedReply.claudeContent);
        }
    }

    // 用 schema 工具函数提取（内部处理 parts + content 回退）
    const text = getTextContent(msg);
    if (text) return text;
    return '';
}

function extractToolCalls(msg) {
    // 新格式：从 parts 提取
    if (Array.isArray(msg?.parts)) {
        const tcNames = msg.parts
            .filter((p) => p.type === 'tool_call' && p.name)
            .map((p) => p.name);
        if (tcNames.length > 0) return tcNames.map((n) => `- ${n}`).join('\n');
    }
    // 旧格式回退
    const toolCalls = msg?.toolCalls;
    if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
        return '';
    }
    const lines = toolCalls
        .map((toolCall) => toolCall?.name || toolCall?.function?.name || toolCall?.id || '')
        .filter(Boolean);
    if (lines.length === 0) return '';
    return lines.map((name) => `- ${name}`).join('\n');
}

/**
 * 将整个会话转换为 Markdown 字符串
 * @param {Object} session - 会话对象
 * @returns {string} Markdown 字符串
 */
export function sessionToMarkdown(session) {
    if (!session) return '';

    const messages = getExportMessages(session);
    if (messages.length === 0) return '';

    let markdown = `# ${session.name || 'Untitled Session'}\n\n`;

    messages.forEach((msg) => {
        if (msg.role === 'system') return;

        const roleName = msg.role === 'user' ? 'User' : 'Assistant';
        markdown += `## ${roleName}\n\n`;

        const thinkingContent = extractThinkingContent(msg); // 运行时变量，非旧格式字段
        if (thinkingContent) {
            markdown += `> **Thinking:**\n> ${thinkingContent.replace(/\n/g, '\n> ')}\n\n`;
        }

        const toolCalls = extractToolCalls(msg);
        if (toolCalls) {
            markdown += `> **Tool Calls:**\n> ${toolCalls.replace(/\n/g, '\n> ')}\n\n`;
        }

        const content = extractMessageBody(msg);
        markdown += `${content || '[无文本内容]'}\n\n`;

        markdown += `---\n\n`;
    });

    return markdown.trim();
}
