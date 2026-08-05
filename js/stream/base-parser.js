/**
 * 流解析器基类
 * 提取三个格式解析器（OpenAI/Claude/Gemini）的公共逻辑
 */

import { logger } from '../utils/logger.js';
import { StreamStats } from './stats.js';
import { cleanupAllIncompleteImages } from './helpers.js';
import {
    buildPartsFromStreamingState,
    buildMetaFromStreamingState
} from '../messages/parts-builder.js';
import { eventBus } from '../core/events.js';
import { renderHumanizedError } from '../utils/errors.js';
import { parseStreamingMarkdownImages } from '../utils/markdown-image-parser.js';
import { XMLStreamAccumulator } from '../tools/xml-formatter.js';
import { state } from '../core/state.js';
import { ThinkTagParser } from './think-tag-parser.js';
import { ToolMode } from '../messages/schema.js';
import { DefaultSink } from './sink.js';

// 响应长度限制
const MAX_RESPONSE_LENGTH = 200000;

// 流式空闲超时（每次 chunk 之间的最长无数据间隔）。
// state.requestTimeout 只保护连接 + headers 阶段（fetch abort），
// 一旦 headers 到达就清掉；token 阶段慢/卡死/代理 silent drop 完全无防御。
// 默认从 state.streamIdleTimeout 读取（用户偏好），子类可通过 get idleTimeout() 覆盖
const FALLBACK_IDLE_TIMEOUT = 120000;

/**
 * 流解析器基类，封装公共的流读取、缓冲、finalize 逻辑
 */
export class BaseStreamParser {
    /**
     * @param {string|null} sessionId
     * @param {import('./sink.js').StreamSink} [sink] - 输出 sink，缺省时构造 DefaultSink(sessionId)
     */
    constructor(sessionId = null, sink = null) {
        this.sessionId = sessionId;
        this.sink = sink || new DefaultSink(sessionId);
        this.decoder = new TextDecoder();
        this.buffer = '';
        this.textContent = '';
        this.thinkingContent = ''; // 运行时变量，非旧格式字段
        this.contentParts = []; // 运行时变量，非旧格式字段
        this.totalReceived = 0;
        this.markdownBuffer = '';

        // signature 来源标识（子类 override：'claude' | 'gemini' | 'openai'）
        // commit 路径自动注入到 streamingState.signatureFormat，parts-builder 写入 thinking part
        this.signatureFormat = null;

        this.stats = new StreamStats();

        // XML 工具调用
        // 构造时冻结当前 toggle，整个流期间只读 this.xmlMode，禁止运行中切换
        this.xmlMode = state.xmlToolCallingEnabled;
        this.xmlToolCallAccumulator = new XMLStreamAccumulator();
        this.xmlParsingDisabled = false;

        // <think> 标签解析器
        this.thinkTagParser = new ThinkTagParser();
    }

    /** 响应长度上限，子类可覆盖 */
    get maxResponseLength() {
        return MAX_RESPONSE_LENGTH;
    }

    /** 流式空闲超时，子类可覆盖。state.requestTimeout 走 fetch abort 只保护连接阶段 */
    get idleTimeout() {
        // 用户偏好优先（设置面板可调），用于 reasoning 模型场景调高 / 弱网调低
        if (typeof state.streamIdleTimeout === 'number' && state.streamIdleTimeout > 0) {
            return state.streamIdleTimeout;
        }
        return FALLBACK_IDLE_TIMEOUT;
    }

