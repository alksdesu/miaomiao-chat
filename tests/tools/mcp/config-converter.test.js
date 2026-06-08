/**
 * MCP config-converter.js 测试
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../js/utils/logger.js', () => ({
    logger: { warn: vi.fn(), debug: vi.fn(), error: vi.fn(), info: vi.fn() }
}));

import {
    standardToInternal,
    internalToStandard,
    validateStandardConfig,
    generateTemplate,
    getAvailableTemplates
} from '../../../js/tools/mcp/config-converter.js';

describe('config-converter', () => {
    // ========== standardToInternal ==========
    describe('standardToInternal', () => {
        it('转换本地 STDIO 服务器', () => {
            const config = {
                mcpServers: {
                    filesystem: {
                        command: 'npx',
                        args: ['-y', '@mcp/server-fs', '/tmp'],
                        env: { NODE_ENV: 'production' },
                        cwd: '/home/user'
                    }
                }
            };
            const result = standardToInternal(config);
            expect(result).toHaveLength(1);
            expect(result[0].name).toBe('filesystem');
            expect(result[0].type).toBe('local');
            expect(result[0].command).toBe('npx');
            expect(result[0].args).toEqual(['-y', '@mcp/server-fs', '/tmp']);
            expect(result[0].env).toEqual({ NODE_ENV: 'production' });
            expect(result[0].cwd).toBe('/home/user');
            expect(result[0].enabled).toBe(true);
            expect(result[0].id).toMatch(/^mcp_/);
        });

        it('转换远程 SSE 服务器', () => {
            const config = {
                mcpServers: {
                    'my-sse': {
                        type: 'sse',
                        url: 'http://localhost:8001/sse',
                        headers: { Authorization: 'Bearer token123' }
                    }
                }
            };
            const result = standardToInternal(config);
            expect(result).toHaveLength(1);
            expect(result[0].type).toBe('remote');
            expect(result[0].transportType).toBe('sse');
            expect(result[0].url).toBe('http://localhost:8001/sse');
            expect(result[0].apiKey).toBe('token123');
            expect(result[0].customHeaders).toEqual({ Authorization: 'Bearer token123' });
        });

        it('转换远程 streamable-http 服务器', () => {
            const config = {
                mcpServers: {
                    'http-server': {
                        type: 'streamable-http',
                        url: 'http://localhost:8002/mcp'
                    }
                }
            };
            const result = standardToInternal(config);
            expect(result[0].transportType).toBe('streamable-http');
        });

        it('自动检测 WebSocket URL', () => {
            const config = {
                mcpServers: {
                    ws: { url: 'ws://localhost:9000' }
                }
            };
            const result = standardToInternal(config);
            expect(result[0].transportType).toBe('websocket');
        });

        it('自动检测 wss:// URL', () => {
            const config = {
                mcpServers: {
                    wss: { url: 'wss://example.com/mcp' }
                }
            };
            const result = standardToInternal(config);
            expect(result[0].transportType).toBe('websocket');
        });

        it('自动检测 HTTP URL 默认为 http', () => {
            const config = {
                mcpServers: {
                    http: { url: 'http://localhost:3000/api' }
                }
            };
            const result = standardToInternal(config);
            expect(result[0].transportType).toBe('http');
        });

        it('传输类型别名兼容: streamableHttp', () => {
            const config = {
                mcpServers: {
                    s: { type: 'streamableHttp', url: 'http://a.com' }
                }
            };
            const result = standardToInternal(config);
            expect(result[0].transportType).toBe('streamable-http');
        });

        it('传输类型别名兼容: https → http', () => {
            const config = {
                mcpServers: {
                    s: { type: 'https', url: 'https://a.com' }
                }
            };
            const result = standardToInternal(config);
            expect(result[0].transportType).toBe('http');
        });

        it('传输类型别名兼容: ws → websocket', () => {
            const config = {
                mcpServers: {
                    s: { type: 'ws', url: 'ws://a.com' }
                }
            };
            const result = standardToInternal(config);
            expect(result[0].transportType).toBe('websocket');
        });

        it('传输类型别名兼容: wss → websocket', () => {
            const config = {
                mcpServers: {
                    s: { type: 'wss', url: 'wss://a.com' }
                }
            };
            const result = standardToInternal(config);
            expect(result[0].transportType).toBe('websocket');
        });

        it('处理 apiKey 字段（无 headers）', () => {
            const config = {
                mcpServers: {
                    s: { url: 'http://a.com', apiKey: 'key123' }
                }
            };
            const result = standardToInternal(config);
            expect(result[0].apiKey).toBe('key123');
        });

        it('从 headers 提取非 Bearer 的 Authorization', () => {
            const config = {
                mcpServers: {
                    s: {
                        url: 'http://a.com',
                        headers: { Authorization: 'Basic abc123' }
                    }
                }
            };
            const result = standardToInternal(config);
            expect(result[0].apiKey).toBe('Basic abc123');
        });

        it('小写 authorization 头也能提取', () => {
            const config = {
                mcpServers: {
                    s: {
                        url: 'http://a.com',
                        headers: { authorization: 'Bearer mytoken' }
                    }
                }
            };
            const result = standardToInternal(config);
            expect(result[0].apiKey).toBe('mytoken');
        });

        it('enabled: false 被正确处理', () => {
            const config = {
                mcpServers: {
                    s: { command: 'node', args: ['server.js'], enabled: false }
                }
            };
            const result = standardToInternal(config);
            expect(result[0].enabled).toBe(false);
        });

        it('缺少 mcpServers 抛错', () => {
            expect(() => standardToInternal({})).toThrow('缺少 mcpServers');
            expect(() => standardToInternal(null)).toThrow();
        });

        it('跳过无效服务器（同时包含本地和远程字段）', () => {
            const config = {
                mcpServers: {
                    mixed: { command: 'node', url: 'http://a.com' }
                }
            };
            const result = standardToInternal(config);
            expect(result).toHaveLength(0);
        });

        it('跳过缺少必要字段的服务器', () => {
            const config = {
                mcpServers: {
                    empty: {}
                }
            };
            const result = standardToInternal(config);
            expect(result).toHaveLength(0);
        });

        it('跳过不支持的传输类型', () => {
            const config = {
                mcpServers: {
                    s: { url: 'http://a.com', type: 'grpc' }
                }
            };
            const result = standardToInternal(config);
            expect(result).toHaveLength(0);
        });

        it('本地服务器缺少 command 被跳过', () => {
            const config = {
                mcpServers: {
                    s: { args: ['--flag'] }
                }
            };
            const result = standardToInternal(config);
            expect(result).toHaveLength(0);
        });

        it('远程服务器缺少 url 被跳过', () => {
            const config = {
                mcpServers: {
                    s: { type: 'sse' }
                }
            };
            const result = standardToInternal(config);
            expect(result).toHaveLength(0);
        });

        it('转换多个服务器', () => {
            const config = {
                mcpServers: {
                    local: { command: 'node', args: ['server.js'] },
                    remote: { url: 'http://a.com', type: 'sse' }
                }
            };
            const result = standardToInternal(config);
            expect(result).toHaveLength(2);
        });

        it('本地服务器缺省值: args=[], env={}, cwd=""', () => {
            const config = {
                mcpServers: {
                    minimal: { command: 'npx' }
                }
            };
            const result = standardToInternal(config);
            expect(result[0].args).toEqual([]);
            expect(result[0].env).toEqual({});
            expect(result[0].cwd).toBe('');
        });
    });

    // ========== internalToStandard ==========
    describe('internalToStandard', () => {
        it('转换本地服务器到标准格式', () => {
            const servers = [
                {
                    id: 'id1',
                    name: 'fs',
                    type: 'local',
                    command: 'npx',
                    args: ['-y', 'server'],
                    env: { KEY: 'val' },
                    cwd: '/tmp',
                    enabled: true
                }
            ];
            const result = internalToStandard(servers);
            expect(result.mcpServers.fs).toBeDefined();
            expect(result.mcpServers.fs.command).toBe('npx');
            expect(result.mcpServers.fs.args).toEqual(['-y', 'server']);
            expect(result.mcpServers.fs.env).toEqual({ KEY: 'val' });
            expect(result.mcpServers.fs.cwd).toBe('/tmp');
            expect(result.mcpServers.fs.enabled).toBe(true);
        });

        it('转换远程 SSE 服务器到标准格式', () => {
            const servers = [
                {
                    name: 'sse-server',
                    type: 'remote',
                    url: 'http://localhost:8001/sse',
                    transportType: 'sse',
                    apiKey: 'token123'
                }
            ];
            const result = internalToStandard(servers);
            const s = result.mcpServers['sse-server'];
            expect(s.url).toBe('http://localhost:8001/sse');
            expect(s.type).toBe('sse');
            expect(s.headers.Authorization).toBe('Bearer token123');
        });

        it('转换远程 streamable-http 服务器', () => {
            const servers = [
                {
                    name: 'http-server',
                    type: 'remote',
                    url: 'http://a.com',
                    transportType: 'streamable-http'
                }
            ];
            const result = internalToStandard(servers);
            expect(result.mcpServers['http-server'].type).toBe('streamable-http');
        });

        it('websocket 和 http 不添加 type 字段', () => {
            const servers = [
                { name: 'ws', type: 'remote', url: 'ws://a.com', transportType: 'websocket' },
                { name: 'http', type: 'remote', url: 'http://a.com', transportType: 'http' }
            ];
            const result = internalToStandard(servers);
            expect(result.mcpServers.ws.type).toBeUndefined();
            expect(result.mcpServers.http.type).toBeUndefined();
        });

        it('customHeaders 优先于 apiKey', () => {
            const servers = [
                {
                    name: 's',
                    type: 'remote',
                    url: 'http://a.com',
                    customHeaders: { 'X-Custom': 'value' },
                    apiKey: 'should-ignore'
                }
            ];
            const result = internalToStandard(servers);
            expect(result.mcpServers.s.headers).toEqual({ 'X-Custom': 'value' });
        });

        it('空 args 和 env 不写入', () => {
            const servers = [
                {
                    name: 's',
                    type: 'local',
                    command: 'npx',
                    args: [],
                    env: {},
                    cwd: ''
                }
            ];
            const result = internalToStandard(servers);
            expect(result.mcpServers.s.args).toBeUndefined();
            expect(result.mcpServers.s.env).toBeUndefined();
            expect(result.mcpServers.s.cwd).toBeUndefined();
        });

        it('没有 name 时用 id 作为 key', () => {
            const servers = [
                {
                    id: 'my-id',
                    type: 'local',
                    command: 'node'
                }
            ];
            const result = internalToStandard(servers);
            expect(result.mcpServers['my-id']).toBeDefined();
        });

        it('非数组输入抛错', () => {
            expect(() => internalToStandard({})).toThrow('必须是数组');
        });

        it('跳过未知类型的服务器', () => {
            const servers = [{ name: 'x', type: 'unknown' }];
            const result = internalToStandard(servers);
            expect(Object.keys(result.mcpServers)).toHaveLength(0);
        });

        it('本地服务器缺 command 被跳过', () => {
            const servers = [{ name: 'x', type: 'local' }];
            const result = internalToStandard(servers);
            expect(Object.keys(result.mcpServers)).toHaveLength(0);
        });

        it('远程服务器缺 url 被跳过', () => {
            const servers = [{ name: 'x', type: 'remote' }];
            const result = internalToStandard(servers);
            expect(Object.keys(result.mcpServers)).toHaveLength(0);
        });
    });

    // ========== validateStandardConfig ==========
    describe('validateStandardConfig', () => {
        it('有效配置返回 valid: true', () => {
            const config = {
                mcpServers: {
                    fs: { command: 'npx', args: ['-y', 'server'] }
                }
            };
            expect(validateStandardConfig(config).valid).toBe(true);
        });

        it('null 配置返回错误', () => {
            const r = validateStandardConfig(null);
            expect(r.valid).toBe(false);
            expect(r.errors[0]).toContain('对象');
        });

        it('缺少 mcpServers 返回错误', () => {
            const r = validateStandardConfig({});
            expect(r.valid).toBe(false);
        });

        it('mcpServers 不是对象返回错误', () => {
            const r = validateStandardConfig({ mcpServers: 'invalid' });
            expect(r.valid).toBe(false);
        });

        it('空 mcpServers 返回错误', () => {
            const r = validateStandardConfig({ mcpServers: {} });
            expect(r.valid).toBe(false);
        });

        it('无效服务器配置返回错误', () => {
            const r = validateStandardConfig({ mcpServers: { s: null } });
            expect(r.valid).toBe(false);
        });

        it('同时本地和远程字段报错', () => {
            const r = validateStandardConfig({
                mcpServers: { s: { command: 'node', url: 'http://a.com' } }
            });
            expect(r.valid).toBe(false);
            expect(r.errors[0]).toContain('同时包含');
        });

        it('缺少必要字段报错', () => {
            const r = validateStandardConfig({ mcpServers: { s: { enabled: true } } });
            expect(r.valid).toBe(false);
        });

        it('本地缺 command 报错', () => {
            const r = validateStandardConfig({ mcpServers: { s: { args: ['--flag'] } } });
            expect(r.valid).toBe(false);
        });

        it('远程缺 url 报错', () => {
            const r = validateStandardConfig({ mcpServers: { s: { type: 'sse' } } });
            expect(r.valid).toBe(false);
        });

        it('无效传输类型报错', () => {
            const r = validateStandardConfig({
                mcpServers: { s: { url: 'http://a.com', type: 'grpc' } }
            });
            expect(r.valid).toBe(false);
            expect(r.errors[0]).toContain('无效');
        });

        it('传输类型别名验证通过', () => {
            const r = validateStandardConfig({
                mcpServers: { s: { url: 'http://a.com', type: 'streamableHttp' } }
            });
            expect(r.valid).toBe(true);
        });

        it('多个错误全部返回', () => {
            const r = validateStandardConfig({
                mcpServers: {
                    s1: null,
                    s2: { enabled: true },
                    s3: { command: 'node', url: 'http://a.com' }
                }
            });
            expect(r.errors.length).toBeGreaterThanOrEqual(3);
        });
    });

    // ========== generateTemplate ==========
    describe('generateTemplate', () => {
        it('返回空模板', () => {
            const t = generateTemplate('empty');
            expect(t.mcpServers).toEqual({});
        });

        it('返回 filesystem 模板', () => {
            const t = generateTemplate('filesystem');
            expect(t.mcpServers.filesystem.command).toBe('npx');
        });

        it('返回 memory 模板', () => {
            const t = generateTemplate('memory');
            expect(t.mcpServers.memory.command).toBe('npx');
        });

        it('返回 fetch 模板', () => {
            const t = generateTemplate('fetch');
            expect(t.mcpServers.fetch.command).toBe('uvx');
        });

        it('返回 sqlite 模板', () => {
            const t = generateTemplate('sqlite');
            expect(t.mcpServers.sqlite).toBeDefined();
        });

        it('返回 github 模板', () => {
            const t = generateTemplate('github');
            expect(t.mcpServers.github.env).toBeDefined();
        });

        it('返回 sse 模板', () => {
            const t = generateTemplate('sse');
            expect(t.mcpServers['my-sse-server'].type).toBe('sse');
        });

        it('返回 streamable-http 模板', () => {
            const t = generateTemplate('streamable-http');
            expect(t.mcpServers['my-http-server'].type).toBe('streamable-http');
        });

        it('未知模板返回空模板', () => {
            const t = generateTemplate('unknown');
            expect(t.mcpServers).toEqual({});
        });
    });

    // ========== getAvailableTemplates ==========
    describe('getAvailableTemplates', () => {
        it('返回非空数组', () => {
            const list = getAvailableTemplates();
            expect(Array.isArray(list)).toBe(true);
            expect(list.length).toBeGreaterThan(0);
        });

        it('每个模板有 id, name, description', () => {
            const list = getAvailableTemplates();
            for (const t of list) {
                expect(t.id).toBeTruthy();
                expect(t.name).toBeTruthy();
                expect(t.description).toBeTruthy();
            }
        });

        it('不包含 empty 模板（转换得 0 服务器，点击必报错）', () => {
            const list = getAvailableTemplates();
            expect(list.find((t) => t.id === 'empty')).toBeUndefined();
        });
    });

    // ========== 双向转换一致性 ==========
    describe('双向转换', () => {
        it('本地服务器: standard → internal → standard 保留核心字段', () => {
            const original = {
                mcpServers: {
                    fs: {
                        command: 'npx',
                        args: ['-y', 'server'],
                        env: { KEY: 'val' },
                        cwd: '/home'
                    }
                }
            };
            const internal = standardToInternal(original);
            const roundTrip = internalToStandard(internal);
            expect(roundTrip.mcpServers.fs.command).toBe('npx');
            expect(roundTrip.mcpServers.fs.args).toEqual(['-y', 'server']);
            expect(roundTrip.mcpServers.fs.env).toEqual({ KEY: 'val' });
            expect(roundTrip.mcpServers.fs.cwd).toBe('/home');
        });

        it('远程 SSE 服务器: standard → internal → standard 保留核心字段', () => {
            const original = {
                mcpServers: {
                    sse: {
                        type: 'sse',
                        url: 'http://localhost:8001/sse'
                    }
                }
            };
            const internal = standardToInternal(original);
            const roundTrip = internalToStandard(internal);
            expect(roundTrip.mcpServers.sse.url).toBe('http://localhost:8001/sse');
            expect(roundTrip.mcpServers.sse.type).toBe('sse');
        });
    });
});
