/**
 * 工具系统初始化
 * 注册所有内置工具
 */

import { registerTool, loadToolStates, loadCustomTools } from './manager.js';
import { calculator } from './builtin/calculator.js';
import { datetime } from './builtin/datetime.js';
import { unitConverter } from './builtin/unit-converter.js';
import { textFormatter } from './builtin/text-formatter.js';
import { randomGenerator } from './builtin/random-generator.js';
import { isElectron } from '../utils/platform.js';
import { logger } from '../utils/logger.js';

/**
 * 初始化工具系统
 */
export async function initTools() {
    logger.debug('[Tools] 初始化工具系统...');

    // 注册内置工具
    await registerBuiltins();

    // 加载自定义工具
    try {
        await loadCustomTools();
    } catch (error) {
        logger.warn('[Tools] 加载自定义工具失败:', error);
    }

    // 加载工具启用状态（包括未注册的工具，为稍后的 MCP 连接做准备）
    try {
        await loadToolStates(true);
    } catch (error) {
        logger.warn('[Tools] 加载工具状态失败:', error);
    }

    // 加载工具调用历史
    try {
        const { loadToolHistory } = await import('./history.js');
        await loadToolHistory();
    } catch (error) {
        logger.warn('[Tools] 加载历史记录失败:', error);
    }

    // 暴露调试函数到控制台
    if (typeof window !== 'undefined') {
        window.getToolSystemStatus = getToolSystemStatus;
    }

    logger.debug('[Tools] 工具系统初始化完成');
}

/**
 * 注册所有内置工具
 */
async function registerBuiltins() {
    registerTool(calculator);
    registerTool(datetime);
    registerTool(unitConverter);
    registerTool(textFormatter);
    registerTool(randomGenerator);

    // Computer Use 工具（仅 Electron 环境）
    if (isElectron()) {
        const { computerUse } = await import('./builtin/computer-use.js');
        registerTool(computerUse);

        // 立即启用（hidden 工具，不在管理面板显示）
        const { setToolEnabled } = await import('./manager.js');
        setToolEnabled('computer', true);

        logger.debug('[Tools] Computer Use 工具已注册并启用');
    }

    const baseCount = 5;
    const cuCount = isElectron() ? 1 : 0;

    // DevTools Monitor 工具
    const { registerDevToolsTools } = await import('../devtools/tools/index.js');
    registerDevToolsTools();

    logger.debug(`[Tools] 已注册 ${baseCount + cuCount + 7} 个内置工具`);
}

/**
 * 获取工具系统状态
 * @returns {Promise<Object>}
 */
export async function getToolSystemStatus() {
    const { getToolStats, debugTools } = await import('./manager.js');

    return {
        initialized: true,
        stats: getToolStats(),
        debug: debugTools()
    };
}
