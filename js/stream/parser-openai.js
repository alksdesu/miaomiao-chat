/**
 * OpenAI 流解析器
 * 解析 OpenAI SSE 流式响应（Chat Completions + Responses API）
 */

import { logger } from '../utils/logger.js';
import { BaseStreamParser } from './base-parser.js';

import { handleContentArray } from './helpers.js';
import { eventBus } from '../core/events.js';
import { createToolCallAccumulator } from './openai-tool-accumulator.js';
import { ToolMode } from '../messages/schema.js';
import { generateIdSet } from '../api/format-converter.js';
import { STREAM_IDLE_TIMEOUT_RESPONSES_MIN } from '../utils/constants.js';

/**
 * OpenAI 流解析器
 */
export class OpenAIStreamParser extends BaseStreamParser {
    constructor(format, sessionId, sink = null) {
        super(sessionId, sink);
        this.isResponsesFormat = format === 'openai-responses';
        this.signatureFormat = 'openai';
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
        this.responsesReasoningItems = new Map();
    }

    /**
     * Responses API 走 reasoning 模型时，模型内部推理阶段可能持续数分钟
     * 不下发任何 SSE chunk，必须比 base 默认空闲超时更宽容；用户偏好优先
     */
    get idleTimeout() {
        if (this.isResponsesFormat) {
            // Responses 默认 5 分钟，给 reasoning 模型留余地；用户偏好若 > 5 分钟则采用更长
            const base = super.idleTimeout;
            return Math.max(base, STREAM_IDLE_TIMEOUT_RESPONSES_MIN);
        }
        return super.idleTimeout;
    }

    async parse(reader, signal = null) {
        this.reader = reader;
        return super.parse(reader, signal);
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
                    this.notifyStreaming(this.textContent, this.thinkingContent);
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
                    this.notifyStreaming(this.textContent, this.thinkingContent);
                }
                break;

            case 'response.output_item.added':
                if (parsed.item?.type === 'reasoning') {
                    this._upsertReasoningItem(parsed.item, parsed.output_index);
                } else if (parsed.item?.type === 'function_call') {
                    const idx = parsed.output_index ?? this.responsesToolCalls.size;
                    const callId = parsed.item.call_id || `call_${Date.now()}_${idx}`;
                    this.responsesToolCalls.set(idx, {
                        id: callId,
                        call_id: callId,
                        responseItemId: parsed.item.id || null,
                        name: parsed.item.name || '',
                        arguments: ''
                    });
                    this.hasResponsesToolCalls = true;
                }
                break;

