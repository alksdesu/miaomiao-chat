/**
 * Claude Messages API Adapter — Anthropic Claude 差异化逻辑（content array + 多轮
 * _turn 拆分）。Claude 严格校验 latest assistant 的 thinking blocks 必须与原响应一致，
 * partsToAPIMessages 按 _turn 把合并消息拆回独立 assistant + tool_result 序列。
 */

import { logger } from '../../utils/logger.js';
import { state } from '../../core/state.js';
import { PartType, MediaKind, Role, ToolMode, ToolState } from '../../messages/schema.js';
import { parseDataURL } from '../../utils/file-helpers.js';
import { extractXMLToolCalls, appendXmlToolResultsForMessage } from '../../tools/xml-formatter.js';
import { parseThinkTags } from '../../stream/think-tag-parser.js';
import { getMappedId, generateIdSet, ensureIdMap } from '../format-converter.js';
import { isElectron } from '../../utils/platform.js';
import { injectToolsToClaude, getXMLInjectionStats } from '../../tools/tool-injection.js';
import { ClaudeStreamParser, parseClaudeStream } from '../../stream/parser-claude.js';
import { isTextFile, stringifyToolResult } from './openai-shared.js';
import { TOOL_INTERRUPTED_MESSAGE } from '../../utils/constants.js';

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

/**
 * 把一组 parts 转换为 Claude content array + 收集需要配对 tool_result 的 tool_call parts
 *
 * Stage 3 之后 state.messages 是唯一消息真相源：tool_call.result 已写回 part，
 * 不再有临时消息双轨。XML 模式的 tool_call 直接跳过（其结果由 appendXmlToolResults 追加）。
 */
function partsToClaudeContent(parts) {
    const content = [];
    const toolCallParts = [];
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
                    // 服务端工具调用（web_search/code_execution）不走 native/XML 双协议，原样输出
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
                    // XML 模式产生的工具调用以 <tool_use> 字符串形式存活于 TEXT part，
                    // 不输出 native tool_use；对应结果由 appendXmlToolResults 追加
                    if (p.mode === ToolMode.XML) break;
                    // 多回复 BufferedSink 拦截的工具调用不下发 tool_use，下方 toolCallParts
                    // 也不收集 → buildClaudeToolResultMessage 不会输出 tool_result
                    if (p.state === ToolState.SKIPPED) break;
                    const claudeId = getMappedId(p, 'claude');
                    let input = p.args || {};
                    if (typeof input === 'string') {
                        try {
                            input = JSON.parse(input);
                        } catch {
                            /* keep string */
                        }
                    }
                    content.push({ type: 'tool_use', id: claudeId, name: p.name, input });
                    toolCallIdMap.set(p, claudeId);
                    toolCallParts.push(p);
                }
                break;
            }
        }
    }

    return { content, toolCallParts, toolCallIdMap };
}

/**
 * 把 tool_call parts 转为 Claude 的 user role tool_result 消息
 *
 * idMap 必须由 partsToClaudeContent 在生成 tool_use 时同步 set 进来。直接二次调
 * getMappedId 在 part.idMap 缺槽时会再走一次 generateFormatId fallback 返回与
 * 上方 tool_use.id 完全不同的随机 id，触发 Anthropic 'tool_use_id … not found' 400。
 *
 * @param {Array} toolCallParts
 * @param {Map<Object, string>} idMap part → 上方 tool_use.id 的精确映射
 */
