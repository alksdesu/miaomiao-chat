/**
 * 工具调用错误分类：orchestrator 按 code 决定回复模型的说法，不靠匹配错误文字
 */

export const TOOL_NOT_FOUND = 'TOOL_NOT_FOUND';

/**
 * 工具没有注册或没有处理器：模型不应再调用它
 * @param {string} message
 * @returns {Error}
 */
export function createToolNotFoundError(message) {
    const error = new Error(message);
    error.code = TOOL_NOT_FOUND;
    return error;
}

/**
 * @param {*} error
 * @returns {boolean}
 */
export function isToolNotFoundError(error) {
    return error?.code === TOOL_NOT_FOUND;
}
