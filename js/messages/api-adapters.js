/**
 * 新格式 → API 请求格式 适配器
 *
 * 运行时将统一的 parts[] 消息转换为各 API 需要的格式。
 * 每个函数接收新格式消息数组，返回对应 API 的消息数组。
 *
 * 注意：这些函数只做数据格式转换，不处理 system prompt 注入、
 * 消息过滤、签名传播等逻辑（那些仍在各 api/*.js 中处理）。
 */

import { PartType, MediaKind, Role } from './schema.js';
import { getOrCreateMappedId } from '../api/format-converter.js';
import { parseDataURL } from '../utils/file-helpers.js';
import { logger } from '../utils/logger.js';

/**
 * 判断 FILE part 是否为纯文本内容（非 base64 数据）
 * 优先读 encoding 字段，旧数据兜底用 parseDataURL 试探
 */
function isTextFile(p) {
    if (p.encoding === 'text') return true;
    if (p.encoding === 'base64') return false;
    return !parseDataURL(p.url);
}

/**
 * 检测消息是否为旧格式（无 parts 字段）
 * 旧格式消息直接透传，不做转换
 */
function isOldFormat(msg) {
    // 有 _schemaVersion 字段的是新格式（即使 parts 为空，如错误消息）
    if (msg._schemaVersion) return false;
    return !msg.parts || !Array.isArray(msg.parts) || msg.parts.length === 0;
}

/**
 * 将旧格式消息透传为 OpenAI 格式
 * 适用于 buildToolResultMessages 等产生的临时消息
 */
function passOldFormatOpenAI(msg) {
    const out = { role: msg.role };
    if (msg.content !== undefined) out.content = msg.content;
    if (msg.tool_calls) out.tool_calls = msg.tool_calls;
    if (msg.tool_call_id) out.tool_call_id = msg.tool_call_id;
    if (msg._toolName) out._toolName = msg._toolName;
    // Responses API 格式
    if (msg.type) out.type = msg.type;
    if (msg.id) out.id = msg.id;
    if (msg.call_id) out.call_id = msg.call_id;
    if (msg.name) out.name = msg.name;
    if (msg.arguments !== undefined) out.arguments = msg.arguments;
    if (msg.output !== undefined) out.output = msg.output;
    return out;
}

// ========== OpenAI 格式 ==========

/**
 * 新格式 → OpenAI Chat Completions 消息数组
 *
 * thinking parts 被忽略（reasoning 由 API 参数控制）。
 * tool_call 拆分为 assistant.tool_calls + 独立 role:"tool" 消息。
 * 旧格式消息（无 parts[]）直接透传。
 *
 * @param {Array} msgs - 新格式消息数组
 * @param {Object} [opts] - 选项
 * @param {boolean} [opts.injectReasoning] - Responses API 模式下在 assistant 消息前注入 reasoning item
 */
