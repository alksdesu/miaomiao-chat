/**
 * 流解析器基类
 * 提取三个格式解析器（OpenAI/Claude/Gemini）的公共逻辑
 */

import { logger } from '../utils/logger.js';
import { appendStreamStats, StreamStats } from './stats.js';
import {
    renderFinalTextWithThinking,
    renderFinalContentWithThinking,
    cleanupAllIncompleteImages
} from './helpers.js';
import { saveAssistantMessage } from '../messages/sync.js';
import { setCurrentMessageIndex } from '../messages/dom-sync.js';
import { eventBus } from '../core/events.js';
import { renderHumanizedError } from '../utils/errors.js';
import { parseStreamingMarkdownImages } from '../utils/markdown-image-parser.js';
import { handleToolCallStream } from './tool-call-handler.js';
import { XMLStreamAccumulator } from '../tools/xml-formatter.js';
import { state } from '../core/state.js';
import { setIsToolCallPending } from '../core/state-mutations.js';
import { ThinkTagParser } from './think-tag-parser.js';
import { requestStateMachine, RequestState } from '../core/request-state-machine.js';

// 响应长度限制
const MAX_RESPONSE_LENGTH = 200000;

/**
 * 流解析器基类，封装公共的流读取、缓冲、finalize 逻辑
 */
export class BaseStreamParser {
    constructor(sessionId = null) {
        this.sessionId = sessionId;
        this.decoder = new TextDecoder();
        this.buffer = '';
        this.textContent = '';
        this.thinkingContent = ''; // 运行时变量，非旧格式字段
        this.contentParts = []; // 运行时变量，非旧格式字段
        this.totalReceived = 0;
        this.markdownBuffer = '';

        this.stats = new StreamStats();

        // XML 工具调用
        this.xmlToolCallAccumulator = new XMLStreamAccumulator();
        this.xmlParsingDisabled = false;

        // <think> 标签解析器
        this.thinkTagParser = new ThinkTagParser();
    }

    /** 响应长度上限，子类可覆盖 */
    get maxResponseLength() {
        return MAX_RESPONSE_LENGTH;
    }

    /**
     * 主循环：读取流 → 按行处理 → finalize
     * @param {ReadableStreamDefaultReader} reader
     */
    async parse(reader) {
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                this.buffer += this.decoder.decode(value, { stream: true });
                const lines = this.buffer.split('\n');
                this.buffer = lines.pop() || '';

                for (const line of lines) {
                    // 子类处理每一行，返回 true 表示流应该终止
                    const shouldReturn = await this.processLine(line);
                    if (shouldReturn) return;
                }
            }

