/**
 * Claude Messages API Adapter — Anthropic Claude 差异化逻辑（content array + 多轮
 * _turn 拆分）。Claude 严格校验 latest assistant 的 thinking blocks 必须与原响应一致，
 * partsToAPIMessages 按 _turn 把合并消息拆回独立 assistant + tool_result 序列。
 */

import { logger } from '../../utils/logger.js';
import {
    PartType,
    MediaKind,
    Role,
    ToolMode,
    ToolState,
    SignatureFormat
} from '../../messages/schema.js';
import { parseDataURL } from '../../utils/file-helpers.js';
import { applyXMLToolCalls, appendXmlToolResultsForMessage } from '../../tools/xml-formatter.js';
import { parseThinkTags } from '../../stream/think-tag-parser.js';
import { getMappedId, generateIdSet, ensureIdMap } from '../format-converter.js';
import { isElectron } from '../../utils/platform.js';
import { injectToolsToClaude, getXMLInjectionStats } from '../../tools/tool-injection.js';
import { ClaudeStreamParser, parseClaudeStream } from '../../stream/parser-claude.js';
import { isTextFile } from './openai-shared.js';
import { describeServerToolCall } from './history-replay.js';
import { splitToolResultContent } from '../../messages/tool-results.js';
import {
    TOOL_INTERRUPTED_MESSAGE,
    CLAUDE_DEFAULT_MAX_TOKENS_STREAM,
    CLAUDE_DEFAULT_MAX_TOKENS_NON_STREAM
} from '../../utils/constants.js';
import {
    resolveThinkingBudget,
    nearestBudgetStrength,
    clampToSupportedLevel
} from '../reasoning.js';
import { CLAUDE_EFFORTS } from '../model-profiles.js';
import { pushXmlBuiltinToolsNotice } from '../request-notices.js';
import {
    COMPUTER_MEMBER_PERMISSIONS,
    COMPUTER_TOOLSET_NAME,
    hasComputerGuiPermission
} from '../../tools/computer-actions.js';
import { normalizeClaudeStop } from '../../messages/stop-reason.js';

const CLAUDE_THINKING_BUDGETS = Object.freeze({ low: 2048, medium: 8192, high: 16384 });
const COMPUTER_TOOLSET_TYPE = 'computer_toolset_20260801';

// ========== Turn 分组与内容转换 ==========

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

// ========== 工具调用回放 ==========

const LEGACY_COMPUTER_TOOL_NAME = 'computer';
// 服务端工具调用名与声明的工具类型前缀：code_execution 的调用名是 bash_code_execution 等
const SERVER_TOOL_FAMILIES = Object.freeze([
    Object.freeze({ name: 'web_search', typePrefix: 'web_search_' }),
    Object.freeze({ name: 'web_fetch', typePrefix: 'web_fetch_' }),
    Object.freeze({ name: 'code_execution', typePrefix: 'code_execution_' })
]);

/**
 * 按本次请求实际声明的工具决定历史调用如何回放
 *
 * 请求没有任何原生工具时历史里不能出现 tool_use（Anthropic 直接 400），只能转成 XML 文本；
 * computer 工具集与旧版 computer 工具不能出现在同一次请求里，历史调用按本次声明的那一种改写
 * @param {Array|undefined} declaredTools 本次请求 tools 字段的内容；undefined 表示不按声明调整
 * @returns {Object|null}
 */
function createToolReplayPolicy(declaredTools) {
    if (!Array.isArray(declaredTools)) return null;
    const declaresType = (prefix) =>
        declaredTools.some(
            (tool) => typeof tool?.type === 'string' && tool.type.startsWith(prefix)
        );
    return {
        hasTools: declaredTools.length > 0,
        toolset: declaredTools.some((tool) => tool?.type === COMPUTER_TOOLSET_TYPE),
        legacyComputer: declaredTools.some(
            (tool) =>
                tool?.name === LEGACY_COMPUTER_TOOL_NAME && tool.type !== COMPUTER_TOOLSET_TYPE
        ),
        declaresServerTool(name) {
            const family = SERVER_TOOL_FAMILIES.find((item) => name?.includes(item.name));
            return !family || declaresType(family.typePrefix);
        }
    };
}

function parseToolInput(args) {
    if (typeof args !== 'string') return args || {};
    try {
        return JSON.parse(args);
    } catch {
        return args;
    }
}

function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 历史原生调用在本次请求里的形态：工具集成员与旧版 computer 的 action 按本次声明互相改写
 * @returns {{ name: string, input: *, toolsetName: string|null }|null} null 表示只能转成 XML 文本
 */
