/**
 * OpenAI 流解析器
 * 解析 OpenAI SSE 流式响应（Chat Completions + Responses API）
 */

import { logger } from '../utils/logger.js';
import { BaseStreamParser } from './base-parser.js';

import { updateStreamingMessage, handleContentArray } from './helpers.js';
import { state } from '../core/state.js';
import { eventBus } from '../core/events.js';
import { createToolCallAccumulator } from './tool-call-handler.js';

/**
 * OpenAI 流解析器
 */
class OpenAIStreamParser extends BaseStreamParser {
    constructor(format, sessionId) {
        super(sessionId);
        this.isResponsesFormat = format === 'openai-responses';
        this.reader = null;

        // 原生工具调用累积器（Chat Completions）
        this.toolCallAccumulator = createToolCallAccumulator();
        this.hasToolCalls = false;

        // Responses API 工具调用
        this.responsesToolCalls = new Map();
        this.hasResponsesToolCalls = false;

        // Responses API 思维链签名
        this.encryptedContent = null;
        this.reasoningItemId = null;
    }

    async parse(reader) {
        this.reader = reader;
        return super.parse(reader);
    }

    async processLine(line) {
        if (!line.startsWith('data: ')) return false;

        const data = line.slice(6).trim();
        if (data === '[DONE]') {
            return this._handleDone();
        }

        try {
            const parsed = JSON.parse(data);

            // 流中错误检测
            if (parsed.error) {
                await this._handleStreamError(parsed.error);
                return true;
            }

            // Responses API 格式
            if (this.isResponsesFormat && parsed.type) {
                return this._processResponsesEvent(parsed);
            }

            // Responses API 兜底：output_text 无 type
            if (
                this.isResponsesFormat &&
                parsed.output_text &&
                (!parsed.output || !Array.isArray(parsed.output)) &&
                !this.textContent
            ) {
                this._consumeOutputText(parsed.output_text);
                return false;
            }

            // Responses API 兜底：output[] 数组
            if (this.isResponsesFormat && parsed.output && Array.isArray(parsed.output)) {
                return await this._processResponsesOutput(parsed);
            }

            // Chat Completions API
            return await this._processChatCompletions(parsed);
        } catch (_e) {
            logger.warn('OpenAI SSE parse error:', _e);
        }
        return false;
    }

    async onStreamEnd() {
        this.flushThinkTagParser();
        this._finalize();
    }

    // ───── Responses API 事件 ─────

    _processResponsesEvent(parsed) {
        switch (parsed.type) {
            case 'response.output_text.delta':
                if (parsed.delta) {
                    this.stats.recordFirstToken();
                    this.stats.recordTokens(parsed.delta);
                    this.textContent += parsed.delta;
                    this.totalReceived += parsed.delta.length;
                    this.mergeContentPart('text', parsed.delta);
                    updateStreamingMessage(this.textContent, this.thinkingContent);
                }
                break;

            case 'response.reasoning.delta':
            case 'response.reasoning_summary.delta':
                if (parsed.delta) {
                    this.stats.recordFirstToken();
                    this.stats.recordTokens(parsed.delta);
                    this.thinkingContent += parsed.delta;
                    this.totalReceived += parsed.delta.length;
                    this.mergeContentPart('thinking', parsed.delta);
                    updateStreamingMessage(this.textContent, this.thinkingContent);
                }
                break;

            case 'response.output_item.added':
                if (parsed.item?.type === 'function_call') {
                    const idx = parsed.output_index ?? this.responsesToolCalls.size;
                    this.responsesToolCalls.set(idx, {
                        id: parsed.item.call_id || parsed.item.id || `resp_tc_${Date.now()}_${idx}`,
                        name: parsed.item.name || '',
                        arguments: ''
                    });
                    this.hasResponsesToolCalls = true;
                }
                break;

            case 'response.function_call_arguments.delta':
                if (parsed.delta) {
                    const tc = this.responsesToolCalls.get(parsed.output_index ?? 0);
                    if (tc) tc.arguments += parsed.delta;
                }
                break;

            case 'response.function_call_arguments.done':
                if (parsed.arguments) {
                    const tc = this.responsesToolCalls.get(parsed.output_index ?? 0);
                    if (tc) tc.arguments = parsed.arguments;
                }
                break;

            case 'response.completed':
            case 'response.done': {
                if (parsed.response?.output_text && !this.textContent) {
                    this.textContent = parsed.response.output_text;
                    this.totalReceived += this.textContent.length;
                    this.stats.recordFirstToken();
                    this.stats.recordTokens(this.textContent);
                    this.contentParts.push({ type: 'text', text: this.textContent });
                    updateStreamingMessage(this.textContent, this.thinkingContent);
                }
                if (parsed.response?.output) {
                    for (const item of parsed.response.output) {
                        if (item.type === 'reasoning' && item.encrypted_content) {
                            this.encryptedContent = item.encrypted_content;
                            this.reasoningItemId = item.id || null;
                        }
                        if (item.type === 'function_call' && !this.responsesToolCalls.size) {
                            const idx = this.responsesToolCalls.size;
                            this.responsesToolCalls.set(idx, {
                                id: item.call_id || item.id || `resp_tc_${Date.now()}_${idx}`,
                                name: item.name || '',
                                arguments: item.arguments || ''
                            });
                            this.hasResponsesToolCalls = true;
                        }
                    }
                }
                if (this._tryExecuteResponsesToolCalls()) return true;
                break;
            }

            default:
                console.debug('[Parser] Responses API 事件:', parsed.type);
                break;
        }
        return false;
    }