export function toOpenAIMessages(msgs, opts = {}) {
    const out = [];

    for (const msg of msgs) {
        if (msg.error || msg.isError) continue; // 跳过错误消息

        // 旧格式消息直接透传
        if (isOldFormat(msg)) {
            out.push(passOldFormatOpenAI(msg));
            continue;
        }

        const role = msg.role;

        // 收集内容 parts 和 tool_call parts
        const contentItems = [];
        const toolCalls = [];
        let hasToolCalls = false;

        for (const p of msg.parts || []) {
            switch (p.type) {
                case PartType.TEXT:
                    contentItems.push({ type: 'text', text: p.text });
                    break;
                case PartType.MEDIA:
                    if (p.media === MediaKind.IMAGE) {
                        contentItems.push({ type: 'image_url', image_url: { url: p.url } });
                    } else if (p.media === MediaKind.VIDEO) {
                        contentItems.push({
                            type: 'video_url',
                            video_url: { url: p.url, mime_type: p.mime }
                        });
                    } else if (p.media === MediaKind.AUDIO) {
                        // OpenAI input_audio 需要纯 base64 和简短格式名
                        const audioParsed = parseDataURL(p.url);
                        if (audioParsed) {
                            const fmt = (audioParsed.mimeType || '').split('/').pop() || 'wav';
                            contentItems.push({
                                type: 'input_audio',
                                input_audio: { data: audioParsed.base64, format: fmt }
                            });
                        }
                    }
                    break;
                case PartType.FILE: {
                    if (isTextFile(p)) {
                        contentItems.push({
                            type: 'text',
                            text: `<document name="${p.name}">\n${p.url}\n</document>`
                        });
                    } else {
                        contentItems.push({
                            type: 'file',
                            file: { filename: p.name, file_data: p.url }
                        });
                    }
                    break;
                }
                case PartType.TOOL_CALL:
                    hasToolCalls = true;
                    toolCalls.push({
                        id: p.id,
                        type: 'function',
                        function: {
                            name: p.name,
                            arguments:
                                typeof p.args === 'string' ? p.args : JSON.stringify(p.args || {})
                        }
                    });
                    break;
                // THINKING: 忽略
            }
        }

        let content;
        if (contentItems.length === 0) {
            content = '';
        } else if (contentItems.length === 1 && contentItems[0].type === 'text') {
            content = contentItems[0].text;
        } else {
            content = contentItems;
        }

        const outMsg = { role, content };
        if (hasToolCalls) outMsg.tool_calls = toolCalls;

        // Responses API：在 assistant 消息前注入 reasoning item（encrypted_content 配对约束）
        if (opts.injectReasoning && role === 'assistant') {
            const ec = msg.meta?.raw?.openai?.encryptedContent;
            if (ec) {
                const reasoningItem = { type: 'reasoning', encrypted_content: ec };
                const rid = msg.meta.raw.openai.reasoningItemId;
                if (rid) reasoningItem.id = rid;
                out.push(reasoningItem);
            }
        }

        out.push(outMsg);

        // 拆出 tool 结果为独立消息
        if (hasToolCalls) {
            for (const p of msg.parts) {
                if (p.type !== PartType.TOOL_CALL) continue;
                const resultContent = p.result
                    ? typeof p.result.content === 'string'
                        ? p.result.content
                        : JSON.stringify(p.result.content || '')
                    : 'Tool execution was interrupted';
                out.push({
                    role: 'tool',
                    tool_call_id: p.id,
                    content: resultContent,
                    _toolName: p.name
                });
            }
        }
    }

    return out;
}

// ========== Claude 格式 ==========

/**
 * 按 _turn 标记把 parts 分组成多轮。无 _turn 时全部归 turn 0。
 *
 * 旧数据兼容：检测到旧 merged 消息（无 _turn 但 thinking 数 > 1）时启发式降级——
 * 只保留最后一个 thinking 块。Claude API 要求 latest assistant message 的 thinking
 * 与原响应一致，旧数据无法精确还原 turn 边界，丢弃前序 thinking 是最安全的兜底。
 */
function groupPartsByTurn(parts) {
    const groups = new Map();
    let hasTurnTag = false;

    for (const p of parts) {
        if (p._turn !== undefined) hasTurnTag = true;
        const t = p._turn || 0;
        if (!groups.has(t)) groups.set(t, []);
        groups.get(t).push(p);
    }

    // 旧数据兜底：未标记 _turn 但含多个 thinking → 只保留最后一个
    if (!hasTurnTag) {
        const allParts = groups.get(0) || [];
        const thinkingCount = allParts.filter((p) => p.type === PartType.THINKING).length;
        if (thinkingCount > 1) {
            let toSkip = thinkingCount - 1;
            const filtered = allParts.filter((p) => {
                if (p.type === PartType.THINKING && toSkip > 0) {
                    toSkip--;
                    return false;
                }
                return true;
            });
            return new Map([[0, filtered]]);
        }
    }

    return groups;
}

/**
 * 把一组 parts 转换为 Claude content array + 收集需要配对 tool_result 的 tool_call parts
 */