function resolveToolUse(part, policy) {
    const input = parseToolInput(part.args);
    const toolsetName = part.toolsetName || null;
    if (!policy) return { name: part.name, input, toolsetName };
    if (!policy.hasTools) return null;

    if (toolsetName === COMPUTER_TOOLSET_NAME) {
        if (policy.toolset) return { name: part.name, input, toolsetName };
        if (policy.legacyComputer && isPlainObject(input)) {
            return {
                name: LEGACY_COMPUTER_TOOL_NAME,
                input: { action: part.name, ...input },
                toolsetName: null
            };
        }
        return null;
    }
    if (
        part.name === LEGACY_COMPUTER_TOOL_NAME &&
        policy.toolset &&
        !policy.legacyComputer &&
        isPlainObject(input) &&
        typeof input.action === 'string'
    ) {
        const { action, ...memberInput } = input;
        return { name: action, input: memberInput, toolsetName: COMPUTER_TOOLSET_NAME };
    }
    return { name: part.name, input, toolsetName };
}

// 导出文件剥离了 web_search 结果的 encrypted_content，缺了它 Anthropic 拒绝整条请求
function hasReplayableServerResult(part) {
    const content = part.result?.content;
    if (!Array.isArray(content)) return true;
    return content.every(
        (item) => item?.type !== 'web_search_result' || typeof item.encrypted_content === 'string'
    );
}

function keepsServerToolUse(part, policy) {
    return hasReplayableServerResult(part) && (!policy || policy.declaresServerTool(part.name));
}

function toClaudeImageBlock(image) {
    const parsed = parseDataURL(image.url);
    if (parsed) {
        return {
            type: 'image',
            source: { type: 'base64', media_type: parsed.mimeType, data: parsed.base64 }
        };
    }
    if (/^https?:\/\//i.test(image.url)) {
        return { type: 'image', source: { type: 'url', url: image.url } };
    }
    return null;
}

function buildClaudeUserMessage(text, images) {
    const imageBlocks = images.map(toClaudeImageBlock).filter(Boolean);
    return {
        role: 'user',
        content: imageBlocks.length > 0 ? [{ type: 'text', text }, ...imageBlocks] : text
    };
}

/**
 * 把一组 parts 转换为 Claude content array + 收集需要配对 tool_result 的原生调用
 *
 * state.messages 是唯一消息真相源：tool_call.result 已写回 part。XML 模式的调用、
 * 以及本次请求无法以原生形式回放的调用不进 content，由 appendXmlToolResultsForMessage 转成 XML 文本
 *
 * @param {Array} parts
 * @param {Object|null} policy createToolReplayPolicy 的结果
 */
function partsToClaudeContent(parts, policy) {
    const content = [];
    const toolUses = [];
    const degradedCalls = new Set();
    // part → claudeId 映射：同 part 双次调 getMappedId 在缺 idMap 槽时会各走 fallback
    // 返回不同的临时 id，导致 tool_use.id 与下方 tool_result.tool_use_id 不配对触发
    // Anthropic 400。此 Map 在 push tool_use 那一刻固化 id，配对消费方按引用复用同一值。
    const toolCallIdMap = new Map();

    for (const p of parts) {
        switch (p.type) {
            case PartType.THINKING:
                // 用户编辑过的 thinking 失去原 signature，跳过避免破坏多轮校验
                if (p._edited) break;
                if (p.redacted && p.data) {
                    // Claude API 安全过滤产生的 redacted_thinking block：data 是加密内容，需原样回传
                    content.push({ type: 'redacted_thinking', data: p.data });
                } else if (typeof p.signature === 'string' && p.signature.length > 0) {
                    // signatureFormat 守门：跨格式继承的 signature（Gemini/OpenAI）发给 Claude API
                    // 会触发 invalid_signature 400，整块跳过避免污染请求。
                    // 老消息无 signatureFormat 字段走宽容模式（视为同格式产物保留兼容）
                    if (p.signatureFormat && p.signatureFormat !== 'claude') break;
                    // 流被截断 / 代理在 signature_delta 前掐线会让 signature 为空串占位 —
                    // 直接下发空 signature 触发 Anthropic invalid_signature 400 比丢失整块更糟糕，
                    // 严格判定后跳过整块（parser-claude._flushCurrentThinkingBlock 会补占位，
                    // 但 adapter 这里短路阻止无效请求出门）
                    content.push({
                        type: 'thinking',
                        thinking: p.text,
                        signature: p.signature
                    });
                }
                break;
            case PartType.TEXT:
                // 空白文本块会被拒绝（text content blocks must contain non-whitespace text）
                if (p.text?.trim()) content.push({ type: 'text', text: p.text });
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
                            '[claude] 图片非 base64 格式，已降级为文本:',
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
                    if (!keepsServerToolUse(p, policy)) {
                        content.push({ type: 'text', text: describeServerToolCall(p) });
                        break;
                    }
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
                    break;
                }
                // XML 模式产生的工具调用以 <tool_use> 字符串形式存活于 TEXT part，
                // 不输出 native tool_use；对应结果由 appendXmlToolResultsForMessage 追加
                if (p.mode === ToolMode.XML) break;
                // 多回复 BufferedSink 拦截的工具调用不下发 tool_use，也不配对 tool_result
                if (p.state === ToolState.SKIPPED) break;
                const toolUse = resolveToolUse(p, policy);
                if (!toolUse) {
                    degradedCalls.add(p);
                    break;
                }
                const claudeId = getMappedId(p, 'claude');
                content.push({
                    type: 'tool_use',
                    id: claudeId,
                    name: toolUse.name,
                    input: toolUse.input,
                    ...(toolUse.toolsetName ? { toolset_name: toolUse.toolsetName } : {})
                });
                toolCallIdMap.set(p, claudeId);
                toolUses.push({ part: p, toolsetName: toolUse.toolsetName });
                break;
            }
        }
    }

    return { content, toolUses, toolCallIdMap, degradedCalls };
}

