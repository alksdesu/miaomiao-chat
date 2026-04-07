/**
 * Gemini API 请求处理器
 * 支持 Google AI Studio 和 Vertex AI
 */

import { state, elements } from '../core/state.js';
import { buildModelParams, buildThinkingConfig, getCustomHeadersObject } from './params.js';
import { getPrefillMessages, getOpeningMessages } from '../utils/prefill.js';
import { processVariables } from '../utils/variables.js';
import { compressImage } from '../utils/images.js';
import { filterMessagesByCapabilities } from '../utils/message-filter.js';
import { getCurrentModelCapabilities, getCurrentProvider } from '../providers/manager.js';
import { toGeminiContents } from '../messages/api-adapters.js';
import { escapeXML } from '../tools/xml-formatter.js';

/**
 * 处理 contents 用于发送请求：压缩历史图片
 * @param {Array} contents - Gemini 格式的消息数组
 * @returns {Promise<Array>} 处理后的消息数组
 */
async function processContentsForRequest(contents) {
    const processed = [];

    for (let i = 0; i < contents.length; i++) {
        const content = contents[i];
        const isLastMessage = i === contents.length - 1;

        // 最后一条消息（当前用户输入）保持完整
        if (isLastMessage) {
            processed.push(content);
            continue;
        }

        // 处理 parts
        const processedParts = [];
        for (const part of content.parts) {
            if (part.inlineData || part.inline_data) {
                const inlineData = part.inlineData || part.inline_data;
                const mimeType = inlineData.mimeType || inlineData.mime_type;
                const data = inlineData.data;

                // 压缩图片
                const compressed = await compressImage(data, mimeType, { apiFormat: 'gemini' });

                processedParts.push({
                    inlineData: {
                        mimeType: compressed.mimeType,
                        data: compressed.data
                    },
                    // 保留 thoughtSignature
                    ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {})
                });
            } else {
                // 非图片部分直接保留
                processedParts.push(part);
            }
        }

        processed.push({
            role: content.role,
            parts: processedParts,
            // 保留消息级别的 thoughtSignature
            ...(content.thoughtSignature ? { thoughtSignature: content.thoughtSignature } : {})
        });
    }

    return processed;
}

/**
 * 构建带 thoughtSignature 的 Gemini contents
 * 全局传播签名：如果任何 content 有签名，所有 contents 都必须有
 * @param {Array} contents - Gemini 格式的消息数组
 * @returns {Array} 处理后的消息数组
 */
function buildGeminiContentsWithSignatures(contents) {
    // 每条消息保留自己的签名，不做全局传播
    return contents.map(content => {
        // 检查消息级别的签名
        const msgSignature = content.thoughtSignature || null;

        // 检查 part 级别的签名
        const partSignature = content.parts?.find(p => p.thoughtSignature)?.thoughtSignature || null;

        // 该消息对应的签名（消息级别优先）
        const signature = msgSignature || partSignature;

        if (signature) {
            // 有签名：应用到该消息的所有 parts
            return {
                role: content.role,
                parts: content.parts.map(part => ({
                    ...part,
                    thoughtSignature: signature
                }))
            };
        }

        // 没有签名：保持原样
        return {
            role: content.role,
            parts: content.parts
        };
    });
}

/**
 * 发送 Gemini 格式的请求
 * @param {string} baseEndpoint - API 端点基础路径
 * @param {string} apiKey - API 密钥
 * @param {string} model - 模型名称
 * @param {AbortSignal} signal - 取消信号
 * @returns {Promise<Response>} Fetch Response
 */
