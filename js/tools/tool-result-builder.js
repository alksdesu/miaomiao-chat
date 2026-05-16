/**
 * 工具调用结果消息构建器
 * 统一 OpenAI/Claude/Gemini 三种格式的工具结果消息生成
 */

import { state } from '../core/state.js';
import { getCurrentProvider } from '../providers/manager.js';
import { getOrCreateMappedId } from '../api/format-converter.js';
import { escapeXML } from './xml-formatter.js';

/**
 * 构建 XML 模式的工具结果消息（三种格式共用）
 */
function buildXmlToolMessages(toolCalls, toolResults) {
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

function buildResponsesFunctionCallItemId(itemId, callId) {
    if (typeof itemId === 'string' && itemId.startsWith('fc')) return itemId;

    const base = String(callId || itemId || `generated_${Date.now()}`)
        .replace(/^call_?/, '')
        .replace(/[^A-Za-z0-9_-]/g, '_');
    return `fc_${base || Date.now()}`;
}

function buildResponsesCallId(rawId) {
    if (typeof rawId === 'string' && rawId.startsWith('call')) return rawId;
    return getOrCreateMappedId(rawId, 'openai');
}

function getToolCallResponseItemId(toolCall) {
    return toolCall.responseItemId || toolCall.itemId || toolCall.fcId || null;
}

/**
 * 构建 OpenAI 原生格式的工具结果消息
 */
function buildOpenAIMessages(toolCalls, toolResults) {
    const provider = getCurrentProvider();

    // Responses API 格式
    if (provider?.apiFormat === 'openai-responses') {
        const messages = [];
        for (const tc of toolCalls) {
            const callId = buildResponsesCallId(tc.call_id || tc.id);
            const functionCallItemId = buildResponsesFunctionCallItemId(
                getToolCallResponseItemId(tc),
                callId
            );
            messages.push({
                type: 'function_call',
                id: functionCallItemId,
                call_id: callId,
                name: tc.name,
                arguments:
                    typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments)
            });
        }
        for (const r of toolResults) {
            const callId = buildResponsesCallId(r.call_id || r.id);
            messages.push({
                type: 'function_call_output',
                call_id: callId,
                output: JSON.stringify(r.result)
            });
        }
        return messages;
    }

    // Chat Completions API 格式
    return [
        {
            role: 'assistant',
            content: '',
            tool_calls: toolCalls.map((tc) => ({
                id: getOrCreateMappedId(tc.id, 'openai'),
                type: 'function',
                function: {
                    name: tc.name,
                    arguments:
                        typeof tc.arguments === 'string'
                            ? tc.arguments
                            : JSON.stringify(tc.arguments)
                }
            }))
        },
        ...toolResults.map((r) => ({
            role: 'tool',
            tool_call_id: getOrCreateMappedId(r.id, 'openai'),
            content: typeof r.result === 'string' ? r.result : JSON.stringify(r.result)
        }))
    ];
}

/**
 * 构建 Claude 原生格式的工具结果消息
 */
function buildClaudeMessages(toolCalls, toolResults) {
    const assistantContent = toolCalls.map((tc) => {
        let input = tc.arguments;
        if (typeof input === 'string') {
            try {
                input = JSON.parse(input);
            } catch {
                input = {};
            }
        }
        return {
            type: 'tool_use',
            id: getOrCreateMappedId(tc.id, 'claude'),
            name: tc.name,
            input: input || {}
        };
    });

    const toolResultContent = toolResults.map((r) => ({
        type: 'tool_result',
        tool_use_id: getOrCreateMappedId(r.id, 'claude'),
        content: typeof r.result === 'string' ? r.result : JSON.stringify(r.result)
    }));

    return [
        { role: 'assistant', content: assistantContent },
        { role: 'user', content: toolResultContent }
    ];
}

/**
 * 构建 Gemini 原生格式的工具结果消息
 */
function buildGeminiMessages(toolCalls, toolResults) {
    // Gemini 3：parallel call 只第一个 functionCall 带 signature
    // 持久化字段是 _thoughtSignature（下划线前缀，避免误发往非 Gemini provider）
    let signatureAttached = false;
    const callParts = toolCalls.map((tc) => {
        const callPart = {
            functionCall: {
                name: tc.name,
                args: tc.arguments || {}
            }
        };
        const sig = tc._thoughtSignature || tc.thoughtSignature;
        if (sig && !signatureAttached) {
            callPart.thoughtSignature = sig;
            signatureAttached = true;
        }
        return callPart;
    });

    const responseParts = toolResults.map((r) => {
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

/**
 * 根据 API 格式构建工具结果消息
 * @param {string} format - API 格式 ('openai'|'openai-responses'|'claude'|'gemini')
 * @param {Array} toolCalls - 工具调用列表 [{id, name, arguments}]
 * @param {Array} toolResults - 格式无关的结果 [{id, name, result, isError}]
 * @returns {Array} 对应格式的消息数组
 */
export function buildToolResultMessages(format, toolCalls, toolResults) {
    // XML 模式下所有格式共用同一实现
    if (state.xmlToolCallingEnabled) {
        return buildXmlToolMessages(toolCalls, toolResults);
    }

    switch (format) {
        case 'claude':
            return buildClaudeMessages(toolCalls, toolResults);
        case 'gemini':
            return buildGeminiMessages(toolCalls, toolResults);
        case 'openai':
        case 'openai-responses':
        default:
            return buildOpenAIMessages(toolCalls, toolResults);
    }
}
