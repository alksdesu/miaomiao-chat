/**
 * Claude 流解析器
 * 解析 Claude SSE 流式响应
 */

import { recordFirstToken, recordTokens, recalculateStreamTokenCount, finalizeStreamStats, getCurrentStreamStatsData, getPartialStreamStatsData, appendStreamStats } from './stats.js';
import { updateStreamingMessage, renderFinalTextWithThinking, renderFinalContentWithThinking, cleanupAllIncompleteImages } from './helpers.js';
import { saveAssistantMessage } from '../messages/sync.js';
import { setCurrentMessageIndex } from '../messages/dom-sync.js';  // Bug 2 导入索引设置函数
import { eventBus } from '../core/events.js';
import { renderHumanizedError } from '../utils/errors.js';
import { parseStreamingMarkdownImages } from '../utils/markdown-image-parser.js';
import { handleToolCallStream } from './tool-call-handler.js';
import { XMLStreamAccumulator } from '../tools/xml-formatter.js';  // XML 工具调用解析
import { state } from '../core/state.js';  // 访问 xmlToolCallingEnabled 配置
import { getCurrentEndpoint, getCurrentApiKey, getCurrentModel } from '../api/handler.js';
import { ThinkTagParser } from './think-tag-parser.js';  // <think> 标签解析器
import { requestStateMachine, RequestState } from '../core/request-state-machine.js';

// 响应长度限制（防止内存溢出）
const MAX_RESPONSE_LENGTH = 200000; // 20万字符

/**
 * 解析 Claude 流式响应
 * @param {ReadableStreamDefaultReader} reader - 流读取器
 * @param {string} sessionId - 会话ID
 */
