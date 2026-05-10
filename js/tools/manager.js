/**
 * 工具管理器模块
 * 负责工具的注册、启用/禁用、格式转换
 *
 * 架构：单一 Map 存储完整工具对象（含 call 函数）
 * 所有工具通过 buildTool 标准化后注册
 *
 * 发布事件:
 * - tool:registered { toolId, type }
 * - tool:enabled:changed { toolId, enabled }
 * - tools:updated (触发保存)
 */

import { eventBus } from '../core/events.js';
import { generateId } from '../utils/helpers.js';
import { mcpClient } from './mcp/client.js';
import { savePreference, loadPreference } from '../state/storage.js';
import { state } from '../core/state.js';
import { buildTool, buildToolFromLegacy } from './build-tool.js';
import { logger } from '../utils/logger.js';

// ========== 核心存储 ==========

/**
 * 统一工具存储
 * Map<toolId, ToolObject>
 * ToolObject 包含: id, name, description, parameters, inputSchema,
 *   type, hidden, enabled, call, validate, checkPermissions, isReadOnly,
 *   rateLimit, timeout, serverId?
 */
const tools = new Map();

/**
 * 工具名称反向索引（O(1) 名称查找）
 * Map<toolName, Set<toolId>>
 */
const toolNameIndex = new Map();

/**
 * 预加载的工具状态缓存（MCP 工具注册前先缓存持久化状态）
 * Map<toolId, boolean>
 */
const _preloadedStates = new Map();

// ========== 辅助函数 ==========

function normalizeToolEnabledValue(value) {
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (normalized === 'true') return true;
        if (normalized === 'false') return false;
    }
    return value === true || value === 1;
}

function parseSavedToolStates(rawStates) {
    if (!rawStates) return null;

    let parsed = rawStates;
    if (typeof rawStates === 'string') {
        try {
            parsed = JSON.parse(rawStates);
        } catch (error) {
            logger.error('[Tools] 解析工具状态 JSON 失败:', error);
            return null;
        }
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return null;
    }

    const normalized = {};
    for (const [toolId, enabled] of Object.entries(parsed)) {
        normalized[toolId] = normalizeToolEnabledValue(enabled);
    }
    return normalized;
}

function addToNameIndex(toolName, toolId) {
    if (!toolNameIndex.has(toolName)) {
        toolNameIndex.set(toolName, new Set());
    }
    toolNameIndex.get(toolName).add(toolId);
}

function removeFromNameIndex(toolName, toolId) {
    if (toolNameIndex.has(toolName)) {
        const idSet = toolNameIndex.get(toolName);
        idSet.delete(toolId);
        if (idSet.size === 0) {
            toolNameIndex.delete(toolName);
        }
    }
}

// ========== 工具注册 API ==========

/**
 * 统一注册入口 — 接收 buildTool 产出的标准化工具对象
 * @param {Object} tool - buildTool() 返回的完整工具对象
 */
export function registerTool(tool) {
    const toolId = tool.id || tool.name;

    if (tools.has(toolId)) {
        logger.warn(`[Tools] 工具 "${toolId}" 已存在，将被覆盖`);
    }

    // 确保 id 字段存在
    tool.id = toolId;

    // 确保 inputSchema 别名
    if (!tool.inputSchema) tool.inputSchema = tool.parameters;
    if (!tool.parameters) tool.parameters = tool.inputSchema;

    tools.set(toolId, tool);
    addToNameIndex(tool.name || toolId, toolId);

    logger.debug(`[Tools] 已注册工具: ${toolId} (${tool.type})`);

    eventBus.emit('tool:registered', { toolId, type: tool.type || 'builtin' });
}

/**
 * 注册内置工具（向后兼容旧的 { definition, handler } 格式）
 * @param {string} toolId - 工具 ID
 * @param {Object} toolDefinition - 工具定义
 * @param {Function} handler - 处理函数
 */