/**
 * 把原生调用的结果转为 Claude 的 user role tool_result 消息
 *
 * idMap 必须由 partsToClaudeContent 在生成 tool_use 时同步 set 进来。直接二次调
 * getMappedId 在 part.idMap 缺槽时会再走一次 generateFormatId fallback 返回与
 * 上方 tool_use.id 完全不同的随机 id，触发 Anthropic 'tool_use_id … not found' 400。
 *
 * @param {Array<{ part: Object, toolsetName: string|null }>} toolUses
 * @param {Map<Object, string>} idMap part → 上方 tool_use.id 的精确映射
 */
function buildClaudeToolResultMessage(toolUses, idMap) {
    if (toolUses.length === 0) return null;
    const toolResults = toolUses.map(({ part: p, toolsetName }) => {
        const block = {
            type: 'tool_result',
            tool_use_id: idMap.get(p),
            // 工具集成员的结果必须带回与调用一致的 toolset_name，否则整条请求被拒
            ...(toolsetName ? { toolset_name: toolsetName } : {}),
            content: p.result ? buildClaudeToolResultContent(p.result) : TOOL_INTERRUPTED_MESSAGE
        };
        // 老化/中断/失败的 tool 结果透传 is_error，Anthropic 据此让模型走错误恢复路径
        // 而非把字符串内容当成正常工具输出继续推理
        if (p.state === 'error' && p.result?.is_error === true) {
            block.is_error = true;
        }
        return block;
    });
    return { role: 'user', content: toolResults };
}

/**
 * 构建 Claude tool_result 的 content：有图片时为 text + image 数组，否则为文本
 */
function buildClaudeToolResultContent(result) {
    const { text, images } = splitToolResultContent(result, '');
    const imageBlocks = images.map(toClaudeImageBlock).filter(Boolean);
    if (imageBlocks.length === 0) return text;
    return [...(text ? [{ type: 'text', text }] : []), ...imageBlocks];
}

// ========== partsToAPIMessages ==========

/**
 * 新格式 → Claude API 消息数组
 *
 * 关键约束：Claude 要求 latest assistant message 的 thinking blocks 与原响应一致。
 * 工具调用 continuation 在 UI 层合并为一条消息（mergeContinuation 给新轮 parts 打 _turn），
 * 转 API 时按 _turn 拆回独立 assistant + tool_result 序列，避免触发"thinking modified"校验。
 * 内容全被跳过的消息不输出（空消息会被拒绝），相邻同角色消息由 Anthropic 合并为一轮
 *
 * @param {Array} msgs
 * @param {{ declaredTools?: Array }} [opts] declaredTools 为本次请求实际声明的原生工具
 */
