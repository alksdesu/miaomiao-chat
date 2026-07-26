/**
 * OpenClaw WebSocket 客户端
 * 管理与 OpenClaw Gateway 的 WebSocket 连接和消息通信
 */

import { logger } from '../utils/logger.js';
import { state } from '../core/state.js';
import { eventBus } from '../core/events.js';
import { buildModelParams, buildThinkingConfig } from './params.js';
import { getToolsForAPI } from '../tools/manager.js';
import { PartType } from '../messages/schema.js';
import { WS_HEARTBEAT_TIMEOUT_RATIO } from '../utils/constants.js';
// 静态 import current 安全：current → manager → fetchModelsFromAPI 内 openclaw 仍是 lazy，
// 顶层 openclaw → current → manager 单向无环
import { getCurrentModel, getCurrentProvider } from './current.js';

// 请求 ID 计数器
let requestIdCounter = 0;

/**
 * OpenClaw WebSocket 客户端（单例）
 */
class OpenClawClient {
    constructor() {
        this.ws = null;
        this.connected = false;
        this.connecting = false;
        this.url = '';
        this.token = '';
        this.tickInterval = null;
        this.tickIntervalMs = 30000;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;
        this.shouldReconnect = true;
        this.instanceId = null;

        // 请求/响应匹配
        this.pendingRequests = new Map();

        // 当前活跃的 run
        this.activeRunId = null;
        this.activeRunResolve = null;
        this.activeRunReject = null;
    }

    /**
     * 清理活跃 run 引用
     */
    _clearActiveRun() {
        this.activeRunId = null;
        this.activeRunResolve = null;
        this.activeRunReject = null;
    }

