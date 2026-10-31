/**
 * download.js 下载工具测试：浏览器下载与 Android 本地保存
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../js/utils/platform.js', () => ({
    isAndroid: vi.fn(() => false)
}));

vi.mock('../../js/utils/logger.js', () => ({
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

import { isAndroid } from '../../js/utils/platform.js';
import { downloadBlob, downloadJSON, describeSavedLocation } from '../../js/utils/download.js';

const ANDROID_ROOT_URI = 'file:///storage/emulated/0';
const DIRECTORY_URIS = {
    DOCUMENTS: `${ANDROID_ROOT_URI}/Documents`,
    EXTERNAL: `${ANDROID_ROOT_URI}/Android/data/com.webchat.app/files`
};

/**
 * 内存版 Capacitor Filesystem：按目录 + 路径记录写入的 base64 片段
 */
function createFakeFilesystem({ failingDirectories = [], failingPaths = [], existing = [] } = {}) {
    const files = new Map(existing.map((key) => [key, ['']]));
    const keyOf = (directory, path) => `${directory}:${path}`;
    const failsFor = (directory, path) =>
        failingDirectories.includes(directory) || failingPaths.includes(keyOf(directory, path));
    return {
        files,
        checkPermissions: vi.fn(async () => ({ publicStorage: 'granted' })),
        requestPermissions: vi.fn(async () => ({ publicStorage: 'granted' })),
        stat: vi.fn(async ({ path, directory }) => {
            if (!files.has(keyOf(directory, path))) throw new Error('File does not exist');
            return { type: 'file' };
        }),
        writeFile: vi.fn(async ({ path, directory, data }) => {
            if (failsFor(directory, path)) throw new Error(`EACCES ${directory}`);
            files.set(keyOf(directory, path), [data]);
            return { uri: `${DIRECTORY_URIS[directory]}/${path}` };
        }),
        appendFile: vi.fn(async ({ path, directory, data }) => {
            files.get(keyOf(directory, path)).push(data);
        }),
        deleteFile: vi.fn(async ({ path, directory }) => {
            files.delete(keyOf(directory, path));
        })
    };
}

function decodeChunks(chunks) {
    return chunks.map((chunk) => atob(chunk)).join('');
}

describe('downloadBlob（浏览器）', () => {
    let clickSpy;

    beforeEach(() => {
        vi.useFakeTimers();
        isAndroid.mockReturnValue(false);
        URL.createObjectURL = vi.fn(() => 'blob:download-test');
        URL.revokeObjectURL = vi.fn();
        clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    });

    afterEach(() => {
        clickSpy.mockRestore();
        vi.useRealTimers();
    });

    it('点击时链接挂在文档上，点击后移除', async () => {
        let attachedAtClick = false;
        clickSpy.mockImplementation(function () {
            attachedAtClick = this.isConnected;
        });

        const result = await downloadBlob(new Blob(['x']), 'file.txt');

        const link = clickSpy.mock.contexts[0];
        expect(result).toEqual({ savedTo: null });
        expect(attachedAtClick).toBe(true);
        expect(link.download).toBe('file.txt');
        expect(link.href).toBe('blob:download-test');
        expect(link.isConnected).toBe(false);
    });

    it('object URL 延后释放，下载开始读取前不会失效', async () => {
        await downloadBlob(new Blob(['x']), 'file.txt');
        expect(URL.revokeObjectURL).not.toHaveBeenCalled();

        vi.runAllTimers();
        expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:download-test');
    });

    it('缺省文件名按时间戳生成', async () => {
        await downloadBlob(new Blob(['x']));
        expect(clickSpy.mock.contexts[0].download).toMatch(/^download-\d+$/);
    });

    it('downloadJSON 以缩进 JSON 写入 application/json Blob', async () => {
        await downloadJSON({ a: 1 }, 'data.json');

        const blob = URL.createObjectURL.mock.calls[0][0];
        expect(blob.type).toBe('application/json');
        expect(await blob.text()).toBe(JSON.stringify({ a: 1 }, null, 2));
        expect(clickSpy.mock.contexts[0].download).toBe('data.json');
    });
});

describe('describeSavedLocation', () => {
    it('有保存位置时附在提示后', () => {
        expect(describeSavedLocation('配置已导出', { savedTo: 'Documents/WebChat/a.json' })).toBe(
            '配置已导出（已保存到 Documents/WebChat/a.json）'
        );
    });

    it('浏览器下载原样返回', () => {
        expect(describeSavedLocation('配置已导出', { savedTo: null })).toBe('配置已导出');
        expect(describeSavedLocation('配置已导出', null)).toBe('配置已导出');
    });
});

