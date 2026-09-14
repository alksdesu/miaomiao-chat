/**
 * 本地 MCP 进程、握手与请求生命周期。
 */
const spawn = require('cross-spawn');
const { EventEmitter } = require('events');
const { version } = require('../package.json');

const MAX_FRAME_BYTES = 32 * 1024 * 1024;
const MAX_HEADER_BYTES = 8192;
const PROTOCOL_VERSIONS = new Set(['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25']);

class MCPManager extends EventEmitter {
    constructor({ spawnProcess = spawn, requestTimeout = 10000, stopTimeout = 5000 } = {}) {
        super();
        this.spawnProcess = spawnProcess;
        this.requestTimeout = requestTimeout;
        this.stopTimeout = stopTimeout;
        this.processes = new Map();
        this.requestQueue = new Map();
        this.requestIdCounter = 0;
        this.restartConfig = {
            enabled: true,
            maxRestarts: 3,
            resetInterval: 60000,
            restartDelay: 2000
        };
        this.restartCounts = new Map();
        this.restartTimers = new Map();
        this.shuttingDown = false;
    }

    async startServer(config, { restart = false } = {}) {
        if (this.shuttingDown) return { success: false, error: '应用正在退出' };
        const { serverId, command, args = [], env = {}, cwd } = config || {};
        if (
            typeof serverId !== 'string' ||
            !serverId ||
            typeof command !== 'string' ||
            !command.trim() ||
            !Array.isArray(args) ||
            args.some((arg) => typeof arg !== 'string') ||
            !env ||
            typeof env !== 'object' ||
            Array.isArray(env) ||
            Object.values(env).some((value) => typeof value !== 'string') ||
            (cwd !== undefined && typeof cwd !== 'string')
        ) {
            return { success: false, error: 'MCP 启动配置格式错误' };
        }
        if (this.processes.has(serverId)) return { success: false, error: '服务器已运行' };
        if (!restart) {
            this.cancelRestart(serverId);
            this.restartCounts.set(serverId, {
                count: 0,
                lastRestart: Date.now(),
                config: { serverId, command, args, env, cwd }
            });
        }
        let info;
        try {
            const child = this.spawnProcess(command, args, {
                cwd: cwd || process.cwd(),
                env: { ...process.env, ...env },
                stdio: ['pipe', 'pipe', 'pipe'],
                windowsHide: true
            });
            info = {
                process: child,
                serverId,
                command,
                args,
                buffer: Buffer.alloc(0),
                startTime: Date.now(),
                status: 'starting',
                initialized: false,
                initializing: null,
                ready: false,
                intentionalStop: false
            };
            this.processes.set(serverId, info);
            child.stdout.on('data', (data) => {
                if (this.processes.get(serverId) === info) this.handleStdout(serverId, data);
            });
            child.stderr.on('data', (data) => {
                this.emit('server-diagnostic', { serverId, bytes: data.length });
            });
            child.on('exit', (code, signal) =>
                this.handleProcessExit(serverId, code, signal, info)
            );
            child.on('error', (error) => this.failProcess(serverId, error, info));
            child.stdin.on('error', (error) => this.failProcess(serverId, error, info));
            child.stdout.on('error', (error) => this.failProcess(serverId, error, info));
            child.stderr.on('error', (error) => this.failProcess(serverId, error, info));
            await new Promise((resolve, reject) => {
                const finish = (error) => {
                    clearTimeout(timer);
                    child.removeListener('spawn', onSpawn);
                    child.removeListener('error', onError);
                    child.removeListener('exit', onExit);
                    error ? reject(error) : resolve();
                };
                const onSpawn = () => finish();
                const onError = (error) => finish(error);
                const onExit = () => finish(new Error('MCP 进程在启动期间退出'));
                const timer = setTimeout(
                    () => finish(new Error('MCP 启动超时')),
                    this.requestTimeout
                );
                child.once('spawn', onSpawn);
                child.once('error', onError);
                child.once('exit', onExit);
            });
            if (info.intentionalStop || this.processes.get(serverId) !== info)
                throw new Error('MCP 启动已取消');
            info.status = 'running';
            await this.ensureInitialized(serverId);
            if (info.intentionalStop || this.processes.get(serverId) !== info)
                throw new Error('MCP 启动已取消');
            info.ready = true;
            this.emit('server-started', { serverId });
            return { success: true };
        } catch (error) {
            if (info && this.processes.get(serverId) === info)
                await this.stopProcess(serverId, info);
            return { success: false, error: error.message };
        }
    }