    /**
     * 连接到 OpenClaw Gateway
     *
     * 复用 connecting promise 避免重连退避期间并发请求各自走 sendMessage 路径
     * 立即 reject 'WebSocket 未连接'。第二个 connect 调用会 await 第一个握手结果，
     * 完成后再继续 sendMessage，相当于排队等握手
     */
    async connect(url, token) {
        if (this.connected) {
            return { success: true };
        }
        if (this.connecting && this._connectPromise) {
            return this._connectPromise;
        }

        this.connecting = true;
        this.url = url;
        this.token = token;
        this.shouldReconnect = true;
        this.instanceId = `oc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

        this._connectPromise = (async () => {
            try {
                await this._establishConnection();
                this.connecting = false;
                this.connected = true;
                this.reconnectAttempts = 0;

                eventBus.emit('openclaw:connected', { url });
                logger.debug('[OpenClaw] 已连接到 Gateway:', url);

                return { success: true };
            } catch (error) {
                this.connecting = false;
                this.connected = false;
                logger.error('[OpenClaw] 连接失败:', error.message);
                return { success: false, error: error.message };
            } finally {
                this._connectPromise = null;
            }
        })();
        return this._connectPromise;
    }

    /**
     * 建立 WebSocket 连接并完成握手
     */
    async _establishConnection() {
        return new Promise((resolve, reject) => {
            const ws = new WebSocket(this.url);
            let handshakeHandler = null;

            const timeout = setTimeout(() => {
                if (handshakeHandler) ws.removeEventListener('message', handshakeHandler);
                try {
                    ws.close();
                } catch {
                    /* ignore */
                }
                reject(new Error('WebSocket 连接超时 (10000ms)'));
            }, 10000);

            ws.onopen = () => {
                logger.debug('[OpenClaw] WebSocket 已打开，发送握手请求');

                const connectMsg = {
                    type: 'method',
                    method: 'connect',
                    id: String(++requestIdCounter),
                    params: {
                        role: 'operator',
                        token: this.token,
                        scopes: ['operator.read', 'operator.write']
                    }
                };

                handshakeHandler = (event) => {
                    try {
                        const msg = JSON.parse(event.data);
                        if (
                            msg.type === 'hello-ok' ||
                            (msg.type === 'result' && msg.id === connectMsg.id)
                        ) {
                            ws.removeEventListener('message', handshakeHandler);
                            clearTimeout(timeout);

                            if (msg.payload?.tickIntervalMs) {
                                this.tickIntervalMs = msg.payload.tickIntervalMs;
                            }

                            this.ws = ws;
                            this._setupMessageHandler();
                            this._startHeartbeat();
                            resolve();
                        } else if (msg.type === 'error') {
                            ws.removeEventListener('message', handshakeHandler);
                            clearTimeout(timeout);
                            try {
                                ws.close();
                            } catch {
                                /* ignore */
                            }
                            reject(new Error(msg.payload?.message || '握手失败'));
                        }
                    } catch {
                        // JSON 解析失败，忽略
                    }
                };

                ws.addEventListener('message', handshakeHandler);
                ws.send(JSON.stringify(connectMsg));
            };

            ws.onerror = () => {
                if (handshakeHandler) ws.removeEventListener('message', handshakeHandler);
                clearTimeout(timeout);
                try {
                    ws.close();
                } catch {
                    /* ignore */
                }
                reject(new Error('WebSocket 连接错误'));
            };
        });
    }

    /**
     * 设置消息路由
     */
    _setupMessageHandler() {
        if (!this.ws) return;

        this.ws.onmessage = (event) => {
            // 跟踪最后服务端消息时间，假死检测（_startHeartbeat 定期检查）
            this.lastServerMessageAt = Date.now();
            try {
                const msg = JSON.parse(event.data);
                this._routeMessage(msg);
            } catch (e) {
                logger.error('[OpenClaw] 消息解析失败:', e);
            }
        };

        this.ws.onclose = (event) => {
            this.connected = false;
            this._stopHeartbeat();

            logger.warn(`[OpenClaw] WebSocket 断开 (code: ${event.code})`);
            eventBus.emit('openclaw:disconnected', { code: event.code, reason: event.reason });

            // 如果有活跃的 run，reject 它
            if (this.activeRunReject) {
                this.activeRunReject(new Error('WebSocket 连接断开'));
                this._clearActiveRun();
            }

            // 自动重连
            if (!event.wasClean && this.shouldReconnect) {
                eventBus.emit('ui:notification', {
                    message: `OpenClaw 连接断开 (code: ${event.code})，正在自动重连`,
                    type: 'warning',
                    duration: 5000
                });
                this._attemptReconnect();
            }
        };

        this.ws.onerror = () => {
            logger.error('[OpenClaw] WebSocket 错误');
        };
    }

    /**
     * 消息路由
     */
    _routeMessage(msg) {
        const { type, event: eventName } = msg;

        if (type === 'result') {
            const pending = this.pendingRequests.get(msg.id);
            if (pending) {
                clearTimeout(pending.timeout);
                this.pendingRequests.delete(msg.id);
                pending.resolve(msg.payload);
            }
            return;
        }

        if (type === 'error') {
            const pending = this.pendingRequests.get(msg.id);
            if (pending) {
                clearTimeout(pending.timeout);
                this.pendingRequests.delete(msg.id);
                pending.reject(new Error(msg.payload?.message || 'Unknown error'));
            } else {
                eventBus.emit('openclaw:error', msg.payload);
            }
            return;
        }

        if (type === 'event') {
            switch (eventName) {
                case 'chat.delta':
                    eventBus.emit('openclaw:chat-delta', msg.payload);
                    break;
                case 'chat.done':
                    eventBus.emit('openclaw:chat-done', msg.payload);
                    break;
                case 'agent.event':
                    eventBus.emit('openclaw:agent-event', msg.payload);
                    break;
                case 'approval':
                    eventBus.emit('openclaw:approval-requested', msg.payload);
                    break;
                case 'cron':
                    eventBus.emit('openclaw:cron-event', msg.payload);
                    break;
                case 'tick':
                    break;
                default:
                    logger.debug('[OpenClaw] 未知事件:', eventName, msg.payload);
            }
        }
    }

    /**
     * 发送方法调用（请求-响应模式）
     */
    send(method, params = {}, timeoutMs = 60000) {
        return new Promise((resolve, reject) => {
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
                reject(new Error('WebSocket 未连接'));
                return;
            }

            const id = String(++requestIdCounter);
            const msg = { type: 'method', method, id, params };

            const timeout = setTimeout(() => {
                this.pendingRequests.delete(id);
                reject(new Error(`请求超时: ${method}`));
            }, timeoutMs);

            this.pendingRequests.set(id, { resolve, reject, timeout });
            this.ws.send(JSON.stringify(msg));
        });
    }

    _sendRaw(msg) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(msg));
        }
    }

    /**
     * 发送聊天消息
     * @returns {Promise<void>} - 当 chat.done 收到时 resolve
     */
    async sendMessage(message, sessionKey, options = {}) {
        const model = getCurrentModel();

        // 切 provider 后 this.url 仍是旧值：重连退避期 sendMessage 会用旧 url 连旧 gateway，
        // 即使新 provider 有新 url。比对当前 provider 的 url 与 this.url 不一致时强制 disconnect
        // 让下面的重连分支用 caller 传入的端点重新建连
        const provider = getCurrentProvider();
        const desiredUrl = provider?.endpoint || provider?.url || null;
        if (desiredUrl && this.url && desiredUrl !== this.url) {
            logger.warn(
                `[OpenClaw] 检测到 provider url 变更 (${this.url} → ${desiredUrl})，强制重连`
            );
            this.disconnect();
            this.url = desiredUrl;
        }

        // ws 未连接（重连退避期或被代理掐线后）主动 await connect 复用，避免在
        // 5-60s 退避窗口里所有 sendMessage 立即 reject 'WebSocket 未连接'
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            if (this.url && this.token) {
                try {
                    const result = await this.connect(this.url, this.token);
                    if (!result.success) {
                        throw new Error(`WebSocket 重连失败: ${result.error}`);
                    }
                } catch (e) {
                    throw new Error(`WebSocket 未连接且重连失败: ${e.message}`);
                }
            }
        }

        return new Promise((resolve, reject) => {
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
                reject(new Error('WebSocket 未连接'));
                return;
            }

            // 如果已有活跃 run，先 reject 旧的
            if (this.activeRunReject) {
                this.activeRunReject(new Error('被新请求取代'));
                this._clearActiveRun();
            }

            const params = {
                sessionKey: sessionKey || state.currentSessionId,
                message,
                model: options.model || model,
                ...options
            };

            const modelParams = buildModelParams('openclaw');
            Object.assign(params, modelParams);

            const thinkingConfig = buildThinkingConfig('openclaw', model);
            if (thinkingConfig) {
                Object.assign(params, thinkingConfig);
            }

            if (!state.xmlToolCallingEnabled) {
                const tools = getToolsForAPI('openclaw');
                if (tools.length > 0) {
                    params.tools = tools;
                    // OpenClaw Gateway 协议设计为 server-side 工具执行（chat.run 通过
                    // agent.event stream 推送 tool_call 给客户端，但协议无对应 chat 工具结果
                    // 回传方法 —— talk.session.submitToolResult 仅用于 Talk realtime session）。
                    // 注入 params.tools 后客户端工具会被调用但结果无法回传，模型下一轮看不到结果
                    // 会重复 call / 幻觉回答 —— 显式告知用户此协议限制
                    eventBus.emit('ui:notification', {
                        message:
                            'OpenClaw 协议下客户端工具结果无法回传给模型（agent 服务端执行模式）。' +
                            '建议改用 OpenClaw 服务端内置工具，或切到 OpenAI/Claude/Gemini 提供商使用客户端工具',
                        type: 'warning',
                        duration: 8000
                    });
                }
            }

            const id = String(++requestIdCounter);
            const msg = {
                type: 'method',
                method: options.useRun ? 'chat.run' : 'chat.send',
                id,
                params
            };

            this.activeRunId = id;
            this.activeRunResolve = resolve;
            this.activeRunReject = reject;

            this.ws.send(JSON.stringify(msg));
        });
    }

    /**
     * 中断当前任务
     */
    async abortRun(runId) {
        try {
            await this.send('chat.abort', { runId: runId || this.activeRunId });
        } catch (e) {
            logger.error('[OpenClaw] 中断失败:', e);
        }

        if (this.activeRunResolve) {
            this.activeRunResolve({ aborted: true });
            this._clearActiveRun();
        }
    }

    async approveAction(approvalId, approved) {
        return this.send('approval.respond', { approvalId, approved });
    }

    async listSessions() {
        return this.send('sessions.list');
    }

    async resetSession(key) {
        return this.send('sessions.reset', { sessionKey: key });
    }

    async compactSession(key) {
        return this.send('sessions.compact', { sessionKey: key });
    }

    async getSessionStatus(key) {
        return this.send('sessions.status', { sessionKey: key });
    }

    completeRun(result) {
        if (this.activeRunResolve) {
            this.activeRunResolve(result);
            this._clearActiveRun();
        }
    }

    failRun(error) {
        if (this.activeRunReject) {
            this.activeRunReject(error);
            this._clearActiveRun();
        }
    }

    _startHeartbeat() {
        this._stopHeartbeat();
        this.lastServerMessageAt = Date.now();
        this.tickInterval = setInterval(() => {
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
            this._sendRaw({ type: 'tick' });
            // tick 是单向发送（不期望 pong），代理 silent drop 让 ws 卡在 OPEN 假死。
            // 超过 2.5 * tickIntervalMs 无任何服务端消息 → 主动 close 触发 onclose
            // 走 _attemptReconnect 重连退避；不依赖 readyState（中间代理掐线 readyState 仍 OPEN）
            if (
                Date.now() - this.lastServerMessageAt >
                this.tickIntervalMs * WS_HEARTBEAT_TIMEOUT_RATIO
            ) {
                logger.warn(
                    `[OpenClaw] ${this.tickIntervalMs * WS_HEARTBEAT_TIMEOUT_RATIO}ms 无服务端消息，疑似假死，主动 close 触发重连`
                );
                try {
                    this.ws.close(4000, 'idle timeout');
                } catch {
                    /* ignore */
                }
            }
        }, this.tickIntervalMs);
    }

    _stopHeartbeat() {
        if (this.tickInterval) {
            clearInterval(this.tickInterval);
            this.tickInterval = null;
        }
    }

    _attemptReconnect() {
        this.reconnectAttempts++;
        if (this.reconnectAttempts > this.maxReconnectAttempts) {
            logger.warn('[OpenClaw] 超过最大重连次数，停止重连');
            eventBus.emit('ui:notification', {
                message: `OpenClaw 重连失败（已尝试 ${this.maxReconnectAttempts} 次），请检查网络后在设置中手动重连`,
                type: 'error',
                duration: 0
            });
            return;
        }

        const delay = Math.min(5000 * Math.pow(2, this.reconnectAttempts - 1), 60000);
        logger.debug(
            `[OpenClaw] ${delay}ms 后尝试重连 (${this.reconnectAttempts}/${this.maxReconnectAttempts})`
        );

        // 保存 timer 句柄到 this._reconnectTimer，让 disconnect() 能取消挂起的重连。
        // 之前 setTimeout 不保句柄 → disconnect 后用户立即 connect() 把 shouldReconnect
        // 设回 true → 旧 timer fire 触发额外 connect() 与新连接 race 让两路 ws 同存
        this._reconnectTimer = setTimeout(async () => {
            this._reconnectTimer = null;
            if (!this.shouldReconnect || this.connected) return;
            const result = await this.connect(this.url, this.token);
            if (!result.success) {
                logger.error('[OpenClaw] 重连失败:', result.error);
                // 连接失败不触发 onclose（握手前 ws 未挂 handler），必须显式续推
                // 重试链，否则第一次失败后静默停止且耗尽通知永不可达
                this._attemptReconnect();
            }
        }, delay);
    }

    disconnect() {
        this.shouldReconnect = false;
        this._stopHeartbeat();

        // 取消挂起的重连退避 timer，避免 disconnect 后旧 timer fire 与新 connect race
        if (this._reconnectTimer) {
            clearTimeout(this._reconnectTimer);
            this._reconnectTimer = null;
        }

        for (const [, pending] of this.pendingRequests) {
            clearTimeout(pending.timeout);
            pending.reject(new Error('连接已关闭'));
        }
        this.pendingRequests.clear();

        if (this.ws) {
            try {
                this.ws.close(1000, 'Client disconnect');
            } catch {
                /* ignore */
            }
            this.ws = null;
        }

        this.connected = false;
        this.connecting = false;
        eventBus.emit('openclaw:disconnected', { code: 1000, reason: 'Client disconnect' });
    }

    getStatus() {
        if (this.connected) return 'connected';
        if (this.connecting) return 'connecting';
        if (this.reconnectAttempts > 0 && this.shouldReconnect) return 'reconnecting';
        return 'disconnected';
    }
}

export const openclawClient = new OpenClawClient();

/**
 * 发送 OpenClaw 请求（符合 factory.js 的 sender 签名）
 * OpenClaw 使用 WS 通信，handler.js 中 openclaw 分支会跳过 response.body，
 * 直接调用 handleOpenClawStream() 监听 eventBus 事件。
 * 此函数只负责：建连 + 发送 WS 消息 + 返回 sentinel 对象。
 */
export async function sendOpenClawRequest(endpoint, apiKey, model, signal = null) {
    // 确保已连接
    if (!openclawClient.connected) {
        const result = await openclawClient.connect(endpoint, apiKey);
        if (!result.success) {
            throw new Error(`OpenClaw 连接失败: ${result.error}`);
        }
    }

    // 从 state.messages 提取最后一条用户消息文本
    const msgs = state.messages;
    let messageText = '';
    for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if (m.isError) continue;
        if (m.role === 'user') {
            // 新格式：从 parts 提取文本
            if (m.parts && Array.isArray(m.parts)) {
                messageText = m.parts
                    .filter((p) => p.type === PartType.TEXT)
                    .map((p) => p.text)
                    .join('\n');
            }
            // 旧格式兼容
            else if (typeof m.content === 'string') {
                messageText = m.content;
            } else if (Array.isArray(m.content)) {
                messageText = m.content
                    .filter((p) => p.type === 'text')
                    .map((p) => p.text)
                    .join('\n');
            }
            break;
        }
    }

    // 监听取消信号 — 在 chat.done / chat.error 收到后由 parser-openclaw 触发的
    // openclaw:disconnected 事件路径同时 cleanup listener，避免连续多次 abort 在
    // signal 上堆积冗余 listener（once:true 仅保证单次触发，不保证生命周期解绑）
    let abortListener = null;
    const detachAbortListener = () => {
        if (abortListener && signal) {
            signal.removeEventListener('abort', abortListener);
            abortListener = null;
        }
    };
    if (signal) {
        abortListener = () => {
            openclawClient.abortRun();
            detachAbortListener();
        };
        signal.addEventListener('abort', abortListener, { once: true });
    }

    // 发送 WS 消息（side effect）
    openclawClient
        .sendMessage(messageText, state.currentSessionId, { model, useRun: true })
        .catch(() => {
            /* abortRun / 失败已由其它路径 reject，这里只确保不堆积 listener */
        })
        .finally(detachAbortListener);

    // 返回 sentinel，handler.js 检测到 openclaw 时不使用 response.body
    return { ok: true, status: 200, body: null };
}