    // ───── Responses API output[] 兜底 ─────

    async _processResponsesOutput(parsed) {
        for (const item of parsed.output) {
            if (item.type === 'reasoning' && item.content) {
                this.stats.recordFirstToken();
                this.stats.recordTokens(item.content);
                this.thinkingContent += item.content;
                this.totalReceived += item.content.length;
                this.mergeContentPart('thinking', item.content);
                updateStreamingMessage(this.textContent, this.thinkingContent);
            } else if (item.type === 'message') {
                const messageText = item.text || item.content?.[0]?.text || '';
                if (messageText) {
                    this.stats.recordFirstToken();
                    this.stats.recordTokens(messageText);
                    this.textContent += messageText;
                    this.totalReceived += messageText.length;
                    this.mergeContentPart('text', messageText);
                    updateStreamingMessage(this.textContent, this.thinkingContent);
                } else if (Array.isArray(item.content)) {
                    this.stats.recordFirstToken();
                    const textFromParts = item.content
                        .filter((p) => typeof p?.text === 'string' && p.text)
                        .map((p) => p.text)
                        .join('');
                    if (textFromParts) {
                        this.stats.recordTokens(textFromParts);
                        this.textContent += textFromParts;
                        updateStreamingMessage(this.textContent, this.thinkingContent);
                    }
                    const addedLength = await handleContentArray(item.content, this.contentParts);
                    this.totalReceived += addedLength;
                }
            } else if (item.type === 'function_call') {
                const idx = this.responsesToolCalls.size;
                this.responsesToolCalls.set(idx, {
                    id: item.call_id || item.id || `resp_tc_${Date.now()}_${idx}`,
                    name: item.name || '',
                    arguments: item.arguments || ''
                });
                this.hasResponsesToolCalls = true;
            }
        }

        if (parsed.output_text && !this.textContent) {
            this._consumeOutputText(parsed.output_text);
        }

        if (this._tryExecuteResponsesToolCalls()) return true;
        return false;
    }

    // ───── Chat Completions API ─────