    async ensureInitialized(serverId) {
        const info = this.processes.get(serverId);
        if (!info || info.status !== 'running') throw new Error(`服务器未运行: ${serverId}`);
        if (info.initialized) return;
        if (info.initializing) return info.initializing;
        info.initializing = (async () => {
            const result = await this.sendRequest(serverId, 'initialize', {
                protocolVersion: '2025-11-25',
                capabilities: {},
                clientInfo: { name: 'webchat', version }
            });
            if (
                !result ||
                !PROTOCOL_VERSIONS.has(result.protocolVersion) ||
                !result.capabilities ||
                typeof result.capabilities !== 'object' ||
                Array.isArray(result.capabilities)
            ) {
                throw new Error('MCP 初始化响应无效或协议版本不受支持');
            }
            await this.writeMessage(info, { jsonrpc: '2.0', method: 'notifications/initialized' });
            info.initialized = true;
        })();
        try {
            await info.initializing;
        } finally {
            info.initializing = null;
        }
    }

    writeMessage(info, message) {
        return new Promise((resolve, reject) => {
            if (
                info.intentionalStop ||
                info.process.stdin.destroyed ||
                !info.process.stdin.writable
            ) {
                reject(new Error('MCP 输入流已关闭'));
                return;
            }
            const data = JSON.stringify(message) + '\n';
            if (Buffer.byteLength(data) > MAX_FRAME_BYTES) {
                reject(new Error('MCP 请求过大'));
                return;
            }
            info.process.stdin.write(data, (error) => (error ? reject(error) : resolve()));
        });
    }

