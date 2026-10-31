/**
 * 各家 adapter 回放历史共用的辅助：合并消息按 _turn 拆轮、工具调用能否原样回放、服务端工具转文本
 */

import { PartType, ToolMode, ToolState } from '../../messages/schema.js';

export function getPartTurn(part) {
    return part?._turn ?? 0;
}

/**
 * 工具循环续作合并成一条 assistant 消息后，按 _turn 拆回每一轮；没有 _turn 的 part 归第 0 轮
 * @param {Array} parts
 * @returns {Array<{ turn: number, parts: Array }>} 轮号升序
 */
export function splitPartsByTurn(parts) {
    const groups = new Map();
    for (const part of parts || []) {
        const turn = getPartTurn(part);
        if (!groups.has(turn)) groups.set(turn, []);
        groups.get(turn).push(part);
    }
    return [...groups.keys()]
        .sort((a, b) => a - b)
        .map((turn) => ({ turn, parts: groups.get(turn) }));
}

/**
 * 以原生调用形式回放的客户端 tool_call：XML 模式的调用经 XML 文本回放，多回复拦截的调用不回放
 */
export function isNativeToolCall(part) {
    return (
        part?.type === PartType.TOOL_CALL &&
        !part.server &&
        part.mode !== ToolMode.XML &&
        part.state !== ToolState.SKIPPED
    );
}

export function isServerToolCall(part) {
    return part?.type === PartType.TOOL_CALL && part.server === true;
}

// ========== 服务端工具转文本 ==========

const SERVER_TOOL_TEXT_LIMIT = 4000;
// 加密内容只有原服务端能解读，转成文本时剔除，避免大段无意义字符进入上下文
const OPAQUE_RESULT_KEYS = new Set(['encrypted_content', 'encrypted_index', 'data', 'signature']);

function stripOpaqueFields(value) {
    if (Array.isArray(value)) return value.map(stripOpaqueFields);
    if (!value || typeof value !== 'object') return value;
    const out = {};
    for (const [key, item] of Object.entries(value)) {
        if (!OPAQUE_RESULT_KEYS.has(key)) out[key] = stripOpaqueFields(item);
    }
    return out;
}

function compactJson(value) {
    try {
        return JSON.stringify(stripOpaqueFields(value));
    } catch {
        return '';
    }
}

function describeServerToolOutput(content) {
    if (Array.isArray(content)) {
        return content
            .map((item) => {
                if (item?.type === 'web_search_result') {
                    return `- ${item.title || item.url || ''}${item.url ? ` (${item.url})` : ''}`;
                }
                return compactJson(item);
            })
            .filter(Boolean)
            .join('\n');
    }
    if (content && typeof content === 'object') {
        if (content.error_code) return `error: ${content.error_code}`;
        const streams = ['stdout', 'stderr']
            .filter((key) => typeof content[key] === 'string' && content[key])
            .map((key) => `${key}:\n${content[key]}`);
        if (streams.length > 0) return streams.join('\n');
        if (content.type === 'web_fetch_result' && content.url) return `fetched: ${content.url}`;
    }
    if (typeof content === 'string') return content;
    return compactJson(content);
}

/**
 * 服务端工具（web_search / code_execution 等）的调用与结果转成一段文本：
 * 换到其他格式、或本次请求没有声明对应工具、或结果缺少只有原服务端能补回的加密内容时，
 * 以文本形式保留这段上下文
 * @param {Object} part 服务端工具的 tool_call part
 * @returns {string}
 */
export function describeServerToolCall(part) {
    const input = part.args && typeof part.args === 'object' ? compactJson(part.args) : '';
    const output = part.result ? describeServerToolOutput(part.result.content) : '';
    const text = [`[${part.name}] ${input}`.trim(), output].filter(Boolean).join('\n');
    return text.length > SERVER_TOOL_TEXT_LIMIT
        ? `${text.slice(0, SERVER_TOOL_TEXT_LIMIT)}\n…`
        : text;
}