    /**
     * 主循环：读取流 → 按行处理 → finalize
     * @param {ReadableStreamDefaultReader} reader
     * @param {AbortSignal} [signal] - 可选取消信号；abort 时主动 cancel reader 让 read() 立即 reject
     */
    async parse(reader, signal = null) {
        let abortListener = null;
        if (signal && typeof signal.addEventListener === 'function') {
            if (signal.aborted) {
                try {
                    await reader.cancel();
                } catch (_e) {
                    /* reader 已释放 */
                }
            } else {
                abortListener = () => {
                    reader.cancel().catch(() => {
                        /* reader 已释放或已 cancel */
                    });
                };
                signal.addEventListener('abort', abortListener, { once: true });
            }
        }

        // 单点抛 AbortError 让 done=true 后 / 单行处理前 / 单行处理后三处共享
        const throwIfAborted = () => {
            if (signal && signal.aborted) {
                const abortErr = new Error('Stream aborted by user');
                abortErr.name = 'AbortError';
                throw abortErr;
            }
        };

        try {
            while (true) {
                let idleTimerId = null;
                let chunk;
                try {
                    // race read 和 idle timeout：超过 idleTimeout 无数据触发 TimeoutError
                    // 让代理 silent drop / 服务端卡死 / slow-loris 场景能主动 abort 兜底
                    chunk = await new Promise((resolve, reject) => {
                        idleTimerId = setTimeout(() => {
                            reader.cancel().catch(() => {});
                            reject(
                                new DOMException(
                                    `流式响应空闲超时（${this.idleTimeout}ms 无新数据）`,
                                    'TimeoutError'
                                )
                            );
                        }, this.idleTimeout);
                        reader.read().then(resolve, reject);
                    });
                } catch (readErr) {
                    if (idleTimerId) clearTimeout(idleTimerId);
                    if (readErr.name === 'AbortError') throw readErr;
                    // 网络断 / idle timeout / 其他 read 异常：持久化已收 token 走 ERROR 落库,
                    // 避免数据全丢；之前未捕获会直接冒泡到 handler.handleSendError 走通用错误路径
                    this._handleStreamReadError(readErr);
                    return;
                }
                if (idleTimerId) clearTimeout(idleTimerId);

                const { done, value } = chunk;
                if (done) break;

                this.buffer += this.decoder.decode(value, { stream: true });
                const lines = this.buffer.split('\n');
                this.buffer = lines.pop() || '';

                for (const line of lines) {
                    // 长 lines 数组内 await processLine 期间 abort 不会自动打断 — 每行
                    // 处理前后显式检查 signal.aborted，让用户取消能在 ms 级生效而非
                    // 等所有 processLine 跑完才看到取消
                    throwIfAborted();
                    // 子类处理每一行，返回 true 表示流应该终止
                    const shouldReturn = await this.processLine(line);
                    if (shouldReturn) return;
                    throwIfAborted();
                }
            }

            const trailingLine = this.buffer + this.decoder.decode();
            this.buffer = '';
            if (trailingLine.trim()) {
                throwIfAborted();
                const shouldReturn = await this.processLine(trailingLine);
                if (shouldReturn) return;
                throwIfAborted();
            }

            // abort 触发的 reader.cancel 也会让 read() 返回 {done:true} 正常退出循环 —
            // 必须在此显式区分"用户取消"vs"服务端自然 EOF"，否则会走 onStreamEnd → commit
            // 把半截内容当成功消息保存，与 handler.js 期望的 AbortError 分支语义冲突
            throwIfAborted();

            // 空响应兜底：代理返回 HTML 错误页伪装 200 时所有 SSE 行都不匹配解析,
            // textContent/thinkingContent/contentParts 全空 → onStreamEnd 落空消息让用户
            // 看到 0 token 不知发生什么。空响应直接走 ERROR 提示「响应内容为空」。
            // 纯 tool_call 流（input_json_delta / function_call_arguments.delta 不累加 totalReceived）
            // 通过 hasOngoingToolStream() hook 排除：子类必须 override 申报自己的工具累积状态
            if (
                !this.textContent &&
                !this.thinkingContent &&
                this.contentParts.length === 0 &&
                this.totalReceived === 0 &&
                !this.hasOngoingToolStream()
            ) {
                this._handleStreamReadError(
                    new Error('收到非 SSE 响应（可能是代理错误页 / HTML 内容）'),
                    'empty_response'
                );
                return;
            }

            // 流自然结束，子类执行收尾
            await this.onStreamEnd();
        } catch (err) {
            // 用户主动取消（非 timeout reason abort）时把已接收内容落库为「已取消」消息，
            // partialSaved 标记让 user-abort handler 跳过 DOM 覆盖与重复状态机操作
            if (err?.name === 'AbortError' && signal?.reason?.name !== 'TimeoutError') {
                err.partialSaved = this.commitAbortedPartial();
            }
            throw err;
        } finally {
            if (signal && abortListener) {
                signal.removeEventListener('abort', abortListener);
            }
            try {
                reader.releaseLock();
            } catch (_e) {
                console.debug('Reader lock already released:', _e);
            }
        }
    }