export function registerBuiltinTool(toolId, toolDefinition, handler) {
    const tool = buildToolFromLegacy(toolId, toolDefinition, handler);
    registerTool(tool);
}

/**
 * 注册 MCP 工具（含远程 call 代理）
 * @param {string} serverId - MCP 服务器 ID
 * @param {string} toolName - 工具名称
 * @param {Object} toolDefinition - MCP 工具定义
 * @returns {string} 工具 ID
 */
export async function registerMCPTool(serverId, toolName, toolDefinition) {
    const toolId = `${serverId}__${toolName}`;

    // 确定初始启用状态
    let enabled = false;

    if (_preloadedStates.has(toolId)) {
        enabled = normalizeToolEnabledValue(_preloadedStates.get(toolId));
        _preloadedStates.delete(toolId); // 消费后清理，防止泄漏
    } else {
        const savedStates = await loadSavedToolStates();
        const hasSavedState = savedStates
            ? Object.prototype.hasOwnProperty.call(savedStates, toolId)
            : false;
        enabled = hasSavedState ? normalizeToolEnabledValue(savedStates[toolId]) : false;
    }

    const tool = buildTool({
        id: toolId,
        name: toolName,
        description: toolDefinition.description || '',
        parameters: toolDefinition.inputSchema || { type: 'object', properties: {} },
        type: 'mcp',
        enabled,
        serverId,
        call: async (args) => {
            const fullToolId = `${serverId}/${toolName}`;
            return await mcpClient.callTool(fullToolId, args);
        }
    });

    tools.set(toolId, tool);
    addToNameIndex(toolName, toolId);

    logger.debug(
        `[Tools] 已注册 MCP 工具: ${toolId} (来自 ${serverId}), 状态: ${enabled ? '启用' : '禁用'}`
    );

    eventBus.emit('tool:registered', { toolId, type: 'mcp', serverId });

    return toolId;
}

/**
 * 注册自定义工具（用户添加）
 * @param {Object} toolConfig - 工具配置
 * @param {boolean} skipSave - 是否跳过保存
 * @returns {string} 工具 ID
 */
export function registerCustomTool(toolConfig, skipSave = false) {
    const toolId = toolConfig.id || `custom_${generateId()}`;

    const tool = buildTool({
        ...toolConfig,
        id: toolId,
        name: toolConfig.name || toolId,
        description: toolConfig.description || '',
        parameters: toolConfig.parameters ||
            toolConfig.inputSchema || { type: 'object', properties: {} },
        type: 'custom',
        enabled: toolConfig.enabled !== false,
        call: async () => {
            throw new Error(
                `自定义工具 "${toolConfig.name || toolId}" 无本地处理器，由 API 后端执行`
            );
        }
    });

    tools.set(toolId, tool);
    addToNameIndex(tool.name || toolId, toolId);

    logger.debug(`[Tools] 已注册自定义工具: ${toolId}`);

    if (!skipSave) {
        saveCustomTools();
    }

    eventBus.emit('tool:registered', { toolId, type: 'custom' });

    return toolId;
}

// ========== 工具查询 API ==========

/**
 * 获取所有工具
 * @returns {Array}
 */
export function getAllTools() {
    return Array.from(tools.values());
}

/**
 * 获取所有已启用的工具
 * @returns {Array}
 */
export function getEnabledTools() {
    return Array.from(tools.values()).filter((tool) => tool.enabled === true);
}

/**
 * 根据 API 格式获取工具列表
 * @param {string} apiFormat - 'openai' | 'gemini' | 'claude' | 'openai-responses' | 'openclaw'
 * @returns {Array}
 */
