/**
 * MCP tool-cache.js 测试
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../js/utils/logger.js', () => ({
    logger: { warn: vi.fn(), debug: vi.fn(), error: vi.fn() }
}));

import {
    cacheTools,
    getCachedTools,
    clearToolCache,
    clearAllToolCaches
} from '../../../js/tools/mcp/tool-cache.js';

describe('tool-cache', () => {
    beforeEach(() => {
        localStorage.clear();
    });

    describe('cacheTools', () => {
        it('缓存工具列表到 localStorage', () => {
            const tools = [{ name: 'tool1' }, { name: 'tool2' }];
            cacheTools('server1', tools);
            const raw = localStorage.getItem('mcp-tools-server1');
            expect(raw).toBeTruthy();
            const parsed = JSON.parse(raw);
            expect(parsed.tools).toEqual(tools);
            expect(typeof parsed.timestamp).toBe('number');
        });

        it('不同 serverId 独立缓存', () => {
            cacheTools('s1', [{ name: 'a' }]);
            cacheTools('s2', [{ name: 'b' }]);
            expect(JSON.parse(localStorage.getItem('mcp-tools-s1')).tools[0].name).toBe('a');
            expect(JSON.parse(localStorage.getItem('mcp-tools-s2')).tools[0].name).toBe('b');
        });

        it('localStorage 满时不抛错', () => {
            const origSetItem = Storage.prototype.setItem;
            Storage.prototype.setItem = () => {
                throw new Error('QuotaExceededError');
            };
            expect(() => cacheTools('s1', [{ name: 'a' }])).not.toThrow();
            Storage.prototype.setItem = origSetItem;
        });
    });

    describe('getCachedTools', () => {
        it('返回缓存的工具列表', () => {
            const tools = [{ name: 'tool1' }];
            cacheTools('server1', tools);
            const result = getCachedTools('server1');
            expect(result).toEqual(tools);
        });

        it('不存在时返回 null', () => {
            expect(getCachedTools('nonexistent')).toBeNull();
        });

        it('过期时返回 null 并清除缓存', () => {
            localStorage.setItem(
                'mcp-tools-expired',
                JSON.stringify({
                    tools: [{ name: 'old' }],
                    timestamp: Date.now() - 25 * 3600 * 1000 // 25小时前
                })
            );
            expect(getCachedTools('expired')).toBeNull();
            expect(localStorage.getItem('mcp-tools-expired')).toBeNull();
        });

        it('自定义 maxAge 生效', () => {
            localStorage.setItem(
                'mcp-tools-custom',
                JSON.stringify({
                    tools: [{ name: 'x' }],
                    timestamp: Date.now() - 5000
                })
            );
            expect(getCachedTools('custom', 3000)).toBeNull();
            expect(getCachedTools('custom2', 10000)).toBeNull(); // 不存在
        });

        it('JSON 解析失败返回 null', () => {
            localStorage.setItem('mcp-tools-bad', 'invalid json');
            expect(getCachedTools('bad')).toBeNull();
        });
    });

    describe('clearToolCache', () => {
        it('清除指定服务器的缓存', () => {
            cacheTools('s1', [{ name: 'a' }]);
            cacheTools('s2', [{ name: 'b' }]);
            clearToolCache('s1');
            expect(localStorage.getItem('mcp-tools-s1')).toBeNull();
            expect(localStorage.getItem('mcp-tools-s2')).toBeTruthy();
        });

        it('清除不存在的缓存不抛错', () => {
            expect(() => clearToolCache('nonexistent')).not.toThrow();
        });
    });

    describe('clearAllToolCaches', () => {
        it('清除所有 MCP 工具缓存', () => {
            cacheTools('s1', []);
            cacheTools('s2', []);
            localStorage.setItem('other-key', 'value');
            clearAllToolCaches();
            expect(localStorage.getItem('mcp-tools-s1')).toBeNull();
            expect(localStorage.getItem('mcp-tools-s2')).toBeNull();
            expect(localStorage.getItem('other-key')).toBe('value');
        });

        it('无缓存时不抛错', () => {
            expect(() => clearAllToolCaches()).not.toThrow();
        });
    });
});
