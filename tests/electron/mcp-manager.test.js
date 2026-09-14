import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import mcpManagerModule from '../../electron/mcp-manager.js';

const { MCPManager } = mcpManagerModule;

class FakeChild extends EventEmitter {
    constructor({ exitOnSpawn = false } = {}) {
        super();
        this.stdout = new PassThrough();
        this.stderr = new PassThrough();
        this.stdin = new PassThrough();
        this.pid = 123;
        this.exitCode = null;
        this.signalCode = null;
        this.stdin.on('data', (chunk) => {
            const request = JSON.parse(chunk.toString());
            if (request.method === 'initialize') {
                this.stdout.write(
                    JSON.stringify({
                        jsonrpc: '2.0',
                        id: request.id,
                        result: { protocolVersion: '2024-11-05', capabilities: {} }
                    }) + '\n'
                );
            } else if (request.method === 'tools/list') {
                this.stdout.write(
                    JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { tools: [] } }) + '\n'
                );
            }
        });
        queueMicrotask(() => {
            this.emit('spawn');
            if (exitOnSpawn) this.exit(1, null);
        });
    }

    kill(signal = 'SIGTERM') {
        if (this.exitCode !== null || this.signalCode !== null) return true;
        this.signalCode = signal;
        queueMicrotask(() => this.emit('exit', null, signal));
        return true;
    }

    exit(code, signal = null) {
        this.exitCode = code;
        this.signalCode = signal;
        this.emit('exit', code, signal);
    }
}

function makeManager(spawnProcess) {
    return new MCPManager({ spawnProcess, requestTimeout: 100, stopTimeout: 100 });
}

describe('MCPManager', () => {
    it('等待进程启动和 MCP 初始化完成后才返回成功', async () => {
        const child = new FakeChild();
        const manager = makeManager(() => child);

        await expect(manager.startServer({ serverId: 'server', command: 'node' })).resolves.toEqual(
            { success: true }
        );
        await expect(manager.sendRequest('server', 'tools/list')).resolves.toEqual({ tools: [] });
        await manager.stopServer('server');
    });

    it('进程立即退出时返回启动失败', async () => {
        const child = new FakeChild({ exitOnSpawn: true });
        const manager = makeManager(() => child);

        const result = await manager.startServer({ serverId: 'server', command: 'node' });
        expect(result.success).toBe(false);
        expect(manager.getStatus('server')).toBeNull();
    });

    it('手动停止不会触发自动重启', async () => {
        const children = [];
        const manager = makeManager(() => {
            const child = new FakeChild();
            children.push(child);
            return child;
        });
        manager.restartConfig.restartDelay = 0;

        await manager.startServer({ serverId: 'server', command: 'node' });
        await manager.stopServer('server');
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(children).toHaveLength(1);
    });

    it('拒绝超过上限的未分帧消息', async () => {
        const child = new FakeChild();
        const manager = makeManager(() => child);
        await manager.startServer({ serverId: 'server', command: 'node' });
        const error = vi.fn();
        manager.on('server-error', error);
        manager.handleStdout('server', Buffer.alloc(33 * 1024 * 1024, 65));
        expect(error).toHaveBeenCalledWith(expect.objectContaining({ serverId: 'server' }));
        await manager.stopServer('server');
    });
});
