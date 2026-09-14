import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import textEditor from '../../electron/computer-use/text-editor.js';

let rootDir;

afterEach(async () => {
    if (rootDir) await rm(rootDir, { recursive: true, force: true });
    rootDir = null;
});

describe('computer use text editor', () => {
    it('只允许访问工作目录内的文件', async () => {
        rootDir = await mkdtemp(join(tmpdir(), 'webchat-editor-'));
        await writeFile(join(rootDir, 'inside.txt'), 'hello');

        await expect(textEditor.read('inside.txt', { rootDir })).resolves.toMatchObject({
            content: 'hello'
        });
        await expect(textEditor.read('../outside.txt', { rootDir })).rejects.toThrow('工作目录内');
    });

    it('拒绝指向工作目录外部的符号链接', async () => {
        rootDir = await mkdtemp(join(tmpdir(), 'webchat-editor-'));
        const outsideDir = await mkdtemp(join(tmpdir(), 'webchat-outside-'));
        await writeFile(join(outsideDir, 'secret.txt'), 'secret');
        await symlink(outsideDir, join(rootDir, 'linked-dir'));

        await expect(textEditor.read('linked-dir/secret.txt', { rootDir })).rejects.toThrow(
            '工作目录内'
        );
        await rm(outsideDir, { recursive: true, force: true });
    });

    it('允许在工作目录内创建缺失的父目录', async () => {
        rootDir = await mkdtemp(join(tmpdir(), 'webchat-editor-'));
        const target = join('nested', 'new.txt');
        await expect(textEditor.write(target, 'created', { rootDir })).resolves.toMatchObject({
            size: 7
        });
        await expect(readFile(join(rootDir, target), 'utf8')).resolves.toBe('created');
        await expect(mkdir(join(rootDir, 'nested'))).rejects.toThrow();
    });
});