function partsToAPIMessages(msgs, opts = {}) {
    const out = [];
    const policy = createToolReplayPolicy(opts.declaredTools);

    for (const msg of msgs) {
        if (msg.error) continue;
        if (msg.role === Role.SYSTEM) continue; // system 由顶级参数处理

        // 旧消息/导入数据可能缺 part.idMap，主动补齐再走转换，避免 partsToClaudeContent
        // 与 buildClaudeToolResultMessage 各自走 getMappedId fallback 落到不同随机 id
        for (const p of msg.parts || []) {
            if (p.type === PartType.TOOL_CALL) ensureIdMap(p);
        }

        const role = msg.role;
        const turnGroups = groupPartsByTurn(msg.parts || []);
        const sortedTurns = [...turnGroups.keys()].sort((a, b) => a - b);

        for (const turn of sortedTurns) {
            const turnParts = turnGroups.get(turn);
            const { content, toolUses, toolCallIdMap, degradedCalls } = partsToClaudeContent(
                turnParts,
                policy
            );
            if (content.length > 0) {
                const outContent =
                    content.length === 1 && content[0].type === 'text' ? content[0].text : content;
                out.push({ role, content: outContent });
            }

            const toolResultMsg = buildClaudeToolResultMessage(toolUses, toolCallIdMap);
            if (toolResultMsg) out.push(toolResultMsg);

            // XML 模式与无法原生回放的调用，配对紧跟在本轮输出之后
            if (role === Role.ASSISTANT) {
                appendXmlToolResultsForMessage(
                    out,
                    { parts: turnParts },
                    buildClaudeUserMessage,
                    (p) => p.mode === ToolMode.XML || degradedCalls.has(p)
                );
            }
        }
    }

    return out;
}

// ========== parseResponse ==========

function parseResponse(data, options = {}) {
    if (data.error) return null;
    const stop = normalizeClaudeStop(data.stop_reason, data.stop_details);
    // 拒答或思考耗尽输出上限时 content 为空，只带回结束原因，由 handler 按空回复处理
    if (!data.content || data.content.length === 0) {
        return { content: '', stop, pauseTurn: data.stop_reason === 'pause_turn' };
    }
    const xmlMode = options.isXmlMode === true;

    // 优先检测原生工具调用 — 不早 return，下方统一抽取 thinking blocks/signatures/items
    // 让 saveAssistantMessage 落库的 part 含完整 thinking，下轮 resendWithToolResults 重发时
    // Claude 校验 latest assistant 的 thinking blocks 与原响应一致才不会 400 'thinking modified'
    const toolCalls = [];
    for (const block of data.content) {
        if (block.type === 'tool_use') {
            toolCalls.push({
                id: block.id,
                name: block.name,
                arguments: block.input,
                ...(block.toolset_name ? { toolsetName: block.toolset_name } : {}),
                mode: ToolMode.NATIVE,
                idMap: generateIdSet(block.id || '', 'claude')
            });
        }
    }

    let textContent = '';
    let thinkingContent = '';
    const contentParts = [];
    const thinkingBlocks = [];
    const thinkingSigs = [];
    // 顺序数组：保留 thinking 和 redacted_thinking 的原响应顺序，
    // Claude API 多轮校验要求所有 thinking 类 block 原样回传
    const thinkingItems = [];

    data.content.forEach((block) => {
        if (block.type === 'text') {
            const { displayText: thinkParsedText, thinkingContent: thinkContent } = parseThinkTags(
                block.text
            );
            if (thinkContent) {
                thinkingContent += thinkContent;
                contentParts.push({ type: 'thinking', text: thinkContent });
            }
            textContent += thinkParsedText;
            if (thinkParsedText) {
                contentParts.push({ type: 'text', text: thinkParsedText });
            }
        } else if (block.type === 'thinking') {
            // display 为 omitted 时 thinking 为空串，签名仍是续发工具结果必须原样带回的部分
            const text = block.thinking || '';
            if (text) thinkingContent += (thinkingContent ? '\n\n---\n\n' : '') + text;
            thinkingBlocks.push(text);
            thinkingSigs.push(block.signature || null);
            thinkingItems.push({ type: 'thinking', text, signature: block.signature || null });
            contentParts.push({ type: 'thinking', text, signature: block.signature || null });
        } else if (block.type === 'redacted_thinking') {
            // 安全过滤产生的加密 thinking 块，必须原样回传给 API
            thinkingItems.push({ type: 'redacted_thinking', data: block.data });
            contentParts.push({ type: 'redacted_thinking', data: block.data });
        } else if (block.type === 'image') {
            const source = block.source;
            if (source.type === 'base64') {
                const dataUrl = `data:${source.media_type};base64,${source.data}`;
                contentParts.push({ type: 'image_url', url: dataUrl, complete: true });
            } else if (source.type === 'url') {
                contentParts.push({ type: 'image_url', url: source.url, complete: true });
            }
        } else if (block.type === 'video') {
            const source = block.source || {};
            if (source.type === 'base64' && source.data) {
                const mimeType = source.media_type || source.mimeType || 'video/mp4';
                const dataUrl = `data:${mimeType};base64,${source.data}`;
                contentParts.push({
                    type: 'video_url',
                    url: dataUrl,
                    complete: true,
                    mimeType
                });
            } else if (source.type === 'url' && source.url) {
                const mimeType = source.media_type || source.mimeType || '';
                contentParts.push({
                    type: 'video_url',
                    url: source.url,
                    complete: true,
                    mimeType
                });
            }
        } else if (block.type === 'server_tool_use') {
            // 服务端工具调用（原子保存）
            contentParts.push({
                type: 'server_tool_use',
                id: block.id,
                name: block.name,
                input: block.input || {}
            });
        } else if (block.type?.endsWith('_tool_result')) {
            // 服务端工具结果，关联到前一个 server_tool_use
            const prevStu = [...contentParts]
                .reverse()
                .find((p) => p.type === 'server_tool_use' && p.id === block.tool_use_id);
            if (prevStu) {
                prevStu.result = { type: block.type, content: block.content };
            } else {
                contentParts.push({
                    type: 'server_tool_use',
                    id: block.tool_use_id || `srvtoolu_unknown`,
                    name: block.type.replace('_tool_result', ''),
                    input: {},
                    result: { type: block.type, content: block.content }
                });
            }
        }
    });

    // 原生工具调用路径：保留全部 thinking/contentParts 上下文，handler.js 据 hasToolCalls
    // 走 handleToolCallStream 分支；继续保留 pauseTurn 字段供服务端工具 continuation 使用
    const hasNativeToolCalls = toolCalls.length > 0 && data.stop_reason === 'tool_use';

    const reply = {
        content: textContent,
        claudeContent: data.content,
        thinkingContent: thinkingContent || null,
        thinkingBlocks: thinkingBlocks.length > 0 ? thinkingBlocks : null,
        thinkingSignatures: thinkingSigs.length > 0 ? thinkingSigs : null,
        thinkingItems: thinkingItems.length > 0 ? thinkingItems : null,
        contentParts: contentParts.length > 0 ? contentParts : null,
        toolCalls: hasNativeToolCalls ? toolCalls : undefined,
        hasToolCalls: hasNativeToolCalls,
        pauseTurn: data.stop_reason === 'pause_turn',
        // 多回复的备选回复经 buildPartsFromReply 落库，签名来源随回复一起带上
        signatureFormat: SignatureFormat.CLAUDE,
        stop
    };

    // XML 兜底：仅在原生 tool_use 不存在时检测（XML/native 互斥），思考块照常落库
    if (xmlMode && toolCalls.length === 0) {
        const xmlReply = applyXMLToolCalls(reply, textContent);
        if (xmlReply) {
            logger.debug('[claude] 检测到 XML 工具调用:', xmlReply.toolCalls.length);
            return xmlReply;
        }
    }
    return reply;
}

