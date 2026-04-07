/**
 * OpenAI API 请求处理器
 * 支持 OpenAI 兼容的 API 端点
 */

import { state } from '../core/state.js';
import { buildModelParams, buildThinkingConfig, buildVerbosityConfig, getCustomHeadersObject } from './params.js';
import { getPrefillMessages, getOpeningMessages } from '../utils/prefill.js';
import { processVariables } from '../utils/variables.js';
import { filterMessagesByCapabilities } from '../utils/message-filter.js';
import { getCurrentModelCapabilities, getCurrentProvider } from '../providers/manager.js';
import { toOpenAIMessages } from '../messages/api-adapters.js';

import { getOrCreateMappedId } from './format-converter.js';
import { escapeXML } from '../tools/xml-formatter.js';

/**
 * 发送 OpenAI 格式的请求
 * @param {string} endpoint - API 端点
 * @param {string} apiKey - API 密钥
 * @param {string} model - 模型名称
 * @param {AbortSignal} signal - 取消信号
 * @returns {Promise<Response>} Fetch Response
 */
export async function sendOpenAIRequest(endpoint, apiKey, model, signal = null) {
    // 使用提供商的原始格式（OpenAI 或 OpenAI-Responses）
    const provider = getCurrentProvider();
    const format = provider?.apiFormat || 'openai';
    const isResponsesFormat = format === 'openai-responses';
    // 端点已在 UI 层正确补全，这里做兼容处理（旧配置可能仍是 /chat/completions）
    let apiEndpoint = endpoint;
    if (isResponsesFormat && !endpoint.includes('/responses')) {
        apiEndpoint = endpoint.replace('/chat/completions', '/responses');
    }

    // 构建消息数组：新格式 → OpenAI API 格式
    // Responses API 模式下注入 reasoning items（encrypted_content 配对）
    let messages = toOpenAIMessages(
        state.messages.filter(m => !m.isError && !m.error),
        { injectReasoning: isResponsesFormat }
    );

    // 根据模型能力过滤消息（在格式转换前，OpenAI格式）
    const capabilities = getCurrentModelCapabilities();
    if (capabilities) {
        messages = filterMessagesByCapabilities(messages, capabilities);
        console.log('📋 [OpenAI] 消息已根据模型能力过滤:', {
            capabilities,
            originalCount: state.messages.length,
            filteredCount: messages.length
        });
    }

    // System Prompt 独立于预填充开关（总是生效）
    if (state.systemPrompt) {
        messages.unshift({
            role: 'system',
            content: processVariables(state.systemPrompt)
        });
    }

    // 开场对话插入到 System Prompt 之后、对话历史之前
    if (state.prefillEnabled) {
        const opening = getOpeningMessages();
        if (opening.length > 0) {
            // 找到 system 消息后的位置插入
            const systemIndex = messages.findIndex(m => m.role === 'system');
            const insertIndex = systemIndex >= 0 ? systemIndex + 1 : 0;
            messages.splice(insertIndex, 0, ...opening);
        }
    }

    // 预填充消息追加到末尾（用户最新消息之后）
    if (state.prefillEnabled) {
        const prefill = getPrefillMessages();
        messages.push(...prefill);
    }

    const requestBody = {
        model: model,
        stream: state.streamEnabled,
    };

    // 根据API格式选择消息参数名
    if (isResponsesFormat) {
        // Responses API 使用 input（reasoning items 已由 toOpenAIMessages 注入）
        requestBody.input = messages;

        // 请求返回加密的推理内容（用于多轮对话保持思维链上下文）
        requestBody.include = ['reasoning.encrypted_content'];
    } else {
        // Chat Completions API 使用 messages
        requestBody.messages = messages;
    }

    // 添加自定义模型参数（两种格式共用 openai 参数）
    Object.assign(requestBody, buildModelParams('openai'));

    // 添加思维链配置（已在 params.js 中根据格式自动选择）
    const thinkingConfig = buildThinkingConfig(format, model);
    if (thinkingConfig) Object.assign(requestBody, thinkingConfig);

    // 添加输出详细度配置（所有格式都发送）
    const verbosityConfig = buildVerbosityConfig();
    if (verbosityConfig) Object.assign(requestBody, verbosityConfig);

    // 添加工具调用支持 (Function Calling)
    const tools = [];

    // Code Interpreter 工具
    if (state.codeExecutionEnabled) {
        tools.push({
            type: "code_interpreter"
        });
        console.log('[OpenAI] 📊 Code Interpreter 工具已启用');
    }

    // Web Search 工具
    if (state.webSearchEnabled) {
        tools.push({
            type: "function",
            function: {
                name: "web_search",
                description: "Search the web for current information",
                parameters: {
                    type: "object",
                    properties: {
                        query: { type: "string", description: "Search query" }
                    },
                    required: ["query"]
                }
            }
        });
    }

    // 添加工具系统中的工具
    try {
        const { getToolsForAPI } = await import('../tools/manager.js');
        const systemTools = getToolsForAPI(format);
        tools.push(...systemTools);
    } catch (error) {
        console.warn('[OpenAI] 工具系统未加载:', error);
    }

    if (tools.length > 0) {
        if (state.xmlToolCallingEnabled) {
            // XML 模式：只注入 XML 到 system prompt，不使用原生 tools 字段
            const { injectToolsToOpenAI, getXMLInjectionStats } = await import('../tools/tool-injection.js');
            injectToolsToOpenAI(messages, tools);

            // 性能监控 - 记录 token 消耗
            const stats = getXMLInjectionStats(tools);
            console.log('[OpenAI] 📊 XML 模式启用，注入统计:', stats);
            if (stats.estimatedTokens > 2000) {
                console.warn('[OpenAI] ⚠️ XML 描述过长，预计消耗', stats.estimatedTokens, 'tokens');
            }
        } else {
            // 原生模式：使用标准 tools 字段
            requestBody.tools = tools;
            requestBody.tool_choice = "auto";
            if (!isResponsesFormat) {
                // parallel_tool_calls 仅 Chat Completions 支持
                requestBody.parallel_tool_calls = true;
            }
            console.log('[OpenAI] 📊 原生 tools 模式，工具数量:', tools.length);
        }
    }

    console.log(`Sending ${isResponsesFormat ? 'Responses API' : 'Chat Completions'} request:`, JSON.stringify(requestBody, null, 2));

    const options = {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
            ...getCustomHeadersObject(), // 合并自定义请求头
        },
        body: JSON.stringify(requestBody),
    };
    if (signal) options.signal = signal;
    return await fetch(apiEndpoint, options);
}