export function getToolsForAPI(apiFormat) {
    let enabledTools = getEnabledTools();

    // Computer Use 特殊处理
    if (apiFormat === 'claude' && !state.xmlToolCallingEnabled) {
        enabledTools = enabledTools.filter((tool) => tool.name !== 'computer');
    } else if (apiFormat !== 'claude') {
        if (!state.computerUseEnabled) {
            enabledTools = enabledTools.filter((tool) => tool.name !== 'computer');
        }
    }

    switch (apiFormat) {
        case 'openai':
        case 'openclaw':
            return enabledTools.map(convertToOpenAIFormat);
        case 'openai-responses':
            return enabledTools.map(convertToResponsesFormat);
        case 'gemini':
            return enabledTools.map(convertToGeminiFormat);
        case 'claude':
            return enabledTools.map(convertToClaudeFormat);
        default:
            logger.warn(`[Tools] 未知 API 格式: ${apiFormat}`);
            return [];
    }
}

/**
 * 获取单个工具
 * @param {string} toolId - 工具 ID 或工具名称
 * @returns {Object|null}
 */
export function getTool(toolId) {
    // 直接 ID 查找
    const tool = tools.get(toolId);
    if (tool) return tool;

    // 名称索引查找（兼容 MCP 工具名与 ID 不一致的情况）
    if (toolNameIndex.has(toolId)) {
        const matchingIds = toolNameIndex.get(toolId);

        if (matchingIds.size > 1) {
            const sortedIds = [...matchingIds].sort();
            // 优先已启用的 MCP 工具
            for (const id of sortedIds) {
                const t = tools.get(id);
                if (t && t.type === 'mcp' && t.enabled) return t;
            }
            // 其次任意 MCP 工具
            for (const id of sortedIds) {
                const t = tools.get(id);
                if (t && t.type === 'mcp') return t;
            }
        }

        const firstId = matchingIds.values().next().value;
        if (firstId) return tools.get(firstId);
    }

    return null;
}

/**
 * 获取工具对象（与 getTool 相同，语义别名）
 * @param {string} toolId
 * @returns {Object|null}
 */
export function getToolObject(toolId) {
    return getTool(toolId);
}

/**
 * 获取工具处理器（向后兼容）
 * @param {string} toolId
 * @returns {Function|null}
 */
export function getToolHandler(toolId) {
    const tool = getTool(toolId);
    return tool?.call || null;
}

// ========== 格式转换 ==========

function convertToOpenAIFormat(tool) {
    return {
        type: 'function',
        function: {
            name: tool.name || tool.id,
            description: tool.description,
            parameters: tool.parameters ||
                tool.inputSchema ||
                tool.input_schema || { type: 'object', properties: {} }
        }
    };
}

function convertToResponsesFormat(tool) {
    return {
        type: 'function',
        name: tool.name || tool.id,
        description: tool.description,
        parameters: tool.parameters ||
            tool.inputSchema ||
            tool.input_schema || { type: 'object', properties: {} }
    };
}

function convertToGeminiFormat(tool) {
    const schema = tool.parameters ||
        tool.inputSchema ||
        tool.input_schema || { type: 'object', properties: {} };
    return {
        name: tool.name || tool.id,
        description: tool.description,
        parameters: cleanSchemaForGemini(schema)
    };
}