function buildClaudeToolResultMessage(toolCallParts, idMap) {
    if (toolCallParts.length === 0) return null;
    const toolResults = toolCallParts.map((p) => {
        const block = {
            type: 'tool_result',
            tool_use_id: idMap.get(p),
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
 * 构建 Claude tool_result 的 content
 *
 * 失败结果 schema {error, is_error, ...} 与任意非 .content 结构（bash {stdout,stderr}、
 * 自定义 MCP）若仅取 .content 会丢成空串让模型看不到错误原因。统一通过 stringifyToolResult
 * 兜底序列化保留信息。
 */
function buildClaudeToolResultContent(result) {
    if (!result) return '';

    // 有媒体时返回 content+image 数组
    if (result.media && result.media.length > 0) {
        const parts = [];
        const textBody = stringifyToolResult(result, '');
        if (textBody) {
            parts.push({ type: 'text', text: textBody });
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
        return parts.length > 0 ? parts : textBody;
    }

    return stringifyToolResult(result, '');
}

// ========== partsToAPIMessages ==========

/**
 * 新格式 → Claude API 消息数组
 *
 * 关键约束：Claude 要求 latest assistant message 的 thinking blocks 与原响应一致。
 * 工具调用 continuation 在 UI 层合并为一条消息（mergeContinuation 给新轮 parts 打 _turn），
 * 转 API 时按 _turn 拆回独立 assistant + tool_result 序列，避免触发"thinking modified"校验。
 */
function partsToAPIMessages(msgs, _opts = {}) {
    const out = [];

    for (const msg of msgs) {
        if (msg.error || msg.isError) continue;
        if (msg.role === Role.SYSTEM) continue; // system 由顶级参数处理

        // 旧消息/导入数据可能缺 part.idMap，主动补齐再走转换，避免 partsToClaudeContent
        // 与 buildClaudeToolResultMessage 各自走 getMappedId fallback 落到不同随机 id
        for (const p of msg.parts || []) {
            if (p.type === PartType.TOOL_CALL) ensureIdMap(p);
        }

        const role = msg.role;
        const turnGroups = groupPartsByTurn(msg.parts || []);
        // 空 parts 也要产生一条空消息占位（兼容历史行为）
        if (turnGroups.size === 0) turnGroups.set(0, []);
        const sortedTurns = [...turnGroups.keys()].sort((a, b) => a - b);

        for (const turn of sortedTurns) {
            const turnParts = turnGroups.get(turn);
            const { content, toolCallParts, toolCallIdMap } = partsToClaudeContent(turnParts);
            // 该 turn 内所有 part 都被跳过（XML 模式或被过滤的 thinking）
            if (content.length === 0 && toolCallParts.length === 0 && turnParts.length > 0) {
                continue;
            }
            if (content.length === 0) {
                content.push({ type: 'text', text: '' });
            }
            const outContent =
                content.length === 1 && content[0].type === 'text' ? content[0].text : content;
            out.push({ role, content: outContent });

            const toolResultMsg = buildClaudeToolResultMessage(toolCallParts, toolCallIdMap);
            if (toolResultMsg) out.push(toolResultMsg);
        }

        // XML 模式 tool_call 配对追加紧跟在本条 assistant 之后（per-turn 内嵌）
        if (msg.role === Role.ASSISTANT) {
            appendXmlToolResultsForMessage(out, msg);
        }
    }

    return out;
}

// ========== parseResponse ==========

function parseResponse(data) {
    if (data.error) return null;
    if (!data.content || data.content.length === 0) return null;
    const xmlMode = state.xmlToolCallingEnabled;

    // 1. 优先检测原生工具调用 — 不早 return，下方统一抽取 thinking blocks/signatures/items
    // 让 saveAssistantMessage 落库的 part 含完整 thinking，下轮 resendWithToolResults 重发时
    // Claude 校验 latest assistant 的 thinking blocks 与原响应一致才不会 400 'thinking modified'
    const toolCalls = [];
    for (const block of data.content) {
        if (block.type === 'tool_use') {
            toolCalls.push({
                id: block.id,
                name: block.name,
                arguments: block.input,
                mode: ToolMode.NATIVE,
                idMap: generateIdSet(block.id || '', 'claude')
            });
        }
    }

    // 2. XML 兜底：仅在原生 tool_use 不存在时检测（XML/native 互斥）
    if (xmlMode && toolCalls.length === 0) {
        let allText = '';
        for (const block of data.content) {
            if (block.type === 'text') {
                allText += block.text;
            }
        }

        if (allText) {
            const xmlToolCalls = extractXMLToolCalls(allText);
            if (xmlToolCalls.length > 0) {
                logger.debug('[claude] 检测到 XML 工具调用:', xmlToolCalls.length);
                return {
                    toolCalls: xmlToolCalls.map((tc) => ({ ...tc, mode: ToolMode.XML })),
                    content: allText,
                    hasToolCalls: true
                };
            }
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
            thinkingContent += (thinkingContent ? '\n\n---\n\n' : '') + block.thinking;
            thinkingBlocks.push(block.thinking);
            thinkingSigs.push(block.signature || null);
            thinkingItems.push({
                type: 'thinking',
                text: block.thinking,
                signature: block.signature || null
            });
            contentParts.push({ type: 'thinking', text: block.thinking });
        } else if (block.type === 'redacted_thinking') {
            // 安全过滤产生的加密 thinking 块，必须原样回传给 API
            thinkingItems.push({ type: 'redacted_thinking', data: block.data });
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

    return {
        content: textContent,
        claudeContent: data.content,
        thinkingContent: thinkingContent || null,
        thinkingBlocks: thinkingBlocks.length > 0 ? thinkingBlocks : null,
        thinkingSignatures: thinkingSigs.length > 0 ? thinkingSigs : null,
        thinkingItems: thinkingItems.length > 0 ? thinkingItems : null,
        contentParts: contentParts.length > 0 ? contentParts : null,
        toolCalls: hasNativeToolCalls ? toolCalls : undefined,
        hasToolCalls: hasNativeToolCalls,
        pauseTurn: data.stop_reason === 'pause_turn'
    };
}

// ========== 工具构造 ==========

/**
 * Claude 内置工具：code_execution / web_search / Computer Use（仅 Electron 且非 XML 模式）
 */
function collectBuiltinTools(stateRef) {
    const tools = [];

    // 1. Code Execution 工具
    if (stateRef.codeExecutionEnabled) {
        tools.push({
            type: 'code_execution_20250825',
            name: 'code_execution'
        });
    }

    // 2. Computer Use 原生工具（仅 Electron 且非 XML 模式）
    // XML 模式下使用统一的自定义 computer 工具（来自 builtin/computer-use.js）
    if (stateRef.computerUseEnabled && isElectron() && !stateRef.xmlToolCallingEnabled) {
        // 统一使用 20251124：较新模型会拒绝旧版本 computer_20250124，新版本向后兼容
        const computerVersion = '20251124';

        let displayWidth = 1920;
        let displayHeight = 1080;
        if (typeof window !== 'undefined' && window.screen) {
            displayWidth = window.screen.width;
            displayHeight = window.screen.height;
        }

        tools.push({
            type: `computer_${computerVersion}`,
            name: 'computer',
            display_width_px: displayWidth,
            display_height_px: displayHeight,
            display_number: 1
        });

        if (stateRef.computerUsePermissions?.bash !== false) {
            tools.push({
                type: 'bash_20250124',
                name: 'bash'
            });
        }

        if (stateRef.computerUsePermissions?.textEditor !== false) {
            tools.push({
                type: 'text_editor_20250728',
                name: 'str_replace_based_edit_tool'
            });
        }
    }

    // 3. Web Search 工具
    if (stateRef.webSearchEnabled) {
        tools.push({
            type: 'web_search_20250305',
            name: 'web_search',
            max_uses: 5
        });
    }

    return tools;
}

function formatSystemTools(systemTools) {
    // Claude 系统工具直接 spread 到 tools 数组，无需包装
    return systemTools;
}

// ========== buildRequestBody ==========

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
        state: stateRef
    } = ctx;

    // Claude messages 数组：opening + history + trailing（system 是顶层参数）
    let claudeMessages = [...messages];
    if (prefill && prefill.opening.length > 0) {
        claudeMessages = [...prefill.opening, ...claudeMessages];
    }
    if (prefill && prefill.trailing.length > 0) {
        claudeMessages = [...claudeMessages, ...prefill.trailing];
    }

    const requestBody = {
        model: model,
        messages: claudeMessages,
        stream: stateRef.streamEnabled,
        ...modelParams // 包含 max_tokens（默认 8192）及其他参数
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
            requestBody.tools = tools;
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
 * Claude headers：x-api-key + anthropic-version + 智能合并 beta features
 */
function buildHeaders(apiKey, _ctx) {
    const headers = {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
    };

    // 智能合并 beta headers
    const betaFeaturesToAdd = [];
    if (state.codeExecutionEnabled) {
        betaFeaturesToAdd.push('code-execution-2025-08-25');
        betaFeaturesToAdd.push('advanced-tool-use-2025-11-20');
        // Code Execution 需要 Files API 支持（用于 container_upload）
        betaFeaturesToAdd.push('files-api-2025-04-14');
    }
    // Computer Use beta（仅 Electron 环境）— 与 computer 工具版本对齐到最新
    if (state.computerUseEnabled && isElectron()) {
        betaFeaturesToAdd.push('computer-use-2025-11-24');
    }

    if (betaFeaturesToAdd.length > 0) {
        // 去重（理论上不重复，但保持原 sendClaudeRequest 行为）
        const unique = [];
        for (const feature of betaFeaturesToAdd) {
            if (!unique.includes(feature)) unique.push(feature);
        }
        headers['anthropic-beta'] = unique.join(',');
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
    filterPosition: 'before', // 转换前过滤 state.messages
    // 非流式 handler.js 调 buildPartsFromStreamingState 时按 adapter 注入 signatureFormat
    // 让 thinking part 携带来源标识，跨格式继承时被自家 adapter 守门
    signatureFormat: 'claude',

    parserClass: ClaudeStreamParser,
    streamParser,

    partsToAPIMessages,
    parseResponse,

    collectBuiltinTools,
    formatSystemTools,
    buildRequestBody,
    resolveEndpoint,
    buildHeaders,
    buildQueryString
});
