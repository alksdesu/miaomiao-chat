/**
 * Computer Use 工具
 * 允许 AI 执行 bash 命令和编辑文件
 * ⚠️ 仅在 Electron 环境中可用
 */

/**
 * 工具定义（OpenAI 格式）
 */
export const computerUseTool = {
    name: 'computer',
    description: '执行计算机操作：bash 命令执行和文本文件编辑。',
    parameters: {
        type: 'object',
        properties: {
            action: {
                type: 'string',
                enum: ['bash', 'str_replace_editor'],
                description: '要执行的操作类型：bash（执行命令）或 str_replace_editor（编辑文件）'
            },
            // Bash 参数
            text: {
                type: 'string',
                description: 'Bash 命令（用于 bash 动作）'
            },
            command: {
                type: 'string',
                description: '编辑器命令（用于 str_replace_editor 动作）或 bash 命令'
            },
            bash_command: {
                type: 'string',
                description: 'Bash 命令（备用字段）'
            },
            // 文本编辑器参数
            path: {
                type: 'string',
                description: '文件路径（用于文本编辑器操作）'
            },
            file_text: {
                type: 'string',
                description: '文件完整内容（用于 create 命令或 insert 命令的插入内容）'
            },
            old_str: {
                type: 'string',
                description: '要替换的旧字符串（用于 str_replace 命令）'
            },
            new_str: {
                type: 'string',
                description: '新字符串（用于 str_replace 命令）'
            },
            insert_line: {
                type: 'number',
                description: '插入位置行号（用于 insert 命令）'
            }
        },
        required: ['action']
    },
    // 标记为隐藏工具（不在工具管理面板显示）
    hidden: true
};

/**
 * 工具处理器
 * @param {Object} args - 参数
 * @returns {Promise<Object>} 执行结果
 */
export async function computerUseHandler(args) {
    const { action } = args;

    logger.debug(`[Computer Use] Action: ${action}`, args);

    // 检查是否在 Electron 环境
    if (!window.electronAPI || !window.electronAPI.isElectron()) {
        throw new Error('Computer Use 仅在 Electron 环境中可用');
    }

    try {
        switch (action) {
            case 'bash':
                return await runBashCommand(args);

            case 'str_replace_editor':
                return await runTextEditorCommand(args);

            default:
                throw new Error(
                    `Unknown action: ${action}. Only 'bash' and 'str_replace_editor' are supported.`
                );
        }
    } catch (error) {
        logger.error(`[Computer Use] Error in ${action}:`, error);
        throw error;
    }
}

// ========== 标准化工具对象 ==========

import { buildToolFromLegacy } from '../build-tool.js';
import { runBashCommand, runTextEditorCommand } from '../computer-commands.js';
import { logger } from '../../utils/logger.js';
import { state } from '../../core/state.js';

/**
 * XML 模式下模型可以写出没有声明过的工具调用，执行前必须再确认 Computer Use 仍开着
 * @returns {{ allowed: boolean, reason?: string, message?: string }}
 */
export function checkComputerUsePermission() {
    return state.computerUseEnabled
        ? { allowed: true }
        : {
              allowed: false,
              reason: 'computer_use_disabled',
              message: '无权限执行工具 "computer"：Computer Use 未开启'
          };
}

export const computerUse = buildToolFromLegacy('computer', computerUseTool, computerUseHandler, {
    hidden: true,
    enabled: true,
    checkPermissions: checkComputerUsePermission
});
