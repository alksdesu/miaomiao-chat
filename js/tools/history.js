/**
 * 工具调用历史管理模块
 * 记录、查询、导出工具调用历史
 */

import { state } from '../core/state.js';
import { savePreference, loadPreference } from '../state/storage.js';
import { logger } from '../utils/logger.js';

// state.* 顶层赋值由 Proxy 自动派发 state:* 事件，无需 setter wrapper
const setToolHistoryEnabledState = (v) => {
    state.toolHistoryEnabled = v;
};
const setMaxToolHistorySizeState = (v) => {
    state.maxToolHistorySize = v;
};

// 截图/图片生成类工具的 base64 结果可达数 MB，全量入库会让每次持久化卡死
const HISTORY_RESULT_MAX_LENGTH = 10240;

/**
 * 裁剪超大 result，保留前 500 字符摘要与原始体积信息
 * @param {*} result
 * @returns {*}
 */
function sanitizeResultForHistory(result) {
    if (result == null) return result;
    try {
        const serialized = JSON.stringify(result);
        if (serialized.length <= HISTORY_RESULT_MAX_LENGTH) return result;
        return {
            _truncated: true,
            _originalSize: `${(serialized.length / 1024).toFixed(1)}KB`,
            summary: `${serialized.slice(0, 500)}…`
        };
    } catch {
        return { _truncated: true, summary: '[result 无法序列化]' };
    }
}

/**
 * 记录工具调用
 * @param {Object} record - 工具调用记录
 * @param {string} record.toolId - 工具ID
 * @param {string} record.toolName - 工具名称
 * @param {Object} record.args - 参数
 * @param {Object} record.result - 结果
 * @param {boolean} record.success - 是否成功
 * @param {number} record.duration - 执行时长（毫秒）
 * @param {string} record.error - 错误信息（如果失败）
 */
export function recordToolCall(record) {
    if (!state.toolHistoryEnabled) {
        return;
    }

    const historyEntry = {
        id: generateHistoryId(),
        timestamp: Date.now(),
        datetime: new Date().toISOString(),
        sessionId: state.currentSessionId,
        ...record,
        result: sanitizeResultForHistory(record.result)
    };

    // 添加到历史记录
    state.toolCallHistory.unshift(historyEntry); // 最新的在前面

    // 限制历史记录数量
    if (state.toolCallHistory.length > state.maxToolHistorySize) {
        state.toolCallHistory = state.toolCallHistory.slice(0, state.maxToolHistorySize);
    }

    // 持久化保存
    saveToolHistory();

    logger.debug(`[ToolHistory] 记录工具调用: ${record.toolName}`, {
        success: record.success,
        duration: `${record.duration}ms`
    });
}

/**
 * 获取工具调用历史
 * @param {Object} options - 查询选项
 * @param {number} options.limit - 返回数量限制
 * @param {string} options.toolName - 按工具名称过滤
 * @param {boolean} options.success - 按成功/失败过滤
 * @param {string} options.sessionId - 按会话ID过滤
 * @param {number} options.since - 从指定时间戳之后的记录
 * @returns {Array} 历史记录数组
 */
export function getToolHistory(options = {}) {
    let history = [...state.toolCallHistory];

    // 应用过滤器
    if (options.toolName) {
        history = history.filter((entry) => entry.toolName === options.toolName);
    }

    if (options.success !== undefined) {
        history = history.filter((entry) => entry.success === options.success);
    }

    if (options.sessionId) {
        history = history.filter((entry) => entry.sessionId === options.sessionId);
    }

    if (options.since) {
        history = history.filter((entry) => entry.timestamp >= options.since);
    }

    // 限制返回数量
    if (options.limit) {
        history = history.slice(0, options.limit);
    }

    return history;
}

/**
 * 获取工具调用统计信息
 * @param {Object} options - 统计选项
 * @returns {Object} 统计信息
 */
