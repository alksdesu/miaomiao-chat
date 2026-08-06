/**
 * 工具执行引擎
 * 负责工具的实际执行、超时控制、错误处理
 *
 * 📚 高级执行 API（可用但未使用）：
 * - executeToolsBatch() - 批量并行执行工具
 * - safeExecuteTool() - 安全执行（不抛出异常）
 * - executeToolWithRetry() - 带重试的执行
 * - executeCancelable() - 可取消的执行
 * - cancelToolExecution() - 取消工具执行
 *
 * 💡 未来可以在以下场景使用：
 * - 批量工具调用优化（使用 executeToolsBatch）
 * - 增强错误恢复（使用 executeToolWithRetry）
 * - 长时间运行的工具（使用 executeCancelable）
 */

import { getTool } from './manager.js';
import { safeValidate, formatValidationErrors } from './validator.js';
import { checkRateLimit } from './rate-limiter.js';
import { state } from '../core/state.js';
import { checkToolPermission, confirmToolExecutionIfRequired } from './permissions.js';
import { recordToolCall } from './history.js';
import { isElectron } from '../utils/platform.js';
import { logger } from '../utils/logger.js';

// ========== 配置 ==========

const DEFAULT_TIMEOUT = 30000; // 30秒
const MCP_TIMEOUT = 180000; // MCP 工具 3 分钟（与 MCP 客户端 toolCallTimeout 一致）
const MAX_TIMEOUT = 180000; // 最大3分钟

// ========== Claude 原生工具执行 ==========

/**
 * 执行 Claude 原生工具（computer, bash, text_editor）
 * @param {string} toolName - 工具名称
 * @param {Object} args - 工具参数
 * @returns {Promise<Object>} 执行结果
 */
async function executeNativeTool(toolName, args) {
    // 检查是否在 Electron 环境
    if (!isElectron()) {
        throw new Error(`原生工具 "${toolName}" 仅在 Electron 环境中可用`);
    }

    switch (toolName) {
        case 'computer':
            return await executeComputerTool(args);

        case 'bash':
            return await executeBashTool(args);

        case 'str_replace_based_edit_tool':
            return await executeTextEditorTool(args);

        default:
            throw new Error(`未知的原生工具: ${toolName}`);
    }
}

/**
 * 执行 computer 工具
 * 参考：https://platform.claude.com/docs/zh-CN/agents-and-tools/tool-use/computer-use-tool
 */
