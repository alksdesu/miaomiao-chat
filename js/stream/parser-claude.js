/**
 * Claude 流解析器
 * 解析 Claude SSE 流式响应
 */

import { logger } from '../utils/logger.js';
import { BaseStreamParser } from './base-parser.js';

import { state } from '../core/state.js';
import { eventBus } from '../core/events.js';
import { ToolMode } from '../messages/schema.js';
import {
    buildPartsFromStreamingState,
    buildMetaFromStreamingState
} from '../messages/parts-builder.js';
import { generateIdSet } from '../api/format-converter.js';

/**
 * Claude 流解析器
 */
export class ClaudeStreamParser extends BaseStreamParser {
    constructor(sessionId, sink = null) {
        super(sessionId, sink);
        this.reader = null;
        this.signatureFormat = 'claude';

        // 思考块管理（Claude 支持多个独立思考块）
        this.thinkingBlocks = [];
        this.currentThinkingBlock = '';
        this.thinkingSignatures = [];
        this.currentSignature = '';
        // 顺序数组：同时记录 thinking 和 redacted_thinking blocks，保持原响应顺序，
        // 回传 Claude API 时不能丢任何一个，否则触发 "blocks cannot be modified" 校验
        this.thinkingItems = [];
        this.currentRedactedData = '';
        this.currentBlockType = null;
        this.blockIndex = 0;

        // 工具调用
        this.toolCalls = new Map();
        this.serverToolCalls = new Map();
        this.serverToolResults = [];
        this.stopReason = null;
    }

    /** Claude 的 thinkingContent 是所有 blocks 合并后的运行时变量（非旧格式字段） */
    get mergedThinking() {
        return [...this.thinkingBlocks, this.currentThinkingBlock]
            .filter(Boolean)
            .join('\n\n---\n\n');
    }

    /** Claude 的 thinking 写入 currentThinkingBlock 而非 thinkingContent（运行时变量） */
    appendThinking(delta) {
        this.currentThinkingBlock += delta;
    }

    async parse(reader, signal = null) {
        this.reader = reader;
        return super.parse(reader, signal);
    }

    async processLine(line) {
        if (!line.startsWith('data: ')) return false;

        try {
            const event = JSON.parse(line.slice(6));

            // 错误事件
            if (event.type === 'error') {
                await this._handleStreamError(event.error);
                return true;
            }

            switch (event.type) {
                case 'content_block_start':
                    this._handleBlockStart(event);
                    break;

                case 'content_block_delta':
                    await this._handleBlockDelta(event);
                    if (this.isOverLimit()) {
                        await this.handleTruncation(this.reader, () => this._finalize());
                        return true;
                    }
                    break;

                case 'content_block_stop':
                    this._handleBlockStop();
                    break;

                case 'message_delta':
                    if (event.delta?.stop_reason) {
                        this.stopReason = event.delta.stop_reason;
                    }
                    break;

                case 'message_stop':
                    return this._handleMessageStop();
            }
        } catch (_e) {
            logger.warn('Claude SSE parse error:', _e);
        }
        return false;
    }

    async onStreamEnd() {
        // flushThinkTagParser 通过 appendThinking 写入 currentThinkingBlock
        this.flushThinkTagParser();
        this._flushCurrentThinkingBlock();
        this._finalize();
    }

    /**
     * 收尾未关闭的 thinking 块（流被截断 / 提前 EOF）—— 同时同步 thinkingBlocks、
     * thinkingSignatures、thinkingItems 三个数组，避免 parts-builder 优先取 items
     * 时遗漏最后那段 thinking 文本（buildPartsFromStreamingState line 138-145）。
     *
     * signature 缺失时填空串占位，让 claude-adapter 据 F6 严格判定直接跳过整块发送
     * 而非用空签名触发 Anthropic invalid_signature 400。
     */
    _flushCurrentThinkingBlock() {
        if (!this.currentThinkingBlock && !this.currentSignature) return;
        const text = this.currentThinkingBlock;
        const sig = this.currentSignature || '';
        this.thinkingBlocks.push(text);
        if (this.thinkingSignatures.length < this.thinkingBlocks.length) {
            this.thinkingSignatures.push(sig);
        }
        this.thinkingItems.push({ type: 'thinking', text, signature: sig });
        this.currentThinkingBlock = '';
        this.currentSignature = '';
    }