// ========== 工具构造 ==========

// 与型号无关的内置工具版本；type 与 name 必须成对升级，只改其一会 400
const CLAUDE_BUILTIN_TOOLS = Object.freeze({
    codeExecution: Object.freeze({ type: 'code_execution_20250825', name: 'code_execution' }),
    bash: Object.freeze({ type: 'bash_20250124', name: 'bash' }),
    textEditor: Object.freeze({
        type: 'text_editor_20250728',
        name: 'str_replace_based_edit_tool'
    }),
    webSearch: Object.freeze({ type: 'web_search_20250305', name: 'web_search', max_uses: 5 })
});

// Code Execution 需要 Files API 支持（用于 container_upload）
const CODE_EXECUTION_BETAS = Object.freeze([
    'code-execution-2025-08-25',
    'advanced-tool-use-2025-11-20',
    'files-api-2025-04-14'
]);

function isComputerPermissionAllowed(permissions, permission) {
    return permissions?.[permission] !== false;
}

// 尺寸先按窗口所在屏幕占位，buildRequestBody 换成实际回传的截图尺寸
function buildComputerTool(type) {
    let displayWidth = 1920;
    let displayHeight = 1080;
    if (typeof window !== 'undefined' && window.screen) {
        displayWidth = window.screen.width;
        displayHeight = window.screen.height;
    }
    return {
        type,
        name: 'computer',
        display_width_px: displayWidth,
        display_height_px: displayHeight,
        display_number: 1
    };
}