    /**
     * 处理 reader.read() 抛出的异常（网络断 / idle timeout / 其他）。
     *
     * 之前未捕获让异常直接冒泡到 handler.handleSendError 走通用错误路径，
     * 已接收的 textContent/thinkingContent 不被持久化全部丢失。
     * 此 helper 统一调 finalizeStreamWithError 落 ERROR 消息保留部分内容。
     *
     * 收尾流程依次调用：syncBeforeFinalize（子类同步运行时字段）→
     * beforeTruncationFinalize（刷 thinkTagParser 等）→ collectExtraSaveFields
     * （子类申报落库字段）→ getGroundingMetadata（搜索引用透传）。
     * 任一 hook 抛错都走 logger.error 不静默吞，防止 Claude flush 失败丢最后段 thinking。
     */
    _handleStreamReadError(err, errorCodeOverride = null) {
        const isTimeout = err?.name === 'TimeoutError';
        const errorCode = errorCodeOverride || (isTimeout ? 'idle_timeout' : 'network_error');
        const errorMessage = isTimeout
            ? err.message
            : errorCodeOverride === 'empty_response'
              ? err.message || '响应内容为空'
              : `流式响应中断: ${err?.message || String(err)}`;

        try {
            this.syncBeforeFinalize();
            this.beforeTruncationFinalize();
        } catch (flushErr) {
            logger.error('[BaseStreamParser] finalize 前收尾失败:', flushErr);
        }
        // read() 抛错路径（idle timeout/网络断）下，子类已累积的 thinkingBlocks/reasoningItems
        // 等多块结构必须透传给 buildPartsFromStreamingState；否则 fallback 把多段 thinking
        // 合并成一段，下轮 retry Claude 触发 'thinking blocks modified' 400 / OpenAI Responses
        // 触发 reasoning_id_not_found 400
        const extra = this._collectExtraSaveFields();
        const grounding = this.getGroundingMetadata();
        this.finalizeStreamWithError(errorCode, errorMessage, extra, grounding);
    }

    /**
     * 用户取消时保存已接收的部分内容（parse 的 AbortError 路径专用）。
     *
     * 有内容时复用 finalizeStreamWithError 机制以「已取消」标记落库：
     * DOM 保留已渲染内容并在末尾 append 取消提示（与 restore 渲染的 append 语义一致）；
     * 无内容返回 false，由 user-abort handler 维持整体「请求已取消」提示。
     * @returns {boolean} 是否执行了部分保存
     */
    commitAbortedPartial() {
        try {
            this.syncBeforeFinalize();
            this.beforeTruncationFinalize();
        } catch (flushErr) {
            logger.error('[BaseStreamParser] 取消前收尾失败:', flushErr);
        }
        if (!this.textContent && !this.thinkingContent && this.contentParts.length === 0) {
            return false;
        }
        const extra = this._collectExtraSaveFields();
        const grounding = this.getGroundingMetadata();
        this.finalizeStreamWithError('user_cancelled', '请求已取消', extra, grounding);
        return true;
    }

    /**
     * 子类申报落库 extra 字段的内部统一入口。
     * 走 collectExtraSaveFields() hook 收集后过滤空值（空数组/空字符串/null/undefined）,
     * 全空返回 undefined（与原契约一致：finalizeStream 据此跳过 extras 透传）
     */
    _collectExtraSaveFields() {
        const raw = this.collectExtraSaveFields();
        if (!raw || typeof raw !== 'object') return undefined;
        const filtered = {};
        for (const [k, v] of Object.entries(raw)) {
            if (v === undefined || v === null) continue;
            if (Array.isArray(v) && v.length === 0) continue;
            if (typeof v === 'string' && v === '') continue;
            filtered[k] = v;
        }
        return Object.keys(filtered).length > 0 ? filtered : undefined;
    }

