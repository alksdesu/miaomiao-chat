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
import { eventBus } from '../core/events.js';
import { EVENTS } from '../core/events-registry.js';
import { savePreference, loadPreference } from '../state/storage.js';
import { showConfirmDialog } from '../utils/dialogs.js';
import { throwIfAbortedBeforeRun } from '../utils/abort.js';
import { logger } from '../utils/logger.js';
import { describeComputerAction } from './computer-actions.js';
import { resolveBashCommand, resolveInsertText } from './computer-commands.js';

import { TOOL_CONFIRM_DIALOG_TIMEOUT, CLAUDE_NATIVE_TOOL_IDS } from '../utils/constants.js';

// Claude computer-use 的 3 件原生工具：bashConfig.requireConfirmation 仅对它们生效
const NATIVE_TOOL_IDS = new Set(CLAUDE_NATIVE_TOOL_IDS);

const GLOBAL_SESSION_KEY = '__global__';
const CONFIRM_TOOL_LABELS = Object.freeze({
    computer: '桌面操作',
    bash: '命令行',
    str_replace_based_edit_tool: '文件编辑'
});
const CONFIRM_PREVIEW_LIMIT = 1000;
const FILE_CONTENT_PREVIEW_LIMIT = 300;

function isPermissionPatch(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    for (const field of ['whitelist', 'blacklist']) {
        if (
            value[field] !== undefined &&
            (!Array.isArray(value[field]) || value[field].some((item) => typeof item !== 'string'))
        ) {
            return false;
        }
    }
    return (
        (value.mode === undefined || ['whitelist', 'blacklist'].includes(value.mode)) &&
        (value.enabled === undefined || typeof value.enabled === 'boolean') &&
        (value.requireConfirmation === undefined || typeof value.requireConfirmation === 'boolean')
    );
}

const sessionGrantedTools = new Map();
const turnApprovalCaches = new Map();

function getSessionKey(sessionId) {
    return sessionId || GLOBAL_SESSION_KEY;
}

function getSessionGrants(sessionId) {
    const key = getSessionKey(sessionId);
    if (!sessionGrantedTools.has(key)) sessionGrantedTools.set(key, new Set());
    return sessionGrantedTools.get(key);
}