            case 'response.output_item.done':
                if (parsed.item?.type === 'reasoning') {
                    this._upsertReasoningItem(parsed.item, parsed.output_index);
                } else if (parsed.item?.type === 'function_call') {
                    const idx = parsed.output_index ?? this.responsesToolCalls.size;
                    const callId = parsed.item.call_id || `call_${Date.now()}_${idx}`;
                    this.responsesToolCalls.set(idx, {
                        id: callId,
                        call_id: callId,
                        responseItemId: parsed.item.id || null,
                        name: parsed.item.name || '',
                        arguments: parsed.item.arguments || ''
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

            case 'response.reasoning_summary_part.added':
            case 'response.reasoning_summary_part.done':
                this._setReasoningSummaryPart(
                    parsed.item_id,
                    parsed.output_index,
                    parsed.summary_index,
                    parsed.part
                );
                break;

            case 'response.reasoning_summary_text.done':
                this._setReasoningSummaryText(
                    parsed.item_id,
                    parsed.output_index,
                    parsed.summary_index,
                    parsed.text
                );
                break;

            case 'response.completed':
            case 'response.done': {
                if (parsed.response?.output_text && !this.textContent) {
                    this.textContent = parsed.response.output_text;
                    this.totalReceived += this.textContent.length;
                    this.stats.recordFirstToken();
                    this.stats.recordTokens(this.textContent);
                    this.contentParts.push({ type: 'text', text: this.textContent });
                    this.notifyStreaming(this.textContent, this.thinkingContent);
                }
                if (parsed.response?.output) {
                    for (const item of parsed.response.output) {
                        if (item.type === 'reasoning') this._upsertReasoningItem(item);
                        if (item.type === 'function_call' && !this.responsesToolCalls.size) {
                            const idx = this.responsesToolCalls.size;
                            const callId = item.call_id || `call_${Date.now()}_${idx}`;
                            this.responsesToolCalls.set(idx, {
                                id: callId,
                                call_id: callId,
                                responseItemId: item.id || null,
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
            if (item.type === 'reasoning') {
                this._upsertReasoningItem(item);
                if (item.content) {
                    this.stats.recordFirstToken();
                    this.stats.recordTokens(item.content);
                    this.thinkingContent += item.content;
                    this.totalReceived += item.content.length;
                    this.mergeContentPart('thinking', item.content);
                    this.notifyStreaming(this.textContent, this.thinkingContent);
                }
            } else if (item.type === 'message') {
                const messageText = item.text || item.content?.[0]?.text || '';
                if (messageText) {
                    this.stats.recordFirstToken();
                    this.stats.recordTokens(messageText);
                    this.textContent += messageText;
                    this.totalReceived += messageText.length;
                    this.mergeContentPart('text', messageText);
                    this.notifyStreaming(this.textContent, this.thinkingContent);
                } else if (Array.isArray(item.content)) {
                    this.stats.recordFirstToken();
                    const textFromParts = item.content
                        .filter((p) => typeof p?.text === 'string' && p.text)
                        .map((p) => p.text)
                        .join('');
                    if (textFromParts) {
                        this.stats.recordTokens(textFromParts);
                        this.textContent += textFromParts;
                        this.notifyStreaming(this.textContent, this.thinkingContent);
                    }
                    const addedLength = await handleContentArray(item.content, this.contentParts);
                    this.totalReceived += addedLength;
                }
            } else if (item.type === 'function_call') {
                const idx = this.responsesToolCalls.size;
                const callId = item.call_id || `call_${Date.now()}_${idx}`;
                this.responsesToolCalls.set(idx, {
                    id: callId,
                    call_id: callId,
                    responseItemId: item.id || null,
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
        if (delta?.tool_calls && !this.xmlMode) {
            this.hasToolCalls = true;
            this.toolCallAccumulator.processDelta(delta.tool_calls);
        }

        // XML 工具调用检测
        let xmlParseResult = null;
        if (delta && typeof delta.content === 'string' && this.xmlMode) {
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
            if (this.xmlMode && !this.xmlParsingDisabled) {
                toolCalls = this.xmlToolCallAccumulator.getCompletedCalls();
            } else {
                toolCalls = this.toolCallAccumulator.getCompletedCalls();
            }
            if (toolCalls.length > 0) {
                // 显式打 mode，便于后续 saveAssistantMessage / handleToolCallStream 透传
                const mode = this.xmlMode ? ToolMode.XML : ToolMode.NATIVE;
                // 落 part 时显式标记 originalFormat=openai 写入 idMap.openai 槽，
                // 即使 OpenAI 服务端返回不带 call_ 前缀的短 id（某些代理/网关）也能正确归位
                toolCalls = toolCalls
                    .filter((tc) => tc && tc.name)
                    .map((tc) => ({
                        ...tc,
                        mode,
                        idMap: tc.idMap || generateIdSet(tc.id || '', 'openai')
                    }));
                this.executeToolCalls(toolCalls);
                return true;
            }
        }

        if (delta) {
            // reasoning_content（OpenAI 思维链）
            if (delta.reasoning_content) {
                this.stats.recordFirstToken();
                this.stats.recordTokens(delta.reasoning_content);
                this.thinkingContent += delta.reasoning_content;
                this.totalReceived += delta.reasoning_content.length;
                this.mergeContentPart('thinking', delta.reasoning_content);
                this.notifyStreaming(this.textContent, this.thinkingContent);
            }

            // 文本内容
            if (typeof delta.content === 'string') {
                this.stats.recordFirstToken();
                this.stats.recordTokens(delta.content);

                let contentToProcess = delta.content;
                if (this.xmlMode && !this.xmlParsingDisabled && xmlParseResult) {
                    contentToProcess = xmlParseResult.displayText.substring(
                        this.textContent.length
                    );
                }

                this.processThinkAndMarkdown(contentToProcess);
                this.notifyStreaming(this.textContent, this.thinkingContent);
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
        this.notifyStreaming(this.textContent, this.thinkingContent);
    }

    _getReasoningKey(itemOrId, outputIndex = null) {
        if (typeof itemOrId === 'string' && itemOrId) return itemOrId;
        if (itemOrId?.id) return itemOrId.id;
        if (outputIndex !== null && outputIndex !== undefined) return `output_${outputIndex}`;
        return `reasoning_${this.responsesReasoningItems.size}`;
    }

    _upsertReasoningItem(item, outputIndex = null) {
        if (!item || item.type !== 'reasoning') return;

        const key = this._getReasoningKey(item, outputIndex);
        const prev = this.responsesReasoningItems.get(key) || {
            type: 'reasoning',
            summary: []
        };

        const next = {
            ...prev,
            type: 'reasoning',
            id: item.id || prev.id || null,
            summary: Array.isArray(item.summary) ? item.summary : prev.summary || []
        };

        if (item.encrypted_content || item.encryptedContent) {
            next.encrypted_content = item.encrypted_content || item.encryptedContent;
            this.encryptedContent = next.encrypted_content;
        }
        if (item.status) next.status = item.status;
        if (next.id) this.reasoningItemId = next.id;

        this.responsesReasoningItems.set(key, next);
    }

    _setReasoningSummaryPart(itemId, outputIndex, summaryIndex = 0, part = null) {
        if (!part) return;
        const key = this._getReasoningKey(itemId, outputIndex);
        const item = this.responsesReasoningItems.get(key) || {
            type: 'reasoning',
            id: itemId || null,
            summary: []
        };
        item.summary = Array.isArray(item.summary) ? item.summary : [];
        item.summary[summaryIndex || 0] = part;
        this.responsesReasoningItems.set(key, item);
        if (item.id) this.reasoningItemId = item.id;
    }

    _setReasoningSummaryText(itemId, outputIndex, summaryIndex = 0, text = '') {
        if (!text) return;
        this._setReasoningSummaryPart(itemId, outputIndex, summaryIndex, {
            type: 'summary_text',
            text
        });
    }

    _getReasoningItemsForSave() {
        return Array.from(this.responsesReasoningItems.values())
            .map((item) => ({
                type: 'reasoning',
                id: item.id || null,
                summary: Array.isArray(item.summary) ? item.summary.filter(Boolean) : [],
                encrypted_content: item.encrypted_content || item.encryptedContent || null,
                status: item.status || null
            }))
            .filter((item) => item.id || item.encrypted_content);
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
            // Responses API function_call 永远是原生协议，
            // 显式标 NATIVE 覆盖 base.executeToolCalls 按 xmlMode 的兜底
            completedCalls.push({
                id: tc.id,
                call_id: tc.call_id || tc.id,
                responseItemId: tc.responseItemId || null,
                name: tc.name,
                arguments: args,
                mode: ToolMode.NATIVE,
                idMap: generateIdSet(tc.id, 'openai')
            });
        }

        if (completedCalls.length > 0) {
            this.executeToolCalls(completedCalls, {
                encryptedContent: this.encryptedContent,
                reasoningItemId: this.reasoningItemId,
                reasoningItems: this._getReasoningItemsForSave()
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

        const userMessage = this.buildStreamErrorUserMessage(errorCode, errorMessage);
        eventBus.emit('ui:notification', { message: userMessage, type: 'error', duration: 8000 });
        await this.reader.cancel();

        if (this.textContent || this.thinkingContent || this.contentParts.length > 0) {
            this.finalizeStreamWithError(errorCode, errorMessage, this.getStreamErrorExtraFields());
        }
    }

    _finalize() {
        this.finalizeStream(this.collectExtraSaveFields());
    }

    // ───── Hook overrides ─────

    hasOngoingToolStream() {
        return (
            super.hasOngoingToolStream() ||
            this.hasToolCalls === true ||
            this.hasResponsesToolCalls === true ||
            (this.toolCallAccumulator?.calls?.size ?? 0) > 0 ||
            (this.responsesToolCalls?.size ?? 0) > 0
        );
    }

    collectExtraSaveFields() {
        const extra = { ...super.collectExtraSaveFields() };
        if (this.isResponsesFormat) {
            // Responses API：reasoningItems 通过 _getReasoningItemsForSave() 从 Map 转 Array
            // 修复 base 旧版嗅探 this.reasoningItems 永远 falsy 的死代码（实际字段是 responsesReasoningItems Map）
            const reasoningItems = this._getReasoningItemsForSave();
            if (reasoningItems.length > 0) {
                extra.reasoningItems = reasoningItems;
            }
            if (typeof this.encryptedContent === 'string' && this.encryptedContent) {
                extra.encryptedContent = this.encryptedContent;
            }
            if (typeof this.reasoningItemId === 'string' && this.reasoningItemId) {
                extra.reasoningItemId = this.reasoningItemId;
            }
        }
        return extra;
    }

    buildStreamErrorUserMessage(errorCode, errorMessage) {
        if (errorCode === 429 || errorCode === 'rate_limit_exceeded') {
            return `请求过多 (429)：${errorMessage}\n请稍后再试`;
        }
        if (errorCode === 503) {
            return `服务暂时不可用 (503)：${errorMessage}`;
        }
        if (errorCode === 500 || errorCode === 'server_error') {
            return `服务器内部错误：${errorMessage}`;
        }
        if (errorCode === 'context_length_exceeded') {
            return `上下文超长 (${errorCode}): ${errorMessage}`;
        }
        return super.buildStreamErrorUserMessage(errorCode, errorMessage);
    }

    /**
     * OpenAI reply：含 encryptedContent / reasoningItemId / reasoningItems（Responses）
     */
    collectReply() {
        return {
            ...super.collectReply(),
            encryptedContent: this.encryptedContent,
            reasoningItemId: this.reasoningItemId,
            reasoningItems: this._getReasoningItemsForSave()
        };
    }
}

/**
 * 解析 OpenAI 流式响应（保持原有导出签名）
 * @param {ReadableStreamDefaultReader} reader
 * @param {string} [format]
 * @param {string|null} [sessionId]
 * @param {import('./sink.js').StreamSink} [sink] - 可选 sink，缺省 DefaultSink(sessionId)
 * @param {AbortSignal|null} [signal]
 * @returns {Promise<OpenAIStreamParser>} 完成后的 parser 实例（multi-stream 从实例字段构建 reply）
 */
export async function parseOpenAIStream(
    reader,
    format = 'openai',
    sessionId = null,
    sink = null,
    signal = null
) {
    const parser = new OpenAIStreamParser(format, sessionId, sink);
    await parser.parse(reader, signal);
    return parser;
}