    // ───── 事件处理 ─────

    _handleBlockStart(event) {
        this.currentBlockType = event.content_block?.type;
        this.blockIndex = event.index;

        const CLAUDE_SERVER_TOOLS = ['web_search', 'code_execution'];
        const blockName = event.content_block?.name;
        const isServerTool =
            this.currentBlockType === 'server_tool_use' ||
            (this.currentBlockType === 'tool_use' && CLAUDE_SERVER_TOOLS.includes(blockName));

        if (isServerTool) {
            const block = event.content_block;
            this.serverToolCalls.set(this.blockIndex, {
                id: block.id,
                name: block.name,
                input: ''
            });
        } else if (this.currentBlockType === 'tool_use' && !this.xmlMode) {
            const block = event.content_block;
            this.toolCalls.set(this.blockIndex, {
                id: block.id,
                name: block.name,
                input: ''
            });
        } else if (this.currentBlockType?.endsWith('_tool_result')) {
            const block = event.content_block;
            this.serverToolResults.push({
                type: this.currentBlockType,
                tool_use_id: block.tool_use_id,
                content: block.content
            });
        } else if (this.currentBlockType === 'thinking') {
            this.currentThinkingBlock = '';
        } else if (this.currentBlockType === 'redacted_thinking') {
            // block_start 时可能直接附带完整 data（非流式增量），先吸收
            this.currentRedactedData = event.content_block?.data || '';
        }
    }

    async _handleBlockDelta(event) {
        if (event.delta?.type === 'input_json_delta') {
            // 工具调用参数累积
            const toolCall = this.toolCalls.get(event.index);
            if (toolCall) toolCall.input += event.delta.partial_json;
            const serverCall = this.serverToolCalls.get(event.index);
            if (serverCall) serverCall.input += event.delta.partial_json;
        } else if (event.delta?.type === 'thinking_delta') {
            this.stats.recordFirstToken();
            this.stats.recordTokens(event.delta.thinking);
            this.currentThinkingBlock += event.delta.thinking;
            this.totalReceived += event.delta.thinking.length;
            this.notifyStreaming(this.textContent, this.mergedThinking);
        } else if (event.delta?.type === 'signature_delta') {
            this.currentSignature += event.delta.signature;
        } else if (event.delta?.type === 'redacted_thinking_delta') {
            // 文档未明确该 delta 类型是否存在，保守处理以兼容未来变更
            this.currentRedactedData += event.delta.data || '';
        } else if (event.delta?.type === 'text_delta') {
            this.stats.recordFirstToken();
            this.stats.recordTokens(event.delta.text);

            // XML 工具调用检测
            let deltaText = event.delta.text;
            const { deltaText: processed } = this.processXmlDetection(deltaText);
            deltaText = processed;

            // <think> + markdown 图片解析（通过 appendThinking 写入 currentThinkingBlock）
            this.processThinkAndMarkdown(deltaText);

            this.notifyStreaming(this.textContent, this.mergedThinking);
        }
    }

    _handleBlockStop() {
        // Claude Opus 4.7+ 默认 display:"omitted"，thinking 字段空字符串但 signature 有效，
        // 必须以 signature 为准保留 block，否则下一轮回传缺 thinking blocks 触发 400
        if (
            this.currentBlockType === 'thinking' &&
            (this.currentThinkingBlock || this.currentSignature)
        ) {
            this.thinkingBlocks.push(this.currentThinkingBlock);
            this.thinkingSignatures.push(this.currentSignature);
            this.thinkingItems.push({
                type: 'thinking',
                text: this.currentThinkingBlock,
                signature: this.currentSignature
            });
            this.currentThinkingBlock = '';
            this.currentSignature = '';
        } else if (this.currentBlockType === 'redacted_thinking' && this.currentRedactedData) {
            this.thinkingItems.push({
                type: 'redacted_thinking',
                data: this.currentRedactedData
            });
            this.currentRedactedData = '';
        }
        this.currentBlockType = null;
    }