async function executeComputerTool(args) {
    const { action } = args;

    // 增强错误提示
    if (!action) {
        const availableParams = Object.keys(args).join(', ');
        throw new Error(
            `Missing required parameter 'action' for computer tool. ` +
                `Received parameters: ${availableParams || 'none'}. ` +
                `Expected format: { action: 'screenshot' | 'bash' | 'mouse_move' | 'type' | ..., ... }`
        );
    }

    switch (action) {
        case 'screenshot':
            return await window.electronAPI.computerUse_screenshot();

        case 'mouse_move': {
            const [x, y] = args.coordinate || [0, 0];
            return await window.electronAPI.computerUse_moveMouse(x, y);
        }

        case 'left_click':
        case 'right_click':
        case 'middle_click': {
            const button = action.replace('_click', '');
            if (args.coordinate) {
                const [x, y] = args.coordinate;
                await window.electronAPI.computerUse_moveMouse(x, y);
            }
            return await window.electronAPI.computerUse_clickMouse(button);
        }

        case 'double_click':
        case 'triple_click': {
            const times = action === 'double_click' ? 2 : 3;
            if (args.coordinate) {
                const [x, y] = args.coordinate;
                await window.electronAPI.computerUse_moveMouse(x, y);
            }
            // 连续点击
            for (let i = 0; i < times; i++) {
                await window.electronAPI.computerUse_clickMouse('left');
                if (i < times - 1) await new Promise((r) => setTimeout(r, 50));
            }
            return { success: true };
        }

        case 'left_click_drag': {
            const [fromX, fromY] = args.coordinate || [0, 0];
            const [toX, toY] = args.end_coordinate || args.coordinate || [0, 0];
            return await window.electronAPI.computerUse_dragMouse(fromX, fromY, toX, toY);
        }

        case 'left_mouse_down': {
            const [x, y] = args.coordinate || [0, 0];
            await window.electronAPI.computerUse_moveMouse(x, y);
            // 简单实现：目前Electron API可能不支持单独的down/up
            logger.warn('[Executor] left_mouse_down 操作：当前简化为移动鼠标');
            return { success: true };
        }

        case 'left_mouse_up':
            logger.warn('[Executor] left_mouse_up 操作：当前简化实现');
            return { success: true };

        case 'scroll': {
            const direction = args.scroll_direction || 'down';
            const amount = args.scroll_amount || 1;
            // 简单实现：使用keyboard模拟滚动
            const key =
                direction === 'down' || direction === 'up'
                    ? direction === 'down'
                        ? 'Page_Down'
                        : 'Page_Up'
                    : direction === 'right'
                      ? 'Right'
                      : 'Left';

            for (let i = 0; i < amount; i++) {
                await window.electronAPI.computerUse_pressKey(key, []);
                await new Promise((r) => setTimeout(r, 100));
            }
            return { success: true };
        }

        case 'type':
            return await window.electronAPI.computerUse_typeText(args.text);

        case 'key':
            return await window.electronAPI.computerUse_pressKey(args.key, args.modifiers || []);

        case 'hold_key':
            // 简单实现：暂不支持真正的hold
            logger.warn('[Executor] hold_key 操作：当前简化为按键');
            return await window.electronAPI.computerUse_pressKey(args.key, []);

        case 'wait': {
            const duration = args.duration || 1;
            await new Promise((r) => setTimeout(r, duration * 1000));
            return { success: true };
        }

        case 'zoom': {
            // Opus 4.5专用：缩放功能
            logger.warn('[Executor] zoom 操作：当前不支持，需要特殊实现');
            throw new Error('Zoom操作需要特殊的图像处理支持，当前版本暂不支持');
        }

        case 'cursor_position':
            // 获取当前鼠标位置（如果有 API 支持）
            return { x: 0, y: 0 };

        default:
            throw new Error(
                `Unknown computer action: "${action}". ` +
                    `Valid actions: screenshot, mouse_move, left_click, right_click, middle_click, ` +
                    `double_click, triple_click, type, key, cursor_position, bash, str_replace_editor, etc.`
            );
    }
}

/**
 * 执行 bash 工具
 */
async function executeBashTool(args) {
    // 支持多种参数字段名（向后兼容）
    const command = args.command || args.text || args.bash_command;
    const { restart } = args;

    if (!command) {
        throw new Error(
            'Missing bash command parameter. Expected one of: command, text, or bash_command'
        );
    }

    if (restart) {
        logger.warn('[Executor] Bash restart 参数被忽略');
    }

    const result = await window.electronAPI.computerUse_executeBash(command);
    return result;
}

/**
 * 执行 text_editor 工具
 */
async function executeTextEditorTool(args) {
    const { command, path } = args;

    switch (command) {
        case 'view':
            return await window.electronAPI.computerUse_readFile(path);

        case 'create':
            return await window.electronAPI.computerUse_writeFile(path, args.file_text || '');

        case 'str_replace': {
            // 先读取文件
            const readResult = await window.electronAPI.computerUse_readFile(path);
            if (!readResult.success) {
                throw new Error(`读取文件失败: ${readResult.error}`);
            }

            // 验证 old_str 唯一性
            const occurrences = readResult.content.split(args.old_str).length - 1;
            if (occurrences === 0) {
                throw new Error('old_str not found in file');
            } else if (occurrences > 1) {
                throw new Error(
                    `old_str found ${occurrences} times, must be unique. Use more context to make it unique.`
                );
            }

            // 执行替换
            const newContent = readResult.content.replace(args.old_str, args.new_str);

            // 写回文件
            return await window.electronAPI.computerUse_writeFile(path, newContent);
        }

        case 'insert': {
            // 先读取文件
            const readResult2 = await window.electronAPI.computerUse_readFile(path);
            if (!readResult2.success) {
                throw new Error(`读取文件失败: ${readResult2.error}`);
            }

            // 在指定行插入
            const lines = readResult2.content.split('\n');
            lines.splice(args.insert_line, 0, args.new_str);
            const newContent2 = lines.join('\n');

            // 写回文件
            return await window.electronAPI.computerUse_writeFile(path, newContent2);
        }

        case 'undo_edit':
            // 简单实现：不支持撤销
            throw new Error('Text editor undo_edit 操作暂不支持');

        default:
            throw new Error(`未知的 text_editor 操作: ${command}`);
    }
}

