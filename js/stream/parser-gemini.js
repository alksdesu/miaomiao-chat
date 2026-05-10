/**
 * Gemini 流解析器
 * 解析 Gemini SSE 流式响应
 */

import { logger } from '../utils/logger.js';
import { BaseStreamParser } from './base-parser.js';

import { updateStreamingMessage } from './helpers.js';
import { state } from '../core/state.js';
import { eventBus } from '../core/events.js';
import { parseStreamingMarkdownImages } from '../utils/markdown-image-parser.js';
import { isVideoMimeType, isAudioMimeType } from '../utils/media.js';

// 响应长度限制（区分文本和图片）
const MAX_TEXT_RESPONSE_LENGTH = 200000;
const MAX_IMAGE_RESPONSE_LENGTH = 60000000;

/**
 * Gemini 流解析器
 */
class GeminiStreamParser extends BaseStreamParser {
    constructor(sessionId) {
        super(sessionId);
        this.reader = null;

        this.thoughtSignature = null;
        this.groundingMetadata = null;
        this.toolCalls = [];
    }

    /** 根据是否包含媒体动态调整长度限制 */
    get maxResponseLength() {
        const hasMedia = this.contentParts.some(
            (p) => p.type === 'image_url' || p.type === 'video_url' || p.type === 'audio_url'
        );
        return hasMedia ? MAX_IMAGE_RESPONSE_LENGTH : MAX_TEXT_RESPONSE_LENGTH;
    }

    async parse(reader) {
        this.reader = reader;
        return super.parse(reader);
    }

    async processLine(line) {
        if (!line.trim()) return false;
        if (line.startsWith(':')) return false;

        try {
            let jsonStr = line;
            if (line.startsWith('data: ')) {
                jsonStr = line.slice(6).trim();
                if (jsonStr === '[DONE]') return false;
            }

            const parsed = JSON.parse(jsonStr);

            // 错误检测
            if (parsed.error) {
                await this._handleStreamError(parsed.error);
                return true;
            }

            // 处理 candidates parts
            const parts = parsed.candidates?.[0]?.content?.parts || [];
            for (const part of parts) {
                this._processPart(part);
            }

            // 智能截断
            if (this._checkTruncation()) {
                await this.handleTruncation(this.reader, () => this._finalize());
                return true;
            }

            // 顶层 reasoning（某些 SDK/代理）
            if (parsed.reasoning) {
                const newReasoning = parsed.reasoning.slice(this.thinkingContent.length);
                if (newReasoning) {
                    this.stats.recordFirstToken();
                    this.stats.recordTokens(newReasoning);
                    this.thinkingContent += newReasoning;
                }
            }

            // metadata.gemini.reasoning（Gemini 3 Pro Image）
            if (parsed.metadata?.gemini?.reasoning) {
                const newReasoning = parsed.metadata.gemini.reasoning.slice(
                    this.thinkingContent.length
                );
                if (newReasoning) {
                    this.stats.recordFirstToken();
                    this.stats.recordTokens(newReasoning);
                    this.thinkingContent += newReasoning;
                }
            }

            // 搜索引用
            if (parsed.candidates?.[0]?.groundingMetadata) {
                this.groundingMetadata = parsed.candidates[0].groundingMetadata;
            }

            updateStreamingMessage(this.textContent, this.thinkingContent);
        } catch (_e) {
            logger.warn('Gemini stream parse error:', _e);
        }
        return false;
    }

    async onStreamEnd() {
        // 检查工具调用
        let finalToolCalls = [];

        if (state.xmlToolCallingEnabled && !this.xmlParsingDisabled) {
            const xmlCalls = this.xmlToolCallAccumulator.getCompletedCalls();
            if (xmlCalls.length > 0) {
                finalToolCalls = xmlCalls.map((tc) => ({
                    ...tc,
                    thoughtSignature: this.thoughtSignature || null
                }));
            }
        } else if (this.toolCalls.length > 0) {
            finalToolCalls = this.toolCalls;
        }

        if (finalToolCalls.length > 0) {
            this.executeToolCalls(finalToolCalls, {
                thoughtSignature: this.thoughtSignature
            });
            return;
        }

        this.flushThinkTagParser();
        this._finalize();
    }

    // ───── 单个 part 处理 ─────

    _processPart(part) {
        if (part.thoughtSignature) {
            this.thoughtSignature = part.thoughtSignature;
        }

        // 原生工具调用
        if (part.functionCall && !state.xmlToolCallingEnabled) {
            const fc = part.functionCall;
            this.toolCalls.push({
                id: fc.id || `gemini_tc_${Date.now()}_${this.toolCalls.length}`,
                name: fc.name,
                arguments: fc.args,
                thoughtSignature: this.thoughtSignature || null
            });
            return;
        }

        if (part.thought) {
            this.stats.recordFirstToken();
            this.stats.recordTokens(part.text);
            const thoughtText = part.text || '';
            this.thinkingContent += thoughtText;
            this.totalReceived += thoughtText.length;
            this.mergeContentPart('thinking', thoughtText);
        } else if (part.text) {
            this.stats.recordFirstToken();
            this.stats.recordTokens(part.text);

            let deltaText = part.text;
            const { deltaText: processed } = this.processXmlDetection(deltaText);
            deltaText = processed;

            this._processTextDelta(deltaText);
        } else if (part.inlineData || part.inline_data) {
            this._processInlineData(part);
        }
    }