function cleanSchemaForGemini(schema) {
    if (!schema || typeof schema !== 'object') return schema;

    const cleaned = Array.isArray(schema) ? [...schema] : { ...schema };

    for (const combiner of ['anyOf', 'oneOf']) {
        if (Array.isArray(cleaned[combiner]) && cleaned[combiner].length > 0) {
            const candidates = cleaned[combiner].filter((s) => s && s.type !== 'null');
            if (candidates.length > 0) {
                const first = candidates[0];
                if (first.type && !cleaned.type) cleaned.type = first.type;
                if (first.properties && !cleaned.properties) cleaned.properties = first.properties;
                if (first.items && !cleaned.items) cleaned.items = first.items;
                if (first.description && !cleaned.description)
                    cleaned.description = first.description;
            }
            delete cleaned[combiner];
        }
    }

    if (Array.isArray(cleaned.allOf) && cleaned.allOf.length > 0) {
        for (const sub of cleaned.allOf) {
            if (sub && typeof sub === 'object') {
                if (sub.type && !cleaned.type) cleaned.type = sub.type;
                if (sub.properties)
                    cleaned.properties = { ...(cleaned.properties || {}), ...sub.properties };
                if (sub.required && Array.isArray(sub.required)) {
                    cleaned.required = [...new Set([...(cleaned.required || []), ...sub.required])];
                }
            }
        }
        delete cleaned.allOf;
    }

    const unsupportedFields = [
        '$schema',
        'additionalProperties',
        'title',
        'examples',
        'default',
        '$defs',
        'definitions',
        'patternProperties',
        'dependencies',
        'not'
    ];
    for (const field of unsupportedFields) delete cleaned[field];

    if (cleaned.properties && typeof cleaned.properties === 'object') {
        cleaned.properties = Object.fromEntries(
            Object.entries(cleaned.properties).map(([key, value]) => [
                key,
                cleanSchemaForGemini(value)
            ])
        );
    }
    if (cleaned.items && typeof cleaned.items === 'object') {
        cleaned.items = cleanSchemaForGemini(cleaned.items);
    }

    return cleaned;
}

function convertToClaudeFormat(tool) {
    const schema = tool.input_schema ||
        tool.inputSchema ||
        tool.parameters || { type: 'object', properties: {} };
    return {
        name: tool.name || tool.id,
        description: tool.description,
        input_schema: schema
    };
}

// ========== 工具管理 API ==========

/**
 * 启用/禁用工具
 * @param {string} toolId
 * @param {boolean} enabled
 */
export function setToolEnabled(toolId, enabled) {
    const tool = tools.get(toolId);
    if (!tool) {
        logger.warn(`[Tools] 工具不存在: ${toolId}`);
        return;
    }

    const normalizedEnabled = normalizeToolEnabledValue(enabled);
    tool.enabled = normalizedEnabled;

    logger.debug(`[Tools] 工具 "${toolId}" 已${normalizedEnabled ? '启用' : '禁用'}`);

    eventBus.emit('tool:enabled:changed', { toolId, enabled: normalizedEnabled });
    eventBus.emit('tools:updated', { toolId });

    saveToolStates();
}

/**
 * 检查工具是否启用
 * @param {string} toolId
 * @returns {boolean}
 */
export function isToolEnabled(toolId) {
    const tool = tools.get(toolId);
    return tool?.enabled === true;
}

/**
 * 移除工具
 * @param {string} toolId
 */
export function removeTool(toolId) {
    const tool = tools.get(toolId);
    if (!tool) {
        logger.warn(`[Tools] 工具不存在: ${toolId}`);
        return;
    }

    if (tool.type === 'builtin') {
        logger.warn(`[Tools] 无法移除内置工具: ${toolId}`);
        return;
    }

    if (tool.name) removeFromNameIndex(tool.name, toolId);
    tools.delete(toolId);

    logger.debug(`[Tools] 已移除工具: ${toolId}`);

    if (tool.type === 'custom') saveCustomTools();

    eventBus.emit('tool:removed', { toolId });
}

/**
 * 清空指定 MCP 服务器的所有工具
 * @param {string} serverId
 */
export async function clearMCPTools(serverId) {
    const mcpTools = Array.from(tools.values()).filter(
        (tool) => tool.type === 'mcp' && tool.serverId === serverId
    );

    // 先禁用再清除
    mcpTools.forEach((tool) => {
        tool.enabled = false;
    });
    await saveToolStates();

    mcpTools.forEach((tool) => {
        if (tool.name) removeFromNameIndex(tool.name, tool.id);
        tools.delete(tool.id);
    });

    logger.debug(`[Tools] 已清空 MCP 服务器 "${serverId}" 的 ${mcpTools.length} 个工具`);
    eventBus.emit('tool:enabled:changed', {});
}

