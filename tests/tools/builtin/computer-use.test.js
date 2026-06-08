/**
 * computer-use.js 测试
 * Computer Use 工具：bash 执行、文件编辑
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../js/tools/build-tool.js', () => ({
    buildToolFromLegacy: vi.fn((id, def, handler, opts) => ({
        id,
        name: def.name || id,
        description: def.description || '',
        parameters: def.parameters,
        type: 'builtin',
        enabled: true,
        hidden: def.hidden || false,
        call: handler
    }))
}));

vi.mock('../../../js/utils/logger.js', () => ({
    logger: {
        debug: vi.fn(),
        error: vi.fn(),
        warn: vi.fn()
    }
}));

// mock electronAPI
const mockElectronAPI = {
    isElectron: vi.fn(() => true),
    computerUse_executeBash: vi.fn(),
    computerUse_readFile: vi.fn(),
    computerUse_writeFile: vi.fn()
};

vi.stubGlobal('window', { electronAPI: mockElectronAPI });

import { computerUseTool, computerUseHandler } from '../../../js/tools/builtin/computer-use.js';

beforeEach(() => {
    vi.clearAllMocks();
    mockElectronAPI.isElectron.mockReturnValue(true);
});

describe('computerUseTool 定义', () => {
    it('名称为 computer', () => {
        expect(computerUseTool.name).toBe('computer');
    });

    it('hidden 为 true', () => {
        expect(computerUseTool.hidden).toBe(true);
    });

    it('action 为必填', () => {
        expect(computerUseTool.parameters.required).toContain('action');
    });

    it('action 枚举包含 bash 和 str_replace_editor', () => {
        const action = computerUseTool.parameters.properties.action;
        expect(action.enum).toContain('bash');
        expect(action.enum).toContain('str_replace_editor');
    });

    it('包含 text 参数', () => {
        expect(computerUseTool.parameters.properties.text).toBeDefined();
    });

    it('包含 path 参数', () => {
        expect(computerUseTool.parameters.properties.path).toBeDefined();
    });

    it('包含 old_str 和 new_str 参数', () => {
        expect(computerUseTool.parameters.properties.old_str).toBeDefined();
        expect(computerUseTool.parameters.properties.new_str).toBeDefined();
    });
});

describe('computerUseHandler - 环境检查', () => {
    it('非 Electron 环境抛出错误', async () => {
        mockElectronAPI.isElectron.mockReturnValue(false);
        await expect(computerUseHandler({ action: 'bash', text: 'ls' })).rejects.toThrow(
            'Electron'
        );
    });

    it('未知 action 抛出错误', async () => {
        await expect(computerUseHandler({ action: 'unknown' })).rejects.toThrow('Unknown action');
    });
});

describe('computerUseHandler - bash', () => {
    it('使用 text 参数执行 bash', async () => {
        mockElectronAPI.computerUse_executeBash.mockResolvedValue({
            success: true,
            stdout: 'hello',
            stderr: '',
            exitCode: 0
        });
        const result = await computerUseHandler({ action: 'bash', text: 'echo hello' });
        expect(result.stdout).toBe('hello');
        expect(result.exitCode).toBe(0);
    });

    it('使用 command 参数执行 bash', async () => {
        mockElectronAPI.computerUse_executeBash.mockResolvedValue({
            success: true,
            stdout: 'ok',
            stderr: '',
            exitCode: 0
        });
        const result = await computerUseHandler({ action: 'bash', command: 'echo ok' });
        expect(result.stdout).toBe('ok');
    });

    it('使用 bash_command 参数执行 bash', async () => {
        mockElectronAPI.computerUse_executeBash.mockResolvedValue({
            success: true,
            stdout: 'done',
            stderr: '',
            exitCode: 0
        });
        const result = await computerUseHandler({ action: 'bash', bash_command: 'echo done' });
        expect(result.stdout).toBe('done');
    });

    it('缺少命令参数抛出错误', async () => {
        await expect(computerUseHandler({ action: 'bash' })).rejects.toThrow(
            'Missing bash command'
        );
    });

    it('执行失败抛出错误', async () => {
        mockElectronAPI.computerUse_executeBash.mockResolvedValue({
            success: false,
            error: 'command not found'
        });
        await expect(computerUseHandler({ action: 'bash', text: 'xyz' })).rejects.toThrow(
            'command not found'
        );
    });

    it('执行失败无错误消息使用默认', async () => {
        mockElectronAPI.computerUse_executeBash.mockResolvedValue({
            success: false
        });
        await expect(computerUseHandler({ action: 'bash', text: 'xyz' })).rejects.toThrow(
            'Bash execution failed'
        );
    });
});

describe('computerUseHandler - str_replace_editor', () => {
    it('view 命令', async () => {
        mockElectronAPI.computerUse_readFile.mockResolvedValue({
            success: true,
            content: 'file content'
        });
        const result = await computerUseHandler({
            action: 'str_replace_editor',
            command: 'view',
            path: '/test.txt'
        });
        expect(result).toBeDefined();
    });

    it('view 缺少 path 抛出错误', async () => {
        await expect(
            computerUseHandler({ action: 'str_replace_editor', command: 'view' })
        ).rejects.toThrow();
    });

    it('create 命令', async () => {
        mockElectronAPI.computerUse_writeFile.mockResolvedValue({ success: true });
        const result = await computerUseHandler({
            action: 'str_replace_editor',
            command: 'create',
            path: '/new.txt',
            file_text: 'hello'
        });
        expect(result).toBeDefined();
    });

    it('create 缺少 path 抛出错误', async () => {
        await expect(
            computerUseHandler({
                action: 'str_replace_editor',
                command: 'create',
                file_text: 'hello'
            })
        ).rejects.toThrow();
    });

    it('str_replace 命令', async () => {
        mockElectronAPI.computerUse_readFile.mockResolvedValue({
            success: true,
            content: 'hello old world'
        });
        mockElectronAPI.computerUse_writeFile.mockResolvedValue({ success: true });
        const result = await computerUseHandler({
            action: 'str_replace_editor',
            command: 'str_replace',
            path: '/test.txt',
            old_str: 'old',
            new_str: 'new'
        });
        expect(result).toBeDefined();
    });

    it('insert 命令', async () => {
        mockElectronAPI.computerUse_readFile.mockResolvedValue({
            success: true,
            content: 'line1\nline2\nline3'
        });
        mockElectronAPI.computerUse_writeFile.mockResolvedValue({ success: true });
        const result = await computerUseHandler({
            action: 'str_replace_editor',
            command: 'insert',
            path: '/test.txt',
            insert_line: 2,
            file_text: 'new line'
        });
        expect(result).toBeDefined();
    });

    it('未知 command 抛出错误', async () => {
        await expect(
            computerUseHandler({
                action: 'str_replace_editor',
                command: 'unknown',
                path: '/test.txt'
            })
        ).rejects.toThrow('Unknown editor command');
    });

    it('缺少 command 抛出错误', async () => {
        await expect(
            computerUseHandler({ action: 'str_replace_editor', path: '/test.txt' })
        ).rejects.toThrow('command is required');
    });
});