function partsToClaudeContent(parts) {
    const content = [];
    const toolCallParts = [];

    for (const p of parts) {
        switch (p.type) {
            case PartType.THINKING:
                if (p.signature) {
                    content.push({
                        type: 'thinking',
                        thinking: p.text,
                        signature: p.signature
                    });
                }
                break;
            case PartType.TEXT:
                content.push({ type: 'text', text: p.text });
                break;
            case PartType.MEDIA:
                if (p.media === MediaKind.IMAGE) {
                    const parsed = parseDataURL(p.url);
                    if (parsed) {
                        content.push({
                            type: 'image',
                            source: {
                                type: 'base64',
                                media_type: parsed.mimeType,
                                data: parsed.base64
                            }
                        });
                    } else {
                        logger.warn(
                            '[Claude Adapter] 图片非 base64 格式，已降级为文本:',
                            p.url?.substring(0, 60)
                        );
                        content.push({
                            type: 'text',
                            text: '[图片附件无法发送：仅支持 base64 格式]'
                        });
                    }
                } else if (p.media === MediaKind.VIDEO || p.media === MediaKind.AUDIO) {
                    content.push({
                        type: 'text',
                        text: `[${p.media === MediaKind.VIDEO ? '视频' : '音频'}附件已省略]`
                    });
                }
                break;
            case PartType.FILE: {
                if (isTextFile(p)) {
                    content.push({
                        type: 'text',
                        text: `<document name="${p.name}">\n${p.url}\n</document>`
                    });
                } else {
                    const fileParsed = parseDataURL(p.url);
                    if (fileParsed) {
                        content.push({
                            type: 'document',
                            source: {
                                type: 'base64',
                                media_type: fileParsed.mimeType,
                                data: fileParsed.base64
                            }
                        });
                    }
                }
                break;
            }
            case PartType.TOOL_CALL: {
                if (p.server) {
                    content.push({
                        type: 'server_tool_use',
                        id: p.id,
                        name: p.name,
                        input: p.args || {}
                    });
                    if (p.result) {
                        content.push({
                            type: p.result.type || `${p.name}_tool_result`,
                            tool_use_id: p.id,
                            content: p.result.content
                        });
                    }
                } else {
                    const claudeId = getOrCreateMappedId(p.id, 'claude');
                    let input = p.args || {};
                    if (typeof input === 'string') {
                        try {
                            input = JSON.parse(input);
                        } catch {
                            /* keep string */
                        }
                    }
                    content.push({ type: 'tool_use', id: claudeId, name: p.name, input });
                    toolCallParts.push(p);
                }
                break;
            }
        }
    }

    return { content, toolCallParts };
}

/**
 * 把 tool_call parts 转为 Claude 的 user role tool_result 消息
 */
function buildClaudeToolResultMessage(toolCallParts) {
    if (toolCallParts.length === 0) return null;
    const toolResults = toolCallParts.map((p) => ({
        type: 'tool_result',
        tool_use_id: getOrCreateMappedId(p.id, 'claude'),
        content: p.result
            ? buildClaudeToolResultContent(p.result)
            : 'Tool execution was interrupted'
    }));
    return { role: 'user', content: toolResults };
}

/**
 * 处理 buildToolResultMessages 产生的旧格式临时消息
 */
function convertOldClaudeMsg(msg) {
    if (msg.role === 'tool') {
        const claudeId = msg.tool_call_id
            ? getOrCreateMappedId(msg.tool_call_id, 'claude')
            : msg.tool_call_id;
        return {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: claudeId, content: msg.content || '' }]
        };
    }
    if (msg.tool_calls && msg.tool_calls.length > 0) {
        const content = [];
        if (msg.content) content.push({ type: 'text', text: msg.content });
        for (const tc of msg.tool_calls) {
            const claudeId = getOrCreateMappedId(tc.id, 'claude');
            let input = tc.function?.arguments || '{}';
            if (typeof input === 'string') {
                try {
                    input = JSON.parse(input);
                } catch {
                    input = {};
                }
            }
            content.push({
                type: 'tool_use',
                id: claudeId,
                name: tc.function?.name || '',
                input
            });
        }
        return { role: 'assistant', content };
    }
    return passOldFormatOpenAI(msg);
}