/**
 * 构建 OpenAI 工具结果消息（OpenAI 原生格式）
 * @param {Array} toolCalls - 工具调用列表 [{id, name, arguments}]
 * @param {Array} toolResults - 格式无关的结果 [{id, name, result, isError}]
 * @returns {Array} OpenAI 格式的消息数组
 */
export function buildToolResultMessages(toolCalls, toolResults) {
    // XML 模式
    if (state.xmlToolCallingEnabled) {
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

    // Responses API 格式
    const provider = getCurrentProvider();
    if (provider?.apiFormat === 'openai-responses') {
        const messages = [];
        for (const tc of toolCalls) {
            messages.push({
                type: 'function_call',
                id: tc.id,
                call_id: tc.id,
                name: tc.name,
                arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments)
            });
        }
        for (const r of toolResults) {
            const mappedId = getOrCreateMappedId(r.id, 'openai');
            messages.push({
                type: 'function_call_output',
                call_id: mappedId,
                output: JSON.stringify(r.result)
            });
        }
        return messages;
    }

    // Chat Completions API 原生格式
    return [
        {
            role: 'assistant',
            content: '',
            tool_calls: toolCalls.map(tc => ({
                id: tc.id,
                type: 'function',
                function: {
                    name: tc.name,
                    arguments: JSON.stringify(tc.arguments)
                }
            }))
        },
        ...toolResults.map(r => ({
            role: 'tool',
            tool_call_id: getOrCreateMappedId(r.id, 'openai'),
            content: JSON.stringify(r.result)
        }))
    ];
}