/**
 * 旧版 computer 工具按回传截图的尺寸声明显示器，模型给出的坐标才与截图像素一一对应
 */
function applyComputerDisplay(tools, computerUse, computerDisplay) {
    if (!computerDisplay || !computerUse?.declaresDisplay) return tools;
    return tools.map((tool) =>
        tool?.type === computerUse.type
            ? {
                  ...tool,
                  display_width_px: computerDisplay.width,
                  display_height_px: computerDisplay.height
              }
            : tool
    );
}

/**
 * computer 工具集：Computer Use 权限里关掉的操作对应的成员不下发
 * @param {Object} [permissions] state.computerUsePermissions
 * @returns {Object}
 */
function buildComputerToolset(permissions) {
    const configs = {};
    for (const [member, permission] of Object.entries(COMPUTER_MEMBER_PERMISSIONS)) {
        if (permission && !isComputerPermissionAllowed(permissions, permission)) {
            configs[member] = { enabled: false };
        }
    }
    return Object.keys(configs).length > 0
        ? { type: COMPUTER_TOOLSET_TYPE, configs }
        : { type: COMPUTER_TOOLSET_TYPE };
}

/**
 * Claude 内置工具：code_execution / web_search / Computer Use（仅 Electron 且非 XML 模式）
 * computer 工具版本由能力表按型号给出
 */
function collectBuiltinTools(stateRef, { profile, notices } = {}) {
    // 服务端工具由 Anthropic 执行，XML 模式下工具写进提示词无法这样调用；
    // computer use 在 XML 模式下改用统一的自定义 computer 工具（来自 builtin/computer-use.js）
    if (stateRef.xmlToolCallingEnabled) {
        pushXmlBuiltinToolsNotice(stateRef, notices);
        return [];
    }

    const tools = [];

    if (stateRef.codeExecutionEnabled) {
        tools.push({ ...CLAUDE_BUILTIN_TOOLS.codeExecution });
    }

    if (stateRef.computerUseEnabled && isElectron()) {
        const permissions = stateRef.computerUsePermissions;
        const computerType = profile?.computerUse?.type;
        // 鼠标、键盘、截图权限全关时 computer 的每个动作都会被拒，不再声明
        if (computerType && hasComputerGuiPermission(permissions)) {
            tools.push(
                computerType === COMPUTER_TOOLSET_TYPE
                    ? buildComputerToolset(permissions)
                    : buildComputerTool(computerType)
            );
        }
        if (isComputerPermissionAllowed(permissions, 'bash')) {
            tools.push({ ...CLAUDE_BUILTIN_TOOLS.bash });
        }
        if (isComputerPermissionAllowed(permissions, 'textEditor')) {
            tools.push({ ...CLAUDE_BUILTIN_TOOLS.textEditor });
        }
    }

    if (stateRef.webSearchEnabled) {
        tools.push({ ...CLAUDE_BUILTIN_TOOLS.webSearch });
    }

    return tools;
}

function formatSystemTools(systemTools) {
    // Claude 系统工具直接 spread 到 tools 数组，无需包装
    return systemTools;
}

// ========== 生成参数 ==========

const THINKING_BINDING_BETA = 'thinking-binding-controls-2026-08-01';
const SAMPLING_KEYS = Object.freeze(['temperature', 'top_p', 'top_k']);
// 开启思考时 top_p 只接受 [0.95, 1]
const THINKING_MIN_TOP_P = 0.95;

// 只支持 adaptive 的型号收到预算设置时，按与预算档位最接近的 effort 换算
function effortFromBudgetIntent(reasoning) {
    if (reasoning.strength === 'custom') {
        return nearestBudgetStrength(reasoning.budget, CLAUDE_THINKING_BUDGETS);
    }
    if (reasoning.strength === 'minimal') return 'low';
    return CLAUDE_EFFORTS.includes(reasoning.strength) ? reasoning.strength : 'high';
}

function adaptiveThinking(effort, reasoning, rules) {
    const thinking = { type: 'adaptive' };
    if (reasoning.showSummary && rules.display) thinking.display = 'summarized';
    // 新账号默认校验思考块的会话前缀；system 里的 {{time}}、未写回历史的末尾预填充都会改动前缀，
    // 对不上的块直接丢弃重算，避免整条请求 400
    if (rules.blockBinding) {
        thinking.block_binding = { prefix_mismatch_behavior: 'drop_block' };
    }
    return {
        thinking,
        output_config: { effort: clampToSupportedLevel(effort, CLAUDE_EFFORTS, rules.efforts) }
    };
}