    _handleMessageStop() {
        // 检查工具调用
        let completedCalls = [];

        if (this.xmlMode && !this.xmlParsingDisabled) {
            const xmlCalls = this.xmlToolCallAccumulator.getCompletedCalls();
            // XML 模式调用 part.mode=XML，adapter 重发时跳过 native 分支；idMap 仍预生成兜底跨格式重发
            // originalFormat='claude' 与 :265 native 分支对称：让短/非标 tc.id（xml_tool_xxx）
            // 也归位到 idMap.claude 槽，避免前缀启发式漏判
            if (xmlCalls.length > 0) {
                completedCalls = xmlCalls
                    .filter((tc) => tc && tc.name)
                    .map((tc) => ({
                        ...tc,
                        mode: ToolMode.XML,
                        idMap: tc.idMap || generateIdSet(tc.id || '', 'claude')
                    }));
            }
        } else if (this.stopReason === 'tool_use' && this.toolCalls.size > 0) {
            for (const [_index, call] of this.toolCalls) {
                let args;
                try {
                    args = call.input != null && call.input !== '' ? JSON.parse(call.input) : {};
                } catch (_e) {
                    args = {};
                }
                completedCalls.push({
                    id: call.id,
                    name: call.name,
                    arguments: args,
                    mode: ToolMode.NATIVE,
                    idMap: generateIdSet(call.id, 'claude')
                });
            }
        }

        if (completedCalls.length > 0) {
            // 同步 thinkingContent 用于 executeToolCalls
            this.thinkingContent = this.thinkingBlocks.join('\n\n---\n\n');
            this.executeToolCalls(completedCalls, {
                thinkingBlocks: this.thinkingBlocks,
                thinkingSignatures: this.thinkingSignatures,
                thinkingItems: this.thinkingItems
            });
            return true;
        }

        // 注入服务端工具调用结果到 contentParts
        for (const [_idx, call] of this.serverToolCalls) {
            let args;
            try {
                args = call.input != null && call.input !== '' ? JSON.parse(call.input) : {};
            } catch {
                args = {};
            }
            const result = this.serverToolResults.find((r) => r.tool_use_id === call.id);
            this.contentParts.push({
                type: 'server_tool_use',
                id: call.id,
                name: call.name,
                input: args,
                result: result ? { type: result.type, content: result.content } : null
            });
        }

        // pause_turn 处理
        if (this.stopReason === 'pause_turn') {
            return this._handlePauseTurn();
        }

        this._finalize();
        return true;
    }

    _handlePauseTurn() {
        logger.debug('[Claude] pause_turn 检测到，准备 continuation');
        const finalThinking = this.thinkingBlocks.join('\n\n---\n\n');

        if (this.contentParts.length > 0) {
            this.sink.renderFinalContent(this.contentParts, finalThinking);
        } else if (this.textContent || finalThinking) {
            this.sink.renderFinalText(this.textContent, finalThinking);
        }

        this.sink.commit(
            buildPartsFromStreamingState({
                textContent: this.textContent,
                thinkingContent: finalThinking,
                thinkingBlocks: this.thinkingBlocks,
                thinkingSignatures: this.thinkingSignatures,
                thinkingItems: this.thinkingItems,
                contentParts: this.contentParts,
                signatureFormat: this.signatureFormat
            }),
            buildMetaFromStreamingState({
                streamStats: this.stats.getPartialData()
            }),
            {}
        );

        const assistantMessageEl = state.currentAssistantMessage?.closest('.message');
        this.sink.triggerPauseTurnResend(assistantMessageEl);

        return true;
    }

    /** 截断前：flushThinkTagParser 写入 currentThinkingBlock，三数组（blocks/signatures/items）同步收尾 */
    beforeTruncationFinalize() {
        this.flushThinkTagParser();
        this._flushCurrentThinkingBlock();
    }

    async _handleStreamError(error) {
        const errorCode = error?.type || 'unknown';
        const errorMessage = error?.message || 'Unknown error';
        logger.error(`Claude API 错误 (流式响应):`, error);

        const userMessage = this.buildStreamErrorUserMessage(errorCode, errorMessage);
        eventBus.emit('ui:notification', { message: userMessage, type: 'error', duration: 8000 });
        await this.reader.cancel();

        // 错误中断也要收尾未关闭的 thinking 块，否则 retry 重发时缺最后那段 thinking
        // 导致 Anthropic 校验 thinking blocks 不一致 400
        this._flushCurrentThinkingBlock();

        const partialThinking = this.mergedThinking;
        if (this.textContent || partialThinking || this.contentParts.length > 0) {
            // 临时同步 thinkingContent 供 finalizeStreamWithError 使用
            this.thinkingContent = partialThinking;
            // getStreamErrorExtraFields() 透传 thinkingBlocks/Signatures/Items + serverTool*
            this.finalizeStreamWithError(errorCode, errorMessage, this.getStreamErrorExtraFields());
        }
    }