export async function parseClaudeStream(reader, sessionId = null) {
    const decoder = new TextDecoder();
    let buffer = '';
    let textContent = '';
    const thinkingBlocks = [];  // 存储多个独立的思考块
    let currentThinkingBlock = '';  // 当前正在接收的思考块
    const thinkingSignatures = [];  // 存储每个思考块的 signature
    let currentSignature = '';  // 当前思考块的 signature
    let currentBlockType = null;
    let blockIndex = 0;
    let totalReceived = 0; // 追踪总接收字符数
    let markdownBuffer = ''; // Markdown 图片缓冲区
    const contentParts = []; // 内容部分（用于支持图片）

    // ⭐ 工具调用相关状态
    const toolCalls = new Map();  // Map<index, {id, name, input: string}>
    const serverToolCalls = new Map();  // Map<index, {id, name, input: string}> — 服务端工具
    const serverToolResults = [];  // 服务端工具结果（原子交付）
    const xmlToolCallAccumulator = new XMLStreamAccumulator();  // XML 工具调用累积器
    let xmlParsingDisabled = false;  // XML 解析崩溃时禁用，回退到纯文本
    let stopReason = null;  // 停止原因
    const thinkTagParser = new ThinkTagParser();  // <think> 标签解析器

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    try {
                        const event = JSON.parse(line.slice(6));

                        // 检测流式响应中的错误（如 429 Too Many Requests）
                        if (event.type === 'error') {
                            const errorCode = event.error?.type || 'unknown';
                            const errorMessage = event.error?.message || 'Unknown error';

                            console.error(`❌ Claude API 错误 (流式响应):`, event.error);

                            // 显示错误通知
                            let userMessage = '';
                            if (errorCode === 'rate_limit_error' || errorCode === 429) {
                                userMessage = `请求过多 (429)：${errorMessage}\n请稍后再试`;
                            } else if (errorCode === 'overloaded_error' || errorCode === 529) {
                                userMessage = `服务过载 (529)：${errorMessage}\n请稍后重试`;
                            } else if (errorCode === 'api_error') {
                                userMessage = `API 错误：${errorMessage}`;
                            } else {
                                userMessage = `错误 (${errorCode}): ${errorMessage}`;
                            }

                            eventBus.emit('ui:notification', {
                                message: userMessage,
                                type: 'error',
                                duration: 8000
                            });

                            // 取消流并清理
                            await reader.cancel();

                            // 如果已有部分内容，保存为错误消息
                            const partialThinking = [...thinkingBlocks, currentThinkingBlock].filter(Boolean).join('\n\n---\n\n');
                            if (textContent || partialThinking || contentParts.length > 0) {
                                finalizeClaudeStreamWithError(textContent, partialThinking, contentParts, errorCode, errorMessage, sessionId);
                            }

                            return; // 退出流处理
                        }

                        switch (event.type) {
                            case 'content_block_start':
                                currentBlockType = event.content_block?.type;
                                blockIndex = event.index;

                                // 检测原生工具调用 (Claude 格式，仅在非 XML 模式)
                                if (currentBlockType === 'tool_use' && !state.xmlToolCallingEnabled) {
                                    const block = event.content_block;
                                    toolCalls.set(blockIndex, {
                                        id: block.id,
                                        name: block.name,
                                        input: ''  // 将通过 delta 事件拼接
                                    });
                                    console.log('[Claude] 检测到原生工具调用:', block.name);
                                } else if (currentBlockType === 'server_tool_use') {
                                    // 服务端工具调用（web_search, code_execution 等）
                                    const block = event.content_block;
                                    serverToolCalls.set(blockIndex, {
                                        id: block.id,
                                        name: block.name,
                                        input: ''
                                    });
                                    console.log('[Claude] 检测到服务端工具调用:', block.name);
                                } else if (currentBlockType?.endsWith('_tool_result')) {
                                    // 服务端工具结果（原子交付，完整内容在 content_block_start 中）
                                    const block = event.content_block;
                                    serverToolResults.push({
                                        type: currentBlockType,
                                        tool_use_id: block.tool_use_id,
                                        content: block.content,
                                    });
                                    console.log('[Claude] 接收到服务端工具结果:', currentBlockType);
                                } else if (currentBlockType === 'thinking') {
                                    // 如果是新的思考块，初始化
                                    currentThinkingBlock = '';
                                }
                                break;

                            case 'content_block_delta':
                                // ⭐ 累积工具调用参数 (Claude 格式)
                                if (event.delta?.type === 'input_json_delta') {
                                    const toolCall = toolCalls.get(event.index);
                                    if (toolCall) {
                                        toolCall.input += event.delta.partial_json;
                                    }
                                    // 服务端工具也用 input_json_delta
                                    const serverCall = serverToolCalls.get(event.index);
                                    if (serverCall) {
                                        serverCall.input += event.delta.partial_json;
                                    }
                                } else if (event.delta?.type === 'thinking_delta') {
                                    recordFirstToken();
                                    recordTokens(event.delta.thinking);
                                    currentThinkingBlock += event.delta.thinking;
                                    totalReceived += event.delta.thinking.length;
                                    // 实时更新显示（合并所有已完成的思考块 + 当前思考块）
                                    const allThinking = [...thinkingBlocks, currentThinkingBlock].join('\n\n---\n\n');
                                    updateStreamingMessage(textContent, allThinking);
                                } else if (event.delta?.type === 'signature_delta') {
                                    // 累积思考块的签名
                                    currentSignature += event.delta.signature;
                                    console.log('[Claude] 接收 signature_delta，当前长度:', currentSignature.length);
                                } else if (event.delta?.type === 'text_delta') {
                                    recordFirstToken();
                                    recordTokens(event.delta.text);

                                    // 优先处理 XML 检测（仅在 XML 模式）
                                    let deltaText = event.delta.text;
                                    if (state.xmlToolCallingEnabled) {
                                        try {
                                            const result = xmlToolCallAccumulator.processDelta(event.delta.text);
                                            const { hasToolCalls: hasXML, displayText, error } = result;

                                            if (error) {
                                                console.error('[Claude Parser] ⚠️ XML 解析错误:', error);
                                                // 回退：将当前内容当作普通文本处理
                                            } else if (hasXML) {
                                                // 更新展示文本（去除 XML 标签）
                                                deltaText = displayText.substring(textContent.length);
                                                console.log('[Claude Parser] 🔧 检测到 XML 工具调用');
                                            }
                                        } catch (xmlError) {
                                            // 顶层错误保护 - XML 解析崩溃时不影响正常流式输出
                                            console.error('[Claude Parser] ❌ XML 累积器异常:', xmlError);
                                            // 禁用 XML 模式，回退到纯文本
                                            xmlParsingDisabled = true;
                                        }
                                    }

                                    // 解析 <think> 标签
                                    const { displayText: thinkParsedText, thinkingDelta } = thinkTagParser.processDelta(deltaText);
                                    if (thinkingDelta) {
                                        // 将 <think> 内容添加到当前思考块
                                        currentThinkingBlock += thinkingDelta;
                                        totalReceived += thinkingDelta.length;
                                    }

                                    // 解析 markdown 图片格式（使用 <think> 解析后的文本）
                                    const { parts, newBuffer } = parseStreamingMarkdownImages(thinkParsedText, markdownBuffer);
                                    markdownBuffer = newBuffer;

                                    for (const part of parts) {
                                        if (part.type === 'text') {
                                            textContent += part.text;
                                            totalReceived += part.text.length;

                                            // 合并连续的文本部分
                                            const lastPart = contentParts[contentParts.length - 1];
                                            if (lastPart && lastPart.type === 'text') {
                                                lastPart.text += part.text;
                                            } else {
                                                contentParts.push({ type: 'text', text: part.text });
                                            }
                                        } else if (part.type === 'image_url') {
                                            contentParts.push(part);
                                            totalReceived += part.url.length;
                                        }
                                    }

                                    // 合并原生思考块和 <think> 标签提取的内容
                                    const allThinking = [...thinkingBlocks, currentThinkingBlock].filter(Boolean).join('\n\n---\n\n');
                                    updateStreamingMessage(textContent, allThinking);
                                }

                                // 检查是否超过长度限制
                                if (totalReceived > MAX_RESPONSE_LENGTH) {
                                    console.warn(`响应超长（${totalReceived} 字符），已强制截断`);
                                    eventBus.emit('ui:notification', {
                                        message: `响应过长（${totalReceived.toLocaleString()} 字符），已自动截断`,
                                        type: 'warning'
                                    });
                                    await reader.cancel();
                                    // 截断前刷新 <think> 解析器缓冲区
                                    const { displayText: truncDisplayText, thinkingDelta: truncThinkingDelta } = thinkTagParser.flush();
                                    if (truncThinkingDelta) {
                                        currentThinkingBlock += truncThinkingDelta;
                                    }
                                    if (truncDisplayText) {
                                        textContent += truncDisplayText;
                                        const lastPart = contentParts[contentParts.length - 1];
                                        if (lastPart && lastPart.type === 'text') {
                                            lastPart.text += truncDisplayText;
                                        } else {
                                            contentParts.push({ type: 'text', text: truncDisplayText });
                                        }
                                    }
                                    if (currentThinkingBlock) {
                                        thinkingBlocks.push(currentThinkingBlock);
                                    }
                                    const finalThinking = thinkingBlocks.join('\n\n---\n\n');
                                    const finalSignature = thinkingSignatures.join('\n\n---\n\n');
                                    finalizeClaudeStream(textContent, finalThinking, finalSignature, contentParts, sessionId);
                                    return;
                                }
                                break;

                            case 'content_block_stop':
                                // 如果当前块是思考块，将其保存到数组
                                if (currentBlockType === 'thinking' && currentThinkingBlock) {
                                    thinkingBlocks.push(currentThinkingBlock);
                                    // 保存对应的签名
                                    thinkingSignatures.push(currentSignature);
                                    console.log('[Claude] 思考块完成，签名长度:', currentSignature.length);
                                    currentThinkingBlock = '';
                                    currentSignature = '';
                                }
                                currentBlockType = null;
                                break;

                            case 'message_delta':
                                // ⭐ 捕获停止原因
                                if (event.delta?.stop_reason) {
                                    stopReason = event.delta.stop_reason;
                                }
                                break;

                            case 'message_stop': {
                                // ⭐ 检查是否有工具调用
                                let completedCalls = [];

                                if (state.xmlToolCallingEnabled && !xmlParsingDisabled) {
                                    // XML 模式：使用 XML 工具调用
                                    const xmlCalls = xmlToolCallAccumulator.getCompletedCalls();
                                    if (xmlCalls.length > 0) {
                                        completedCalls = xmlCalls;
                                        console.log(`[Claude] 流结束，检测到 ${xmlCalls.length} 个 XML 工具调用`);
                                    }
                                } else {
                                    // 原生模式：使用原生工具调用
                                    if (stopReason === 'tool_use' && toolCalls.size > 0) {
                                        console.log(`[Claude] 流结束，检测到 ${toolCalls.size} 个原生工具调用`);

                                        // 解析所有原生工具调用
                                        for (const [_index, call] of toolCalls) {
                                            let args;
                                            try {
                                                args = (call.input != null && call.input !== '')
                                                    ? JSON.parse(call.input)
                                                    : {};
                                            } catch (_e) {
                                                console.error('[Claude] 解析工具参数失败:', call.name, _e);
                                                args = {};
                                            }
                                            completedCalls.push({
                                                id: call.id,
                                                name: call.name,
                                                arguments: args
                                            });
                                        }
                                    }
                                }

                                // 执行工具调用（如果有）
                                if (completedCalls.length > 0) {
                                    console.log('[Claude] 检测到工具调用:', {
                                        toolCallsCount: completedCalls.length,
                                        toolNames: completedCalls.map(tc => tc.name).join(', ')
                                    });

                                    // 注意：工具调用时不结束统计，让统计在 continuation 完成后才最终确定
                                    // finalizeStreamStats() 会在 continuation 完成时调用

                                    // 合并思维链（用于渲染）
                                    const finalThinking = thinkingBlocks.join('\n\n---\n\n');

                                    // 关键先渲染思维链到 DOM，然后再保存消息
                                    if (contentParts.length > 0) {
                                        renderFinalContentWithThinking(contentParts, finalThinking);
                                    } else if (textContent || finalThinking) {
                                        renderFinalTextWithThinking(textContent, finalThinking);
                                    }

                                    // 工具调用时不添加统计 HTML，等 continuation 完成后再添加
                                    // appendStreamStats() 会在 continuation 完成时调用

                                    // 保存助手消息（包含工具调用）- 保存部分统计（TTFT 和当前 token 数）
                                    const messageIndex = saveAssistantMessage({
                                        textContent: textContent || '(调用工具)',
                                        thinkingContent: finalThinking,
                                        thinkingBlocks,
                                        thinkingSignatures,
                                        contentParts,
                                        toolCalls: completedCalls,
                                        streamStats: getPartialStreamStatsData(),  // 保存部分统计，供 continuation 聚合
                                        sessionId
                                    });

                                    // 设置消息索引
                                    setCurrentMessageIndex(messageIndex);

                                    // 转换到工具调用状态
                                    requestStateMachine.transition(RequestState.TOOL_CALLING);
                                    state.isToolCallPending = true; // 向后兼容

                                    // 执行工具调用（异步）
                                    handleToolCallStream(completedCalls, {
                                        endpoint: getCurrentEndpoint(),
                                        apiKey: getCurrentApiKey(),
                                        model: getCurrentModel()
                                    }).catch(error => {
                                        console.error('[Parser] 工具调用流程失败:', error);
                                    });

                                    return; // 退出流处理
                                }

                                // 将服务端工具调用和结果注入 contentParts（用于保存和回传）
                                for (const [_idx, call] of serverToolCalls) {
                                    let args;
                                    try {
                                        args = (call.input != null && call.input !== '') ? JSON.parse(call.input) : {};
                                    } catch { args = {}; }

                                    // 找到对应的 result
                                    const result = serverToolResults.find(r => r.tool_use_id === call.id);
                                    contentParts.push({
                                        type: 'server_tool_use',
                                        id: call.id,
                                        name: call.name,
                                        input: args,
                                        result: result ? { type: result.type, content: result.content } : null,
                                    });
                                }

                                // pause_turn：服务端工具执行完毕，模型需要继续
                                if (stopReason === 'pause_turn') {
                                    console.log('[Claude] pause_turn 检测到，准备 continuation');
                                    const finalThinking = thinkingBlocks.join('\n\n---\n\n');

                                    if (contentParts.length > 0) {
                                        renderFinalContentWithThinking(contentParts, finalThinking);
                                    } else if (textContent || finalThinking) {
                                        renderFinalTextWithThinking(textContent, finalThinking);
                                    }

                                    // 保存消息（包含 server tool blocks）
                                    const messageIndex = saveAssistantMessage({
                                        textContent,
                                        thinkingContent: finalThinking,
                                        thinkingBlocks,
                                        thinkingSignatures,
                                        contentParts,
                                        streamStats: getPartialStreamStatsData(),
                                        sessionId
                                    });
                                    setCurrentMessageIndex(messageIndex);

                                    // 保存消息元素引用用于 continuation
                                    const assistantMessageEl = state.currentAssistantMessage?.closest('.message');

                                    // 转换到工具调用状态（复用 continuation 机制）
                                    requestStateMachine.transition(RequestState.TOOL_CALLING);
                                    state.isToolCallPending = true;

                                    // 发起 continuation（不带新 user 消息，只带完整历史）
                                    import('../api/handler.js').then(({ resendWithToolResults }) => {
                                        resendWithToolResults([], {
                                            endpoint: getCurrentEndpoint(),
                                            apiKey: getCurrentApiKey(),
                                            model: getCurrentModel()
                                        }, assistantMessageEl);
                                    }).catch(error => {
                                        console.error('[Claude] pause_turn continuation 失败:', error);
                                    });

                                    return;
                                }

                                // 合并所有思考块（用于渲染）
                                const finalThinking = thinkingBlocks.join('\n\n---\n\n');
                                finalizeClaudeStream(textContent, finalThinking, thinkingBlocks, thinkingSignatures, contentParts, sessionId);
                                return;
                            }
                        }
                    } catch (_e) {
                        console.warn('Claude SSE parse error:', _e);
                    }
                }
            }
        }

        // 流结束前刷新 <think> 解析器缓冲区
        const { displayText: finalDisplayText, thinkingDelta: finalThinkingDelta } = thinkTagParser.flush();
        if (finalThinkingDelta) {
            currentThinkingBlock += finalThinkingDelta;
        }
        if (finalDisplayText) {
            textContent += finalDisplayText;
            const lastPart = contentParts[contentParts.length - 1];
            if (lastPart && lastPart.type === 'text') {
                lastPart.text += finalDisplayText;
            } else {
                contentParts.push({ type: 'text', text: finalDisplayText });
            }
        }

        // 如果有未保存的 <think> 内容，添加到 thinkingBlocks
        if (currentThinkingBlock) {
            thinkingBlocks.push(currentThinkingBlock);
        }

        // 流结束
        const finalThinking = thinkingBlocks.join('\n\n---\n\n');
        finalizeClaudeStream(textContent, finalThinking, thinkingBlocks, thinkingSignatures, contentParts, sessionId);
    } finally {
        // 关键释放 reader 锁，防止资源泄漏
        try {
            reader.releaseLock();
        } catch (_e) {
            // Reader 可能已被释放或取消，忽略错误
            console.debug('Reader lock already released:', _e);
        }
    }
}