// ========== 统计与调试 ==========

export function getToolStats() {
    const allTools = Array.from(tools.values());
    const visibleTools = allTools.filter((t) => !t.hidden);

    return {
        total: visibleTools.length,
        enabled: visibleTools.filter((t) => t.enabled).length,
        builtin: visibleTools.filter((t) => t.type === 'builtin').length,
        mcp: visibleTools.filter((t) => t.type === 'mcp').length,
        custom: visibleTools.filter((t) => t.type === 'custom').length
    };
}

export async function cleanupExpiredToolStates() {
    try {
        const savedStates = await loadSavedToolStates();
        if (!savedStates) return;

        let cleanedCount = 0;
        const activeToolIds = new Set(tools.keys());

        for (const toolId of Object.keys(savedStates)) {
            if (!activeToolIds.has(toolId)) {
                delete savedStates[toolId];
                cleanedCount++;
            }
        }

        if (cleanedCount > 0) {
            await savePreference('toolsEnabled', JSON.stringify(savedStates));
            logger.debug(`[Tools] 已清理 ${cleanedCount} 个过期工具状态`);
        }
    } catch (error) {
        logger.error('[Tools] 清理过期工具状态失败:', error);
    }
}

export function debugTools() {
    logger.debug('工具管理器状态:');
    logger.debug(getToolStats());
    logger.debug('已注册工具:');

    tools.forEach((tool, id) => {
        logger.debug(`  ${tool.enabled ? '✅' : '⭕'} [${tool.type}] ${id} - ${tool.description}`);
    });
}

// ========== MCP 集成 ==========

export async function syncMCPTools(serverId) {
    // 清理该服务器旧工具（保留状态到 _preloadedStates）
    const oldTools = Array.from(tools.values()).filter(
        (tool) => tool.type === 'mcp' && tool.serverId === serverId
    );
    oldTools.forEach((tool) => {
        // 保存当前状态到预加载缓存
        _preloadedStates.set(tool.id, tool.enabled);
        if (tool.name) removeFromNameIndex(tool.name, tool.id);
        tools.delete(tool.id);
    });

    // 从 MCP 客户端获取新工具
    const mcpTools = mcpClient.getToolsByServer(serverId);

    for (const tool of mcpTools) {
        await registerMCPTool(serverId, tool.name, tool.mcpDefinition);
    }

    logger.debug(`[Tools] 已同步 ${mcpTools.length} 个工具 (MCP 服务器: ${serverId})`);

    // 同步后恢复持久化状态
    const toolsWithSavedState = new Set();
    try {
        const savedStates = await loadSavedToolStates();
        if (savedStates) {
            let restoredCount = 0;
            for (const tool of mcpTools) {
                const toolId = `${serverId}__${tool.name}`;
                const t = tools.get(toolId);
                if (t && savedStates[toolId] !== undefined) {
                    toolsWithSavedState.add(toolId);
                    const savedState = normalizeToolEnabledValue(savedStates[toolId]);
                    if (t.enabled !== savedState) {
                        t.enabled = savedState;
                        restoredCount++;
                    }
                }
            }
            if (restoredCount > 0) {
                logger.debug(`[Tools] 额外恢复了 ${restoredCount} 个工具状态`);
                eventBus.emit('tool:enabled:changed', {});
            }
        }
    } catch (error) {
        logger.error('[Tools] 恢复 MCP 工具状态失败:', error);
    }

    // 自动启用该服务器的新工具（跳过已有持久化状态的工具）
    let autoEnabledCount = 0;
    for (const tool of mcpTools) {
        const toolId = `${serverId}__${tool.name}`;
        if (toolsWithSavedState.has(toolId)) continue;
        const t = tools.get(toolId);
        if (t && !t.enabled) {
            t.enabled = true;
            autoEnabledCount++;
        }
    }
    if (autoEnabledCount > 0) {
        logger.debug(`[Tools] 自动启用 ${autoEnabledCount} 个 MCP 工具 (${serverId})`);
        await saveToolStates();
    }

    eventBus.emit('tool:enabled:changed', {});
}

