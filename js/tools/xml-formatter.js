/**
 * XML 工具调用格式化器
 * 用于将工具转换为 CherryStudio 风格的 XML 格式
 */

import {
    TOOL_ID_COUNTER_MAX,
    XML_MAX_BUFFER_SIZE,
    XML_MAX_TOOL_CONTENT_LENGTH
} from '../utils/constants.js';
import { logger } from '../utils/logger.js';

// 工具 ID 生成计数器（避免短时间内重复）
let toolIdCounter = 0;

/**
 * 生成唯一的工具调用 ID
 * @returns {string} 唯一 ID
 */
function generateToolCallId() {
    // 使用时间戳 + 计数器 + 随机数三重保障
    const timestamp = Date.now();
    const counter = (toolIdCounter++ % TOOL_ID_COUNTER_MAX).toString().padStart(4, '0');
    const random = Math.random().toString(36).substring(2, 11);
    return `xml_tool_${timestamp}_${counter}_${random}`;
}

/**
 * 构建 XML 模式的工具结果消息（保留以兼容历史调用方）
 *
 * Stage 3 之后 adapter 不再调用本函数（XML 模式经 appendXmlToolResults 下沉到
 * partsToAPIMessages 内部）。本函数仅供测试与潜在第三方扩展使用。
 *
 * @param {Array} toolCalls   [{ id, name, arguments }, ...]
 * @param {Array} toolResults [{ id, name, result, isError }, ...]
 * @returns {Array} [{ role:'assistant', content:<xml> }, { role:'user', content:<xml> }]
 */
export function buildXmlToolMessages(toolCalls, toolResults) {
    let toolCallXML = '';
    for (const tc of toolCalls) {
        toolCallXML += `<tool_use>\n  <name>${escapeXML(tc.name)}</name>\n  <arguments>${escapeXML(JSON.stringify(tc.arguments))}</arguments>\n</tool_use>\n`;
    }
    let toolResultXML = '';
    for (const r of toolResults) {
        toolResultXML += `<tool_use_result>\n  <name>${escapeXML(r.name)}</name>\n  <result>${escapeXML(JSON.stringify(r.result))}</result>\n</tool_use_result>\n`;
    }
    return [
        { role: 'assistant', content: toolCallXML.trim() },
        { role: 'user', content: toolResultXML.trim() }
    ];
}

/**
 * 把单条 assistant 消息中的 XML 模式 tool_call 配对追加 <tool_use> + <tool_use_result>
 * 作为一条 user 消息 push 到 adapter 输出末尾（在对应 assistant 紧后位置）
 *
 * base-parser.processXmlDetection 把原始 <tool_use> 块从 textContent 剥离，重发时
 * 前序 assistant TEXT part 已不含 tool_use；只追加 result 一侧会破坏 XML 协议对称性
 * 让 LLM 看到孤立的 tool_use_result。这里从 part.name/args/result 重建配对块。
 *
 * 5 个 adapter 的 partsToAPIMessages 在每条 assistant msg 输出之后调用一次（per-turn 内嵌），
 * 而非全量遍历后末尾合并——保证多轮工具调用与对应 assistant 的相邻关系。
 *
 * @param {Array}  out adapter 输出的 API 消息数组（原地修改）
 * @param {Object} msg 单条 assistant 消息
 */
export function appendXmlToolResultsForMessage(out, msg) {
    if (!Array.isArray(out) || !msg || !Array.isArray(msg.parts)) return;

    let xml = '';
    for (const p of msg.parts) {
        if (p.type !== 'tool_call') continue;
        if (p.mode !== 'xml') continue;
        if (p.result == null) continue;
        const argsText = typeof p.args === 'string' ? p.args : JSON.stringify(p.args ?? {});
        const resultText = typeof p.result === 'string' ? p.result : JSON.stringify(p.result);
        xml += `<tool_use>\n  <name>${escapeXML(p.name)}</name>\n  <arguments>${escapeXML(argsText)}</arguments>\n</tool_use>\n`;
        xml += `<tool_use_result>\n  <name>${escapeXML(p.name)}</name>\n  <result>${escapeXML(resultText)}</result>\n</tool_use_result>\n`;
    }

    if (xml.trim()) {
        out.push({ role: 'user', content: xml.trim() });
    }
}