// ========== 工具执行 API ==========

/**
 * 执行工具
 * @param {string} toolId - 工具 ID
 * @param {Object} args - 工具参数
 * @param {Object} options - 执行选项
 * @param {AbortSignal} [options.signal] - 外部取消信号；abort 时 race 进 executeWithTimeout
 *   内部 AbortController，tool.call({signal}) 收到合并 signal 后可立即停止长跑操作
 * @param {number} [options.timeout] - 自定义超时（毫秒，上限 MAX_TIMEOUT）
 * @returns {Promise<Object>} 执行结果
 */
export async function executeTool(toolId, args, options = {}) {
    const startTime = Date.now();
    const apiFormat = options.apiFormat ?? state.apiFormat;
    const isXmlMode = options.isXmlMode ?? state.xmlToolCallingEnabled;
    const sessionId = options.sessionId ?? state.currentSessionId;

    // 特殊处理：Claude 原生工具（computer, bash, text_editor）
    // 这些工具通过 beta header 启用，只在 Claude 原生模式下使用
    // ⭐ XML 模式下即使是 Claude 也使用自定义工具
    const nativeTools = ['computer', 'bash', 'str_replace_based_edit_tool'];
    const isClaudeNativeMode = apiFormat === 'claude' && !isXmlMode;

    // 只有在 Claude 原生模式下才将这些工具名当作原生工具处理
    if (nativeTools.includes(toolId) && isClaudeNativeMode) {
        logger.debug(`[Executor] 🚀 执行 Claude 原生工具: ${toolId}`);
        logger.debug(`[Executor] 参数:`, args);

        try {
            // gate: 权限检查（与主分支等价，不进入 getTool 路径所以独立执行）
            const permission = checkToolPermission(toolId, toolId);
            if (!permission.allowed) {
                const reason = permission.message || `无权限执行工具: ${toolId}`;
                logger.warn(`[Executor] Claude native ${toolId} 被拒：${reason}`);
                throw new Error(reason);
            }

            // gate: 用户确认（内部承载 sessionAllow 缓存 + toolPermissions/bashConfig OR 逻辑）
            const approved = await confirmToolExecutionIfRequired(toolId, toolId, args, {
                signal: options.signal,
                sessionId: options.sessionId,
                turnId: options.turnId
            });
            if (!approved) {
                const reason = `用户拒绝执行工具 "${toolId}"`;
                logger.warn(`[Executor] Claude native ${toolId} 被拒：${reason}`);
                throw new Error(reason);
            }

            const result = await executeNativeTool(toolId, args);
            const duration = Date.now() - startTime;

            logger.debug(`[Executor] 工具执行成功: ${toolId} (耗时 ${duration}ms)`);
            logger.debug(`[Executor] 结果:`, result);

            // 记录到历史（与主分支对齐）
            try {
                recordToolCall({
                    sessionId,
                    toolId,
                    toolName: toolId,
                    args,
                    result,
                    success: true,
                    duration
                });
            } catch (err) {
                if (err instanceof SyntaxError) {
                    logger.error('[Executor] ❌ 历史模块存在语法错误:', err);
                } else {
                    logger.warn('[Executor] ⚠️ 记录历史失败:', err.message);
                }
            }

            return result;
        } catch (error) {
            const duration = Date.now() - startTime;
            logger.error(
                `[Executor] ❌ Claude native 工具执行失败: ${toolId} (耗时 ${duration}ms)`
            );
            logger.error(error);

            // 失败也记录（与主分支 catch 路径对齐）
            try {
                recordToolCall({
                    sessionId,
                    toolId,
                    toolName: toolId,
                    args,
                    result: null,
                    success: false,
                    duration,
                    error: error.message
                });
            } catch (err) {
                if (err instanceof SyntaxError) {
                    logger.error('[Executor] ❌ 历史模块存在语法错误:', err);
                } else {
                    logger.warn('[Executor] ⚠️ 记录历史失败:', err.message);
                }
            }

            throw error;
        }
    }

    // XML 模式下的提示
    if (nativeTools.includes(toolId) && apiFormat === 'claude' && isXmlMode) {
        logger.debug(`[Executor] 💬 XML 模式：使用自定义工具 "${toolId}"（非 Claude 原生工具）`);
    }

    // 获取工具定义
    // getTool 已经支持通过名称查找和MCP工具ID格式转换
    const tool = getTool(toolId);
    if (!tool) {
        // 如果是MCP工具格式（serverId/toolName），尝试转换为双下划线格式
        if (toolId.includes('/')) {
            const [serverId, toolName] = toolId.split('/');
            const mcpToolId = `${serverId}__${toolName}`;
            const mcpTool = getTool(mcpToolId);
            if (mcpTool) {
                logger.debug(`[Executor] 🔄 转换MCP工具ID: ${toolId} -> ${mcpToolId}`);
                return await executeTool(mcpToolId, args, options);
            }
        }
        throw new Error(`工具不存在: ${toolId}`);
    }

    const toolName = tool.name || toolId;

    logger.debug(`[Executor] 🚀 开始执行工具: ${toolName}`);
    logger.debug(`[Executor] 参数:`, args);

    try {
        // 1. 权限检查
        try {
            const permission = checkToolPermission(toolId, toolName);

            if (!permission.allowed) {
                logger.error(`[Executor] ❌ 权限拒绝: ${toolName}`);
                logger.error(permission.message || '无权限执行此工具');

                throw new Error(permission.message || `无权限执行工具: ${toolName}`);
            }

            // requireConfirmation 开启时弹窗等待用户批准，拒绝走 ERROR 路径让 LLM 知道。
            // 透传 options.signal 让用户点停止按钮 / 切走会话时关闭对话框，避免永久 RUNNING
            const approved = await confirmToolExecutionIfRequired(toolId, toolName, args, {
                signal: options.signal,
                sessionId: options.sessionId,
                turnId: options.turnId
            });
            if (!approved) {
                logger.warn(`[Executor] ❌ 用户拒绝执行: ${toolName}`);
                throw new Error(`用户拒绝执行工具 "${toolName}"`);
            }
        } catch (err) {
            // 如果是权限拒绝 / 用户拒绝错误，直接抛出
            if (
                err.message &&
                (err.message.includes('无权限') || err.message.includes('用户拒绝'))
            ) {
                throw err;
            }
            // 模块导入失败（语法错误、文件缺失）- 这是严重错误
            if (err instanceof SyntaxError || err.message.includes('Cannot find module')) {
                logger.error('[Executor] ❌ 权限模块加载失败（严重错误）:', err);
                throw new Error(`权限系统故障，无法执行工具: ${err.message}`);
            }
            // 其他未知错误，记录警告但允许继续（降级模式）
            logger.warn('[Executor] ⚠️ 权限检查失败，降级为默认允许模式:', err.message);
        }

        // 2. 速率限制检查
        if (tool.rateLimit) {
            try {
                checkRateLimit(toolId, tool.rateLimit);
            } catch (err) {
                logger.error(`[Executor] ❌ 速率限制: ${toolName}`);
                logger.error(err.message);
                throw err; // 抛出速率限制错误
            }
        }

        // 3. 参数验证
        const validation = safeValidate(args, tool.inputSchema);
        if (!validation.valid) {
            const errorMsg = formatValidationErrors(validation.errors);
            logger.error(`[Executor] ❌ 参数验证失败: ${toolName}`);
            logger.error(errorMsg);

            throw new Error(errorMsg);
        }

        // 4. 执行工具（带超时 + 外部 abort）— MCP 工具使用更长的超时
        // orchestrator 传的是裸工具名（不含 serverId__ 前缀），必须按注册类型判定
        const isMCP = tool.type === 'mcp';
        const defaultTimeout = isMCP ? MCP_TIMEOUT : DEFAULT_TIMEOUT;
        const timeout = Math.min(options.timeout || defaultTimeout, MAX_TIMEOUT);
        const result = await executeWithTimeout(tool, args, timeout, options.signal);

        const duration = Date.now() - startTime;

        logger.debug(`[Executor] 工具执行成功: ${toolName} (耗时 ${duration}ms)`);
        logger.debug(`[Executor] 结果:`, result);

        // 记录到历史
        try {
            recordToolCall({
                sessionId,
                toolId,
                toolName,
                args,
                result,
                success: true,
                duration
            });
        } catch (err) {
            // 历史记录失败不影响工具执行，但语法错误应明确记录
            if (err instanceof SyntaxError) {
                logger.error('[Executor] ❌ 历史模块存在语法错误:', err);
            } else {
                logger.warn('[Executor] ⚠️ 记录历史失败:', err.message);
            }
        }

        return result;
    } catch (error) {
        const duration = Date.now() - startTime;

        logger.error(`[Executor] ❌ 工具执行失败: ${toolName} (耗时 ${duration}ms)`);
        logger.error(error);

        // 记录到历史
        try {
            recordToolCall({
                sessionId,
                toolId,
                toolName,
                args,
                result: null,
                success: false,
                duration,
                error: error.message
            });
        } catch (err) {
            // 历史记录失败不影响错误抛出，但语法错误应明确记录
            if (err instanceof SyntaxError) {
                logger.error('[Executor] ❌ 历史模块存在语法错误:', err);
            } else {
                logger.warn('[Executor] ⚠️ 记录历史失败:', err.message);
            }
        }

        throw error;
    }
}

