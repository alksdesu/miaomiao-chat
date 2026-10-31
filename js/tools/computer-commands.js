/**
 * Computer Use 的命令执行与文件编辑：Claude 原生 bash / str_replace_based_edit_tool
 * 与 XML 模式内置 computer 工具共用；路径限制在工作目录内由主进程负责
 */

// 主进程没能完成调用时返回 {success:false, error} 而不是抛错
function unwrapMainResult(result, failureMessage) {
    if (!result || result.success === false) {
        throw new Error(result?.error || failureMessage);
    }
    return result;
}

function firstNonEmptyString(...values) {
    return values.find((value) => typeof value === 'string' && value.trim());
}

// XML 模式的参数可能把行号写成字符串
function toInteger(value) {
    if (typeof value === 'string' && value.trim() !== '') return Number(value);
    return value;
}

// ========== bash ==========

/**
 * 实际要执行的命令；确认弹窗与执行共用，弹窗里看到的就是会执行的
 * @param {Object} args 原生 bash 的 { command }，或 XML 内置工具的 text / command / bash_command
 * @returns {string|undefined}
 */
export function resolveBashCommand(args = {}) {
    return firstNonEmptyString(args.text, args.command, args.bash_command);
}

/**
 * 执行一条命令：命令跑完（含非零退出码）时把输出交给模型，没能运行时报错
 * @param {Object} args 原生 bash 的 { command, restart }，或 XML 内置工具的 text / command / bash_command
 * @returns {Promise<{ stdout: string, stderr: string, exitCode: number }|{ content: string }>}
 */
export async function runBashCommand(args = {}) {
    // 每条命令都在新进程里执行，没有需要重启的会话
    if (args.restart === true) return { content: 'Bash session restarted.' };
    const command = resolveBashCommand(args);
    if (!command) {
        throw new Error(
            'Missing bash command parameter. Expected one of: command, text, or bash_command'
        );
    }

    const result = await window.electronAPI.computerUse_executeBash(command);
    // 命令跑完时一定带 exitCode；只有 {success:false, error} 说明命令没能运行
    if (!result || result.exitCode === undefined) {
        throw new Error(result?.error || 'Bash execution failed');
    }
    return {
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
        exitCode: result.exitCode
    };
}

// ========== 文件编辑 ==========

function requirePath(path, command) {
    if (typeof path !== 'string' || !path.trim()) {
        throw new Error(`path is required for ${command} command`);
    }
    return path;
}

async function readText(path) {
    return unwrapMainResult(
        await window.electronAPI.computerUse_readFile(path),
        `Read file failed: ${path}`
    );
}

async function writeText(path, content) {
    return unwrapMainResult(
        await window.electronAPI.computerUse_writeFile(path, content),
        `Write file failed: ${path}`
    );
}

/**
 * view_range 为 [起始行, 结束行]，行号从 1 开始，结束行 -1 表示到文件末尾
 */
function sliceLines(content, viewRange) {
    if (viewRange === undefined || viewRange === null) return content;
    const lines = content.split('\n');
    const [start, end] = (Array.isArray(viewRange) ? viewRange : []).map(toInteger);
    const last = end === -1 ? lines.length : end;
    if (
        !Number.isInteger(start) ||
        !Number.isInteger(last) ||
        start < 1 ||
        last < start ||
        last > lines.length
    ) {
        throw new Error(
            `Invalid view_range ${JSON.stringify(viewRange)}: the file has ${lines.length} lines`
        );
    }
    return lines.slice(start - 1, last).join('\n');
}

async function viewFile(path, viewRange) {
    const result = await readText(requirePath(path, 'view'));
    return { content: sliceLines(result.content, viewRange), size: result.size };
}

async function createFile(path, fileText) {
    requirePath(path, 'create');
    if (typeof fileText !== 'string') {
        throw new Error('file_text is required for create command');
    }
    const result = await writeText(path, fileText);
    return { path: result.path, size: result.size };
}

async function replaceInFile(path, oldStr, newStr) {
    requirePath(path, 'str_replace');
    if (typeof oldStr !== 'string' || !oldStr) {
        throw new Error('old_str is required for str_replace command');
    }
    if (typeof newStr !== 'string') {
        throw new Error('new_str is required for str_replace command');
    }

    const { content } = await readText(path);
    const occurrences = content.split(oldStr).length - 1;
    if (occurrences === 0) {
        throw new Error('old_str not found in file');
    }
    if (occurrences > 1) {
        throw new Error(
            `old_str found ${occurrences} times, must be unique. Use more context to make it unique.`
        );
    }
    // 不用 String.replace：替换文本里的 $& / $' 会被当成替换模式
    const index = content.indexOf(oldStr);
    const result = await writeText(
        path,
        content.slice(0, index) + newStr + content.slice(index + oldStr.length)
    );
    return { path: result.path, size: result.size, replaced: true };
}

async function insertIntoFile(path, insertLine, text) {
    requirePath(path, 'insert');
    if (typeof text !== 'string') {
        throw new Error('insert_text is required for insert command');
    }

    const { content } = await readText(path);
    const lines = content.split('\n');
    const line = toInteger(insertLine);
    if (!Number.isInteger(line) || line < 0 || line > lines.length) {
        throw new Error(
            `Invalid insert_line ${JSON.stringify(insertLine)}: must be between 0 and ${lines.length}`
        );
    }
    lines.splice(line, 0, text);
    const result = await writeText(path, lines.join('\n'));
    return { path: result.path, size: result.size, inserted: true };
}

/**
 * insert 要插入的文本：原生工具用 insert_text（更早的版本用 new_str），XML 内置工具用 file_text
 * @returns {string|undefined}
 */
export function resolveInsertText(args = {}) {
    return args.insert_text ?? args.new_str ?? args.file_text;
}

/**
 * 文件编辑命令：view / create / str_replace / insert
 * @param {Object} args 原生 str_replace_based_edit_tool 的输入（insert 用 insert_text），
 *   或 XML 内置工具的同名字段（insert 用 file_text）
 * @returns {Promise<Object>}
 */
export async function runTextEditorCommand(args = {}) {
    const { command, path } = args;
    if (!command) {
        throw new Error('command is required for the text editor');
    }

    switch (command) {
        case 'view':
            return await viewFile(path, args.view_range);
        case 'create':
            return await createFile(path, args.file_text);
        case 'str_replace':
            return await replaceInFile(path, args.old_str, args.new_str);
        case 'insert':
            return await insertIntoFile(path, args.insert_line, resolveInsertText(args));
        case 'undo_edit':
            throw new Error('undo_edit is not supported');
        default:
            throw new Error(`Unknown editor command: ${command}`);
    }
}
