/**
 * 工具工厂 — 统一的工具构建接口
 *
 * 所有工具通过 buildTool() 创建，自动填充安全默认值
 * 默认策略偏保守：假设非只读、不并发安全
 */

const TOOL_DEFAULTS = {
    name: '',
    description: '',
    parameters: { type: 'object', properties: {} },
    type: 'builtin',
    hidden: false,
    enabled: false,

    // 核心执行：async (args, options?) => result
    call: null,

    // 参数校验：(args) => { valid: boolean, errors?: string[] }
    validate: null,

    // 权限检查：(args) => { allowed: boolean, reason?: string, message?: string }
    checkPermissions: null,

    // 能力标识
    isReadOnly: () => false,

    // 速率限制配置：{ max: number, unit: 'minute'|'hour'|'day' } 或 null
    rateLimit: null,

    // 超时（毫秒），null 表示用 executor 默认值
    timeout: null
};

/**
 * 构建标准化工具对象
 * @param {Object} def - 工具定义（必须包含 name 和 call/handler）
 * @returns {Object} 填充了默认值的完整工具对象
 */
export function buildTool(def) {
    if (!def.name) {
        throw new Error('[buildTool] name is required');
    }

    // 兼容 handler 命名
    if (!def.call && typeof def.handler === 'function') {
        def = { ...def, call: def.handler };
    }

    if (typeof def.call !== 'function') {
        throw new Error(`[buildTool] "${def.name}" must have call()`);
    }

    const tool = { ...TOOL_DEFAULTS, ...def };

    // inputSchema 别名，兼容 MCP 格式读取
    if (!tool.inputSchema) {
        tool.inputSchema = tool.parameters;
    }

    return tool;
}

/**
 * 从旧版 { definition, handler } 格式构建标准工具对象
 * @param {string} id - 工具 ID
 * @param {Object} definition - 旧版工具定义
 * @param {Function} handler - 旧版 handler 函数
 * @param {Object} [overrides] - 额外覆盖属性（如 isReadOnly, hidden, enabled）
 * @returns {Object} 标准化工具对象
 */
export function buildToolFromLegacy(id, definition, handler, overrides) {
    return buildTool({
        id,
        name: definition.name,
        description: definition.description,
        parameters: definition.parameters || definition.inputSchema,
        hidden: definition.hidden || false,
        call: handler,
        type: 'builtin',
        ...overrides
    });
}
