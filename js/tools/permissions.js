/**
 * 工具调用权限管理模块
 * 控制哪些工具可以被调用（白名单/黑名单模式）
 *
 * ⚠️ 注意：此模块提供完整的权限管理 API，但目前没有 UI 界面
 *
 * 🔧 使用方式：
 * 1. 在浏览器控制台中手动调用这些函数
 * 2. 未来可以创建 js/ui/tool-permissions.js 来提供管理界面
 *
 * 📚 可用 API：
 * - addToWhitelist(toolId) - 添加到白名单
 * - removeFromWhitelist(toolId) - 从白名单移除
 * - addToBlacklist(toolId) - 添加到黑名单
 * - removeFromBlacklist(toolId) - 从黑名单移除
 * - setPermissionMode('whitelist' | 'blacklist') - 设置模式
 * - setPermissionsEnabled(boolean) - 启用/禁用权限系统
 * - getPermissions() - 查看当前配置
 * - resetPermissions() - 重置为默认值
 *
 * 💡 示例：
 * ```javascript
 * import { addToWhitelist, setPermissionMode } from './js/tools/permissions.js';
 * setPermissionMode('whitelist');
 * addToWhitelist('calculator');
 * ```
 */

import { state } from '../core/state.js';
import { savePreference, loadPreference } from '../state/storage.js';
import { showConfirmDialog } from '../utils/dialogs.js';
import { logger } from '../utils/logger.js';

import { TOOL_CONFIRM_DIALOG_TIMEOUT } from '../utils/constants.js';

// Claude computer-use 的 3 件原生工具：bashConfig.requireConfirmation 仅对它们生效
const NATIVE_TOOL_IDS = new Set(['computer', 'bash', 'str_replace_based_edit_tool']);

const sessionGrantedTools = new Map();
const turnApprovalCaches = new Map();
let legacyTurnId = null;

function getSessionKey(sessionId) {
    return sessionId || '__global__';
}

function getSessionGrants(sessionId) {
    const key = getSessionKey(sessionId);
    if (!sessionGrantedTools.has(key)) sessionGrantedTools.set(key, new Set());
    return sessionGrantedTools.get(key);
}

function getTurnCache(sessionId, turnId) {
    const key = `${getSessionKey(sessionId)}:${turnId || legacyTurnId || '__turn__'}`;
    if (!turnApprovalCaches.has(key)) {
        if (turnApprovalCaches.size >= 64) {
            turnApprovalCaches.delete(turnApprovalCaches.keys().next().value);
        }
        turnApprovalCaches.set(key, new Map());
    }
    return turnApprovalCaches.get(key);
}

