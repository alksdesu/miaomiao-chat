/**
 * Claude 流解析器
 * 解析 Claude SSE 流式响应
 */

import { logger } from '../utils/logger.js';
import { BaseStreamParser } from './base-parser.js';

import {
    updateStreamingMessage,
    renderFinalContentWithThinking,
    renderFinalTextWithThinking
} from './helpers.js';
import { saveAssistantMessage } from '../messages/sync.js';
import { setCurrentMessageIndex } from '../messages/dom-sync.js';
import { state } from '../core/state.js';
import { setIsToolCallPending } from '../core/state-mutations.js';
import { eventBus } from '../core/events.js';
import { requestStateMachine, RequestState } from '../core/request-state-machine.js';

/**
 * Claude 流解析器
 */
class ClaudeStreamParser extends BaseStreamParser {
    constructor(sessionId) {
        super(sessionId);
        this.reader = null;

        // 思考块管理（Claude 支持多个独立思考块）
        this.thinkingBlocks = [];
        this.currentThinkingBlock = '';
        this.thinkingSignatures = [];
        this.currentSignature = '';
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

    async parse(reader) {
        this.reader = reader;
        return super.parse(reader);
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
        if (this.currentThinkingBlock) {
            this.thinkingBlocks.push(this.currentThinkingBlock);
        }
        this._finalize();
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
        } else if (this.currentBlockType === 'tool_use' && !state.xmlToolCallingEnabled) {
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
            updateStreamingMessage(this.textContent, this.mergedThinking);
        } else if (event.delta?.type === 'signature_delta') {
            this.currentSignature += event.delta.signature;
        } else if (event.delta?.type === 'text_delta') {
            this.stats.recordFirstToken();
            this.stats.recordTokens(event.delta.text);

            // XML 工具调用检测
            let deltaText = event.delta.text;
            const { deltaText: processed } = this.processXmlDetection(deltaText);
            deltaText = processed;

            // <think> + markdown 图片解析（通过 appendThinking 写入 currentThinkingBlock）
            this.processThinkAndMarkdown(deltaText);

            updateStreamingMessage(this.textContent, this.mergedThinking);
        }
    }

    _handleBlockStop() {
        if (this.currentBlockType === 'thinking' && this.currentThinkingBlock) {
            this.thinkingBlocks.push(this.currentThinkingBlock);
            this.thinkingSignatures.push(this.currentSignature);
            this.currentThinkingBlock = '';
            this.currentSignature = '';
        }
        this.currentBlockType = null;
    }

    _handleMessageStop() {
        // 检查工具调用
        let completedCalls = [];

        if (state.xmlToolCallingEnabled && !this.xmlParsingDisabled) {
            const xmlCalls = this.xmlToolCallAccumulator.getCompletedCalls();
            if (xmlCalls.length > 0) completedCalls = xmlCalls;
        } else if (this.stopReason === 'tool_use' && this.toolCalls.size > 0) {
            for (const [_index, call] of this.toolCalls) {
                let args;
                try {
                    args = call.input != null && call.input !== '' ? JSON.parse(call.input) : {};
                } catch (_e) {
                    args = {};
                }
                completedCalls.push({ id: call.id, name: call.name, arguments: args });
            }
        }

        if (completedCalls.length > 0) {
            // 同步 thinkingContent 用于 executeToolCalls
            this.thinkingContent = this.thinkingBlocks.join('\n\n---\n\n');
            this.executeToolCalls(completedCalls, {
                thinkingBlocks: this.thinkingBlocks,
                thinkingSignatures: this.thinkingSignatures
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
            renderFinalContentWithThinking(this.contentParts, finalThinking);
        } else if (this.textContent || finalThinking) {
            renderFinalTextWithThinking(this.textContent, finalThinking);
        }

        const messageIndex = saveAssistantMessage({
            textContent: this.textContent,
            thinkingContent: finalThinking,
            thinkingBlocks: this.thinkingBlocks,
            thinkingSignatures: this.thinkingSignatures,
            contentParts: this.contentParts,
            streamStats: this.stats.getPartialData(),
            sessionId: this.sessionId
        });
        setCurrentMessageIndex(messageIndex);

        const assistantMessageEl = state.currentAssistantMessage?.closest('.message');

        requestStateMachine.transition(RequestState.TOOL_CALLING);
        setIsToolCallPending(true);

        import('../api/handler.js')
            .then(
                ({
                    resendWithToolResults,
                    getCurrentEndpoint,
                    getCurrentApiKey,
                    getCurrentModel
                }) => {
                    resendWithToolResults(
                        [],
                        {
                            endpoint: getCurrentEndpoint(),
                            apiKey: getCurrentApiKey(),
                            model: getCurrentModel()
                        },
                        assistantMessageEl
                    ).catch((error) => {
                        logger.error('[Claude] pause_turn resend 失败:', error);
                    });
                }
            )
            .catch((error) => {
                logger.error('[Claude] pause_turn 加载 handler 模块失败:', error);
                setIsToolCallPending(false);
                requestStateMachine.forceReset();
                eventBus.emit('ui:reset-input-buttons');
            });

        return true;
    }

    /** 截断前：flushThinkTagParser 通过 appendThinking 写入 currentThinkingBlock，然后推入 thinkingBlocks */
    beforeTruncationFinalize() {
        this.flushThinkTagParser();
        if (this.currentThinkingBlock) {
            this.thinkingBlocks.push(this.currentThinkingBlock);
        }
    }

    async _handleStreamError(error) {
        const errorCode = error?.type || 'unknown';
        const errorMessage = error?.message || 'Unknown error';
        logger.error(`Claude API 错误 (流式响应):`, error);

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

        eventBus.emit('ui:notification', { message: userMessage, type: 'error', duration: 8000 });
        await this.reader.cancel();

        const partialThinking = this.mergedThinking;
        if (this.textContent || partialThinking || this.contentParts.length > 0) {
            // 临时同步 thinkingContent 供 finalizeStreamWithError 使用
            this.thinkingContent = partialThinking;
            this.finalizeStreamWithError(errorCode, errorMessage);
        }
    }

    _finalize() {
        const finalThinking = this.thinkingBlocks.join('\n\n---\n\n');
        this.thinkingContent = finalThinking;
        this.finalizeStream({
            thinkingBlocks: this.thinkingBlocks,
            thinkingSignatures: this.thinkingSignatures
        });
    }
}

/**
 * 解析 Claude 流式响应（保持原有导出签名）
 */
export async function parseClaudeStream(reader, sessionId = null) {
    const parser = new ClaudeStreamParser(sessionId);
    await parser.parse(reader);
}