export function getToolStats(options = {}) {
    const history = getToolHistory(options);

    const stats = {
        total: history.length,
        success: 0,
        failed: 0,
        avgDuration: 0,
        byTool: {},
        bySession: {},
        recentErrors: []
    };

    let totalDuration = 0;

    history.forEach((entry) => {
        // 成功/失败统计
        if (entry.success) {
            stats.success++;
        } else {
            stats.failed++;
            if (stats.recentErrors.length < 10) {
                stats.recentErrors.push({
                    toolName: entry.toolName,
                    error: entry.error,
                    timestamp: entry.timestamp,
                    datetime: entry.datetime
                });
            }
        }

        // 执行时长统计
        if (entry.duration) {
            totalDuration += entry.duration;
        }

        // 按工具统计
        if (!stats.byTool[entry.toolName]) {
            stats.byTool[entry.toolName] = {
                total: 0,
                success: 0,
                failed: 0,
                avgDuration: 0,
                totalDuration: 0
            };
        }
        const toolStats = stats.byTool[entry.toolName];
        toolStats.total++;
        if (entry.success) {
            toolStats.success++;
        } else {
            toolStats.failed++;
        }
        if (entry.duration) {
            toolStats.totalDuration += entry.duration;
        }

        // 按会话统计
        if (entry.sessionId) {
            if (!stats.bySession[entry.sessionId]) {
                stats.bySession[entry.sessionId] = 0;
            }
            stats.bySession[entry.sessionId]++;
        }
    });

    // 计算平均时长
    if (history.length > 0) {
        stats.avgDuration = Math.round(totalDuration / history.length);
    }

    // 计算每个工具的平均时长
    Object.keys(stats.byTool).forEach((toolName) => {
        const toolStats = stats.byTool[toolName];
        if (toolStats.total > 0) {
            toolStats.avgDuration = Math.round(toolStats.totalDuration / toolStats.total);
        }
        delete toolStats.totalDuration; // 删除中间计算字段
    });

    return stats;
}

/**
 * 清除工具调用历史
 * @param {Object} options - 清除选项
 * @param {string} options.toolName - 仅清除指定工具的历史
 * @param {string} options.sessionId - 仅清除指定会话的历史
 * @param {number} options.before - 清除指定时间戳之前的记录
 */
export function clearToolHistory(options = {}) {
    if (!options.toolName && !options.sessionId && !options.before) {
        // 清除所有历史
        state.toolCallHistory = [];
        logger.debug('[ToolHistory] 已清除所有工具调用历史');
    } else {
        // 有条件地清除
        const originalLength = state.toolCallHistory.length;

        state.toolCallHistory = state.toolCallHistory.filter((entry) => {
            if (options.toolName && entry.toolName === options.toolName) {
                return false;
            }
            if (options.sessionId && entry.sessionId === options.sessionId) {
                return false;
            }
            if (options.before && entry.timestamp < options.before) {
                return false;
            }
            return true;
        });

        const removedCount = originalLength - state.toolCallHistory.length;
        logger.debug(`[ToolHistory] 已清除 ${removedCount} 条工具调用历史`);
    }

    // 持久化保存
    saveToolHistory();
}

/**
 * 导出工具调用历史
 * @param {string} format - 导出格式 ('json' | 'csv')
 * @returns {string} 导出的数据
 */
export function exportToolHistory(format = 'json') {
    const history = getToolHistory();

    if (format === 'json') {
        return JSON.stringify(history, null, 2);
    } else if (format === 'csv') {
        return convertToCSV(history);
    } else {
        throw new Error(`不支持的导出格式: ${format}`);
    }
}

/**
 * 导入工具调用历史
 * @param {string} data - 导入的数据（JSON 格式）
 * @param {Object} options - 导入选项
 * @param {boolean} options.merge - 是否合并到现有历史（默认 false，替换）
 */
export function importToolHistory(data, options = {}) {
    try {
        const imported = JSON.parse(data);

        if (!Array.isArray(imported)) {
            throw new Error('导入数据必须是数组格式');
        }

        if (options.merge) {
            // 合并到现有历史
            state.toolCallHistory = [...imported, ...state.toolCallHistory];

            // 限制数量
            if (state.toolCallHistory.length > state.maxToolHistorySize) {
                state.toolCallHistory = state.toolCallHistory.slice(0, state.maxToolHistorySize);
            }
        } else {
            // 替换现有历史
            state.toolCallHistory = imported;
        }

        // 保存到 localStorage
        saveToolHistory();

        logger.debug(`[ToolHistory] 已导入 ${imported.length} 条工具调用历史`);

        return imported.length;
    } catch (error) {
        logger.error('[ToolHistory] 导入失败:', error);
        throw new Error(`导入工具历史失败: ${error.message}`);
    }
}