export async function sendGeminiRequest(baseEndpoint, apiKey, model, signal = null) {
    // 根据流式模式选择正确的端点
    const action = state.streamEnabled ? 'streamGenerateContent' : 'generateContent';

    // 智能端点处理：根据提供商的原始 apiFormat 决定端点格式
    const provider = getCurrentProvider();
    const isNativeGeminiProvider = provider && provider.apiFormat === 'gemini';

    let endpoint;
    if (isNativeGeminiProvider) {
        // 原生 Gemini 提供商：清理路径并构建 Gemini 标准格式
        let cleanedEndpoint = baseEndpoint.replace(/\/$/, '');
        cleanedEndpoint = cleanedEndpoint
            .replace(/\/v1\/chat\/completions$/, '')  // 移除 OpenAI 路径
            .replace(/\/chat\/completions$/, '')
            .replace(/\/v1\/messages$/, '')  // 移除 Claude 路径
            .replace(/\/messages$/, '')
            .replace(/\/v1\/responses$/, '')  // 移除 OpenAI Responses 路径
            .replace(/\/responses$/, '');
        endpoint = `${cleanedEndpoint}/v1beta/models/${model}:${action}`;
        console.log('🔧 [Gemini] 原生 Gemini 提供商，构建标准端点:', endpoint);
    } else {
        // 统一代理（OpenAI/Claude/OpenAI-Responses 提供商切换格式）：
        // 保持原始端点不变，代理会根据请求体自动识别 Gemini 格式
        endpoint = baseEndpoint.replace(/\/$/, '');
        console.log('🔧 [Gemini] 统一代理模式（原始格式: ' + (provider?.apiFormat || 'unknown') + '），保持原始端点:', endpoint);
    }

    // 构建 generationConfig（使用自定义参数或默认值）
    const generationConfig = buildModelParams('gemini');

    // 获取图片配置
    const imageSize = elements.imageSizeSelect?.value;
    if (imageSize) {
        // 添加图片生成配置
        generationConfig.responseModalities = ['TEXT', 'IMAGE'];
        generationConfig.imageConfig = {
            imageSize: imageSize, // "2K" 或 "4K"
        };
    }

    // 添加思维链配置 (Gemini 3+ 使用 thinkingLevel，2.5 使用 thinkingBudget)
    const geminiThinkingConfig = buildThinkingConfig('gemini', model);
    if (geminiThinkingConfig) {
        generationConfig.thinkingConfig = geminiThinkingConfig.thinkingConfig;
    }

    // 根据端点判断使用 Vertex AI 还是 AI Studio 的安全设置
    let safetySettings;
    if (baseEndpoint.includes('aiplatform.googleapis.com')) {
        // Vertex AI 格式（10 个类别，threshold: "OFF"）
        safetySettings = [
            { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'OFF' },
            { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'OFF' },
            { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'OFF' },
            { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'OFF' },
            { category: 'HARM_CATEGORY_CIVIC_INTEGRITY', threshold: 'OFF' },
            { category: 'HARM_CATEGORY_IMAGE_HATE', threshold: 'OFF' },
            { category: 'HARM_CATEGORY_IMAGE_DANGEROUS_CONTENT', threshold: 'OFF' },
            { category: 'HARM_CATEGORY_IMAGE_HARASSMENT', threshold: 'OFF' },
            { category: 'HARM_CATEGORY_IMAGE_SEXUALLY_EXPLICIT', threshold: 'OFF' },
            { category: 'HARM_CATEGORY_JAILBREAK', threshold: 'OFF' },
        ];
    } else {
        // AI Studio 格式（5 个类别，threshold: "BLOCK_NONE"）
        safetySettings = [
            { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_CIVIC_INTEGRITY', threshold: 'BLOCK_NONE' },
        ];
    }

    // 处理 contents：新格式 → Gemini API 格式
    let filtered = state.messages.filter(m => !m.isError && !m.error);

    const capabilities = getCurrentModelCapabilities();
    if (capabilities) {
        filtered = filterMessagesByCapabilities(filtered, capabilities);
        console.log('📋 [Gemini] 消息已根据模型能力过滤:', {
            capabilities,
            filteredCount: filtered.length
        });
    }

    // 使用 api-adapters 转换为 Gemini 格式
    const geminiContents = toGeminiContents(filtered);

    // ⚠️ 安全检查：如果所有消息都被过滤掉，抛出错误
    if (geminiContents.length === 0) {
        throw new Error('所有消息都被过滤，无法发送请求。请至少输入一条有效消息。');
    }

    console.log('🔄 [Gemini] 新格式 → Gemini 转换完成:', geminiContents.length, '条消息');

    // 压缩历史图片以减小请求体积
    const processedContents = await processContentsForRequest(geminiContents);

    // 开场对话插入到对话历史之前（Gemini 的 systemInstruction 是独立参数）
    let finalContents = processedContents;
    if (state.prefillEnabled) {
        const opening = getOpeningMessages('gemini');
        if (opening.length > 0) {
            finalContents = [...opening, ...processedContents];
        }
    }

    // 预填充消息追加到末尾（用户最新消息之后）
    if (state.prefillEnabled) {
        const prefill = getPrefillMessages('gemini');
        finalContents = [...finalContents, ...prefill];
    }

    // 构建带 thoughtSignature 的 contents
    // 只传播从 API 响应中接收到的签名，不自动生成新签名
    const contentsWithSignatures = buildGeminiContentsWithSignatures(finalContents);

    const requestBody = {
        contents: contentsWithSignatures,
        generationConfig: generationConfig,
        safetySettings: safetySettings,
    };

    // 添加 System Instruction (独立于预填充开关)
    const systemParts = [];

    // 1. 优先使用 geminiSystemParts（多段系统提示）- 仅在开关启用时
    if (state.geminiSystemPartsEnabled && state.geminiSystemParts && state.geminiSystemParts.length > 0) {
        state.geminiSystemParts.forEach(part => {
            if (part.text && part.text.trim()) {
                systemParts.push({ text: processVariables(part.text) });
            }
        });
    }

    // 2. 如果没有自定义 parts，但有 systemPrompt，使用单个 part
    if (systemParts.length === 0 && state.systemPrompt) {
        systemParts.push({ text: processVariables(state.systemPrompt) });
    }

    // 3. 添加到请求体
    if (systemParts.length > 0) {
        requestBody.systemInstruction = { parts: systemParts };
    }

    // ⭐ 添加工具调用支持 (Function Calling)
    const tools = [];

    // 1. Code Execution 工具（新增）
    if (state.codeExecutionEnabled) {
        tools.push({ codeExecution: {} });
        console.log('[Gemini] 📊 Code Execution 工具已启用');
    }

    // 2. Google Search 工具（保持不变）
    if (state.webSearchEnabled) {
        tools.push({ googleSearch: {} });
        tools.push({ urlContext: {} });  // 可选：允许读取 URL 内容
    }

    // 添加工具系统中的工具 (Function Declaration 格式)
    try {
        const { getToolsForAPI } = await import('../tools/manager.js');
        const systemTools = getToolsForAPI('gemini');
        if (systemTools.length > 0) {
            // Gemini 要求工具包装在 functionDeclarations 数组中
            tools.push({
                functionDeclarations: systemTools
            });
        }
    } catch (error) {
        console.warn('[Gemini] 工具系统未加载:', error);
    }

    if (tools.length > 0) {
        if (state.xmlToolCallingEnabled) {
            // XML 模式：只注入 XML 到 systemInstruction，不使用原生 tools 字段
            const { injectToolsToGemini, getXMLInjectionStats } = await import('../tools/tool-injection.js');
            injectToolsToGemini(requestBody, tools);

            // 性能监控
            const stats = getXMLInjectionStats(tools);
            console.log('[Gemini] 📊 XML 模式启用，注入统计:', stats);
        } else {
            // 原生模式：使用标准 tools 字段
            requestBody.tools = tools;
            console.log('[Gemini] 📊 原生 tools 模式，工具数量:', tools.length);
        }
    }

    console.log('Sending Gemini request:', JSON.stringify(requestBody, null, 2));

    // 构建请求头
    const headers = {
        'Content-Type': 'application/json',
        ...getCustomHeadersObject(), // 合并自定义请求头
    };

    // 根据配置决定 API key 传递方式
    let queryParams = '';
    if (state.geminiApiKeyInHeader) {
        // 方式1: 通过请求头传递（适用于代理服务器）
        headers['x-goog-api-key'] = apiKey;
        // 流式模式仅添加 alt=sse
        if (state.streamEnabled) {
            queryParams = 'alt=sse';
        }
    } else {
        // 方式2: 通过 URL 参数传递（标准 Gemini API）
        queryParams = state.streamEnabled
            ? `key=${apiKey}&alt=sse`
            : `key=${apiKey}`;
    }

    const options = {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(requestBody),
    };
    if (signal) options.signal = signal;

    const fullUrl = queryParams ? `${endpoint}?${queryParams}` : endpoint;
    return await fetch(fullUrl, options);
}

/**
 * 构建 Gemini 工具结果消息（Gemini 原生格式）
 * @param {Array} toolCalls - 工具调用列表 [{id, name, arguments}]
 * @param {Array} toolResults - 格式无关的结果 [{id, name, result, isError}]
 * @returns {Array} Gemini 格式的 contents 数组
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

    // Gemini 原生格式
    // 1. model 的 functionCall parts
    const callParts = toolCalls.map(tc => {
        const callPart = {
            functionCall: {
                name: tc.name,
                args: tc.arguments || {}
            }
        };
        if (tc.thoughtSignature) callPart.thoughtSignature = tc.thoughtSignature;
        return callPart;
    });

    // 2. user 的 functionResponse parts
    const responseParts = toolResults.map(r => {
        let responseObj;
        try {
            responseObj = typeof r.result === 'string' ? JSON.parse(r.result) : r.result;
        } catch {
            responseObj = r.result;
        }
        return {
            functionResponse: {
                name: r.name,
                response: { result: responseObj }
            }
        };
    });

    return [
        { role: 'model', parts: callParts },
        { role: 'user', parts: responseParts }
    ];
}