    /**
     * 子类必须实现 processLine / onStreamEnd 两个抽象方法。
     *
     * 新增 parser 子类时，除上述两方法外按需 override 以下 protected hook
     * （详见各方法 JSDoc）：
     *   - hasOngoingToolStream()         原生工具流必须 override，否则纯工具响应被空响应兜底误判走 ERROR
     *   - collectExtraSaveFields()       格式专属落库字段（reasoning / thinking / grounding 等）
     *   - getGroundingMetadata()         Gemini-like grounding 必须 override
     *   - syncBeforeFinalize()           finalize 前需把运行时字段同步到 streamingState 的场景必须 override
     *   - buildStreamErrorUserMessage()  自定义错误码 → 用户提示文案
     *   - getStreamErrorExtraFields()    错误路径附加字段（默认复用 collectExtraSaveFields）
     */
    // eslint-disable-next-line no-unused-vars
    async processLine(line) {
        throw new Error('子类必须实现 processLine()');
    }

    async onStreamEnd() {
        throw new Error('子类必须实现 onStreamEnd()');
    }

    // ───── 公共工具方法 ─────

    /**
     * 流结束时排空 XML 累积器的 partial-tag 残留
     * 仅工具调用流需要补尾：textContent 此时按 displayText 差值消费，
     * 截留在 buffer 的尾部文本不补会丢失；非工具流走原文透传，全文已在 textContent。
     * hasEverCompleted 而非 completedCalls：getCompletedCalls 在 [DONE]/message_stop
     * 处理时已清空数组。startsWith 守卫：透传/差值混合流下两轨坐标会错位（如 <think>
     * 标签被 thinkTagParser 抽走），错位时补尾会重复已渲染文本，只在前缀契约成立时动作
     */
    flushXmlAccumulator() {
        if (!this.xmlMode || this.xmlParsingDisabled) return;
        try {
            const acc = this.xmlToolCallAccumulator;
            const hadToolCalls = acc.hasEverCompleted || acc.completedCalls.length > 0;
            const finalText = acc.flush();
            if (!hadToolCalls) return;
            if (!finalText.startsWith(this.textContent)) return;
            const tail = finalText.substring(this.textContent.length);
            if (tail) this.processThinkAndMarkdown(tail);
        } catch (error) {
            logger.error('[Parser] XML 累积器 flush 异常:', error);
        }
    }