            // 流自然结束，子类执行收尾
            await this.onStreamEnd();
        } finally {
            try {
                reader.releaseLock();
            } catch (_e) {
                console.debug('Reader lock already released:', _e);
            }
        }
    }

    /**
     * 子类实现：处理单行 SSE 数据
     * @param {string} line
     * @returns {boolean} 返回 true 则立即退出主循环
     */
    // eslint-disable-next-line no-unused-vars
    async processLine(line) {
        throw new Error('子类必须实现 processLine()');
    }

    /**
     * 子类实现：流自然结束后的收尾逻辑
     */
    async onStreamEnd() {
        throw new Error('子类必须实现 onStreamEnd()');
    }

    // ───── 公共工具方法 ─────

    /**
     * XML 工具调用检测（处理 text delta）
     * @param {string} deltaText - 原始文本增量
     * @returns {{ deltaText: string, hasXML: boolean, xmlParseResult: object|null }}
     */
    processXmlDetection(deltaText) {
        if (!state.xmlToolCallingEnabled || this.xmlParsingDisabled) {
            return { deltaText, hasXML: false, xmlParseResult: null };
        }
        try {
            const result = this.xmlToolCallAccumulator.processDelta(deltaText);
            if (result.error) {
                logger.error(`[Parser] XML 解析错误:`, result.error);
                return { deltaText, hasXML: false, xmlParseResult: result };
            }
            if (result.hasToolCalls) {
                const newDelta = result.displayText.substring(this.textContent.length);
                return { deltaText: newDelta, hasXML: true, xmlParseResult: result };
            }
            return { deltaText, hasXML: false, xmlParseResult: result };
        } catch (xmlError) {
            logger.error(`[Parser] XML 累积器异常:`, xmlError);
            this.xmlParsingDisabled = true;
            return { deltaText, hasXML: false, xmlParseResult: null };
        }
    }

    /**
     * 处理 <think> 标签解析 + markdown 图片解析
     * 将结果写入 textContent / thinkingContent / contentParts
     * @param {string} deltaText - XML 处理后的文本增量
     */
    processThinkAndMarkdown(deltaText) {
        const { displayText: thinkParsedText, thinkingDelta } =
            this.thinkTagParser.processDelta(deltaText);

        if (thinkingDelta) {
            this.appendThinking(thinkingDelta);
            this.totalReceived += thinkingDelta.length;
            this.mergeContentPart('thinking', thinkingDelta);
        }

        const { parts, newBuffer } = parseStreamingMarkdownImages(
            thinkParsedText,
            this.markdownBuffer
        );
        this.markdownBuffer = newBuffer;

        for (const part of parts) {
            if (part.type === 'text') {
                this.textContent += part.text;
                this.totalReceived += part.text.length;
                this.mergeContentPart('text', part.text);
            } else if (part.type === 'image_url') {
                this.contentParts.push(part);
                this.totalReceived += part.url.length;
            }
        }
    }

    /**
     * 追加 thinking 内容，子类可覆盖以写入不同目标
     * （Claude 写入 currentThinkingBlock，默认写入 thinkingContent）
     * @param {string} delta
     */
    appendThinking(delta) {
        this.thinkingContent += delta;
    }

    /**
     * 合并连续的同类型 contentPart（text 或 thinking）
     * @param {'text'|'thinking'} type
     * @param {string} text
     */
    mergeContentPart(type, text) {
        const last = this.contentParts[this.contentParts.length - 1];
        if (last && last.type === type) {
            last.text += text;
        } else {
            this.contentParts.push({ type, text });
        }
    }

    /**
     * 刷新 thinkTagParser 缓冲区，将残余内容写入 textContent / thinkingContent / contentParts
     */
    flushThinkTagParser() {
        const { displayText, thinkingDelta } = this.thinkTagParser.flush();
        if (thinkingDelta) {
            this.appendThinking(thinkingDelta);
            this.mergeContentPart('thinking', thinkingDelta);
        }
        if (displayText) {
            this.textContent += displayText;
            this.mergeContentPart('text', displayText);
        }
    }

    /**
     * 检查是否超过响应长度限制
     * @returns {boolean} 是否超限
     */
    isOverLimit() {
        return this.totalReceived > this.maxResponseLength;
    }

    /**
     * 超长截断时的通用处理：通知 + cancel + flush + finalize
     * @param {ReadableStreamDefaultReader} reader
     * @param {Function} finalizeFn - 调用的 finalize 函数
     */
    async handleTruncation(reader, finalizeFn) {
        logger.warn(`响应超长（${this.totalReceived} 字符），已强制截断`);
        eventBus.emit('ui:notification', {
            message: `响应过长（${this.totalReceived.toLocaleString()} 字符），已自动截断`,
            type: 'warning'
        });
        await reader.cancel();
        this.beforeTruncationFinalize();
        finalizeFn();
    }

    /**
     * 截断前的收尾逻辑，子类可覆盖
     * 默认刷新 thinkTagParser 缓冲区
     */
    beforeTruncationFinalize() {
        this.flushThinkTagParser();
    }

    // ───── finalize 公共逻辑 ─────

    /**
     * 正常完成流处理（公共骨架）
     * @param {Object} extraSaveFields - 格式特有的保存字段（如 thoughtSignature, thinkingBlocks 等）
     * @param {Object} groundingMetadata - 搜索引用元数据（Gemini 用）
     */
    finalizeStream(extraSaveFields = {}, groundingMetadata = null) {
        if (state.isToolCallPending) {
            setIsToolCallPending(false);
        }

        this.stats.finalize();
        cleanupAllIncompleteImages(this.contentParts);

        const isBackground = this.sessionId && this.sessionId !== state.currentSessionId;

        if (!isBackground) {
            if (this.contentParts.length > 0) {
                renderFinalContentWithThinking(
                    this.contentParts,
                    this.thinkingContent,
                    groundingMetadata
                );
            } else if (this.textContent || this.thinkingContent) {
                renderFinalTextWithThinking(
                    this.textContent,
                    this.thinkingContent,
                    groundingMetadata
                );
            }

            this.stats.recalculateTokenCount({
                textContent: this.textContent,
                thinkingContent: this.thinkingContent,
                contentParts: this.contentParts
            });

            this.stats.syncToGlobal();
            appendStreamStats();
        }

        const messageIndex = saveAssistantMessage({
            textContent: this.textContent,
            thinkingContent: this.thinkingContent,
            contentParts: this.contentParts,
            streamStats: this.stats.getData(),
            sessionId: this.sessionId,
            ...extraSaveFields
        });

        setCurrentMessageIndex(messageIndex);
    }

    /**
     * 以错误状态完成流处理（公共骨架）
     * @param {string|number} errorCode
     * @param {string} errorMessage
     * @param {Object} extraSaveFields - 格式特有的保存字段
     * @param {Object} groundingMetadata - 搜索引用元数据
     */
    finalizeStreamWithError(
        errorCode,
        errorMessage,
        extraSaveFields = {},
        groundingMetadata = null
    ) {
        this.stats.finalize();
        cleanupAllIncompleteImages(this.contentParts);

        const isBackground = this.sessionId && this.sessionId !== state.currentSessionId;

        const errorObject = { code: errorCode, message: errorMessage, type: errorCode };
        const errorHtml =
            renderHumanizedError(errorObject, errorCode, true) +
            `<div class="stream-error-partial-save">\u{1F4BE} 已保存部分接收的内容</div>`;

        const finalText = this.textContent + '\n\n' + errorMessage;

        if (!isBackground) {
            if (this.contentParts.length > 0) {
                renderFinalContentWithThinking(
                    this.contentParts,
                    this.thinkingContent,
                    groundingMetadata
                );
            } else if (this.textContent || this.thinkingContent) {
                renderFinalTextWithThinking(
                    this.textContent,
                    this.thinkingContent,
                    groundingMetadata
                );
            }

            const currentMsg = document.querySelector('.message.assistant:last-child');
            if (currentMsg) {
                const contentDiv = currentMsg.querySelector('.message-content');
                if (contentDiv) {
                    contentDiv.insertAdjacentHTML('beforeend', errorHtml);
                }
            }

            this.stats.recalculateTokenCount({
                textContent: finalText,
                thinkingContent: this.thinkingContent,
                contentParts: this.contentParts
            });
            this.stats.syncToGlobal();
            appendStreamStats();
        }

        const messageIndex = saveAssistantMessage({
            textContent: finalText,
            thinkingContent: this.thinkingContent,
            contentParts: this.contentParts,
            streamStats: this.stats.getData(),
            isError: true,
            errorData: { code: errorCode, message: errorMessage },
            errorHtml,
            sessionId: this.sessionId,
            ...extraSaveFields
        });

        setCurrentMessageIndex(messageIndex);

        if (!isBackground) {
            eventBus.emit('stream:error', {
                errorCode,
                errorMessage,
                partialContent: this.textContent
            });

            if (state.isToolCallPending) {
                setIsToolCallPending(false);
            }
        }
    }

    /**
     * 工具调用的公共执行流程
     * @param {Array} completedCalls - 已完成的工具调用列表
     * @param {Object} extraSaveFields - 额外保存字段
     */
    executeToolCalls(completedCalls, extraSaveFields = {}) {
        logger.debug(`[Parser] 检测到工具调用:`, {
            toolCallsCount: completedCalls.length,
            toolNames: completedCalls.map((tc) => tc.name).join(', ')
        });

        if (this.contentParts.length > 0) {
            renderFinalContentWithThinking(this.contentParts, this.thinkingContent);
        } else if (this.textContent || this.thinkingContent) {
            renderFinalTextWithThinking(this.textContent, this.thinkingContent);
        }

        const messageIndex = saveAssistantMessage({
            textContent: this.textContent || '(调用工具)',
            thinkingContent: this.thinkingContent,
            contentParts: this.contentParts,
            toolCalls: completedCalls,
            streamStats: this.stats.getPartialData(),
            sessionId: this.sessionId,
            ...extraSaveFields
        });

        setCurrentMessageIndex(messageIndex);

        requestStateMachine.transition(RequestState.TOOL_CALLING);
        setIsToolCallPending(true);

        // 动态 import 避免 base-parser ↔ handler 循环依赖
        import('../api/handler.js')
            .then(({ getCurrentEndpoint, getCurrentApiKey, getCurrentModel }) => {
                handleToolCallStream(completedCalls, {
                    endpoint: getCurrentEndpoint(),
                    apiKey: getCurrentApiKey(),
                    model: getCurrentModel()
                }).catch((error) => {
                    logger.error('[Parser] 工具调用流程失败:', error);
                });
            })
            .catch((error) => {
                logger.error('[Parser] 加载 handler 模块失败:', error);
                setIsToolCallPending(false);
                requestStateMachine.forceReset();
                eventBus.emit('ui:reset-input-buttons');
            });
    }
}

// 不再 re-export 子模块符号，子类应从源模块直接 import