    _finalize() {
        this.syncBeforeFinalize();
        this.finalizeStream(this.collectExtraSaveFields());
    }

    // ───── Hook overrides ─────

    hasOngoingToolStream() {
        return (
            super.hasOngoingToolStream() ||
            (this.toolCalls?.size ?? 0) > 0 ||
            (this.serverToolCalls?.size ?? 0) > 0 ||
            (Array.isArray(this.serverToolResults) && this.serverToolResults.length > 0)
        );
    }

    /**
     * finalize 出口前把多段 thinkingBlocks join 写回 thinkingContent,
     * 避免 buildPartsFromStreamingState 读到旧 thinkingContent 导致下轮 retry
     * 触发 'thinking blocks modified' 400
     */
    syncBeforeFinalize() {
        if (Array.isArray(this.thinkingBlocks) && this.thinkingBlocks.length > 0) {
            this.thinkingContent = this.mergedThinking;
        }
    }

    collectExtraSaveFields() {
        const extra = { ...super.collectExtraSaveFields() };
        if (this.thinkingBlocks.length > 0) extra.thinkingBlocks = this.thinkingBlocks;
        if (this.thinkingSignatures.length > 0) extra.thinkingSignatures = this.thinkingSignatures;
        if (this.thinkingItems.length > 0) extra.thinkingItems = this.thinkingItems;
        // serverToolCalls / serverToolResults 在 idle_timeout / network_error 路径下也要落库
        // 否则 _handleMessageStop 注入到 contentParts 前就丢失了
        if (this.serverToolCalls.size > 0) {
            extra.serverToolCalls = Array.from(this.serverToolCalls.values());
        }
        if (this.serverToolResults.length > 0) {
            extra.serverToolResults = this.serverToolResults;
        }
        return extra;
    }

    buildStreamErrorUserMessage(errorCode, errorMessage) {
        if (errorCode === 'rate_limit_error' || errorCode === 429) {
            return `请求过多 (429)：${errorMessage}\n请稍后再试`;
        }
        if (errorCode === 'overloaded_error' || errorCode === 529) {
            return `服务过载 (529)：${errorMessage}\n请稍后重试`;
        }
        if (errorCode === 'api_error') {
            return `API 错误：${errorMessage}`;
        }
        if (errorCode === 'invalid_request_error' && /thinking/i.test(errorMessage)) {
            return `Thinking blocks 校验失败 (${errorCode}): ${errorMessage}`;
        }
        return `错误 (${errorCode}): ${errorMessage}`;
    }

    /**
     * Claude reply：含 thinkingBlocks / thinkingSignatures / thinkingItems 顺序数组
     */
    collectReply() {
        const merged = this.mergedThinking;
        return {
            ...super.collectReply(),
            thinkingContent: merged || null,
            thinkingBlocks: this.thinkingBlocks.length > 0 ? this.thinkingBlocks : null,
            thinkingSignatures: this.thinkingSignatures.length > 0 ? this.thinkingSignatures : null,
            thinkingItems: this.thinkingItems.length > 0 ? this.thinkingItems : null,
            thinkingSignature:
                this.thinkingSignatures.length === 1 ? this.thinkingSignatures[0] : null
        };
    }
}

/**
 * 解析 Claude 流式响应（保持原有导出签名）
 * @param {ReadableStreamDefaultReader} reader
 * @param {string|null} [sessionId]
 * @param {import('./sink.js').StreamSink} [sink]
 * @param {AbortSignal|null} [signal]
 * @returns {Promise<ClaudeStreamParser>}
 */
export async function parseClaudeStream(reader, sessionId = null, sink = null, signal = null) {
    const parser = new ClaudeStreamParser(sessionId, sink);
    await parser.parse(reader, signal);
    return parser;
}
