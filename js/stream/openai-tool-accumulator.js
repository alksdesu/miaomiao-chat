/**
 * OpenAI Chat Completions delta 工具调用累积器
 *
 * stream 层真职责：parser-openai 在收到 SSE 增量时累积 tool_calls[index].function.{name,arguments}
 * 直到 finish_reason==='tool_calls' 才一次性吐出 completedCalls 给 orchestrator 执行
 *
 * 与 tools/xml-formatter.js 的 XMLStreamAccumulator 形成对称：两个 accumulator 都是 parser 内部状态
 */

import { logger } from '../utils/logger.js';

/**
 * 工具调用累积器
 * 用于累积流式传输的工具调用参数（OpenAI Chat Completions delta 风格）
 */
class ToolCallAccumulator {
    constructor() {
        // Map<index, {id, name, arguments}>
        this.calls = new Map();
    }

    /**
     * 处理工具调用增量
     * @param {Array} toolCallsDeltas - 工具调用增量数组
     */
    processDelta(toolCallsDeltas) {
        if (!Array.isArray(toolCallsDeltas)) return;

        for (const delta of toolCallsDeltas) {
            const index = delta.index;

            if (!this.calls.has(index)) {
                // 初始化新的工具调用
                this.calls.set(index, {
                    id: delta.id || '',
                    type: delta.type || 'function',
                    name: '',
                    arguments: ''
                });
            }

            const call = this.calls.get(index);

            // 累积 ID
            if (delta.id) {
                call.id = delta.id;
            }

            // 累积函数名
            if (delta.function?.name) {
                call.name += delta.function.name;
            }

            // 累积参数（增量拼接）
            if (delta.function?.arguments) {
                call.arguments += delta.function.arguments;
            }
        }
    }

    /**
     * 获取所有完整的工具调用
     *
     * JSON 截断 / 解析失败的 call 标 parseError=true 让上游写回 ERROR 状态而非 args={}
     * 蒙混过关——空参数交给模型会让其用错误前提产出回复，远比让模型看到"参数解析失败"
     * 显式错误更难调试
     *
     * @returns {Array} 工具调用列表（含 parseError / parseErrorMessage 字段供 ERROR 路径使用）
     */
    getCompletedCalls() {
        const completed = [];

        for (const [index, call] of this.calls.entries()) {
            if (call.name) {
                let args = {};
                let parseError = false;
                let parseErrorMessage = '';
                let rawArguments = '';

                if (call.arguments != null && call.arguments !== '') {
                    try {
                        args = JSON.parse(call.arguments);
                    } catch (error) {
                        logger.error(
                            `[ToolCallAccumulator] 工具调用 ${index} 参数解析失败:`,
                            call.arguments
                        );
                        logger.error(error);
                        parseError = true;
                        parseErrorMessage = error?.message || String(error);
                        rawArguments = call.arguments;
                        args = {};
                    }
                }

                completed.push({
                    id: call.id,
                    type: call.type,
                    name: call.name,
                    arguments: args,
                    parseError,
                    parseErrorMessage,
                    rawArguments
                });
            }
        }

        return completed;
    }

    /**
     * 清空累积器
     */
    clear() {
        this.calls.clear();
    }
}

/**
 * 创建工具调用累积器实例
 * @returns {ToolCallAccumulator}
 */
export function createToolCallAccumulator() {
    return new ToolCallAccumulator();
}
