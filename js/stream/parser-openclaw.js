/**
 * OpenClaw 事件流处理器
 * 处理 OpenClaw WebSocket 事件，驱动流式渲染
 */

import { logger } from '../utils/logger.js';
import { eventBus } from '../core/events.js';
import { state } from '../core/state.js';
import { StreamStats } from './stats.js';
import {
    buildPartsFromStreamingState,
    buildMetaFromStreamingState
} from '../messages/parts-builder.js';
import { openclawClient } from '../api/openclaw.js';
import { ThinkTagParser } from './think-tag-parser.js';
import { ToolMode } from '../messages/schema.js';
import { DefaultSink } from './sink.js';
import { generateIdSet } from '../api/format-converter.js';
import { renderHumanizedError } from '../utils/errors.js';
import { STREAM_IDLE_TIMEOUT_DEFAULT } from '../utils/constants.js';

/**
 * 处理 OpenClaw 的流式事件
 * 由 handler.js 在 openclaw 格式下调用
 *
 * @param {string} sessionId
 * @param {import('./sink.js').StreamSink} [sink] - 输出 sink，缺省走 DefaultSink(sessionId)
 * @param {AbortSignal|null} [signal] - 用户取消信号；abort 时清理 eventBus listener + 失败 WS run
 */
export async function handleOpenClawStream(sessionId, sink = null, signal = null) {
    sink = sink || new DefaultSink(sessionId);

    let textContent = '';
    let thinkingContent = ''; // 运行时变量，非旧格式字段
    const thinkTagParser = new ThinkTagParser();
    const collectedToolCalls = [];
    let hasToolCalls = false;
    const stats = new StreamStats();

    // 事件监听器引用，用于清理
    const listeners = [];

    function addListener(event, handler) {
        eventBus.on(event, handler);
        listeners.push({ event, handler });
    }

    function removeAllListeners() {
        for (const { event, handler } of listeners) {
            eventBus.off(event, handler);
        }
        listeners.length = 0;
    }

    return new Promise((resolve, reject) => {
        let abortListener = null;
        let settled = false;
        let idleTimerId = null;
        const idleTimeoutMs =
            typeof state.streamIdleTimeout === 'number' && state.streamIdleTimeout > 0
                ? state.streamIdleTimeout
                : STREAM_IDLE_TIMEOUT_DEFAULT;
        const cleanup = () => {
            removeAllListeners();
            if (idleTimerId) {
                clearTimeout(idleTimerId);
                idleTimerId = null;
            }
            if (abortListener && signal) {
                signal.removeEventListener('abort', abortListener);
                abortListener = null;
            }
        };
        const settle = (fn) => {
            if (settled) return;
            settled = true;
            cleanup();
            fn();
        };

        // 错误收尾统一入口 — 走 sink.commitError 让消息标记 isError + 携 errorHtml，
        // 与 base-parser.finalizeStreamWithError 路径对称：已接收内容保留渲染 + append 错误块
        const settleWithStreamError = (errorCode, errorMessage, settleFn) => {
            settle(() => {
                logger.error(`[OpenClaw Parser] 流错误 (${errorCode}):`, errorMessage);

                if (state.isToolCallPending) state.isToolCallPending = false;
                stats.finalize();

                const remaining = thinkTagParser.flush();
                if (remaining.thinkingDelta) thinkingContent += remaining.thinkingDelta;
                if (remaining.displayText) textContent += remaining.displayText;

                if (textContent || thinkingContent) {
                    sink.renderFinalText(textContent, thinkingContent);
                }

                const errorObject = { code: errorCode, message: errorMessage, type: errorCode };
                const errorHtml =
                    renderHumanizedError(errorObject, errorCode, true) +
                    `<div class="stream-error-partial-save">\u{1F4BE} 已保存部分接收的内容</div>`;
                sink.renderError(errorHtml);

                stats.recalculateTokenCount({ textContent, thinkingContent, contentParts: [] });
                sink.appendStats(stats);

                sink.commitError(
                    buildPartsFromStreamingState({
                        textContent,
                        thinkingContent,
                        signatureFormat: 'claude'
                    }),
                    buildMetaFromStreamingState({ streamStats: stats.getData() }),
                    {},
                    { errorCode, errorMessage, errorHtml, partialContent: textContent }
                );

                settleFn();
            });
        };

        // WS 哨兵返回后 handler 已清 fetch 超时与 sendLock，服务端 run 挂死会永久
        // loading — 以 frame 间隔计时兜底，语义与 base-parser 的 idle timeout 对齐
        const resetIdleTimer = () => {
            if (idleTimerId) clearTimeout(idleTimerId);
            if (settled) return;
            idleTimerId = setTimeout(() => {
                const errorMessage = `流式响应空闲超时（${idleTimeoutMs}ms 无新数据）`;
                settleWithStreamError('idle_timeout', errorMessage, () => {
                    openclawClient.failRun(new DOMException(errorMessage, 'TimeoutError'));
                    // 与 base-parser idle_timeout 一致：commitError 已落库并发 stream:error，
                    // reject 会再触发 generic handler 双重落库并覆盖已渲染内容
                    resolve();
                });
            }, idleTimeoutMs);
        };

        // chat.delta - 流式文本/思维链
        addListener('openclaw:chat-delta', (payload) => {
            resetIdleTimer();
            if (!payload) return;

            const { delta, type: deltaType } = payload;

            if (deltaType === 'thinking' || deltaType === 'reasoning') {
                thinkingContent += delta || '';
                stats.recordTokens(delta || '');
                sink.streamingUpdate(textContent, thinkingContent);
            } else {
                const text = delta || payload.text || payload.content || '';
                if (!text) return;

                stats.recordFirstToken();
                stats.recordTokens(text);

                const { displayText, thinkingDelta } = thinkTagParser.processDelta(text);
                if (thinkingDelta) thinkingContent += thinkingDelta;
                if (displayText) textContent += displayText;

                sink.streamingUpdate(textContent, thinkingContent);
            }
        });

        // agent.event - 工具调用、屏幕截图等
        addListener('openclaw:agent-event', (payload) => {
            resetIdleTimer();
            if (!payload) return;

            switch (payload.type) {
                case 'tool_call': {
                    hasToolCalls = true;
                    const tc = payload.data || {};
                    let args;
                    try {
                        args =
                            typeof tc.arguments === 'string'
                                ? JSON.parse(tc.arguments)
                                : typeof tc.function?.arguments === 'string'
                                  ? JSON.parse(tc.function.arguments)
                                  : tc.arguments || tc.function?.arguments || {};
                    } catch {
                        args = {};
                    }
                    // OpenClaw 永远走原生协议（无 XML 注入路径）
                    // OpenClaw 网关返回 OpenAI 兼容 id（call_*），按 openai 槽预生成 idMap
                    const tcId = tc.id || `oc_tc_${Date.now()}`;
                    collectedToolCalls.push({
                        id: tcId,
                        name: tc.name || tc.function?.name,
                        arguments: args,
                        mode: ToolMode.NATIVE,
                        idMap: generateIdSet(tcId, 'openai')
                    });
                    break;
                }
                case 'tool_result':
                    break;
                case 'screen_capture':
                    eventBus.emit('openclaw:screen-capture', payload.data);
                    break;
                default:
                    logger.debug('[OpenClaw Parser] 未知 agent 事件:', payload.type);
            }
        });

        // chat.done - 完成
        addListener('openclaw:chat-done', () => {
            settle(() => {
                // 处理 <think> 标签剩余内容
                const remaining = thinkTagParser.flush();
                if (remaining.thinkingDelta) thinkingContent += remaining.thinkingDelta;
                if (remaining.displayText) textContent += remaining.displayText;

                // 如果有工具调用
                if (hasToolCalls && collectedToolCalls.length > 0) {
                    if (textContent || thinkingContent) {
                        sink.renderFinalText(textContent, thinkingContent);
                    }

                    sink.commit(
                        buildPartsFromStreamingState({
                            textContent: textContent || '(调用工具)',
                            thinkingContent,
                            toolCalls: collectedToolCalls,
                            signatureFormat: 'claude'
                        }),
                        buildMetaFromStreamingState({
                            streamStats: stats.getPartialData()
                        }),
                        { toolCalls: collectedToolCalls }
                    );

                    sink.triggerToolCalls(collectedToolCalls);

                    resolve();
                    return;
                }

                // 无工具调用，正常完成
                finalizeOpenClawStream(textContent, thinkingContent, sessionId, stats, sink);
                openclawClient.completeRun({ done: true });
                resolve();
            });
        });

        // 错误事件 — 不用 finalizeOpenClawStream 把错误消息当正常 commit 保存
        addListener('openclaw:error', (payload) => {
            const errorCode = payload?.code || 'openclaw_error';
            const errorMessage = payload?.message || '未知错误';
            settleWithStreamError(errorCode, errorMessage, () => {
                openclawClient.failRun(new Error(errorMessage));
                reject(new Error(errorMessage));
            });
        });

        // WS 异常断开 — openclaw.js _setupMessageHandler.onclose 会触发
        // openclaw:disconnected 事件并 reject activeRunReject；如果 parser 此时仍
        // 挂着 5 个 listener 且没收到 chat.done/error，listener 会永久驻留，被多次
        // 重试污染 eventBus。订阅 disconnected 让 settle 也走清理路径
        addListener('openclaw:disconnected', (payload) => {
            settle(() => {
                const reason = payload?.reason || 'WebSocket disconnected';
                logger.warn('[OpenClaw Parser] 连接断开，清理 listener:', reason);
                const disconnectErr = new Error(reason);
                disconnectErr.name = 'OpenClawDisconnectedError';
                reject(disconnectErr);
            });
        });

        // abort 信号 — 清理 listener 防止后续 WS 事件触发已 settled 流程，
        // 同时让 openclawClient 取消 run；抛 AbortError 与 base-parser F9 对称
        if (signal) {
            if (signal.aborted) {
                settle(() => {
                    openclawClient.failRun(new Error('Aborted'));
                    const abortErr = new Error('Stream aborted by user');
                    abortErr.name = 'AbortError';
                    reject(abortErr);
                });
                return;
            }
            abortListener = () => {
                // 已接收内容非空时以「已取消」标记落库，partialSaved 让 user-abort
                // handler 跳过 DOM 覆盖 — 与 base-parser.commitAbortedPartial 语义对齐
                if (textContent || thinkingContent) {
                    settleWithStreamError('user_cancelled', '请求已取消', () => {
                        openclawClient.failRun(new Error('Aborted'));
                        const abortErr = new Error('Stream aborted by user');
                        abortErr.name = 'AbortError';
                        abortErr.partialSaved = true;
                        reject(abortErr);
                    });
                } else {
                    settle(() => {
                        openclawClient.failRun(new Error('Aborted'));
                        const abortErr = new Error('Stream aborted by user');
                        abortErr.name = 'AbortError';
                        reject(abortErr);
                    });
                }
            };
            signal.addEventListener('abort', abortListener, { once: true });
        }

        resetIdleTimer();
    });
}

/**
 * 完成 OpenClaw 流处理
 */
function finalizeOpenClawStream(textContent, thinkingContent, sessionId, stats, sink) {
    if (state.isToolCallPending) {
        state.isToolCallPending = false;
    }

    stats.finalize();

    if (textContent || thinkingContent) {
        sink.renderFinalText(textContent, thinkingContent);
    }

    stats.recalculateTokenCount({ textContent, thinkingContent, contentParts: [] });
    sink.appendStats(stats);

    sink.commit(
        buildPartsFromStreamingState({
            textContent,
            thinkingContent,
            signatureFormat: 'claude'
        }),
        buildMetaFromStreamingState({ streamStats: stats.getData() }),
        {}
    );
}