    _processTextDelta(deltaText) {
        const { displayText: thinkParsedText, thinkingDelta } =
            this.thinkTagParser.processDelta(deltaText);
        if (thinkingDelta) {
            this.thinkingContent += thinkingDelta;
            this.totalReceived += thinkingDelta.length;
            this.mergeContentPart('thinking', thinkingDelta);
        }

        const { parts: parsedParts, newBuffer } = parseStreamingMarkdownImages(
            thinkParsedText,
            this.markdownBuffer
        );
        this.markdownBuffer = newBuffer;

        for (const parsedPart of parsedParts) {
            if (parsedPart.type === 'text') {
                let textToAdd = parsedPart.text;
                const hasMediaParts = this.contentParts.some(
                    (p) => p.type === 'image_url' || p.type === 'video_url'
                );
                if (hasMediaParts) {
                    textToAdd = textToAdd.replace(/\[Image #\d+\]/g, '').trim();
                }
                if (textToAdd) {
                    this.textContent += textToAdd;
                    this.totalReceived += textToAdd.length;
                    this.mergeContentPart('text', textToAdd);
                }
            } else if (parsedPart.type === 'image_url') {
                this.contentParts.push(parsedPart);
                this.totalReceived += parsedPart.url.length;
            }
        }
    }

    _processInlineData(part) {
        const inlineData = part.inlineData || part.inline_data;
        const mimeType = inlineData.mimeType || inlineData.mime_type || '';

        if (
            typeof inlineData.data === 'string' &&
            inlineData.data.length < 200 &&
            !inlineData.data.includes('/')
        ) {
            logger.error('[Gemini] Code Execution 返回的是文件名而非 base64 数据!');
            const warningText = `\n无法显示图片 "${inlineData.data}"（后端返回了文件名而不是图片数据，请联系代理服务商修复）\n`;
            this.textContent += warningText;
            this.contentParts.push({ type: 'text', text: warningText });
        } else {
            const dataUrl = `data:${mimeType};base64,${inlineData.data}`;
            let mediaType;
            if (isVideoMimeType(mimeType)) mediaType = 'video_url';
            else if (isAudioMimeType(mimeType)) mediaType = 'audio_url';
            else mediaType = 'image_url';
            this.contentParts.push({ type: mediaType, url: dataUrl, complete: true, mimeType });
            this.totalReceived += inlineData.data.length;
        }
    }

    // ───── 截断检查 ─────

    _checkTruncation() {
        const hasMedia = this.contentParts.some(
            (p) => p.type === 'image_url' || p.type === 'video_url' || p.type === 'audio_url'
        );
        const limit = hasMedia ? MAX_IMAGE_RESPONSE_LENGTH : MAX_TEXT_RESPONSE_LENGTH;
        if (this.totalReceived <= limit) return false;

        if (hasMedia) {
            const mediaDataSize = this.contentParts
                .filter(
                    (p) =>
                        p.type === 'image_url' || p.type === 'video_url' || p.type === 'audio_url'
                )
                .reduce((sum, p) => sum + (p.url ? p.url.length : 0), 0);
            const textDataSize = this.totalReceived - mediaDataSize;
            if (textDataSize <= MAX_TEXT_RESPONSE_LENGTH) {
                logger.debug(
                    `媒体生成完成（媒体 ${(mediaDataSize / 1024 / 1024).toFixed(1)}MB + 文本 ${textDataSize.toLocaleString()} 字符）`
                );
                return false;
            }
        }
        return true;
    }

    // ───── 错误处理 ─────

    async _handleStreamError(error) {
        const errorCode = error.code;
        const errorMessage = error.message || 'Unknown error';
        logger.error(`Gemini API 错误 (流式响应):`, error);

        let userMessage = '';
        if (errorCode === 429) {
            userMessage = `请求过多 (429)：${errorMessage}\n请稍后再试或检查配额限制`;
        } else if (errorCode === 503) {
            userMessage = `服务暂时不可用 (503)：${errorMessage}\n请稍后重试`;
        } else if (errorCode === 500) {
            userMessage = `服务器内部错误 (500)：${errorMessage}`;
        } else {
            userMessage = `API 错误 (${errorCode}): ${errorMessage}`;
        }

        eventBus.emit('ui:notification', { message: userMessage, type: 'error', duration: 8000 });
        await this.reader.cancel();

        if (this.textContent || this.thinkingContent || this.contentParts.length > 0) {
            this.finalizeStreamWithError(
                errorCode,
                errorMessage,
                {
                    thoughtSignature: this.thoughtSignature,
                    groundingMetadata: this.groundingMetadata
                },
                this.groundingMetadata
            );
        }
    }

    _finalize() {
        this.finalizeStream(
            {
                thoughtSignature: this.thoughtSignature,
                groundingMetadata: this.groundingMetadata
            },
            this.groundingMetadata
        );
    }
}

/**
 * 解析 Gemini 流式响应（保持原有导出签名）
 */
export async function parseGeminiStream(reader, sessionId = null) {
    const parser = new GeminiStreamParser(sessionId);
    await parser.parse(reader);
}