// 必须对完整序列化串哈希：截断会让不同长参数共享同一批准结果，确认 gate 失效
function hashArgs(args) {
    let str;
    try {
        str = JSON.stringify(args) ?? String(args);
    } catch {
        str = String(args);
    }
    let h1 = 0x811c9dc5;
    let h2 = 0x1505;
    for (let i = 0; i < str.length; i++) {
        const c = str.charCodeAt(i);
        h1 = Math.imul(h1 ^ c, 0x01000193);
        h2 = Math.imul(h2, 33) ^ c;
    }
    return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

/**
 * 进入新 turn 边界时调用，幂等：同 turnId 重复调用不清缓存
 * 由 chat 发送入口（api:send-requested handler）传入新 requestId 触发
 * @param {string|number} turnId - 本轮请求的唯一标识
 */
export function resetTurnApprovalCache(turnId) {
    if (turnId !== legacyTurnId) {
        turnApprovalCaches.clear();
        legacyTurnId = turnId;
    }
}

/**
 * 切换会话时调用，清空"本次会话全部允许"集合 + turn 缓存
 * 避免授权跨会话残留，符合"会话级"语义
 */
export function resetSessionGrants(sessionId = state.currentSessionId) {
    const sessionKey = getSessionKey(sessionId);
    sessionGrantedTools.delete(sessionKey);
    for (const key of turnApprovalCaches.keys()) {
        if (key.startsWith(`${sessionKey}:`)) turnApprovalCaches.delete(key);
    }
}

/**
 * 工具执行前的用户确认
 *
 * 触发条件（满足任一即弹窗）：
 *   1) state.toolPermissions.requireConfirmation = true（全局开关）
 *   2) NATIVE_TOOL_IDS 命中 && state.bashConfig.requireConfirmation = true（Claude 原生 3 件套专属）
 *
 * 短路路径：
 *   - sessionGrantedTools 命中 → 直接放行（本会话用户已勾选"全部允许"）
 *   - turnApprovalCache 命中 → 沿用上次结果（拒绝也缓存，避免一轮内反复打扰）
 *
 * 之前 setRequireConfirmation 只写 state，executor.js 从未读取触发 → 假开关。
 * 此 helper 由 executor.executeTool 在权限检查通过后调用，返回 false 时 executor
 * 抛 "用户拒绝执行" 走 ERROR 路径，UI tool-display 显示 'failed' 状态。
 *
 * @param {string} toolId
 * @param {string} toolName
 * @param {Object} args - 工具参数（用于摘要展示给用户）
 * @param {object} [options]
 * @param {AbortSignal} [options.signal] - 用户点停止按钮 → abort → 关闭对话框 resolve(false)
 * @returns {Promise<boolean>} true = 批准执行，false = 用户拒绝/超时/abort
 */
export async function confirmToolExecutionIfRequired(toolId, toolName, args, options = {}) {
    const sessionId = options.sessionId ?? state.currentSessionId;
    const grants = getSessionGrants(sessionId);
    const approvalCache = getTurnCache(sessionId, options.turnId);
    // 本会话已授权 → 直接放行（不进缓存判定，省一次 hash 计算）
    if (grants.has(toolName) || grants.has(toolId)) return true;

    const isNative = NATIVE_TOOL_IDS.has(toolId) || NATIVE_TOOL_IDS.has(toolName);
    const needConfirm =
        !!state.toolPermissions?.requireConfirmation ||
        (isNative && !!state.bashConfig?.requireConfirmation);
    if (!needConfirm) return true;

    // 同 turn 同参数复用历史决定（含拒绝）
    const cacheKey = toolName + ':' + hashArgs(args);
    if (approvalCache.has(cacheKey)) return approvalCache.get(cacheKey);

    let argsSummary = '';
    try {
        const s = typeof args === 'string' ? args : JSON.stringify(args);
        argsSummary = s.length > 200 ? s.slice(0, 200) + '…' : s;
    } catch {
        argsSummary = '[args 无法序列化]';
    }

    const result = await showConfirmDialog(
        `工具：${toolName}\n参数：${argsSummary}\n\n是否允许执行？`,
        '工具调用确认',
        {
            signal: options.signal,
            timeoutMs: TOOL_CONFIRM_DIALOG_TIMEOUT,
            allowSessionPersistOption: {
                label: '本次会话全部允许',
                key: 'persist'
            }
        }
    );

    // 兼容 dialog 两种返回形态：boolean（未传 option）/ {confirmed, persistForSession}（传了 option）
    const confirmed =
        !options.signal?.aborted &&
        (typeof result === 'object' && result !== null ? !!result.confirmed : !!result);
    const persistForSession =
        typeof result === 'object' && result !== null ? !!result.persistForSession : false;

    if (confirmed && persistForSession) {
        grants.add(toolName);
        logger.debug(`[Permissions] 本会话已授权工具: ${toolName}`);
    }

    approvalCache.set(cacheKey, confirmed);
    return confirmed;
}

/**
 * 检查工具是否有执行权限
 * @param {string} toolId - 工具ID
 * @param {string} toolName - 工具名称
 * @returns {Object} 权限检查结果
 */
export function checkToolPermission(toolId, toolName) {
    // 如果权限系统未启用，默认允许
    if (!state.toolPermissions.enabled) {
        return {
            allowed: true,
            reason: 'permissions_disabled'
        };
    }

    const { mode, whitelist, blacklist } = state.toolPermissions;

    if (mode === 'whitelist') {
        // 白名单模式：只允许列表中的工具
        const allowed = whitelist.includes(toolId) || whitelist.includes(toolName);
        return {
            allowed,
            reason: allowed ? 'whitelist_match' : 'whitelist_reject',
            message: allowed ? undefined : `工具 "${toolName}" 不在白名单中`
        };
    } else if (mode === 'blacklist') {
        // 黑名单模式：禁止列表中的工具
        const blocked = blacklist.includes(toolId) || blacklist.includes(toolName);
        return {
            allowed: !blocked,
            reason: blocked ? 'blacklist_reject' : 'blacklist_pass',
            message: blocked ? `工具 "${toolName}" 在黑名单中` : undefined
        };
    }

    // 默认允许（未知模式）
    return {
        allowed: true,
        reason: 'unknown_mode'
    };
}

/**
 * 添加工具到白名单
 * @param {string} toolIdentifier - 工具ID或名称
 */
export function addToWhitelist(toolIdentifier) {
    if (!state.toolPermissions.whitelist.includes(toolIdentifier)) {
        state.toolPermissions.whitelist.push(toolIdentifier);
        savePermissions();

        logger.debug(`[Permissions] 已添加到白名单: ${toolIdentifier}`);
    }
}

/**
 * 从白名单移除工具
 * @param {string} toolIdentifier - 工具ID或名称
 */
export function removeFromWhitelist(toolIdentifier) {
    const index = state.toolPermissions.whitelist.indexOf(toolIdentifier);
    if (index !== -1) {
        state.toolPermissions.whitelist.splice(index, 1);
        savePermissions();

        logger.debug(`[Permissions] 已从白名单移除: ${toolIdentifier}`);
    }
}

/**
 * 添加工具到黑名单
 * @param {string} toolIdentifier - 工具ID或名称
 */
export function addToBlacklist(toolIdentifier) {
    if (!state.toolPermissions.blacklist.includes(toolIdentifier)) {
        state.toolPermissions.blacklist.push(toolIdentifier);
        savePermissions();

        logger.debug(`[Permissions] 已添加到黑名单: ${toolIdentifier}`);
    }
}

/**
 * 从黑名单移除工具
 * @param {string} toolIdentifier - 工具ID或名称
 */
export function removeFromBlacklist(toolIdentifier) {
    const index = state.toolPermissions.blacklist.indexOf(toolIdentifier);
    if (index !== -1) {
        state.toolPermissions.blacklist.splice(index, 1);
        savePermissions();

        logger.debug(`[Permissions] 已从黑名单移除: ${toolIdentifier}`);
    }
}

/**
 * 设置权限模式
 * @param {string} mode - 'whitelist' | 'blacklist'
 */
export function setPermissionMode(mode) {
    if (mode !== 'whitelist' && mode !== 'blacklist') {
        throw new Error(`无效的权限模式: ${mode}。必须是 'whitelist' 或 'blacklist'`);
    }

    state.toolPermissions.mode = mode;
    savePermissions();

    logger.debug(`[Permissions] 权限模式已设为: ${mode}`);
}

/**
 * 启用/禁用权限系统
 * @param {boolean} enabled - 是否启用
 */
export function setPermissionsEnabled(enabled) {
    state.toolPermissions.enabled = enabled;
    savePermissions();

    logger.debug(`[Permissions] 权限系统已${enabled ? '启用' : '禁用'}`);
}

/**
 * 设置是否需要用户确认
 * @param {boolean} required - 是否需要确认
 */
export function setRequireConfirmation(required) {
    state.toolPermissions.requireConfirmation = required;
    savePermissions();

    logger.debug(`[Permissions] 用户确认已${required ? '启用' : '禁用'}`);
}

/**
 * 获取权限配置
 * @returns {Object} 权限配置
 */
export function getPermissions() {
    return {
        ...state.toolPermissions,
        whitelist: [...state.toolPermissions.whitelist],
        blacklist: [...state.toolPermissions.blacklist]
    };
}

/**
 * 重置权限配置
 */
export function resetPermissions() {
    state.toolPermissions = {
        enabled: false,
        mode: 'whitelist',
        whitelist: [],
        blacklist: [],
        requireConfirmation: false
    };

    savePermissions();

    logger.debug('[Permissions] 权限配置已重置');
}

/**
 * 导出权限配置
 * @returns {string} JSON 字符串
 */
export function exportPermissions() {
    return JSON.stringify(state.toolPermissions, null, 2);
}

/**
 * 导入权限配置
 * @param {string} data - JSON 字符串
 */
export function importPermissions(data) {
    try {
        const imported = JSON.parse(data);

        // 验证数据结构
        if (typeof imported !== 'object') {
            throw new Error('导入数据必须是对象');
        }

        // 合并到当前配置
        state.toolPermissions = {
            ...state.toolPermissions,
            ...imported
        };

        savePermissions();

        logger.debug('[Permissions] 权限配置已导入');
    } catch (error) {
        logger.error('[Permissions] 导入失败:', error);
        throw new Error(`导入权限配置失败: ${error.message}`);
    }
}

/**
 * 获取权限统计
 * @returns {Object} 统计信息
 */
export function getPermissionStats() {
    return {
        enabled: state.toolPermissions.enabled,
        mode: state.toolPermissions.mode,
        whitelistCount: state.toolPermissions.whitelist.length,
        blacklistCount: state.toolPermissions.blacklist.length,
        requireConfirmation: state.toolPermissions.requireConfirmation
    };
}

/**
 * 批量设置白名单
 * @param {Array<string>} tools - 工具ID/名称数组
 * @param {boolean} replace - 是否替换（默认 false，追加）
 */
export function setWhitelist(tools, replace = false) {
    if (replace) {
        state.toolPermissions.whitelist = [...tools];
    } else {
        // 追加并去重
        const combined = [...state.toolPermissions.whitelist, ...tools];
        state.toolPermissions.whitelist = [...new Set(combined)];
    }

    savePermissions();

    logger.debug(
        `[Permissions] 白名单已${replace ? '替换' : '更新'}: ${state.toolPermissions.whitelist.length} 个工具`
    );
}

/**
 * 批量设置黑名单
 * @param {Array<string>} tools - 工具ID/名称数组
 * @param {boolean} replace - 是否替换（默认 false，追加）
 */
export function setBlacklist(tools, replace = false) {
    if (replace) {
        state.toolPermissions.blacklist = [...tools];
    } else {
        // 追加并去重
        const combined = [...state.toolPermissions.blacklist, ...tools];
        state.toolPermissions.blacklist = [...new Set(combined)];
    }

    savePermissions();

    logger.debug(
        `[Permissions] 黑名单已${replace ? '替换' : '更新'}: ${state.toolPermissions.blacklist.length} 个工具`
    );
}

/**
 * 保存权限配置到 IndexedDB
 * session/config 持久化字段集均不含 toolPermissions，必须独立落 preference
 */
function savePermissions() {
    Promise.resolve(savePreference('toolPermissions', JSON.stringify(state.toolPermissions))).catch(
        (error) => logger.error('[Permissions] 保存权限配置失败:', error)
    );
}

/**
 * 启动时恢复权限配置
 */
export async function loadToolPermissions() {
    try {
        const saved = await loadPreference('toolPermissions');
        if (!saved) return;
        const parsed = typeof saved === 'string' ? JSON.parse(saved) : saved;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            state.toolPermissions = { ...state.toolPermissions, ...parsed };
            logger.debug('[Permissions] 已恢复权限配置');
        }
    } catch (error) {
        logger.error('[Permissions] 加载权限配置失败:', error);
    }
}

logger.debug('[Permissions] 🔒 工具权限管理模块已加载');