/**
 * 新格式 → Claude API 消息数组
 *
 * 关键约束：Claude 要求 latest assistant message 的 thinking blocks 与原响应一致。
 * 工具调用 continuation 在 UI 层合并为一条消息（mergeContinuation 给新轮 parts 打 _turn），
 * 转 API 时按 _turn 拆回独立 assistant + tool_result 序列，避免触发"thinking modified"校验。
 */
export function toClaudeMessages(msgs) {
    const out = [];

    for (const msg of msgs) {
        if (msg.error || msg.isError) continue;
        if (msg.role === Role.SYSTEM) continue; // system 由顶级参数处理

        if (isOldFormat(msg)) {
            out.push(convertOldClaudeMsg(msg));
            continue;
        }

        const role = msg.role;
        const turnGroups = groupPartsByTurn(msg.parts || []);
        // 空 parts 也要产生一条空消息占位（兼容历史行为）
        if (turnGroups.size === 0) turnGroups.set(0, []);
        const sortedTurns = [...turnGroups.keys()].sort((a, b) => a - b);

        for (const turn of sortedTurns) {
            const { content, toolCallParts } = partsToClaudeContent(turnGroups.get(turn));
            if (content.length === 0) {
                content.push({ type: 'text', text: '' });
            }
            const outContent =
                content.length === 1 && content[0].type === 'text' ? content[0].text : content;
            out.push({ role, content: outContent });

            const toolResultMsg = buildClaudeToolResultMessage(toolCallParts);
            if (toolResultMsg) out.push(toolResultMsg);
        }
    }

    return out;
}

/**
 * 构建 Claude tool_result 的 content
 */
function buildClaudeToolResultContent(result) {
    if (!result) return '';

    // 有媒体时返回数组
    if (result.media && result.media.length > 0) {
        const parts = [];
        if (result.content) {
            parts.push({ type: 'text', text: result.content });
        }
        for (const m of result.media) {
            if (m.type === MediaKind.IMAGE) {
                const parsed = parseDataURL(m.url);
                if (parsed) {
                    parts.push({
                        type: 'image',
                        source: { type: 'base64', media_type: parsed.mimeType, data: parsed.base64 }
                    });
                }
            }
        }
        return parts.length > 0 ? parts : result.content || '';
    }

    return result.content || '';
}

// ========== Gemini 格式 ==========

/**
 * 新格式 → Gemini API contents 数组
 *
 * system 消息被过滤（Gemini 用 systemInstruction 参数）。
 * thinking parts 转为 parts[{text, thought:true}]。
 * tool_call 和结果在同一层级处理（model functionCall + user functionResponse）。
 */
