/**
 * computer-commands.js 测试：命令执行与文件编辑（原生工具与 XML 内置工具共用）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockElectronAPI = {
    computerUse_executeBash: vi.fn(),
    computerUse_readFile: vi.fn(),
    computerUse_writeFile: vi.fn()
};

vi.stubGlobal('window', { electronAPI: mockElectronAPI });

import {
    resolveBashCommand,
    resolveInsertText,
    runBashCommand,
    runTextEditorCommand
} from '../../js/tools/computer-commands.js';

beforeEach(() => {
    vi.clearAllMocks();
    mockElectronAPI.computerUse_writeFile.mockImplementation(async (path, content) => ({
        success: true,
        path,
        size: content.length
    }));
});

function readsFile(content) {
    mockElectronAPI.computerUse_readFile.mockResolvedValue({ success: true, content, size: 1 });
}

function writtenContent() {
    return mockElectronAPI.computerUse_writeFile.mock.calls.at(-1)?.[1];
}

describe('runBashCommand', () => {
    it('命令跑完时返回输出，非零退出码也交给模型而不是报错', async () => {
        mockElectronAPI.computerUse_executeBash.mockResolvedValue({
            success: false,
            stdout: '',
            stderr: 'error TS2304',
            exitCode: 2
        });

        await expect(runBashCommand({ command: 'npx tsc' })).resolves.toEqual({
            stdout: '',
            stderr: 'error TS2304',
            exitCode: 2
        });
    });

    it('主进程没能运行命令时报错', async () => {
        mockElectronAPI.computerUse_executeBash.mockResolvedValue({
            success: false,
            error: 'bash 权限未授权'
        });

        await expect(runBashCommand({ command: 'ls' })).rejects.toThrow('bash 权限未授权');
    });

    it('restart 不执行命令，直接回复已重启', async () => {
        await expect(runBashCommand({ restart: true })).resolves.toEqual({
            content: 'Bash session restarted.'
        });
        expect(mockElectronAPI.computerUse_executeBash).not.toHaveBeenCalled();
    });

    it('取第一个非空的命令字段，与确认弹窗显示的一致', () => {
        expect(resolveBashCommand({ text: '', command: 'ls -la' })).toBe('ls -la');
        expect(resolveBashCommand({ bash_command: 'pwd' })).toBe('pwd');
        expect(resolveBashCommand({})).toBeUndefined();
    });

    it('缺少命令时报错', async () => {
        await expect(runBashCommand({})).rejects.toThrow('Missing bash command');
    });
});

describe('runTextEditorCommand', () => {
    it("str_replace 原样写入替换文本，$& 与 $' 不被当成替换模式", async () => {
        readsFile('const price = OLD;');

        await runTextEditorCommand({
            command: 'str_replace',
            path: 'a.js',
            old_str: 'OLD',
            new_str: "`$&$'$$`"
        });

        expect(writtenContent()).toBe("const price = `$&$'$$`;");
    });

    it('str_replace 找不到或不唯一时报错，缺少 new_str 时不写入', async () => {
        readsFile('a a');
        await expect(
            runTextEditorCommand({ command: 'str_replace', path: 'f', old_str: 'b', new_str: '' })
        ).rejects.toThrow('old_str not found');
        await expect(
            runTextEditorCommand({ command: 'str_replace', path: 'f', old_str: 'a', new_str: '' })
        ).rejects.toThrow('found 2 times');
        await expect(
            runTextEditorCommand({ command: 'str_replace', path: 'f', old_str: 'a' })
        ).rejects.toThrow('new_str is required');
        expect(mockElectronAPI.computerUse_writeFile).not.toHaveBeenCalled();
    });

    it('insert 读原生工具的 insert_text，插在指定行之后', async () => {
        readsFile('line1\nline2');

        await runTextEditorCommand({
            command: 'insert',
            path: 'f',
            insert_line: 1,
            insert_text: 'inserted'
        });

        expect(writtenContent()).toBe('line1\ninserted\nline2');
    });

    it('insert 兼容 XML 内置工具的 file_text 与字符串行号，行号越界时报错', async () => {
        readsFile('line1');

        await runTextEditorCommand({
            command: 'insert',
            path: 'f',
            insert_line: '0',
            file_text: 'top'
        });
        expect(writtenContent()).toBe('top\nline1');

        await expect(
            runTextEditorCommand({ command: 'insert', path: 'f', insert_line: 5, file_text: 'x' })
        ).rejects.toThrow('Invalid insert_line');
    });

    it('insert 文本字段的优先级：insert_text → new_str → file_text', () => {
        expect(resolveInsertText({ insert_text: 'a', new_str: 'b', file_text: 'c' })).toBe('a');
        expect(resolveInsertText({ new_str: 'b', file_text: 'c' })).toBe('b');
        expect(resolveInsertText({ file_text: 'c' })).toBe('c');
    });

    it('view 支持 view_range，-1 表示到文件末尾', async () => {
        readsFile('1\n2\n3\n4');

        await expect(
            runTextEditorCommand({ command: 'view', path: 'f', view_range: [2, 3] })
        ).resolves.toMatchObject({ content: '2\n3' });
        await expect(
            runTextEditorCommand({ command: 'view', path: 'f', view_range: [3, -1] })
        ).resolves.toMatchObject({ content: '3\n4' });
        await expect(
            runTextEditorCommand({ command: 'view', path: 'f', view_range: [0, 2] })
        ).rejects.toThrow('Invalid view_range');
    });

    it('主进程读写失败时报错，不当成成功结果', async () => {
        mockElectronAPI.computerUse_readFile.mockResolvedValue({
            success: false,
            error: 'Text editor permission denied'
        });
        await expect(runTextEditorCommand({ command: 'view', path: 'f' })).rejects.toThrow(
            'Text editor permission denied'
        );

        mockElectronAPI.computerUse_writeFile.mockResolvedValue({
            success: false,
            error: '文件路径必须位于 Computer Use 工作目录内'
        });
        await expect(
            runTextEditorCommand({ command: 'create', path: '../x', file_text: '' })
        ).rejects.toThrow('工作目录内');
    });

    it('create 允许写入空文件', async () => {
        await expect(
            runTextEditorCommand({ command: 'create', path: 'empty.txt', file_text: '' })
        ).resolves.toEqual({ path: 'empty.txt', size: 0 });
    });

    it('undo_edit 与未知命令报错', async () => {
        await expect(runTextEditorCommand({ command: 'undo_edit', path: 'f' })).rejects.toThrow(
            'not supported'
        );
        await expect(runTextEditorCommand({ command: 'rename', path: 'f' })).rejects.toThrow(
            'Unknown editor command'
        );
        await expect(runTextEditorCommand({ path: 'f' })).rejects.toThrow('command is required');
    });
});