/**
 * 带超时 + 外部取消的工具执行
 *
 * 内部 AbortController 同时承载 timeout 触发 + 外部 signal forward：
 * - tool.call({ signal }) 拿到的 signal 在任一条件触发时 aborted=true，长跑工具可主动停止
 * - timeoutPromise / externalAbortPromise 任一 reject 让 Promise.race 立即返回
 * - 外部 signal 已 aborted 时直接抛 AbortError，连 tool.call 都不调用
 */
async function executeWithTimeout(tool, args, timeout, externalSignal = null) {
    if (typeof tool.call !== 'function') {
        throw new Error(`工具处理器不存在: ${tool.id}`);
    }

    // 已 abort 短路，避免无谓的工具启动
    if (externalSignal?.aborted) {
        throw new DOMException('Tool execution aborted', 'AbortError');
    }

    const abortController = new AbortController();
    const { signal } = abortController;

    // 收集所有挂在 externalSignal 上的 listener，正常完成路径统一移除避免内存泄漏。
    // 之前 detachExternal 只清第一个 forward listener，externalAbortPromise 内的匿名
    // onAbort 永久滞留 → 长会话多次工具调用 → signal 累积 N 个 listener
    const externalListeners = [];
    const detachExternal = () => {
        if (!externalSignal) return;
        for (const fn of externalListeners) {
            externalSignal.removeEventListener('abort', fn);
        }
        externalListeners.length = 0;
    };
    if (externalSignal) {
        const forwardAbort = () => abortController.abort();
        externalSignal.addEventListener('abort', forwardAbort, { once: true });
        externalListeners.push(forwardAbort);
    }

    const executePromise = tool.call(args, { signal });

    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
            abortController.abort();
            reject(new Error(`工具执行超时 (${timeout}ms)`));
        }, timeout);
    });

    // 外部 signal abort 时显式 reject Promise.race，避免 tool.call 不响应 signal 时永久挂起
    const externalAbortPromise = new Promise((_, reject) => {
        if (!externalSignal) return;
        if (externalSignal.aborted) {
            reject(new DOMException('Tool execution aborted', 'AbortError'));
            return;
        }
        const onAbort = () => reject(new DOMException('Tool execution aborted', 'AbortError'));
        externalSignal.addEventListener('abort', onAbort, { once: true });
        externalListeners.push(onAbort);
    });

    try {
        const result = await Promise.race([executePromise, timeoutPromise, externalAbortPromise]);
        clearTimeout(timeoutId);
        detachExternal();
        return result;
    } catch (error) {
        clearTimeout(timeoutId);
        detachExternal();
        abortController.abort();
        throw error;
    }
}