describe('downloadBlob（Android）', () => {
    let filesystem;

    beforeEach(() => {
        isAndroid.mockReturnValue(true);
        URL.createObjectURL = vi.fn();
    });

    afterEach(() => {
        delete window.Capacitor;
    });

    function installFilesystem(options) {
        filesystem = createFakeFilesystem(options);
        window.Capacitor = { Plugins: { Filesystem: filesystem } };
        return filesystem;
    }

    it('写入公共 Documents 下的 WebChat 目录并返回保存位置，不走浏览器下载', async () => {
        installFilesystem();

        const result = await downloadBlob(new Blob(['hello']), 'note.txt');

        expect(result).toEqual({ savedTo: 'Documents/WebChat/note.txt' });
        expect(filesystem.writeFile).toHaveBeenCalledWith(
            expect.objectContaining({
                path: 'WebChat/note.txt',
                directory: 'DOCUMENTS',
                recursive: true
            })
        );
        expect(decodeChunks(filesystem.files.get('DOCUMENTS:WebChat/note.txt'))).toBe('hello');
        expect(URL.createObjectURL).not.toHaveBeenCalled();
    });

    it('大文件分块写入，拼起来与原内容一致', async () => {
        installFilesystem();
        const content = 'a'.repeat(3 * 1024 * 1024) + 'tail-bytes';

        await downloadBlob(new Blob([content]), 'big.bin');

        expect(filesystem.writeFile).toHaveBeenCalledTimes(1);
        expect(filesystem.appendFile).toHaveBeenCalledTimes(1);
        expect(decodeChunks(filesystem.files.get('DOCUMENTS:WebChat/big.bin'))).toBe(content);
    });

    it('空文件也会创建', async () => {
        installFilesystem();

        await downloadBlob(new Blob([]), 'empty.txt');

        expect(filesystem.files.get('DOCUMENTS:WebChat/empty.txt')).toEqual(['']);
    });

    it('同名文件已存在时另起名字', async () => {
        installFilesystem({
            existing: ['DOCUMENTS:WebChat/a.json', 'DOCUMENTS:WebChat/a (1).json']
        });

        const result = await downloadBlob(new Blob(['{}']), 'a.json');

        expect(result.savedTo).toBe('Documents/WebChat/a (2).json');
    });

    it('看不到的旧文件导致写入失败时，在同一目录换带时间戳的名字重试', async () => {
        installFilesystem({ failingPaths: ['DOCUMENTS:WebChat/a.json'] });

        const result = await downloadBlob(new Blob(['{}']), 'a.json');

        expect(result.savedTo).toMatch(/^Documents\/WebChat\/a-\d+\.json$/);
        expect(filesystem.deleteFile).toHaveBeenCalledWith({
            path: 'WebChat/a.json',
            directory: 'DOCUMENTS'
        });
    });

    it('Documents 写不进去时退到应用专属目录', async () => {
        installFilesystem({ failingDirectories: ['DOCUMENTS'] });

        const result = await downloadBlob(new Blob(['x']), 'x.txt');

        expect(result.savedTo).toBe('Android/data/com.webchat.app/files/WebChat/x.txt');
        expect(filesystem.files.has('DOCUMENTS:WebChat/x.txt')).toBe(false);
    });

    it('所有目录都写不进去时 reject', async () => {
        installFilesystem({ failingDirectories: ['DOCUMENTS', 'EXTERNAL'] });

        await expect(downloadBlob(new Blob(['x']), 'x.txt')).rejects.toThrow('EACCES EXTERNAL');
    });

    it('未授权时先申请存储权限，已授权时不再申请', async () => {
        installFilesystem();
        filesystem.checkPermissions.mockResolvedValueOnce({ publicStorage: 'prompt' });
        await downloadBlob(new Blob(['x']), 'x.txt');
        expect(filesystem.requestPermissions).toHaveBeenCalledTimes(1);

        await downloadBlob(new Blob(['x']), 'y.txt');
        expect(filesystem.requestPermissions).toHaveBeenCalledTimes(1);
    });

    it('文件名里的路径分隔符与保留字符不会把文件写出下载目录', async () => {
        installFilesystem();

        const result = await downloadBlob(new Blob(['x']), '../evil:name?.json');

        expect(result.savedTo).toBe('Documents/WebChat/.._evil_name_.json');
        expect(filesystem.writeFile.mock.calls[0][0].path).toBe('WebChat/.._evil_name_.json');
    });

    it('Filesystem 插件不可用时退回浏览器下载', async () => {
        delete window.Capacitor;
        URL.createObjectURL = vi.fn(() => 'blob:fallback');
        URL.revokeObjectURL = vi.fn();
        const clickSpy = vi
            .spyOn(HTMLAnchorElement.prototype, 'click')
            .mockImplementation(() => {});

        try {
            const result = await downloadBlob(new Blob(['x']), 'x.txt');
            expect(result).toEqual({ savedTo: null });
            expect(clickSpy).toHaveBeenCalledTimes(1);
        } finally {
            clickSpy.mockRestore();
        }
    });
});