/**
 * 转义 XML 特殊字符
 */
export function escapeXML(str) {
    if (typeof str !== 'string') return '';

    // 修复1: 过滤非法 XML 字符（控制字符，除了 \t \n \r）
    // eslint-disable-next-line no-control-regex
    str = str.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');

    // 修复2: 转义顺序很重要（& 必须最先处理）
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;')
        .replace(/\r/g, '&#xD;'); // 修复3: 转义回车符
}

/**
 * 反转 escapeXML（& 必须最后处理，与转义顺序镜像对称）
 */
export function unescapeXML(str) {
    if (typeof str !== 'string') return '';
    return str
        .replace(/&#xD;/g, '\r')
        .replace(/&apos;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/&gt;/g, '>')
        .replace(/&lt;/g, '<')
        .replace(/&amp;/g, '&');
}

/**
 * 解析工具调用 arguments JSON
 * 回灌历史经 escapeXML 转义，模型可能模仿输出 &quot; 实体格式，失败时反转义重试
 * @param {string} argsText
 * @returns {Object}
 */
function parseToolArguments(argsText) {
    try {
        return JSON.parse(argsText);
    } catch (error) {
        const unescaped = unescapeXML(argsText);
        if (unescaped !== argsText) {
            return JSON.parse(unescaped);
        }
        throw error;
    }
}

/**
 * 收集 markdown 代码块的位置区间（fenced + inline code）
 * 物理删除文本会误伤工具 arguments JSON 内的反引号内容，只能按区间跳过
 * @param {string} text
 * @returns {Array<[number, number]>} [start, end) 区间数组
 */
function findCodeBlockRanges(text) {
    const ranges = [];
    const re = /```[\s\S]*?```|`[^`\n]*`/g;
    let m;
    while ((m = re.exec(text)) !== null) {
        ranges.push([m.index, m.index + m[0].length]);
    }
    return ranges;
}

/**
 * 判断索引是否落在任一代码块区间内
 * @param {Array<[number, number]>} ranges
 * @param {number} index
 * @returns {boolean}
 */
function isInsideCodeBlock(ranges, index) {
    return ranges.some(([start, end]) => index >= start && index < end);
}

/**
 * 将工具列表转换为 XML 描述（注入 system prompt）
 * @param {Array} tools - 工具列表（已经是 OpenAI/Claude/Gemini 格式）
 * @returns {string} XML 格式的工具描述
 */
export function convertToolsToXML(tools) {
    if (!tools || tools.length === 0) return '';

    // 提示过长警告
    if (tools.length > 20) {
        logger.warn('[XML Formatter] 工具数量过多 (>20)，可能导致 system prompt 超长');
    }

    let xml =
        "\n\nIn this environment you have access to a set of tools you can use to answer the user's question.\n\n";
    xml += '## Tool Use Formatting\n\n';
    xml +=
        'Tool use is formatted using XML-style tags. The tool name is enclosed in opening and closing tags, ';
    xml +=
        "and each parameter is similarly enclosed within its own set of tags. Here's the structure:\n\n";
    xml += '<tool_use>\n';
    xml += '  <name>{tool_name}</name>\n';
    xml += '  <arguments>{json_arguments}</arguments>\n';
    xml += '</tool_use>\n\n';

    // 工具列表
    xml += '## Available Tools\n\n';
    tools.forEach((tool) => {
        // 提取工具信息（兼容不同格式）
        const name = tool.name || tool.function?.name;
        const description = tool.description || tool.function?.description;
        const parameters =
            tool.inputSchema || tool.input_schema || tool.parameters || tool.function?.parameters;

        if (!name) return; // 跳过无效工具

        xml += `<tool>\n`;
        xml += `  <name>${escapeXML(name)}</name>\n`;
        xml += `  <description>${escapeXML(description || 'No description')}</description>\n`;
        xml += `  <arguments>${escapeXML(JSON.stringify({ jsonSchema: parameters }))}</arguments>\n`;
        xml += `</tool>\n\n`;
    });

    // 详细示例
    xml += '## Tool Use Examples\n\n';
    xml += 'Here are some examples demonstrating proper tool use:\n\n';
    xml += '---\n';
    xml += 'User: What is the current time?\n\n';
    xml += 'Assistant: I will use the datetime tool to get the current time.\n';
    xml += '<tool_use>\n';
    xml += '  <name>datetime</name>\n';
    xml += '  <arguments>{"action": "current"}</arguments>\n';
    xml += '</tool_use>\n\n';
    xml += 'User: <tool_use_result>\n';
    xml += '  <name>datetime</name>\n';
    xml += '  <result>2025-12-14 15:30:00</result>\n';
    xml += '</tool_use_result>\n\n';
    xml += 'Assistant: The current time is 15:30:00 on December 14, 2025.\n\n';
    xml += '---\n';
    xml += 'User: Search for the latest AI news.\n\n';
    xml += 'Assistant: I will search for the latest AI news using the web_search tool.\n';
    xml += '<tool_use>\n';
    xml += '  <name>web_search</name>\n';
    xml += '  <arguments>{"query": "latest AI news 2025"}</arguments>\n';
    xml += '</tool_use>\n\n';
    xml += '---\n\n';

    // Extended Thinking 支持
    xml += '## Extended Thinking with Tools\n\n';
    xml += 'You can use <thinking> tags to show your reasoning process BEFORE calling tools:\n\n';
    xml +=
        '<thinking>I need to check the weather in Tokyo, so I will call the weather tool.</thinking>\n';
    xml += '<tool_use>\n';
    xml += '  <name>weather</name>\n';
    xml += '  <arguments>{"location": "Tokyo"}</arguments>\n';
    xml += '</tool_use>\n\n';

    // 明确的规则
    xml += '## Tool Use Rules\n\n';
    xml += 'Here are the rules you MUST follow:\n';
    xml +=
        '1. Always use the correct parameter values. Never use variable names, use actual values.\n';
    xml += '2. Call a tool only when needed. Do not call tools if you can answer directly.\n';
    xml += '3. If no tool is needed, just answer the question directly.\n';
    xml += '4. **CRITICAL**: Never repeat the exact same tool call with the same parameters.\n';
    xml +=
        '5. **CRITICAL**: Simply mentioning a tool in <thinking> does NOT execute it. You MUST output the <tool_use> XML block.\n';
    xml += '6. Use the EXACT format shown above. Do not use any other format.\n\n';

    // 激励语句
    xml += 'Now Begin! If you use tools correctly, you will be rewarded.\n';

    return xml;
}

/**
 * 从文本中提取 XML 工具调用（完整匹配，非流式）
 * 支持多种 XML 格式：
 * 1. tool_use 格式 (CherryStudio)
 * 2. invoke 格式 (Claude native)
 * 3. function_call 格式 (一些代理)
 * 4. antml:invoke 格式 (Anthropic 官方)
 * @param {string} text - 模型响应文本
 * @returns {Array} 工具调用列表 [{ id, name, arguments }, ...]
 */
export function extractXMLToolCalls(text) {
    if (!text || typeof text !== 'string') return [];

    // 代码块内的 XML 是示例展示不是真实调用，按起点区间跳过
    const codeBlockRanges = findCodeBlockRanges(text);

    const toolCalls = [];

    // 格式 1: tool_use 格式 (CherryStudio 风格)
    // 修复 ReDoS: 使用两步解析避免灾难性回溯
    const toolUseBlockRegex = /<tool_use>([\s\S]*?)<\/tool_use>/gi;
    let match;
    while ((match = toolUseBlockRegex.exec(text)) !== null) {
        if (isInsideCodeBlock(codeBlockRanges, match.index)) continue;
        const block = match[1];
        // 在块内解析 name 和 arguments（简单正则，无回溯风险）
        const nameMatch = /<name>([^<]+)<\/name>/.exec(block);
        const argsMatch = /<arguments>([\s\S]*?)<\/arguments>/.exec(block);

        if (nameMatch && argsMatch) {
            const name = nameMatch[1].trim();
            const argsText = argsMatch[1].trim();
            try {
                const args = parseToolArguments(argsText);
                toolCalls.push({
                    id: generateToolCallId(),
                    name,
                    arguments: args
                });
                logger.debug('[XML Parser] 提取到 tool_use 格式工具调用:', name);
            } catch (error) {
                logger.error(
                    '[XML Parser] tool_use 格式解析参数失败:',
                    argsText.substring(0, 100),
                    error
                );
                // 返回错误对象而不是跳过
                toolCalls.push({
                    id: generateToolCallId(),
                    name,
                    arguments: {},
                    _parseError: error.message,
                    _originalText: argsText.substring(0, 200)
                });
            }
        }
    }

    // 格式 2: function_call 格式 (一些代理使用)
    // 修复 ReDoS: 使用两步解析避免灾难性回溯
    const functionCallBlockRegex = /<function_call>([\s\S]*?)<\/function_call>/gi;
    while ((match = functionCallBlockRegex.exec(text)) !== null) {
        if (isInsideCodeBlock(codeBlockRanges, match.index)) continue;
        const block = match[1];
        // 在块内解析 name 和 arguments（简单正则，无回溯风险）
        const nameMatch = /<name>([^<]+)<\/name>/.exec(block);
        const argsMatch = /<arguments>([\s\S]*?)<\/arguments>/.exec(block);

        if (nameMatch && argsMatch) {
            const name = nameMatch[1].trim();
            const argsText = argsMatch[1].trim();
            try {
                const args = parseToolArguments(argsText);
                toolCalls.push({
                    id: generateToolCallId(),
                    name,
                    arguments: args
                });
                logger.debug('[XML Parser] 提取到 function_call 格式工具调用:', name);
            } catch (error) {
                logger.error(
                    '[XML Parser] function_call 格式解析参数失败:',
                    argsText.substring(0, 100),
                    error
                );
                // 返回错误对象而不是跳过
                toolCalls.push({
                    id: generateToolCallId(),
                    name,
                    arguments: {},
                    _parseError: error.message,
                    _originalText: argsText.substring(0, 200)
                });
            }
        }
    }

    // 格式 3: invoke 格式 (Claude native XML)
    // 匹配: <invoke name="xxx"> 或 <invoke name="xxx">
    const invokeRegex = /<(?:antml:)?invoke\s+name="([^"]+)">([\s\S]*?)<\/(?:antml:)?invoke>/gi;
    while ((match = invokeRegex.exec(text)) !== null) {
        if (isInsideCodeBlock(codeBlockRanges, match.index)) continue;
        const name = match[1].trim();
        const paramsContent = match[2];
        const args = {};

        // 解析 parameter 标签（兼容 antml:parameter）
        const paramRegex =
            /<(?:antml:)?parameter\s+name="([^"]+)">([\s\S]*?)<\/(?:antml:)?parameter>/gi;
        let paramMatch;
        while ((paramMatch = paramRegex.exec(paramsContent)) !== null) {
            const paramName = paramMatch[1].trim();
            let paramValue = paramMatch[2].trim();
            // 尝试解析 JSON 值
            try {
                paramValue = JSON.parse(paramValue);
            } catch (_error) {
                // 保留字符串值
            }
            args[paramName] = paramValue;
        }

        if (Object.keys(args).length > 0 || paramsContent.trim() === '') {
            toolCalls.push({
                id: generateToolCallId(),
                name,
                arguments: args
            });
            logger.debug('[XML Parser] 提取到 invoke 格式工具调用:', name);
        }
    }

    // 输出解析结果日志
    if (toolCalls.length > 0) {
        logger.debug('[XML Parser] 共提取到', toolCalls.length, '个工具调用');
    }

    return toolCalls;
}

// 与状态机正则 (?:NS)?invoke 的命名空间支持保持镜像
const XML_TAG_NS = ['ant', 'ml:'].join('');

// 流式标签前缀候选：chunk 边界可能把标签切成两半，buffer 尾部命中前缀时保留待续拼
const OPEN_TAG_PREFIXES = ['<thinking>', '<tool_use', '<invoke ', `<${XML_TAG_NS}invoke `];
const THINKING_CLOSE_PREFIXES = ['</thinking>'];
const TOOL_CLOSE_PREFIXES = ['</tool_use>', '</invoke>', `</${XML_TAG_NS}invoke>`];

/**
 * 查找 buffer 尾部被 chunk 边界切断的候选标签前缀起点
 * @param {string} buffer
 * @param {Array<string>} candidates - 候选标签列表
 * @returns {number} 前缀起点索引，无则 -1
 */
function findPartialTagStart(buffer, candidates) {
    const lt = buffer.lastIndexOf('<');
    if (lt === -1) return -1;
    const tail = buffer.slice(lt);
    // 含 '>' 的尾部已是完整标签，完整候选早被状态机消费，到这里说明不是目标标签
    if (tail.includes('>')) return -1;
    for (const candidate of candidates) {
        if (candidate.startsWith(tail) || tail.startsWith(candidate)) return lt;
    }
    return -1;
}

/**
 * buffer 尾部疑似被切断的代码块围栏（'`' 或 '``'）长度
 * @param {string} buffer
 * @returns {number}
 */
function partialFenceLength(buffer) {
    if (buffer.endsWith('``') && !buffer.endsWith('```')) return 2;
    if (buffer.endsWith('`') && !buffer.endsWith('``')) return 1;
    return 0;
}

/**
 * 查找行首代码围栏：CommonMark 要求 fence 在行首，行内三反引号是 code span，
 * 误入 fence 态会把后续所有工具调用当代码内容直通不执行
 * @param {string} buffer
 * @param {string} displayText - 判定 buffer[0] 是否处于行首
 * @returns {number}
 */
function findFenceIndex(buffer, displayText) {
    let from = 0;
    let idx;
    while ((idx = buffer.indexOf('```', from)) !== -1) {
        const atLineStart =
            idx === 0 ? displayText === '' || displayText.endsWith('\n') : buffer[idx - 1] === '\n';
        if (atLineStart) return idx;
        from = idx + 3;
    }
    return -1;
}

/**
 * XML 流式累积器（流式解析）
 * 处理流式响应中可能截断的 XML 标签
 * 支持 thinking 标签（Claude Extended Thinking with Tools）
 */
export class XMLStreamAccumulator {
    constructor() {
        this.buffer = ''; // 待消费的文本
        this.displayText = ''; // 展示给用户的文本（不含 XML 标签）
        this.inToolUse = false; // 是否在 tool_use/invoke 标签内
        this.inThinking = false; // 是否在 thinking 标签内
        this.inCodeFence = false; // 是否在 markdown 代码块内（块内 XML 是示例，不触发工具检测）
        this.currentToolXML = ''; // 当前工具的 XML
        this.currentThinking = ''; // 当前思考的内容
        this.completedCalls = []; // 已完成的工具调用
        this.thinkingBlocks = []; // 已完成的思考块
        // getCompletedCalls 会清空 completedCalls，流结束 flush 判定需要不被清的事实记录
        this.hasEverCompleted = false;
    }

    /**
     * 处理增量文本
     * @param {string} deltaText - 流式增量文本
     * @returns {Object} { hasToolCalls: boolean, displayText: string, error: string|null }
     */
    processDelta(deltaText) {
        if (!deltaText) return { hasToolCalls: false, displayText: this.displayText, error: null };

        try {
            this.buffer += deltaText;

            // 错误边界 - 检测过长的 buffer（防止内存泄漏）
            if (this.buffer.length > XML_MAX_BUFFER_SIZE) {
                logger.error('[XMLStreamAccumulator] Buffer 过长，可能存在格式错误');
                this.buffer = this.buffer.slice(-1000);
                this.inToolUse = false;
                this.currentToolXML = '';
                return {
                    hasToolCalls: this.completedCalls.length > 0,
                    displayText: this.displayText,
                    error: 'Buffer overflow, possible malformed XML'
                };
            }

            const error = this._consumeBuffer();

            return {
                hasToolCalls: this.completedCalls.length > 0,
                displayText: this.displayText,
                error
            };
        } catch (error) {
            logger.error('[XMLStreamAccumulator] processDelta 异常:', error);
            this.inToolUse = false;
            this.buffer = '';
            this.currentToolXML = '';
            return {
                hasToolCalls: this.completedCalls.length > 0,
                displayText: this.displayText,
                error: error.message
            };
        }
    }

    /**
     * 循环消费 buffer 直到无可推进内容
     * 单个 delta 可能携带多个完整标签块，块后文本也可能内嵌下一个开始标签，
     * 必须重扫而非直接进 displayText；尾部疑似被切断的标签前缀保留待下轮续拼
     * @returns {string|null} 错误信息
     * @private
     */
    _consumeBuffer() {
        let progressed = true;
        while (progressed && this.buffer) {
            progressed = false;

            if (this.inThinking) {
                const endMatch = this.buffer.match(/<\/thinking>/);
                if (endMatch) {
                    this.inThinking = false;
                    const inner = this.buffer.substring(0, endMatch.index);
                    const thinkingContent = (this.currentThinking + inner)
                        .replace(/<thinking>/, '')
                        .trim();

                    if (thinkingContent) {
                        this.thinkingBlocks.push(thinkingContent);
                        logger.debug(
                            '[XMLStreamAccumulator] 检测到思考块:',
                            thinkingContent.substring(0, 50) + '...'
                        );
                    }

                    this.currentThinking = '';
                    this.buffer = this.buffer.substring(endMatch.index + '</thinking>'.length);
                    progressed = true;
                } else {
                    const partialStart = findPartialTagStart(this.buffer, THINKING_CLOSE_PREFIXES);
                    const safeEnd = partialStart === -1 ? this.buffer.length : partialStart;
                    this.currentThinking += this.buffer.substring(0, safeEnd);
                    this.buffer = this.buffer.substring(safeEnd);

                    if (this.currentThinking.length > 20000) {
                        logger.error('[XMLStreamAccumulator] 单个思考块过长，跳过');
                        this.inThinking = false;
                        this.currentThinking = '';
                        this.buffer = '';
                        return 'Single thinking block too large';
                    }
                }
            } else if (this.inToolUse) {
                const endMatch = this.buffer.match(/<\/(?:tool_use|(?:antml:)?invoke)>/);
                if (endMatch) {
                    this.inToolUse = false;
                    const closingEnd = endMatch.index + endMatch[0].length;
                    const toolXML = this.currentToolXML + this.buffer.substring(0, closingEnd);
                    this.currentToolXML = '';
                    this.buffer = this.buffer.substring(closingEnd);
                    progressed = true;

                    try {
                        logger.debug('[XMLStreamAccumulator] 原始 XML 内容:', toolXML);
                        const toolCalls = extractXMLToolCalls(toolXML);
                        if (toolCalls.length > 0) {
                            this.completedCalls.push(...toolCalls);
                            this.hasEverCompleted = true;
                        } else {
                            logger.warn(
                                '[XMLStreamAccumulator] 解析 XML 未提取到工具调用，XML:',
                                toolXML.substring(0, 500)
                            );
                        }
                    } catch (parseError) {
                        logger.error(
                            '[XMLStreamAccumulator] 解析 XML 失败:',
                            parseError,
                            'XML:',
                            toolXML.substring(0, 500)
                        );
                    }
                } else {
                    const partialStart = findPartialTagStart(this.buffer, TOOL_CLOSE_PREFIXES);
                    const safeEnd = partialStart === -1 ? this.buffer.length : partialStart;
                    this.currentToolXML += this.buffer.substring(0, safeEnd);
                    this.buffer = this.buffer.substring(safeEnd);

                    if (this.currentToolXML.length > XML_MAX_TOOL_CONTENT_LENGTH) {
                        logger.error('[XMLStreamAccumulator] 单个工具调用过长，跳过');
                        this.inToolUse = false;
                        this.currentToolXML = '';
                        this.buffer = '';
                        return 'Single tool call too large';
                    }
                }
            } else if (this.inCodeFence) {
                const fenceEnd = findFenceIndex(this.buffer, this.displayText);
                if (fenceEnd !== -1) {
                    this.inCodeFence = false;
                    this.displayText += this.buffer.substring(0, fenceEnd + 3);
                    this.buffer = this.buffer.substring(fenceEnd + 3);
                    progressed = true;
                } else {
                    const keep = partialFenceLength(this.buffer);
                    const safeEnd = this.buffer.length - keep;
                    this.displayText += this.buffer.substring(0, safeEnd);
                    this.buffer = this.buffer.substring(safeEnd);
                }
            } else {
                const thinkingStartMatch = this.buffer.match(/<thinking>/);
                const toolStartMatch = this.buffer.match(
                    /<(tool_use|(?:antml:)?invoke\s+name="[^"]+")/
                );
                const fenceIndex = findFenceIndex(this.buffer, this.displayText);

                // 三类标记都可能命中，取最靠前者决定状态转移
                const candidates = [
                    thinkingStartMatch && { index: thinkingStartMatch.index, kind: 'thinking' },
                    toolStartMatch && { index: toolStartMatch.index, kind: 'tool' },
                    fenceIndex !== -1 && { index: fenceIndex, kind: 'fence' }
                ].filter(Boolean);

                if (candidates.length > 0) {
                    candidates.sort((a, b) => a.index - b.index);
                    const first = candidates[0];
                    this.displayText += this.buffer.substring(0, first.index);

                    if (first.kind === 'fence') {
                        this.inCodeFence = true;
                        this.displayText += '```';
                        this.buffer = this.buffer.substring(first.index + 3);
                    } else if (first.kind === 'thinking') {
                        this.inThinking = true;
                        this.currentThinking = '';
                        this.buffer = this.buffer.substring(first.index);
                    } else {
                        this.inToolUse = true;
                        this.currentToolXML = '';
                        this.buffer = this.buffer.substring(first.index);
                    }
                    progressed = true;
                } else {
                    let keepFrom = this.buffer.length;
                    const tagStart = findPartialTagStart(this.buffer, OPEN_TAG_PREFIXES);
                    if (tagStart !== -1) keepFrom = tagStart;
                    const fenceKeep = partialFenceLength(this.buffer);
                    if (fenceKeep > 0) {
                        keepFrom = Math.min(keepFrom, this.buffer.length - fenceKeep);
                    }
                    this.displayText += this.buffer.substring(0, keepFrom);
                    this.buffer = this.buffer.substring(keepFrom);
                }
            }
        }
        return null;
    }

    /**
     * 流结束时排空残留
     * 未闭合的标签内容按原文回吐到 displayText，否则被
     * partial-tag 保留逻辑截留的尾部文本会在流结束时丢失
     * @returns {string} 最终 displayText
     */
    flush() {
        if (this.inThinking) {
            this.displayText += this.currentThinking + this.buffer;
        } else if (this.inToolUse) {
            this.displayText += this.currentToolXML + this.buffer;
        } else {
            this.displayText += this.buffer;
        }
        this.buffer = '';
        this.currentThinking = '';
        this.currentToolXML = '';
        this.inThinking = false;
        this.inToolUse = false;
        this.inCodeFence = false;
        return this.displayText;
    }

    /**
     * 获取已完成的工具调用
     * 返回副本并清空数组，防止重复调用返回相同工具
     */
    getCompletedCalls() {
        const calls = [...this.completedCalls];
        this.completedCalls = []; // 清空已处理的工具
        logger.debug(`[XMLStreamAccumulator] 返回 ${calls.length} 个工具调用并清空缓存`);
        return calls;
    }

    /**
     * 获取已完成的思考块
     * @returns {Array} 思考内容数组
     */
    getThinkingBlocks() {
        return this.thinkingBlocks;
    }

    /**
     * 重置累积器
     */
    reset() {
        this.buffer = '';
        this.displayText = '';
        this.inToolUse = false;
        this.inThinking = false;
        this.inCodeFence = false;
        this.currentToolXML = '';
        this.currentThinking = '';
        this.completedCalls = [];
        this.thinkingBlocks = [];
        this.hasEverCompleted = false;
    }
}