// 同一轮请求内同参数复用确认结果；拿不到轮次 id 时不复用，否则旧的批准会沿用到之后的请求
function getTurnCache(sessionId, turnId) {
    if (!turnId) return new Map();
    const key = `${getSessionKey(sessionId)}:${turnId}`;
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
 * 清空某个会话"本次会话全部允许"的授权与它的 turn 缓存
 * 授权按会话 id 隔离，切换会话不清空：后台继续运行的任务仍属于原会话，沿用原会话的授权
 */
export function resetSessionGrants(sessionId = state.currentSessionId) {
    const sessionKey = getSessionKey(sessionId);
    sessionGrantedTools.delete(sessionKey);
    for (const key of turnApprovalCaches.keys()) {
        if (key.startsWith(`${sessionKey}:`)) turnApprovalCaches.delete(key);
    }
}

/**
 * 会话被删除（本标签页或其他标签页）后，它的授权随之失效
 */
function pruneDeletedSessionGrants() {
    const liveSessionKeys = new Set(
        (state.sessions || []).map((session) => getSessionKey(session?.id))
    );
    for (const sessionKey of [...sessionGrantedTools.keys()]) {
        if (sessionKey !== GLOBAL_SESSION_KEY && !liveSessionKeys.has(sessionKey)) {
            resetSessionGrants(sessionKey);
            logger.debug(`[Permissions] 会话已删除，清除其工具授权: ${sessionKey}`);
        }
    }
}

eventBus.on(EVENTS.SESSIONS_UPDATED, pruneDeletedSessionGrants);

// ========== 确认弹窗文案 ==========

function previewText(value, limit = CONFIRM_PREVIEW_LIMIT) {
    const text = String(value);
    return text.length > limit ? `${text.slice(0, limit)}…（共 ${text.length} 字）` : text;
}

function describeShellCommand(command) {
    return typeof command === 'string' && command.trim()
        ? `执行命令：\n${previewText(command)}`
        : null;
}

function describeFileEdit(input = {}) {
    const { command, path, file_text, old_str, new_str, insert_line } = input;
    if (typeof path !== 'string' || !path.trim()) return null;
    const preview = (label, value) =>
        typeof value === 'string'
            ? `\n${label}：${previewText(value, FILE_CONTENT_PREVIEW_LIMIT)}`
            : '';
    switch (command) {
        case 'view':
            return `查看 ${path}`;
        case 'create':
            return `创建文件 ${path}${preview('内容', file_text)}`;
        case 'str_replace':
            return `修改文件 ${path}${preview('原文', old_str)}${preview('改为', new_str)}`;
        case 'insert':
            return `在 ${path} 第 ${insert_line ?? '?'} 行后插入文本${preview('内容', resolveInsertText(input))}`;
        case 'undo_edit':
            return `撤销对 ${path} 的上次修改`;
        default:
            return null;
    }
}

/**
 * Computer Use 相关工具写成人能读懂的一句话；无法识别时返回 null，退回参数摘要
 * XML 模式的内置 computer 工具用 action 区分命令与改文件，原生 computer 的 action 是桌面动作
 * @returns {{ label: string, description: string }|null}
 */
function describeToolAction(toolId, args) {
    const input = args && typeof args === 'object' ? args : {};
    let label = CONFIRM_TOOL_LABELS[toolId];
    let description = null;
    if (toolId === 'computer' && input.action === 'bash') {
        label = CONFIRM_TOOL_LABELS.bash;
        description = describeShellCommand(resolveBashCommand(input));
    } else if (toolId === 'computer' && input.action === 'str_replace_editor') {
        label = CONFIRM_TOOL_LABELS.str_replace_based_edit_tool;
        description = describeFileEdit(input);
    } else if (toolId === 'computer') {
        description = describeComputerAction(input.action, input);
    } else if (toolId === 'bash') {
        description =
            input.restart === true
                ? '重启命令行会话'
                : describeShellCommand(resolveBashCommand(input));
    } else if (toolId === 'str_replace_based_edit_tool') {
        description = describeFileEdit(input);
    }
    return label && description ? { label, description } : null;
}

function summarizeArgs(args) {
    try {
        const s = typeof args === 'string' ? args : JSON.stringify(args);
        return s.length > 200 ? s.slice(0, 200) + '…' : s;
    } catch {
        return '[args 无法序列化]';
    }
}

function describeSourceSession(sessionId) {
    const name = state.sessions?.find?.((session) => session?.id === sessionId)?.name;
    const label = name || '未命名会话';
    return sessionId && sessionId !== state.currentSessionId ? `${label}（后台运行）` : label;
}

function buildConfirmMessage(toolId, toolName, args, sessionId) {
    const action = describeToolAction(toolId, args);
    const lines = [
        `会话：${describeSourceSession(sessionId)}`,
        action ? `工具：${action.label}` : `工具：${toolName}`,
        action ? `操作：${action.description}` : `参数：${summarizeArgs(args)}`
    ];
    return `${lines.join('\n')}\n\n是否允许执行？`;
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
 * 停止请求与用户拒绝分开：signal 已中止（包括弹窗因停止而关闭）时抛 AbortError，
 * 不返回 false，也不写入任何缓存或授权
 *
 * @param {string} toolId
 * @param {string} toolName
 * @param {Object} args - 工具参数（用于摘要展示给用户）
 * @param {object} [options]
 * @param {AbortSignal} [options.signal] - 用户点停止按钮 → abort → 关闭对话框并抛 AbortError
 * @param {string} [options.sessionId] - 工具调用所属会话，弹窗里标出会话名
 * @param {string} [options.turnId] - 本轮请求 id，同轮同参数复用确认结果
 * @returns {Promise<boolean>} true = 批准执行，false = 用户拒绝/超时
 */
export async function confirmToolExecutionIfRequired(toolId, toolName, args, options = {}) {
    const { signal } = options;
    throwIfAbortedBeforeRun(signal);
    const sessionId = options.sessionId ?? state.currentSessionId;
    const grants = getSessionGrants(sessionId);
    // 本会话已授权 → 直接放行（不进缓存判定，省一次 hash 计算）
    if (grants.has(toolId)) return true;

    const isNative = NATIVE_TOOL_IDS.has(toolId) || NATIVE_TOOL_IDS.has(toolName);
    const needConfirm =
        !!state.toolPermissions?.requireConfirmation ||
        (isNative && !!state.bashConfig?.requireConfirmation);
    if (!needConfirm) return true;

    // 同 turn 同参数复用历史决定（含拒绝）
    const approvalCache = getTurnCache(sessionId, options.turnId);
    const cacheKey = toolId + ':' + hashArgs(args);
    if (approvalCache.has(cacheKey)) return approvalCache.get(cacheKey);

    const result = await showConfirmDialog(
        buildConfirmMessage(toolId, toolName, args, sessionId),
        '工具调用确认',
        {
            signal,
            timeoutMs: TOOL_CONFIRM_DIALOG_TIMEOUT,
            // 用户可能正在输入框里打字，回车不能直接放行
            defaultFocus: 'cancel',
            allowSessionPersistOption: {
                label: '本次会话全部允许',
                key: 'persist'
            }
        }
    );
    throwIfAbortedBeforeRun(signal);

    // 兼容 dialog 两种返回形态：boolean（未传 option）/ {confirmed, persistForSession}（传了 option）
    const confirmed = typeof result === 'object' && result !== null ? !!result.confirmed : !!result;
    const persistForSession =
        typeof result === 'object' && result !== null ? !!result.persistForSession : false;

    if (confirmed && persistForSession) {
        grants.add(toolId);
        logger.debug(`[Permissions] 本会话已授权工具: ${toolId}`);
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
        if (!imported || typeof imported !== 'object' || Array.isArray(imported)) {
            throw new Error('导入数据必须是对象');
        }
        if (!isPermissionPatch(imported)) {
            throw new Error('权限配置字段类型无效');
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
        if (isPermissionPatch(parsed)) {
            state.toolPermissions = { ...state.toolPermissions, ...parsed };
            logger.debug('[Permissions] 已恢复权限配置');
        } else {
            logger.warn('[Permissions] 已忽略无效的已保存权限配置');
        }
    } catch (error) {
        logger.error('[Permissions] 加载权限配置失败:', error);
    }
}

logger.debug('[Permissions] 🔒 工具权限管理模块已加载');