/**
 * 完成 Claude 流处理
 * @param {string} textContent - 文本内容
 * @param {string} thinkingContent - 思维链内容（合并后，用于渲染）
 * @param {Array} thinkingBlocksArr - 思维链块数组（独立保存）
 * @param {Array} thinkingSigsArr - 对应签名数组
 * @param {Array} contentParts - 内容部分数组
 * @param {string} sessionId - 会话ID
 */
function finalizeClaudeStream(textContent, thinkingContent, thinkingBlocksArr, thinkingSigsArr, contentParts, sessionId) {
    // 流结束，清除工具调用pending标志（如果没有新的工具调用）
    // 这样handler的finally块才能正确清理loading状态
    if (state.isToolCallPending) {
        console.log('[Claude] 流结束，重置 isToolCallPending 标志');
        state.isToolCallPending = false;
    }

    // 完成统计
    finalizeStreamStats();

    // 清理所有未完成的图片缓冲区
    cleanupAllIncompleteImages(contentParts);

    // 会话已切换时跳过 DOM 操作，只保存消息
    const isBackground = sessionId && sessionId !== state.currentSessionId;

    if (!isBackground) {
        // 渲染最终内容
        if (contentParts.length > 0) {
            renderFinalContentWithThinking(contentParts, thinkingContent);
        } else if (textContent || thinkingContent) {
            renderFinalTextWithThinking(textContent, thinkingContent);
        }

        // 兜底：按最终内容重算 token（避免工具调用后正文漏计数）
        recalculateStreamTokenCount({ textContent, thinkingContent, contentParts });

        // 添加统计信息
        appendStreamStats();
    }

    // 使用统一函数保存消息到所有三种格式并获取索引
    const messageIndex = saveAssistantMessage({
        textContent,
        thinkingContent,
        thinkingBlocks: thinkingBlocksArr,
        thinkingSignatures: thinkingSigsArr,
        contentParts,
        streamStats: getCurrentStreamStatsData(),
        sessionId: sessionId, // 🔒 传递会话ID防止串消息
    });

    // Bug 2 立即设置 dataset.messageIndex
    setCurrentMessageIndex(messageIndex);
}