    async _processChatCompletions(parsed) {
        // Chat Completions usage（最后一个 chunk 带 usage）
        const delta = parsed.choices?.[0]?.delta;
        const finishReason = parsed.choices?.[0]?.finish_reason;

        // 原生 tool_calls
        if (delta?.tool_calls && !state.xmlToolCallingEnabled) {
            this.hasToolCalls = true;
            this.toolCallAccumulator.processDelta(delta.tool_calls);
        }

        // XML 工具调用检测
        let xmlParseResult = null;
        if (delta && typeof delta.content === 'string' && state.xmlToolCallingEnabled) {
            try {
                xmlParseResult = this.xmlToolCallAccumulator.processDelta(delta.content);
                if (xmlParseResult.error) {
                    logger.error('[Parser] XML 解析错误:', xmlParseResult.error);
                } else if (xmlParseResult.hasToolCalls) {
                    this.hasToolCalls = true;
                }
            } catch (xmlError) {
                logger.error('[Parser] XML 累积器异常:', xmlError);
                xmlParseResult = null;
                this.xmlParsingDisabled = true;
            }
        }

        // 工具调用完成
        if (finishReason === 'tool_calls' || (finishReason === 'stop' && this.hasToolCalls)) {
            let toolCalls;
            if (state.xmlToolCallingEnabled && !this.xmlParsingDisabled) {
                toolCalls = this.xmlToolCallAccumulator.getCompletedCalls();
            } else {
                toolCalls = this.toolCallAccumulator.getCompletedCalls();
            }
            if (toolCalls.length > 0) {
                this.executeToolCalls(toolCalls);
                return true;
            }
        }

        if (delta) {
            // reasoning_content（OpenAI o1/o3/o4 思维链）
            if (delta.reasoning_content) {
                this.stats.recordFirstToken();
                this.stats.recordTokens(delta.reasoning_content);
                this.thinkingContent += delta.reasoning_content;
                this.totalReceived += delta.reasoning_content.length;
                this.mergeContentPart('thinking', delta.reasoning_content);
                updateStreamingMessage(this.textContent, this.thinkingContent);
            }

            // 文本内容
            if (typeof delta.content === 'string') {
                this.stats.recordFirstToken();
                this.stats.recordTokens(delta.content);

                let contentToProcess = delta.content;
                if (state.xmlToolCallingEnabled && !this.xmlParsingDisabled && xmlParseResult) {
                    contentToProcess = xmlParseResult.displayText.substring(
                        this.textContent.length
                    );
                }

                this.processThinkAndMarkdown(contentToProcess);
                updateStreamingMessage(this.textContent, this.thinkingContent);
            }
            // content 数组（图片等）
            else if (Array.isArray(delta.content)) {
                this.stats.recordFirstToken();
                const addedLength = await handleContentArray(delta.content, this.contentParts);
                this.totalReceived += addedLength;
            }
        }

        // 长度限制检查
        if (this.isOverLimit()) {
            await this.handleTruncation(this.reader, () => this._finalize());
            return true;
        }

        return false;
    }

    // ───── 辅助方法 ─────

    _consumeOutputText(text) {
        this.textContent = text;
        this.totalReceived += text.length;
        this.stats.recordFirstToken();
        this.stats.recordTokens(text);
        const hasTextPart = this.contentParts.some((p) => p.type === 'text' && p.text);
        if (!hasTextPart && text) {
            this.contentParts.push({ type: 'text', text });
        }
        updateStreamingMessage(this.textContent, this.thinkingContent);
    }

    _tryExecuteResponsesToolCalls() {
        if (!this.hasResponsesToolCalls || this.responsesToolCalls.size === 0) return false;

        const completedCalls = [];
        for (const [_idx, tc] of this.responsesToolCalls) {
            let args;
            try {
                args = tc.arguments != null && tc.arguments !== '' ? JSON.parse(tc.arguments) : {};
            } catch (_e) {
                args = {};
            }
            completedCalls.push({ id: tc.id, name: tc.name, arguments: args });
        }

        if (completedCalls.length > 0) {
            this.executeToolCalls(completedCalls, {
                encryptedContent: this.encryptedContent,
                reasoningItemId: this.reasoningItemId
            });
            return true;
        }
        return false;
    }

    _handleDone() {
        if (this.isResponsesFormat && this._tryExecuteResponsesToolCalls()) return true;
        this._finalize();
        return true;
    }

    async _handleStreamError(error) {
        const errorCode = error.code || error.type;
        const errorMessage = error.message || 'Unknown error';
        logger.error(`OpenAI API 错误 (流式响应):`, error);

        let userMessage = '';
        if (errorCode === 429 || errorCode === 'rate_limit_exceeded') {
            userMessage = `请求过多 (429)：${errorMessage}\n请稍后再试`;
        } else if (errorCode === 503) {
            userMessage = `服务暂时不可用 (503)：${errorMessage}`;
        } else if (errorCode === 500 || errorCode === 'server_error') {
            userMessage = `服务器内部错误：${errorMessage}`;
        } else {
            userMessage = `API 错误: ${errorMessage}`;
        }

        eventBus.emit('ui:notification', { message: userMessage, type: 'error', duration: 8000 });
        await this.reader.cancel();

        if (this.textContent || this.thinkingContent || this.contentParts.length > 0) {
            this.finalizeStreamWithError(errorCode, errorMessage, {
                encryptedContent: this.encryptedContent,
                reasoningItemId: this.reasoningItemId
            });
        }
    }

    _finalize() {
        this.finalizeStream({
            encryptedContent: this.encryptedContent,
            reasoningItemId: this.reasoningItemId
        });
    }
}

/**
 * 解析 OpenAI 流式响应（保持原有导出签名）
 */
export async function parseOpenAIStream(reader, format = 'openai', sessionId = null) {
    const parser = new OpenAIStreamParser(format, sessionId);
    await parser.parse(reader);
}