/**
 * 批量执行工具（并行）
 * @param {Array<{toolId: string, args: Object}>} toolCalls - 工具调用列表
 * @param {Object} options - 执行选项
 * @returns {Promise<Array>} 结果列表
 */
export async function executeToolsBatch(toolCalls, options = {}) {
    logger.debug(`[Executor] 🔄 并行执行 ${toolCalls.length} 个工具`);

    const promises = toolCalls.map(({ toolId, args }) =>
        executeTool(toolId, args, options)
            .then((result) => ({ success: true, toolId, result }))
            .catch((error) => ({ success: false, toolId, error: error.message }))
    );

    const results = await Promise.all(promises);

    const successCount = results.filter((r) => r.success).length;
    logger.debug(`[Executor] 批量执行完成: ${successCount}/${toolCalls.length} 成功`);

    return results;
}

/**
 * 安全执行工具（不抛出异常）
 * @param {string} toolId - 工具 ID
 * @param {Object} args - 参数
 * @param {Object} options - 执行选项
 * @returns {Promise<{success: boolean, result?: Object, error?: string}>}
 */
export async function safeExecuteTool(toolId, args, options = {}) {
    try {
        const result = await executeTool(toolId, args, options);
        return { success: true, result };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

// ========== 工具重试机制 ==========

/**
 * 带重试的工具执行
 * @param {string} toolId - 工具 ID
 * @param {Object} args - 参数
 * @param {Object} options - 执行选项
 * @returns {Promise<Object>} 执行结果
 */
export async function executeToolWithRetry(toolId, args, options = {}) {
    const maxRetries = options.maxRetries || 3;
    const retryDelay = options.retryDelay || 1000;

    let lastError;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            logger.debug(`[Executor] 尝试 ${attempt}/${maxRetries}: ${toolId}`);
            return await executeTool(toolId, args, options);
        } catch (error) {
            lastError = error;

            // 用户取消/拒绝/权限拒绝不是瞬态故障，重试只会连环弹确认框
            if (
                error.name === 'AbortError' ||
                (error.message &&
                    (error.message.includes('用户拒绝') || error.message.includes('无权限')))
            ) {
                throw error;
            }

            if (attempt < maxRetries) {
                const backoff = retryDelay * 2 ** (attempt - 1);
                logger.warn(`[Executor] ⚠️ 第 ${attempt} 次尝试失败，${backoff}ms 后重试...`);
                await delay(backoff); // 指数退避
            }
        }
    }

    logger.error(`[Executor] ❌ 工具执行失败（已重试 ${maxRetries} 次）: ${toolId}`);
    throw lastError;
}