function budgetThinking(reasoning) {
    return {
        thinking: {
            type: 'enabled',
            budget_tokens: resolveThinkingBudget(reasoning, CLAUDE_THINKING_BUDGETS)
        }
    };
}

/**
 * @param {import('../reasoning.js').ReasoningIntent} reasoning
 * @param {Object} rules profile.reasoning
 * @param {import('../request-notices.js').RequestNotice[]} notices
 * @returns {Object|null}
 */
function buildThinkingConfig(reasoning, rules, notices) {
    const supportsAdaptive = rules.modes.includes('adaptive');
    const supportsBudget = rules.modes.includes('budget');

    if (!reasoning.enabled) {
        // 默认开启思考的型号省略 thinking 等于按默认档位思考，关掉开关时改用最低 effort
        return rules.alwaysOn ? adaptiveThinking('low', reasoning, rules) : null;
    }

    if (reasoning.adaptive) {
        const effort = CLAUDE_EFFORTS.includes(reasoning.adaptiveEffort)
            ? reasoning.adaptiveEffort
            : 'high';
        if (supportsAdaptive) return adaptiveThinking(effort, reasoning, rules);
        notices.push({
            key: 'claude.adaptive-unsupported',
            message: '当前 Claude 模型不支持 adaptive thinking，已按同档位的思考预算发送'
        });
        return budgetThinking({ strength: effort });
    }

    if (supportsBudget) return budgetThinking(reasoning);
    notices.push({
        key: 'claude.budget-unsupported',
        message: '当前 Claude 模型只支持 adaptive thinking，思考强度已换算为 effort 档位'
    });
    return adaptiveThinking(effortFromBudgetIntent(reasoning), reasoning, rules);
}

/**
 * 型号拒绝采样参数时整体丢弃；开启思考时 temperature 固定为 1、top_p 不低于 0.95、不能带 top_k
 */
function buildSamplingParams(userParams, { thinking, profile, notices }) {
    const requested = SAMPLING_KEYS.filter((key) => userParams[key] !== null);
    if (requested.length === 0) return {};

    if (profile.sampling === false) {
        notices.push({
            key: 'claude.sampling',
            message: `当前 Claude 模型不接受自定义 ${requested.join(' / ')}，已忽略`
        });
        return {};
    }

    const params = {};
    let adjusted = false;
    if (userParams.temperature !== null) {
        params.temperature = thinking ? 1 : userParams.temperature;
        adjusted ||= params.temperature !== userParams.temperature;
    }
    if (userParams.top_p !== null) {
        params.top_p = thinking ? Math.max(userParams.top_p, THINKING_MIN_TOP_P) : userParams.top_p;
        adjusted ||= params.top_p !== userParams.top_p;
    }
    if (userParams.top_k !== null) {
        if (thinking) adjusted = true;
        else params.top_k = userParams.top_k;
    }
    if (adjusted) {
        notices.push({
            key: 'claude.thinking-sampling',
            message:
                '开启思考时 Claude 要求 temperature 为 1、top_p 不低于 0.95 且不能设置 top_k，已自动调整'
        });
    }
    return params;
}

/**
 * @param {import('../params.js').GenerationSettings} settings
 * @param {{ profile: Object }} ctx
 * @returns {import('./format-adapter-types.js').GenerationParams}
 */
function buildGenerationParams(settings, { profile }) {
    const { userParams, reasoning } = settings;
    const notices = [];
    const thinkingCfg = buildThinkingConfig(reasoning, profile.reasoning, notices);
    // Messages API 要求 max_tokens 必填，缺失直接 400；它是 thinking 与正文共享的总输出上限
    const modelParams = {
        max_tokens:
            userParams.max_tokens !== null
                ? userParams.max_tokens
                : settings.streamEnabled
                  ? CLAUDE_DEFAULT_MAX_TOKENS_STREAM
                  : CLAUDE_DEFAULT_MAX_TOKENS_NON_STREAM,
        ...buildSamplingParams(userParams, { thinking: !!thinkingCfg, profile, notices })
    };

    return { modelParams, thinkingCfg, verbosityCfg: null, notices };
}

// ========== buildRequestBody ==========

/**
 * 型号拒绝以 assistant 结尾的请求时，去掉末尾预填充里收尾的 assistant 消息
 */
function resolveTrailingPrefill(trailing, profile, notices) {
    if (profile.assistantPrefill !== false) return trailing;
    let end = trailing.length;
    while (end > 0 && trailing[end - 1]?.role === 'assistant') end--;
    if (end === trailing.length) return trailing;
    notices.push({
        key: 'claude.assistant-prefill',
        message:
            '当前 Claude 模型不支持以 assistant 消息结尾的预填充，已跳过末尾的 assistant 预填充'
    });
    return trailing.slice(0, end);
}