    async sendRequest(serverId, method, params = {}) {
        if (method !== 'initialize') await this.ensureInitialized(serverId);
        const info = this.processes.get(serverId);
        if (!info || info.status !== 'running' || info.intentionalStop)
            throw new Error(`服务器未运行: ${serverId}`);
        const id = `req_${++this.requestIdCounter}`;
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(
                () => {
                    this.requestQueue.delete(id);
                    reject(new Error(`MCP 请求超时: ${method}`));
                },
                method === 'tools/call' ? 180000 : this.requestTimeout
            );
            this.requestQueue.set(id, { serverId, resolve, reject, timeout });
            this.writeMessage(info, { jsonrpc: '2.0', id, method, params }).catch((error) => {
                clearTimeout(timeout);
                this.requestQueue.delete(id);
                reject(error);
            });
        });
    }

    handleStdout(serverId, data) {
        const info = this.processes.get(serverId);
        if (!info || info.intentionalStop) return;
        const incoming = Buffer.from(data);
        if (info.buffer.length + incoming.length > MAX_FRAME_BYTES + MAX_HEADER_BYTES) {
            this.failProcess(serverId, new Error('MCP 缓冲区超过大小限制'), info);
            return;
        }
        info.buffer = Buffer.concat([info.buffer, incoming]);
        while (info.buffer.length) {
            const prefix = info.buffer.toString('utf8', 0, Math.min(info.buffer.length, 128));
            let payload;
            if (/^content-length\s*:/i.test(prefix)) {
                const crlf = info.buffer.indexOf('\r\n\r\n');
                const lf = info.buffer.indexOf('\n\n');
                const headerEnd = crlf >= 0 ? crlf : lf;
                if (headerEnd < 0 && info.buffer.length <= MAX_HEADER_BYTES) break;
                const header = headerEnd >= 0 ? info.buffer.toString('utf8', 0, headerEnd) : '';
                const length = Number(header.match(/^content-length\s*:\s*(\d+)\s*$/im)?.[1]);
                if (
                    headerEnd < 0 ||
                    headerEnd > MAX_HEADER_BYTES ||
                    !Number.isSafeInteger(length) ||
                    length <= 0 ||
                    length > MAX_FRAME_BYTES
                ) {
                    this.failProcess(serverId, new Error('MCP 帧长度无效或过大'), info);
                    return;
                }
                const start = headerEnd + (crlf >= 0 ? 4 : 2);
                if (info.buffer.length < start + length) break;
                payload = info.buffer.subarray(start, start + length);
                info.buffer = info.buffer.subarray(start + length);
            } else {
                const newline = info.buffer.indexOf('\n');
                if (newline < 0) {
                    if (info.buffer.length > MAX_FRAME_BYTES)
                        this.failProcess(serverId, new Error('MCP 消息过大'), info);
                    break;
                }
                if (newline > MAX_FRAME_BYTES) {
                    this.failProcess(serverId, new Error('MCP 消息过大'), info);
                    return;
                }
                payload = info.buffer.subarray(0, newline);
                info.buffer = info.buffer.subarray(newline + 1);
            }
            const text = payload.toString('utf8').trim();
            if (!text) continue;
            try {
                this.handleMessage(serverId, JSON.parse(text));
            } catch {
                this.emit('server-diagnostic', { serverId, error: 'MCP 返回无效 JSON' });
            }
        }
    }

    handleMessage(serverId, message) {
        // MCP 返回内容可能包含用户数据或凭据，日志只保留协议类型。
        if (
            !message ||
            typeof message !== 'object' ||
            Array.isArray(message) ||
            message.jsonrpc !== '2.0'
        )
            return;
        if (Object.hasOwn(message, 'id') && Object.hasOwn(message, 'method')) {
            const info = this.processes.get(serverId);
            if (info)
                this.writeMessage(info, {
                    jsonrpc: '2.0',
                    id: message.id,
                    ...(message.method === 'ping'
                        ? { result: {} }
                        : { error: { code: -32601, message: 'Method not supported' } })
                }).catch(() => {});
        } else if (Object.hasOwn(message, 'id')) {
            const pending = this.requestQueue.get(message.id);
            if (!pending || pending.serverId !== serverId) return;
            if (!Object.hasOwn(message, 'result') && !message.error) return;
            clearTimeout(pending.timeout);
            this.requestQueue.delete(message.id);
            message.error
                ? pending.reject(new Error(message.error.message || 'MCP 请求失败'))
                : pending.resolve(message.result);
        } else if (typeof message.method === 'string') {
            this.emit('notification', { serverId, message });
        }
    }

    rejectRequests(serverId, error) {
        for (const [id, pending] of this.requestQueue) {
            if (pending.serverId !== serverId) continue;
            clearTimeout(pending.timeout);
            this.requestQueue.delete(id);
            pending.reject(error);
        }
    }

    failProcess(serverId, error, info) {
        if (this.processes.get(serverId) !== info || info.intentionalStop) return;
        this.rejectRequests(serverId, error);
        this.emit('server-error', { serverId, error: error.message });
        void this.stopProcess(serverId, info);
    }

    handleProcessExit(serverId, code, signal, info = this.processes.get(serverId)) {
        if (!info || this.processes.get(serverId) !== info) return;
        info.status = 'stopped';
        this.processes.delete(serverId);
        this.rejectRequests(serverId, new Error('服务器进程已退出'));
        this.emit('server-exited', { serverId, code, signal });
        if (info.ready && !info.intentionalStop && code !== 0) this.scheduleRestart(serverId);
    }

    cancelRestart(serverId) {
        clearTimeout(this.restartTimers.get(serverId));
        this.restartTimers.delete(serverId);
    }

    scheduleRestart(serverId) {
        const restart = this.restartCounts.get(serverId);
        if (
            this.shuttingDown ||
            !this.restartConfig.enabled ||
            !restart ||
            this.restartTimers.has(serverId)
        )
            return;
        if (Date.now() - restart.lastRestart > this.restartConfig.resetInterval) restart.count = 0;
        if (restart.count >= this.restartConfig.maxRestarts) {
            this.emit('restart-limit-exceeded', { serverId, count: restart.count });
            return;
        }
        restart.count++;
        restart.lastRestart = Date.now();
        const timer = setTimeout(async () => {
            this.restartTimers.delete(serverId);
            if (this.shuttingDown || this.restartCounts.get(serverId) !== restart) return;
            this.emit('server-restarting', { serverId, attempt: restart.count });
            const result = await this.startServer(restart.config, { restart: true });
            if (this.restartCounts.get(serverId) !== restart || this.shuttingDown) return;
            if (result.success) this.emit('server-restarted', { serverId, attempt: restart.count });
            else {
                this.emit('server-restart-failed', {
                    serverId,
                    error: result.error,
                    attempt: restart.count
                });
                this.scheduleRestart(serverId);
            }
        }, this.restartConfig.restartDelay);
        this.restartTimers.set(serverId, timer);
    }

    async stopProcess(serverId, info) {
        if (info.stopping) return info.stopping;
        info.intentionalStop = true;
        info.status = 'stopping';
        info.buffer = Buffer.alloc(0);
        this.rejectRequests(serverId, new Error('MCP 服务器已停止'));
        info.stopping = new Promise((resolve) => {
            const child = info.process;
            if (child.exitCode !== null || child.signalCode !== null || !child.pid) {
                resolve();
                return;
            }
            const done = () => {
                clearTimeout(timer);
                child.removeListener('exit', done);
                resolve();
            };
            const timer = setTimeout(() => {
                child.kill('SIGKILL');
                done();
            }, this.stopTimeout);
            child.once('exit', done);
            child.kill('SIGTERM');
        });
        await info.stopping;
        if (this.processes.get(serverId) === info) this.processes.delete(serverId);
    }

    async stopServer(serverId) {
        this.cancelRestart(serverId);
        this.restartCounts.delete(serverId);
        const info = this.processes.get(serverId);
        if (info) await this.stopProcess(serverId, info);
        this.emit('server-stopped', { serverId });
    }

    getStatus(serverId) {
        const info = this.processes.get(serverId);
        return info
            ? {
                  serverId,
                  status: info.status,
                  pid: info.process.pid,
                  uptime: Date.now() - info.startTime,
                  command: info.command
              }
            : null;
    }

    getAllStatus() {
        return [...this.processes.keys()].map((id) => this.getStatus(id));
    }

    async stopAll() {
        this.shuttingDown = true;
        await Promise.all(
            [...new Set([...this.processes.keys(), ...this.restartCounts.keys()])].map((id) =>
                this.stopServer(id)
            )
        );
    }
}

module.exports = { MCPManager, mcpManager: new MCPManager() };