export function toGeminiContents(msgs) {
    const out = [];

    for (const msg of msgs) {
        if (msg.error || msg.isError) continue;
        if (msg.role === Role.SYSTEM) continue;

        // 旧格式消息：转换为 Gemini 格式（buildToolResultMessages 产生的临时消息）
        if (isOldFormat(msg)) {
            const converted = convertOldMsgToGemini(msg);
            if (converted) out.push(...converted);
            continue;
        }

        // 已经是 Gemini 原生格式的消息（buildToolResultMessages 直接返回的）
        if (
            !msg._schemaVersion &&
            msg.parts &&
            msg.parts.some((p) => p.functionCall || p.functionResponse)
        ) {
            out.push(msg);
            continue;
        }

        const role = msg.role === Role.ASSISTANT ? 'model' : msg.role;
        const parts = [];
        const toolCallParts = [];
        let thoughtSignature = null;

        for (const p of msg.parts || []) {
            switch (p.type) {
                case PartType.THINKING:
                    parts.push({ text: p.text, thought: true });
                    if (p.signature) thoughtSignature = p.signature;
                    break;
                case PartType.TEXT:
                    parts.push({ text: p.text });
                    break;
                case PartType.MEDIA:
                case PartType.FILE: {
                    if (p.type === PartType.FILE && isTextFile(p)) {
                        parts.push({
                            text: `<document name="${p.name}">\n${p.url}\n</document>`
                        });
                    } else {
                        const parsed = parseDataURL(p.url);
                        if (parsed) {
                            parts.push({
                                inlineData: { mimeType: parsed.mimeType, data: parsed.base64 }
                            });
                        } else {
                            logger.warn(
                                '[Gemini Adapter] 媒体非 base64 格式，已跳过:',
                                p.name || p.url?.substring(0, 60)
                            );
                        }
                    }
                    break;
                }
                case PartType.TOOL_CALL: {
                    getOrCreateMappedId(p.id, 'gemini');
                    let args = p.args || {};
                    if (typeof args === 'string') {
                        try {
                            args = JSON.parse(args);
                        } catch {
                            args = {};
                        }
                    }
                    const callPart = {
                        functionCall: { name: p.name, args }
                    };
                    if (thoughtSignature) {
                        callPart.thoughtSignature = thoughtSignature;
                    }
                    parts.push(callPart);
                    toolCallParts.push(p);
                    break;
                }
            }
        }

        if (parts.length === 0) {
            parts.push({ text: '' });
        }

        const outMsg = { role, parts };
        if (thoughtSignature && toolCallParts.length === 0) {
            outMsg.thoughtSignature = thoughtSignature;
        }

        out.push(outMsg);

        // 拆出 tool 结果为 user 消息
        if (toolCallParts.length > 0) {
            const responseParts = [];
            for (const p of toolCallParts) {
                const geminiId = getOrCreateMappedId(p.id, 'gemini');
                const response = p.result
                    ? buildGeminiToolResponse(p.result)
                    : { content: 'Tool execution was interrupted' };
                const frPart = { functionResponse: { name: p.name, response } };
                // 只对非自动生成的 ID 传递
                if (!geminiId.startsWith('gemini_tc_')) {
                    frPart.functionResponse.id = geminiId;
                }
                responseParts.push(frPart);
            }
            if (responseParts.length > 0) {
                out.push({ role: 'user', parts: responseParts });
            }
        }
    }

    return out;
}

/**
 * 构建 Gemini functionResponse 的 response 对象
 */
function buildGeminiToolResponse(result) {
    if (!result) return { result: '' };

    // 有媒体时使用 parts 格式
    if (result.media && result.media.length > 0) {
        const parts = [];
        if (result.content) {
            parts.push({ text: result.content });
        }
        for (const m of result.media) {
            const parsed = parseDataURL(m.url);
            if (parsed) {
                parts.push({ inlineData: { mimeType: parsed.mimeType, data: parsed.base64 } });
            }
        }
        return { parts };
    }

    // 纯文本
    const content = result.content || '';
    try {
        return { result: JSON.parse(content) };
    } catch {
        return { result: content };
    }
}

function tryParseJSON(str) {
    try {
        return JSON.parse(str);
    } catch {
        return str || '';
    }
}

/**
 * 将旧格式消息转换为 Gemini contents
 * 用于 buildToolResultMessages 产生的临时消息
 * @returns {Array|null} Gemini content 数组
 */
function convertOldMsgToGemini(msg) {
    const role = msg.role === 'assistant' ? 'model' : msg.role;

    // role:"tool" → Gemini functionResponse
    if (msg.role === 'tool') {
        return [
            {
                role: 'user',
                parts: [
                    {
                        functionResponse: {
                            name: msg._toolName || 'unknown',
                            response: { result: tryParseJSON(msg.content) }
                        }
                    }
                ]
            }
        ];
    }

    const parts = [];

    // assistant 带 tool_calls → functionCall parts
    if (msg.tool_calls && msg.tool_calls.length > 0) {
        for (const tc of msg.tool_calls) {
            const rawArgs = tc.function?.arguments;
            const callPart = {
                functionCall: {
                    name: tc.function?.name || tc.name,
                    args:
                        typeof rawArgs === 'string'
                            ? tryParseJSON(rawArgs)
                            : rawArgs || tc.args || {}
                }
            };
            if (tc._thoughtSignature) callPart.thoughtSignature = tc._thoughtSignature;
            parts.push(callPart);
        }
    }

    // 文本内容
    if (msg.content && typeof msg.content === 'string' && msg.content.trim()) {
        parts.push({ text: msg.content });
    }

    if (parts.length === 0) parts.push({ text: '' });

    return [{ role, parts }];
}