/**
 * 保存工具历史到持久化存储
 */
async function saveToolHistory() {
    try {
        // 输入验证：确保 toolCallHistory 是数组
        if (!Array.isArray(state.toolCallHistory)) {
            logger.error('[ToolHistory] ❌ toolCallHistory 不是数组，无法保存');
            state.toolCallHistory = []; // 重置为空数组
            return;
        }

        await savePreference('toolCallHistory', state.toolCallHistory);
    } catch (error) {
        logger.error('[ToolHistory] 保存历史失败:', error);
    }
}

/**
 * 从持久化存储加载工具历史
 */
export async function loadToolHistory() {
    try {
        const [saved, enabledPref, maxSizePref] = await Promise.all([
            loadPreference('toolCallHistory'),
            loadPreference('toolHistoryEnabled'),
            loadPreference('maxToolHistorySize')
        ]);

        if (enabledPref !== null && enabledPref !== undefined) {
            setToolHistoryEnabledState(enabledPref === true || enabledPref === 'true');
        }
        if (maxSizePref !== null && maxSizePref !== undefined) {
            const parsedSize = parseInt(maxSizePref, 10);
            if (Number.isFinite(parsedSize) && parsedSize > 0) {
                setMaxToolHistorySizeState(parsedSize);
            }
        }

        if (saved) {
            const parsed = typeof saved === 'string' ? JSON.parse(saved) : saved;

            // 输入验证：确保加载的数据是数组
            if (!Array.isArray(parsed)) {
                logger.error('[ToolHistory] ❌ 加载的数据不是数组，已重置');
                state.toolCallHistory = [];
                return;
            }

            state.toolCallHistory = parsed;
            logger.debug(`[ToolHistory] 已加载 ${state.toolCallHistory.length} 条历史记录`);
        }
    } catch (error) {
        logger.error('[ToolHistory] 加载历史失败:', error);
        state.toolCallHistory = [];
    }
}

/**
 * 生成历史记录 ID
 * @returns {string}
 */
function generateHistoryId() {
    return `tool_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * 转换为 CSV 格式
 * @param {Array} history - 历史记录
 * @returns {string}
 */
function convertToCSV(history) {
    if (history.length === 0) {
        return '';
    }

    // CSV 表头
    const headers = [
        'timestamp',
        'datetime',
        'toolName',
        'success',
        'duration',
        'error',
        'sessionId'
    ];
    let csv = headers.join(',') + '\n';

    // CSV 数据行
    history.forEach((entry) => {
        const row = [
            entry.timestamp,
            `"${entry.datetime}"`,
            `"${entry.toolName}"`,
            entry.success,
            entry.duration || '',
            entry.error ? `"${entry.error.replace(/"/g, '""')}"` : '',
            entry.sessionId || ''
        ];
        csv += row.join(',') + '\n';
    });

    return csv;
}

/**
 * 启用/禁用历史记录
 * @param {boolean} enabled - 是否启用
 */
export function setToolHistoryEnabled(enabled) {
    setToolHistoryEnabledState(enabled);
    logger.debug(`[ToolHistory] 历史记录已${enabled ? '启用' : '禁用'}`);

    // session 持久化字段集不含此开关，独立落 preference
    Promise.resolve(savePreference('toolHistoryEnabled', !!enabled)).catch((error) =>
        logger.error('[ToolHistory] 保存开关失败:', error)
    );
}

/**
 * 设置最大历史记录数量
 * @param {number} maxSize - 最大数量
 */
export function setMaxToolHistorySize(maxSize) {
    setMaxToolHistorySizeState(maxSize);

    // 如果当前历史超过新的限制，裁剪
    if (state.toolCallHistory.length > maxSize) {
        state.toolCallHistory = state.toolCallHistory.slice(0, maxSize);
        saveToolHistory();
    }

    logger.debug(`[ToolHistory] 最大历史记录数已设为: ${maxSize}`);

    Promise.resolve(savePreference('maxToolHistorySize', maxSize)).catch((error) =>
        logger.error('[ToolHistory] 保存配置失败:', error)
    );
}

logger.debug('[ToolHistory] 📚 工具调用历史管理模块已加载');