export function getMCPToolHandler(toolId) {
    const tool = tools.get(toolId);
    if (!tool || tool.type !== 'mcp') return null;
    return tool.call;
}

// MCP 事件监听
eventBus.on('mcp:tools-discovered', async ({ serverId, tools: discoveredTools }) => {
    logger.debug(`[Tools] 检测到 MCP 工具发现: ${serverId} (${discoveredTools.length} 个)`);
    await syncMCPTools(serverId);
});

eventBus.on('mcp:disconnected', async ({ serverId }) => {
    logger.debug(`[Tools] MCP 断开连接: ${serverId}`);
    await clearMCPTools(serverId);
});

// ========== 持久化 ==========

async function loadSavedToolStates() {
    try {
        const statesRaw = await loadPreference('toolsEnabled');
        return parseSavedToolStates(statesRaw);
    } catch (error) {
        logger.error('[Tools] 读取工具状态失败:', error);
        return null;
    }
}

async function saveToolStates() {
    try {
        const states = {};
        tools.forEach((tool, toolId) => {
            if (tool.hidden) return;
            states[toolId] = normalizeToolEnabledValue(tool.enabled);
        });

        await savePreference('toolsEnabled', JSON.stringify(states));
    } catch (error) {
        logger.error('[Tools] 保存工具状态失败:', error);
    }
}

/**
 * 从持久化存储加载工具启用状态
 * @param {boolean} includeUnregistered - 是否预加载未注册工具的状态
 */
export async function loadToolStates(includeUnregistered = false) {
    try {
        const statesRaw = await loadPreference('toolsEnabled');
        const states = parseSavedToolStates(statesRaw);
        if (!states) return;

        let restoredCount = 0;
        let unregisteredCount = 0;

        for (const [toolId, enabled] of Object.entries(states)) {
            const normalizedEnabled = normalizeToolEnabledValue(enabled);
            const tool = tools.get(toolId);

            if (tool) {
                if (tool.hidden) continue;
                tool.enabled = normalizedEnabled;
                restoredCount++;
            } else if (includeUnregistered) {
                _preloadedStates.set(toolId, normalizedEnabled);
                unregisteredCount++;
            }
        }

        logger.debug(`[Tools] 已恢复 ${restoredCount} 个工具状态`);
        if (unregisteredCount > 0) {
            logger.debug(`[Tools] 预加载了 ${unregisteredCount} 个未注册工具的状态`);
        }
    } catch (error) {
        logger.error('[Tools] 加载工具状态失败:', error);
    }
}

export async function saveCustomTools() {
    try {
        const customTools = [];
        for (const [toolId, tool] of tools.entries()) {
            if (tool.type === 'custom') {
                customTools.push({
                    id: toolId,
                    name: tool.name,
                    description: tool.description,
                    parameters: tool.parameters,
                    enabled: tool.enabled,
                    permissions: tool.permissions,
                    rateLimit: tool.rateLimit
                });
            }
        }

        await savePreference('customTools', JSON.stringify(customTools));
    } catch (error) {
        logger.error('[Tools] 保存自定义工具失败:', error);
    }
}

export async function loadCustomTools() {
    try {
        const toolsJson = await loadPreference('customTools');
        if (!toolsJson) return;

        const customToolsList = JSON.parse(toolsJson);
        let loadedCount = 0;

        for (const toolConfig of customToolsList) {
            registerCustomTool(toolConfig, true);
            loadedCount++;
        }

        logger.debug(`[Tools] 已加载 ${loadedCount} 个自定义工具`);
    } catch (error) {
        logger.error('[Tools] 加载自定义工具失败:', error);
    }
}
