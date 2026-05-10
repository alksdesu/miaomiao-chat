/**
 * OpenClaw 事件流处理器
 * 处理 OpenClaw WebSocket 事件，驱动流式渲染
 */

import { logger } from '../utils/logger.js';
import { eventBus } from '../core/events.js';
import { state } from '../core/state.js';
import { setIsToolCallPending } from '../core/state-mutations.js';
import { updateStreamingMessage, renderFinalTextWithThinking } from './helpers.js';
import { StreamStats, appendStreamStats } from './stats.js';
import { saveAssistantMessage } from '../messages/sync.js';
import { setCurrentMessageIndex } from '../messages/dom-sync.js';
import { openclawClient } from '../api/openclaw.js';
import { ThinkTagParser } from './think-tag-parser.js';
import { handleToolCallStream } from './tool-call-handler.js';

/**
 * 处理 OpenClaw 的流式事件
 * 由 handler.js 在 openclaw 格式下调用
 */
export async function handleOpenClawStream(sessionId) {
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
        // chat.delta - 流式文本/思维链
        addListener('openclaw:chat-delta', (payload) => {
            if (!payload) return;

            const { delta, type: deltaType } = payload;

            if (deltaType === 'thinking' || deltaType === 'reasoning') {
                thinkingContent += delta || '';
                stats.recordTokens(delta || '');
                updateStreamingMessage(textContent, thinkingContent);
            } else {
                const text = delta || payload.text || payload.content || '';
                if (!text) return;

                stats.recordFirstToken();
                stats.recordTokens(text);

                const { displayText, thinkingDelta } = thinkTagParser.processDelta(text);
                if (thinkingDelta) thinkingContent += thinkingDelta;
                if (displayText) textContent += displayText;

                updateStreamingMessage(textContent, thinkingContent);
            }
        });

        // agent.event - 工具调用、屏幕截图等
        addListener('openclaw:agent-event', (payload) => {
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
                    collectedToolCalls.push({
                        id: tc.id || `oc_tc_${Date.now()}`,
                        name: tc.name || tc.function?.name,
                        arguments: args
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
            removeAllListeners();

            // 处理 <think> 标签剩余内容
            const remaining = thinkTagParser.flush();
            if (remaining.thinkingDelta) thinkingContent += remaining.thinkingDelta;
            if (remaining.displayText) textContent += remaining.displayText;

            // 如果有工具调用
            if (hasToolCalls) {
                if (collectedToolCalls.length > 0) {
                    if (textContent || thinkingContent) {
                        renderFinalTextWithThinking(textContent, thinkingContent);
                    }

                    const messageIndex = saveAssistantMessage({
                        textContent: textContent || '(调用工具)',
                        thinkingContent,
                        toolCalls: collectedToolCalls,
                        streamStats: stats.getPartialData(),
                        sessionId
                    });
                    setCurrentMessageIndex(messageIndex);

                    handleToolCallStream(collectedToolCalls, {
                        endpoint: openclawClient.url,
                        apiKey: openclawClient.token,
                        model: state.selectedModel,
                        sessionId
                    });

                    resolve();
                    return;
                }
            }

            // 无工具调用，正常完成
            finalizeOpenClawStream(textContent, thinkingContent, sessionId, stats);
            openclawClient.completeRun({ done: true });
            resolve();
        });

        // 错误事件
        addListener('openclaw:error', (payload) => {
            removeAllListeners();

            const errorMsg = payload?.message || '未知错误';
            logger.error('[OpenClaw Parser] 错误:', errorMsg);

            if (textContent || thinkingContent) {
                finalizeOpenClawStream(textContent, thinkingContent, sessionId, stats);
            }

            if (sessionId === state.currentSessionId) {
                eventBus.emit('stream:error', {
                    errorCode: payload?.code || 'openclaw_error',
                    errorMessage: errorMsg
                });
            }

            openclawClient.failRun(new Error(errorMsg));
            reject(new Error(errorMsg));
        });
    });
}

/**
 * 完成 OpenClaw 流处理
 */
function finalizeOpenClawStream(textContent, thinkingContent, sessionId, stats) {
    const isBackground = sessionId && sessionId !== state.currentSessionId;

    if (state.isToolCallPending) {
        setIsToolCallPending(false);
    }

    stats.finalize();

    if (!isBackground && (textContent || thinkingContent)) {
        renderFinalTextWithThinking(textContent, thinkingContent);
    }

    stats.recalculateTokenCount({ textContent, thinkingContent, contentParts: [] });

    if (!isBackground) {
        stats.syncToGlobal();
        appendStreamStats();
    }

    const messageIndex = saveAssistantMessage({
        textContent,
        thinkingContent,
        streamStats: stats.getData(),
        sessionId
    });

    if (!isBackground) {
        setCurrentMessageIndex(messageIndex);
    }
}