    /**
     * XML 工具调用检测（处理 text delta）
     * @param {string} deltaText - 原始文本增量
     * @returns {{ deltaText: string, hasXML: boolean, xmlParseResult: object|null }}
     */
    processXmlDetection(deltaText) {
        if (!this.xmlMode || this.xmlParsingDisabled) {
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
        // 同一 chunk 内 thinking 与正文的先后由进入时的解析状态决定：
        // 已在 <think> 内则 thinking 段在前，否则正文在前，保证 contentParts 顺序与模型输出一致
        const wasInsideThink = this.thinkTagParser.isInsideThink;
        const { displayText: thinkParsedText, thinkingDelta } =
            this.thinkTagParser.processDelta(deltaText);

        const appendThinkingDelta = () => {
            if (!thinkingDelta) return;
            this.appendThinking(thinkingDelta);
            this.totalReceived += thinkingDelta.length;
            this.mergeContentPart('thinking', thinkingDelta);
        };

        if (wasInsideThink) appendThinkingDelta();

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

        if (!wasInsideThink) appendThinkingDelta();
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
     * 流式增量 UI 通知 — 单流走全局 updateStreamingMessage，多流由 BufferedSink 静音
     */
    notifyStreaming(text, thinking) {
        this.sink.streamingUpdate(text, thinking);
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

    // ───── Protected Hooks（子类按需 override，禁止读子类私有字段） ─────

    /**
     * 是否存在已累积的原生工具调用流（用于空响应判定排除纯 tool_call 场景）。
     * 基类默认只判 XML 累积器（base 自有字段 xmlToolCallAccumulator.completedCalls）。
     * 子类涉及原生工具调用必须 super.hasOngoingToolStream() 并追加本格式工具累积判定，
     * 否则纯原生工具流（无 textContent）会被空响应兜底误判走 ERROR。
     * @returns {boolean}
     */
    hasOngoingToolStream() {
        const xml = this.xmlToolCallAccumulator;
        return !!(xml && Array.isArray(xml.completedCalls) && xml.completedCalls.length > 0);
    }

    /**
     * 子类申报需随 finalize / finalizeStreamWithError / executeToolCalls 落库的格式专属字段。
     * 基类默认空对象。返回值会经 _collectExtraSaveFields 过滤空字段。
     *
     * 注意：被三处出口共用，子类 override 时必须保证字段在所有调用时机都已初始化。
     * @returns {object}
     */
    collectExtraSaveFields() {
        return {};
    }

    /**
     * Gemini-like grounding metadata 透传：返回搜索引用数据让 base
     * 在所有错误路径（idle_timeout / network_error / empty_response）下
     * 自动透传给 sink.finalizeStreamWithError 第 4 参。
     * 基类默认 null。Gemini 子类 override 返回 this.groundingMetadata。
     * @returns {object | null}
     */
    getGroundingMetadata() {
        return null;
    }

    /**
     * finalize 出口前同步运行时字段的钩子。
     * 基类默认 no-op。Claude 子类 override 把 mergedThinking 写回 thinkingContent,
     * 避免 buildPartsFromStreamingState 读到旧值导致下轮 retry 触发 thinking blocks 校验失败。
     */
    syncBeforeFinalize() {
        // 默认无需同步
    }

    /**
     * 流错误时面向用户的提示文案。基类默认 `API 错误 (code): message`。
     * 子类 override 加自家错误码翻译（如 OpenAI 的 context_length_exceeded、
     * Claude 的 overloaded_error、Gemini 的 RESOURCE_EXHAUSTED）。
     * @param {string|number} errorCode
     * @param {string} errorMessage
     * @returns {string}
     */
    buildStreamErrorUserMessage(errorCode, errorMessage) {
        return `API 错误 (${errorCode}): ${errorMessage}`;
    }

    /**
     * 流错误落库时的 extra 字段，默认复用 collectExtraSaveFields()。
     * 子类如需在错误路径附加额外字段（如 Claude 把 serverToolCalls Map 转 Array）
     * 可单独 override 而不影响正常 finalize 路径。
     * @returns {object}
     */
    getStreamErrorExtraFields() {
        return this.collectExtraSaveFields();
    }

    /**
     * 收集流式中间状态为一个 reply 对象（multi-stream.js 多回复模式从 parser 实例提取结果用）。
     * 子类覆盖以补充格式特有字段（thinkingBlocks / thoughtSignature / encryptedContent 等）。
     *
     * @returns {Object} reply 对象 — content/thinkingContent/contentParts/toolCalls/stats + 子类扩展字段
     */
    collectReply() {
        const reply = {
            content: this.textContent,
            thinkingContent: this.thinkingContent || null,
            contentParts: this.contentParts.length > 0 ? this.contentParts : null,
            stats: this.stats,
            // signatureFormat 透传到 multi-stream → buildPartsFromReply → thinking part
            // 多回复模式下每个流独立 parser 实例，signatureFormat 由各家子类 override
            signatureFormat: this.signatureFormat
        };
        // 多流模式下 BufferedSink 拦截的工具调用透传到 reply，由 multi-stream 落库为
        // tool_call part 保留会话历史；否则用户看不到模型尝试调用什么工具
        const skipped = this.sink?.skippedToolCalls;
        if (Array.isArray(skipped) && skipped.length > 0) {
            reply.toolCalls = skipped;
        }
        return reply;
    }

    // ───── finalize 公共逻辑 ─────

    /**
     * 正常完成流处理（公共骨架）
     * @param {Object} extraSaveFields - 格式特有的保存字段（如 thoughtSignature, thinkingBlocks 等）
     * @param {Object} groundingMetadata - 搜索引用元数据（Gemini 用）
     */
    finalizeStream(extraSaveFields = {}, groundingMetadata = null) {
        if (state.isToolCallPending) {
            state.isToolCallPending = false;
        }

        // 所有正常 commit 路径（[DONE]/message_stop/自然 EOF）的汇聚点，
        // 在此排空 XML 累积器残留才能覆盖 processLine 提前 return 的格式
        this.flushXmlAccumulator();

        this.stats.finalize();
        cleanupAllIncompleteImages(this.contentParts);

        if (this.contentParts.length > 0) {
            this.sink.renderFinalContent(
                this.contentParts,
                this.thinkingContent,
                groundingMetadata
            );
        } else if (this.textContent || this.thinkingContent) {
            this.sink.renderFinalText(this.textContent, this.thinkingContent, groundingMetadata);
        }

        this.stats.recalculateTokenCount({
            textContent: this.textContent,
            thinkingContent: this.thinkingContent,
            contentParts: this.contentParts
        });
        this.sink.appendStats(this.stats);

        const streamingState = {
            textContent: this.textContent,
            thinkingContent: this.thinkingContent,
            contentParts: this.contentParts,
            signatureFormat: this.signatureFormat,
            ...extraSaveFields
        };
        const metaExtras = {
            streamStats: this.stats.getData(),
            groundingMetadata,
            ...extraSaveFields
        };
        this.sink.commit(
            buildPartsFromStreamingState(streamingState),
            buildMetaFromStreamingState(metaExtras),
            {}
        );
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
        this.flushXmlAccumulator();
        this.stats.finalize();
        cleanupAllIncompleteImages(this.contentParts);

        const errorObject = { code: errorCode, message: errorMessage, type: errorCode };
        const errorHtml =
            renderHumanizedError(errorObject, errorCode, true) +
            `<div class="stream-error-partial-save">\u{1F4BE} 已保存部分接收的内容</div>`;

        const finalText = this.textContent + '\n\n' + errorMessage;

        if (!this.sink.isBackground()) {
            if (this.contentParts.length > 0) {
                this.sink.renderFinalContent(
                    this.contentParts,
                    this.thinkingContent,
                    groundingMetadata
                );
            } else if (this.textContent || this.thinkingContent) {
                this.sink.renderFinalText(
                    this.textContent,
                    this.thinkingContent,
                    groundingMetadata
                );
            }

            // 错误 HTML 由 sink 决定渲染目标：DefaultSink 注入当前 assistant DOM；BufferedSink no-op
            this.sink.renderError(errorHtml);

            this.stats.recalculateTokenCount({
                textContent: finalText,
                thinkingContent: this.thinkingContent,
                contentParts: this.contentParts
            });
            this.sink.appendStats(this.stats);
        }

        const streamingState = {
            textContent: finalText,
            thinkingContent: this.thinkingContent,
            contentParts: this.contentParts,
            signatureFormat: this.signatureFormat,
            ...extraSaveFields
        };
        const metaExtras = {
            streamStats: this.stats.getData(),
            groundingMetadata,
            ...extraSaveFields
        };
        this.sink.commitError(
            buildPartsFromStreamingState(streamingState),
            buildMetaFromStreamingState(metaExtras),
            {},
            { errorCode, errorMessage, errorHtml, partialContent: this.textContent }
        );

        if (!this.sink.isBackground() && state.isToolCallPending) {
            state.isToolCallPending = false;
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
            this.sink.renderFinalContent(this.contentParts, this.thinkingContent);
        } else if (this.textContent || this.thinkingContent) {
            this.sink.renderFinalText(this.textContent, this.thinkingContent);
        }

        // 给本流期间产生的工具调用打上 mode 标记（来自构造时冻结的 xmlMode）。
        // 子类如已显式打 mode，保留其值；否则按 parser 实例的 xmlMode 派生。
        const callMode = this.xmlMode ? ToolMode.XML : ToolMode.NATIVE;
        const callsWithMode = completedCalls.map((tc) => ({
            ...tc,
            mode: tc.mode || callMode
        }));

        const streamingState = {
            textContent: this.textContent || '(调用工具)',
            thinkingContent: this.thinkingContent,
            contentParts: this.contentParts,
            toolCalls: callsWithMode,
            signatureFormat: this.signatureFormat,
            ...extraSaveFields
        };
        const metaExtras = {
            streamStats: this.stats.getPartialData(),
            ...extraSaveFields
        };
        this.sink.commit(
            buildPartsFromStreamingState(streamingState),
            buildMetaFromStreamingState(metaExtras),
            { toolCalls: callsWithMode }
        );

        this.sink.triggerToolCalls(callsWithMode);
    }
}

// 不再 re-export 子模块符号，子类应从源模块直接 import
