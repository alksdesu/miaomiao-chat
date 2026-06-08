/**
 * executor.js 测试
 * 工具执行引擎: executeTool, executeToolsBatch, safeExecuteTool, cancelToolExecution
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../js/tools/manager.js', () => ({
    getTool: vi.fn()
}));

vi.mock('../../js/tools/validator.js', () => ({
    safeValidate: vi.fn(() => ({ valid: true, errors: [] })),
    formatValidationErrors: vi.fn((errors) => errors.join(', '))
}));

vi.mock('../../js/tools/rate-limiter.js', () => ({
    checkRateLimit: vi.fn()
}));

vi.mock('../../js/utils/platform.js', () => ({
    isElectron: vi.fn(() => false)
}));

vi.mock('../../js/tools/permissions.js', () => ({
    checkToolPermission: vi.fn(() => ({ allowed: true, reason: 'permissions_disabled' }))
}));

vi.mock('../../js/tools/history.js', () => ({
    recordToolCall: vi.fn()
}));

vi.mock('../../js/core/state.js', () => ({
    state: {
        apiFormat: 'openai',
        xmlToolCallingEnabled: false
    }
}));

import { getTool } from '../../js/tools/manager.js';
import { safeValidate } from '../../js/tools/validator.js';
import {
    executeTool,
    executeToolsBatch,
    safeExecuteTool,
    cancelToolExecution,
    executeCancelable
} from '../../js/tools/executor.js';

beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks 不重置 mockReturnValue，需手动还原默认
    safeValidate.mockReturnValue({ valid: true, errors: [] });
});

describe('executeTool', () => {
    it('执行已注册工具', async () => {
        const mockResult = { success: true, data: 'hello' };
        getTool.mockReturnValue({
            id: 'test-exec',
            name: 'test-exec',
            enabled: true,
            call: vi.fn().mockResolvedValue(mockResult),
            inputSchema: { type: 'object', properties: {} }
        });

        const result = await executeTool('test-exec', {});
        expect(result).toEqual(mockResult);
    });

    it('工具不存在时抛出错误', async () => {
        getTool.mockReturnValue(null);
        await expect(executeTool('nonexistent', {})).rejects.toThrow('工具不存在');
    });

    it('参数验证失败时抛出错误', async () => {
        getTool.mockReturnValue({
            id: 'validate-fail',
            name: 'validate-fail',
            call: vi.fn(),
            inputSchema: { type: 'object', properties: {} }
        });
        safeValidate.mockReturnValue({
            valid: false,
            errors: ['missing required field']
        });

        await expect(executeTool('validate-fail', {})).rejects.toThrow();
    });

    it('工具执行失败时抛出错误', async () => {
        getTool.mockReturnValue({
            id: 'exec-fail',
            name: 'exec-fail',
            call: vi.fn().mockRejectedValue(new Error('tool crashed')),
            inputSchema: { type: 'object', properties: {} }
        });

        await expect(executeTool('exec-fail', {})).rejects.toThrow('tool crashed');
    });

    it('传递参数到 tool.call', async () => {
        const callFn = vi.fn().mockResolvedValue({ ok: true });
        getTool.mockReturnValue({
            id: 'args-test',
            name: 'args-test',
            call: callFn,
            inputSchema: { type: 'object', properties: {} }
        });

        await executeTool('args-test', { foo: 'bar' });
        expect(callFn).toHaveBeenCalledWith({ foo: 'bar' }, expect.any(Object));
    });

    it('MCP 工具 ID 格式转换 (serverId/toolName -> serverId__toolName)', async () => {
        getTool.mockReturnValueOnce(null); // 第一次 getTool('server/tool') 返回 null
        getTool.mockReturnValue({
            id: 'server__tool',
            name: 'tool',
            call: vi.fn().mockResolvedValue({ ok: true }),
            inputSchema: { type: 'object', properties: {} }
        });

        const result = await executeTool('server/tool', {});
        expect(result).toEqual({ ok: true });
    });
});

describe('executeToolsBatch', () => {
    it('并行执行多个工具', async () => {
        getTool.mockReturnValue({
            id: 'batch-tool',
            name: 'batch-tool',
            call: vi.fn().mockResolvedValue({ data: 'ok' }),
            inputSchema: { type: 'object', properties: {} }
        });

        const results = await executeToolsBatch([
            { toolId: 'batch-tool', args: {} },
            { toolId: 'batch-tool', args: {} }
        ]);

        expect(results.length).toBe(2);
        expect(results[0].success).toBe(true);
        expect(results[1].success).toBe(true);
    });

    it('单个失败不影响其他', async () => {
        let callCount = 0;
        getTool.mockReturnValue({
            id: 'mixed',
            name: 'mixed',
            call: vi.fn().mockImplementation(() => {
                callCount++;
                if (callCount === 1) return Promise.reject(new Error('fail'));
                return Promise.resolve({ ok: true });
            }),
            inputSchema: { type: 'object', properties: {} }
        });

        const results = await executeToolsBatch([
            { toolId: 'mixed', args: {} },
            { toolId: 'mixed', args: {} }
        ]);

        expect(results[0].success).toBe(false);
        expect(results[1].success).toBe(true);
    });
});

describe('safeExecuteTool', () => {
    it('成功时返回 success: true', async () => {
        getTool.mockReturnValue({
            id: 'safe-ok',
            name: 'safe-ok',
            call: vi.fn().mockResolvedValue({ data: 1 }),
            inputSchema: { type: 'object', properties: {} }
        });

        const result = await safeExecuteTool('safe-ok', {});
        expect(result.success).toBe(true);
        expect(result.result).toEqual({ data: 1 });
    });

    it('失败时返回 success: false', async () => {
        getTool.mockReturnValue({
            id: 'safe-fail',
            name: 'safe-fail',
            call: vi.fn().mockRejectedValue(new Error('oops')),
            inputSchema: { type: 'object', properties: {} }
        });

        const result = await safeExecuteTool('safe-fail', {});
        expect(result.success).toBe(false);
        expect(result.error).toBe('oops');
    });
});

describe('cancelToolExecution', () => {
    it('未运行的工具返回 false', () => {
        expect(cancelToolExecution('nonexistent-exec')).toBe(false);
    });

    it('运行中的工具返回 true', async () => {
        let resolveExec;
        const promise = new Promise((r) => {
            resolveExec = r;
        });

        getTool.mockReturnValue({
            id: 'cancel-test',
            name: 'cancel-test',
            call: vi.fn().mockReturnValue(promise),
            inputSchema: { type: 'object', properties: {} }
        });

        const execPromise = executeCancelable('exec-1', 'cancel-test', {});

        const canceled = cancelToolExecution('exec-1');
        expect(canceled).toBe(true);

        resolveExec({ ok: true });
        const result = await execPromise;
        expect(result.canceled).toBe(true);
    });
});
