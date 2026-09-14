/**
 * 文本编辑器模块
 * 使用 Node.js fs API 进行文件读写
 */

const fs = require('fs').promises;
const path = require('path');

function assertInsideRoot(rootPath, targetPath) {
    const relative = path.relative(rootPath, targetPath);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error('文件路径必须位于 Computer Use 工作目录内');
    }
}

async function resolveSafePath(filePath, rootPath = process.cwd(), allowMissing = false) {
    if (typeof filePath !== 'string' || !filePath.trim()) {
        throw new Error('文件路径不能为空');
    }
    if (typeof rootPath !== 'string' || !rootPath.trim()) {
        rootPath = process.cwd();
    }

    const realRoot = await fs.realpath(path.resolve(rootPath));
    const candidate = path.resolve(realRoot, filePath);
    assertInsideRoot(realRoot, candidate);

    try {
        const realTarget = await fs.realpath(candidate);
        assertInsideRoot(realRoot, realTarget);
        return realTarget;
    } catch (error) {
        if (!allowMissing || error.code !== 'ENOENT') throw error;

        let ancestor = path.dirname(candidate);
        while (ancestor !== realRoot) {
            try {
                const realAncestor = await fs.realpath(ancestor);
                assertInsideRoot(realRoot, realAncestor);
                return candidate;
            } catch (ancestorError) {
                if (ancestorError.code !== 'ENOENT') throw ancestorError;
                const parent = path.dirname(ancestor);
                if (parent === ancestor) break;
                ancestor = parent;
            }
        }
        return candidate;
    }
}

/**
 * 读取文件内容
 * @param {string} filePath - 文件路径
 * @returns {Promise<{content: string, size: number}>}
 */
async function read(filePath, options = {}) {
    try {
        const absolutePath = await resolveSafePath(filePath, options.rootDir);
        const content = await fs.readFile(absolutePath, 'utf-8');
        const stats = await fs.stat(absolutePath);

        console.log(`[TextEditor] Read file: ${absolutePath} (${stats.size} bytes)`);

        return {
            content,
            size: stats.size,
            path: absolutePath
        };
    } catch (error) {
        console.error('[TextEditor] Read error:', error);
        throw error;
    }
}

/**
 * 写入文件内容
 * @param {string} filePath - 文件路径
 * @param {string} content - 文件内容
 * @returns {Promise<{path: string, size: number}>}
 */
async function write(filePath, content, options = {}) {
    try {
        const absolutePath = await resolveSafePath(filePath, options.rootDir, true);

        const directory = path.dirname(absolutePath);
        await fs.mkdir(directory, { recursive: true });

        // 写入文件
        await fs.writeFile(absolutePath, content, 'utf-8');

        const stats = await fs.stat(absolutePath);

        console.log(`[TextEditor] Wrote file: ${absolutePath} (${stats.size} bytes)`);

        return {
            path: absolutePath,
            size: stats.size
        };
    } catch (error) {
        console.error('[TextEditor] Write error:', error);
        throw error;
    }
}

/**
 * 在文件末尾追加内容
 * @param {string} filePath - 文件路径
 * @param {string} content - 要追加的内容
 */
async function append(filePath, content, options = {}) {
    try {
        const absolutePath = await resolveSafePath(filePath, options.rootDir);
        await fs.appendFile(absolutePath, content, 'utf-8');

        const stats = await fs.stat(absolutePath);

        console.log(`[TextEditor] Appended to file: ${absolutePath} (${stats.size} bytes total)`);

        return {
            path: absolutePath,
            size: stats.size
        };
    } catch (error) {
        console.error('[TextEditor] Append error:', error);
        throw error;
    }
}

/**
 * 检查文件是否存在
 * @param {string} filePath - 文件路径
 */
async function exists(filePath, options = {}) {
    try {
        const absolutePath = await resolveSafePath(filePath, options.rootDir);
        await fs.access(absolutePath);
        return true;
    } catch {
        return false;
    }
}

/**
 * 删除文件
 * @param {string} filePath - 文件路径
 */
async function remove(filePath, options = {}) {
    try {
        const absolutePath = await resolveSafePath(filePath, options.rootDir);
        await fs.unlink(absolutePath);

        console.log(`[TextEditor] Deleted file: ${absolutePath}`);

        return {
            path: absolutePath,
            deleted: true
        };
    } catch (error) {
        console.error('[TextEditor] Delete error:', error);
        throw error;
    }
}

/**
 * 获取文件信息
 * @param {string} filePath - 文件路径
 */
async function getInfo(filePath, options = {}) {
    try {
        const absolutePath = await resolveSafePath(filePath, options.rootDir);
        const stats = await fs.stat(absolutePath);

        return {
            path: absolutePath,
            size: stats.size,
            isFile: stats.isFile(),
            isDirectory: stats.isDirectory(),
            created: stats.birthtime,
            modified: stats.mtime,
            accessed: stats.atime
        };
    } catch (error) {
        console.error('[TextEditor] Get info error:', error);
        throw error;
    }
}

module.exports = {
    read,
    write,
    append,
    exists,
    remove,
    getInfo
};