function buildRequestBody(ctx) {
    const {
        messages,
        model,
        modelParams,
        thinkingCfg,
        systemCtx,
        prefill,
        tools,
        isXmlMode,
        profile,
        notices,
        computerDisplay,
        state: stateRef
    } = ctx;

    // Claude messages 数组：opening + history + trailing（system 是顶层参数）
    let claudeMessages = [...messages];
    if (prefill && prefill.opening.length > 0) {
        claudeMessages = [...prefill.opening, ...claudeMessages];
    }
    if (prefill && prefill.trailing.length > 0) {
        claudeMessages = [
            ...claudeMessages,
            ...resolveTrailingPrefill(prefill.trailing, profile, notices)
        ];
    }

    const requestBody = {
        model: model,
        messages: claudeMessages,
        stream: stateRef.streamEnabled,
        ...modelParams // max_tokens（必填，buildGenerationParams 保证存在）及其他参数
    };

    // Claude 的 system 是顶层参数（独立于预填充开关）
    if (systemCtx.systemPrompt) {
        requestBody.system = systemCtx.systemPrompt;
    }

    // AI DevTools Monitor 上下文注入：字符串拼接
    if (systemCtx.monitorContext) {
        requestBody.system = (requestBody.system || '') + systemCtx.monitorContext;
    }

    // 添加思维链配置 (Claude Extended Thinking)
    if (thinkingCfg) Object.assign(requestBody, thinkingCfg);

    if (tools.length > 0) {
        if (isXmlMode) {
            injectToolsToClaude(requestBody, tools);
            const stats = getXMLInjectionStats(tools);
            logger.debug('[claude] XML 模式注入统计:', stats);
        } else {
            requestBody.tools = applyComputerDisplay(tools, profile?.computerUse, computerDisplay);
            logger.debug('[claude] 原生 tools 模式，工具数量:', tools.length);
        }
    }

    return requestBody;
}

// ========== Endpoint / Headers / Query ==========

function resolveEndpoint(baseEndpoint, _model, _isStreaming) {
    return baseEndpoint;
}

/**
 * beta 头只按请求里实际出现的原生工具与思考配置收集，XML 模式下工具写进提示词不需要 beta
 */
function collectBetas(tools, requestProfile) {
    const betas = new Set();
    if (!requestProfile?.isXmlMode) {
        const computerUse = requestProfile?.profile?.computerUse;
        for (const tool of tools || []) {
            if (tool?.type === CLAUDE_BUILTIN_TOOLS.codeExecution.type) {
                CODE_EXECUTION_BETAS.forEach((beta) => betas.add(beta));
            }
            if (computerUse?.beta && tool?.type === computerUse.type) {
                betas.add(computerUse.beta);
            }
        }
    }
    if (requestProfile?.thinkingCfg?.thinking?.block_binding) {
        betas.add(THINKING_BINDING_BETA);
    }
    return betas;
}

/**
 * Claude headers：x-api-key + anthropic-version + 按请求内容合并 beta features
 */
function buildHeaders(apiKey, { tools, requestProfile } = {}) {
    const headers = {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
    };

    const betas = collectBetas(tools, requestProfile);
    if (betas.size > 0) {
        headers['anthropic-beta'] = [...betas].join(',');
        logger.debug('[claude] Beta headers:', headers['anthropic-beta']);
    }

    return headers;
}

function buildQueryString(_apiKey, _ctx) {
    return '';
}

// ========== Adapter 对象 + 注册 ==========

// 统一 (reader, sessionId, sink, signal) 入口签名，parseClaudeStream 内部完成构造 + 解析
function streamParser(reader, sessionId, sink = null, signal = null) {
    return parseClaudeStream(reader, sessionId, sink, signal);
}

export const claudeAdapter = Object.freeze({
    name: 'Claude',
    apiFormat: 'claude',
    // 非流式 handler.js 调 buildPartsFromStreamingState 时按 adapter 注入 signatureFormat
    // 让 thinking part 携带来源标识，跨格式继承时被自家 adapter 守门
    signatureFormat: 'claude',

    parserClass: ClaudeStreamParser,
    streamParser,

    partsToAPIMessages,
    parseResponse,

    collectBuiltinTools,
    formatSystemTools,
    buildGenerationParams,
    buildRequestBody,
    resolveEndpoint,
    buildHeaders,
    buildQueryString
});