/**
 * 延迟函数
 * @param {number} ms - 毫秒数
 * @returns {Promise<void>}
 */
function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// ========== 工具取消 ==========

// 存储当前执行的工具（用于取消）
const runningTools = new Map();

/**
 * 可取消的工具执行
 * @param {string} executionId - 执行 ID
 * @param {string} toolId - 工具 ID
 * @param {Object} args - 参数
 * @param {Object} options - 执行选项
 * @returns {Promise<Object>} 执行结果
 */
export async function executeCancelable(executionId, toolId, args, options = {}) {
    // 创建取消控制器
    const cancelController = {
        canceled: false,
        cancel() {
            this.canceled = true;
        }
    };

    runningTools.set(executionId, cancelController);

    try {
        // 在执行前检查是否已取消
        if (cancelController.canceled) {
            return { canceled: true };
        }

        const result = await executeTool(toolId, args, options);

        // 检查执行后是否被取消
        if (cancelController.canceled) {
            return { canceled: true };
        }

        return result;
    } finally {
        runningTools.delete(executionId);
    }
}

/**
 * 取消工具执行
 * @param {string} executionId - 执行 ID
 * @returns {boolean} 是否成功取消
 */
export function cancelToolExecution(executionId) {
    const controller = runningTools.get(executionId);

    if (controller) {
        controller.cancel();
        logger.debug(`[Executor] 🛑 已取消工具执行: ${executionId}`);
        return true;
    }

    return false;
}