/**
 * 以错误状态完成 Claude 流处理
 * 用于处理流式响应中的 API 错误（如 429）
 * @param {string} textContent - 已接收的文本内容
 * @param {string} thinkingContent - 已接收的思维链内容
 * @param {Array} contentParts - 内容部分数组
 * @param {string} errorCode - 错误码
 * @param {string} errorMessage - 错误消息
 * @param {string} sessionId - 会话ID
 */
function finalizeClaudeStreamWithError(textContent, thinkingContent, contentParts, errorCode, errorMessage, sessionId) {
    // 完成统计
    finalizeStreamStats();

    // 清理所有未完成的图片缓冲区
    cleanupAllIncompleteImages(contentParts);

    // 会话已切换时跳过 DOM 操作，只保存消息
    const isBackground = sessionId && sessionId !== state.currentSessionId;

    // 使用统一的错误渲染函数（包含折叠的技术详情）
    const errorObject = {
        type: errorCode,
        message: errorMessage
    };

    const errorHtml = renderHumanizedError(errorObject, null, true) +
        `<div style="margin-top: 8px; padding: 8px; background: rgba(255, 140, 0, 0.1); border-left: 3px solid var(--md-coral); font-size: 12px;">
            💾 已保存部分接收的内容
        </div>`;

    const finalText = textContent + '\n\n' + errorMessage;

    if (!isBackground) {
        // 渲染内容（包含部分内容和错误）
        if (contentParts.length > 0) {
            renderFinalContentWithThinking(contentParts, thinkingContent);
        } else if (textContent || thinkingContent) {
            renderFinalTextWithThinking(textContent, thinkingContent);
        }

        // 在消息末尾插入错误提示
        const currentMsg = document.querySelector('.message.assistant:last-child');
        if (currentMsg) {
            const contentDiv = currentMsg.querySelector('.message-content');
            if (contentDiv) {
                contentDiv.insertAdjacentHTML('beforeend', errorHtml);
            }
        }
    }

    if (!isBackground) {
        // 兜底：按最终内容重算 token（避免工具调用后正文漏计数）
        recalculateStreamTokenCount({ textContent: finalText, thinkingContent, contentParts });

        // 添加统计信息
        appendStreamStats();
    }

    // 保存消息（标记为错误）并获取索引
    const messageIndex = saveAssistantMessage({
        textContent: finalText,
        thinkingContent,
        contentParts,
        streamStats: getCurrentStreamStatsData(),
        isError: true,
        errorData: {
            code: errorCode,
            message: errorMessage
        },
        sessionId: sessionId,
        errorHtml
    });

    // Bug 2 立即设置 dataset.messageIndex
    setCurrentMessageIndex(messageIndex);

    // 触发 UI 状态重置（后台任务不触发，防止干扰当前会话）
    if (!isBackground) {
        eventBus.emit('stream:error', {
            errorCode,
            errorMessage,
            partialContent: textContent
        });

        // 强制清理工具调用标志（防止状态泄漏）
        if (state.isToolCallPending) {
            console.log('[Parser-Claude] 错误状态下强制清理 isToolCallPending');
            state.isToolCallPending = false;
        }
    }
}
