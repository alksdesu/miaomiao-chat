/**
 * permissions.js 测试
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../js/core/state.js', () => ({
    state: {
        toolPermissions: {
            enabled: false,
            mode: 'whitelist',
            whitelist: [],
            blacklist: [],
            requireConfirmation: false
        },
        currentSessionId: 'session-a',
        sessions: [],
        bashConfig: { requireConfirmation: false }
    }
}));

vi.mock('../../js/state/sessions.js', () => ({
    debouncedSaveSession: vi.fn()
}));

vi.mock('../../js/utils/dialogs.js', () => ({
    showConfirmDialog: vi.fn(async () => ({ confirmed: true, persistForSession: false }))
}));

import { state } from '../../js/core/state.js';
import {
    checkToolPermission,
    addToWhitelist,
    removeFromWhitelist,
    addToBlacklist,
    removeFromBlacklist,
    setPermissionMode,
    setPermissionsEnabled,
    setRequireConfirmation,
    getPermissions,
    resetPermissions,
    exportPermissions,
    importPermissions,
    getPermissionStats,
    setWhitelist,
    setBlacklist,
    confirmToolExecutionIfRequired,
    resetSessionGrants
} from '../../js/tools/permissions.js';
import { showConfirmDialog } from '../../js/utils/dialogs.js';
import { eventBus } from '../../js/core/events.js';
import { EVENTS } from '../../js/core/events-registry.js';

beforeEach(() => {
    vi.clearAllMocks();
    state.toolPermissions = {
        enabled: false,
        mode: 'whitelist',
        whitelist: [],
        blacklist: [],
        requireConfirmation: false
    };
    state.currentSessionId = 'session-a';
    state.sessions = [
        { id: 'session-a', name: '整理桌面' },
        { id: 'session-b', name: '后台下载' }
    ];
    state.bashConfig = { requireConfirmation: false };
    resetSessionGrants('session-a');
    resetSessionGrants('session-b');
    showConfirmDialog.mockResolvedValue({ confirmed: true, persistForSession: false });
});

// ========== checkToolPermission ==========

describe('checkToolPermission', () => {
    it('权限未启用时允许', () => {
        const result = checkToolPermission('tool1', 'Tool 1');
        expect(result.allowed).toBe(true);
        expect(result.reason).toBe('permissions_disabled');
    });

    it('白名单模式 - 在列表中允许', () => {
        state.toolPermissions.enabled = true;
        state.toolPermissions.mode = 'whitelist';
        state.toolPermissions.whitelist = ['tool1'];
        const result = checkToolPermission('tool1', 'Tool 1');
        expect(result.allowed).toBe(true);
        expect(result.reason).toBe('whitelist_match');
    });

    it('白名单模式 - 按名称匹配', () => {
        state.toolPermissions.enabled = true;
        state.toolPermissions.mode = 'whitelist';
        state.toolPermissions.whitelist = ['Tool 1'];
        const result = checkToolPermission('tool1', 'Tool 1');
        expect(result.allowed).toBe(true);
    });

    it('白名单模式 - 不在列表中拒绝', () => {
        state.toolPermissions.enabled = true;
        state.toolPermissions.mode = 'whitelist';
        state.toolPermissions.whitelist = ['other'];
        const result = checkToolPermission('tool1', 'Tool 1');
        expect(result.allowed).toBe(false);
        expect(result.reason).toBe('whitelist_reject');
        expect(result.message).toContain('不在白名单中');
    });

    it('黑名单模式 - 不在列表中允许', () => {
        state.toolPermissions.enabled = true;
        state.toolPermissions.mode = 'blacklist';
        state.toolPermissions.blacklist = ['other'];
        const result = checkToolPermission('tool1', 'Tool 1');
        expect(result.allowed).toBe(true);
        expect(result.reason).toBe('blacklist_pass');
    });

    it('黑名单模式 - 在列表中拒绝', () => {
        state.toolPermissions.enabled = true;
        state.toolPermissions.mode = 'blacklist';
        state.toolPermissions.blacklist = ['tool1'];
        const result = checkToolPermission('tool1', 'Tool 1');
        expect(result.allowed).toBe(false);
        expect(result.reason).toBe('blacklist_reject');
        expect(result.message).toContain('在黑名单中');
    });

    it('黑名单模式 - 按名称匹配', () => {
        state.toolPermissions.enabled = true;
        state.toolPermissions.mode = 'blacklist';
        state.toolPermissions.blacklist = ['Tool 1'];
        const result = checkToolPermission('tool1', 'Tool 1');
        expect(result.allowed).toBe(false);
    });

    it('未知模式默认允许', () => {
        state.toolPermissions.enabled = true;
        state.toolPermissions.mode = 'other';
        const result = checkToolPermission('tool1', 'Tool 1');
        expect(result.allowed).toBe(true);
        expect(result.reason).toBe('unknown_mode');
    });
});

// ========== addToWhitelist / removeFromWhitelist ==========

describe('whitelist 操作', () => {
    it('添加到白名单', () => {
        addToWhitelist('tool1');
        expect(state.toolPermissions.whitelist).toContain('tool1');
    });

    it('重复添加不重复', () => {
        addToWhitelist('tool1');
        addToWhitelist('tool1');
        expect(state.toolPermissions.whitelist.filter((t) => t === 'tool1')).toHaveLength(1);
    });

    it('从白名单移除', () => {
        addToWhitelist('tool1');
        removeFromWhitelist('tool1');
        expect(state.toolPermissions.whitelist).not.toContain('tool1');
    });

    it('移除不存在的不报错', () => {
        expect(() => removeFromWhitelist('nonexistent')).not.toThrow();
    });
});

// ========== addToBlacklist / removeFromBlacklist ==========

describe('blacklist 操作', () => {
    it('添加到黑名单', () => {
        addToBlacklist('tool1');
        expect(state.toolPermissions.blacklist).toContain('tool1');
    });

    it('重复添加不重复', () => {
        addToBlacklist('tool1');
        addToBlacklist('tool1');
        expect(state.toolPermissions.blacklist.filter((t) => t === 'tool1')).toHaveLength(1);
    });

    it('从黑名单移除', () => {
        addToBlacklist('tool1');
        removeFromBlacklist('tool1');
        expect(state.toolPermissions.blacklist).not.toContain('tool1');
    });
});

// ========== setPermissionMode ==========

describe('setPermissionMode', () => {
    it('设置 whitelist', () => {
        setPermissionMode('whitelist');
        expect(state.toolPermissions.mode).toBe('whitelist');
    });

    it('设置 blacklist', () => {
        setPermissionMode('blacklist');
        expect(state.toolPermissions.mode).toBe('blacklist');
    });

    it('无效模式抛异常', () => {
        expect(() => setPermissionMode('invalid')).toThrow('无效的权限模式');
    });
});

// ========== setPermissionsEnabled ==========

describe('setPermissionsEnabled', () => {
    it('启用权限系统', () => {
        setPermissionsEnabled(true);
        expect(state.toolPermissions.enabled).toBe(true);
    });

    it('禁用权限系统', () => {
        setPermissionsEnabled(true);
        setPermissionsEnabled(false);
        expect(state.toolPermissions.enabled).toBe(false);
    });
});

// ========== setRequireConfirmation ==========

describe('setRequireConfirmation', () => {
    it('设置确认', () => {
        setRequireConfirmation(true);
        expect(state.toolPermissions.requireConfirmation).toBe(true);
    });
});

describe('工具确认作用域', () => {
    it('会话内授权不会泄漏到其他会话', async () => {
        state.toolPermissions.requireConfirmation = true;
        showConfirmDialog.mockResolvedValue({ confirmed: true, persistForSession: true });

        await confirmToolExecutionIfRequired(
            'search',
            'search',
            {},
            {
                sessionId: 'session-a',
                turnId: 'turn-a'
            }
        );
        await confirmToolExecutionIfRequired(
            'search',
            'search',
            {},
            {
                sessionId: 'session-a',
                turnId: 'turn-b'
            }
        );
        await confirmToolExecutionIfRequired(
            'search',
            'search',
            {},
            {
                sessionId: 'session-b',
                turnId: 'turn-a'
            }
        );

        expect(showConfirmDialog).toHaveBeenCalledTimes(2);
    });

    it('不同请求不会共享拒绝缓存', async () => {
        state.toolPermissions.requireConfirmation = true;
        showConfirmDialog
            .mockResolvedValueOnce({ confirmed: false, persistForSession: false })
            .mockResolvedValueOnce({ confirmed: true, persistForSession: false });

        const first = await confirmToolExecutionIfRequired(
            'search',
            'search',
            { q: 'x' },
            {
                sessionId: 'session-a',
                turnId: 'turn-a'
            }
        );
        const second = await confirmToolExecutionIfRequired(
            'search',
            'search',
            { q: 'x' },
            {
                sessionId: 'session-a',
                turnId: 'turn-b'
            }
        );

        expect(first).toBe(false);
        expect(second).toBe(true);
        expect(showConfirmDialog).toHaveBeenCalledTimes(2);
    });

    it('确认结果返回前任务被取消时抛 AbortError，不授予会话权限', async () => {
        state.toolPermissions.requireConfirmation = true;
        const controller = new AbortController();
        let resolveDialog;
        showConfirmDialog.mockReturnValueOnce(
            new Promise((resolve) => {
                resolveDialog = resolve;
            })
        );

        const pending = confirmToolExecutionIfRequired(
            'search',
            'search',
            {},
            {
                sessionId: 'session-a',
                turnId: 'turn-aborted',
                signal: controller.signal
            }
        );
        controller.abort();
        resolveDialog({ confirmed: true, persistForSession: true });

        await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        await confirmToolExecutionIfRequired(
            'search',
            'search',
            {},
            {
                sessionId: 'session-a',
                turnId: 'turn-next'
            }
        );
        expect(showConfirmDialog).toHaveBeenCalledTimes(2);
    });

    it('停止导致弹窗关闭时不记成用户拒绝，同一轮再次请求重新弹窗', async () => {
        state.bashConfig.requireConfirmation = true;
        const controller = new AbortController();
        showConfirmDialog.mockImplementationOnce(async () => {
            controller.abort();
            return { confirmed: false, persistForSession: false };
        });
        const args = { action: 'left_click', coordinate: [1, 2] };
        const options = { sessionId: 'session-a', turnId: 'turn-stop' };

        await expect(
            confirmToolExecutionIfRequired('computer', 'computer', args, {
                ...options,
                signal: controller.signal
            })
        ).rejects.toMatchObject({ name: 'AbortError' });
        showConfirmDialog.mockResolvedValueOnce({ confirmed: true, persistForSession: false });

        await expect(
            confirmToolExecutionIfRequired('computer', 'computer', args, options)
        ).resolves.toBe(true);
        expect(showConfirmDialog).toHaveBeenCalledTimes(2);
    });

    it('已停止时直接抛 AbortError，本会话已授权或无需确认也不放行', async () => {
        state.bashConfig.requireConfirmation = true;
        showConfirmDialog.mockResolvedValueOnce({ confirmed: true, persistForSession: true });
        await confirmToolExecutionIfRequired(
            'computer',
            'computer',
            {},
            { sessionId: 'session-a' }
        );
        const controller = new AbortController();
        controller.abort();

        await expect(
            confirmToolExecutionIfRequired(
                'computer',
                'computer',
                {},
                { sessionId: 'session-a', signal: controller.signal }
            )
        ).rejects.toMatchObject({ name: 'AbortError' });
        state.bashConfig.requireConfirmation = false;
        await expect(
            confirmToolExecutionIfRequired(
                'search',
                'search',
                {},
                { sessionId: 'session-a', signal: controller.signal }
            )
        ).rejects.toMatchObject({ name: 'AbortError' });
        expect(showConfirmDialog).toHaveBeenCalledTimes(1);
    });

    it('拿不到轮次 id 时不复用确认结果，旧的批准不会沿用到之后的请求', async () => {
        state.toolPermissions.requireConfirmation = true;
        showConfirmDialog.mockResolvedValue({ confirmed: true, persistForSession: false });

        await confirmToolExecutionIfRequired('search', 'search', { q: 'x' }, {});
        await confirmToolExecutionIfRequired('search', 'search', { q: 'x' }, {});

        expect(showConfirmDialog).toHaveBeenCalledTimes(2);
    });

    it('确认前或确认期间停止时抛出的 AbortError 标记为未执行', async () => {
        state.bashConfig.requireConfirmation = true;
        const controller = new AbortController();
        controller.abort();

        await expect(
            confirmToolExecutionIfRequired(
                'computer',
                'computer',
                {},
                { sessionId: 'session-a', signal: controller.signal }
            )
        ).rejects.toMatchObject({ name: 'AbortError', notExecuted: true });
    });
});

describe('工具确认弹窗内容', () => {
    beforeEach(() => {
        state.bashConfig.requireConfirmation = true;
    });

    async function confirmMessage(toolId, args, options = {}) {
        await confirmToolExecutionIfRequired(toolId, toolId, args, {
            sessionId: 'session-a',
            turnId: `turn-${Math.random()}`,
            ...options
        });
        const [message, title, dialogOptions] = showConfirmDialog.mock.calls.at(-1);
        return { message, title, dialogOptions };
    }

    it('标出来源会话，用中文描述桌面动作，默认聚焦取消', async () => {
        const { message, title, dialogOptions } = await confirmMessage('computer', {
            action: 'left_click',
            coordinate: [100, 200]
        });

        expect(title).toBe('工具调用确认');
        expect(message).toContain('会话：整理桌面');
        expect(message).toContain('工具：桌面操作');
        expect(message).toContain('操作：左键单击 (100, 200)');
        expect(message).not.toContain('{');
        expect(dialogOptions.defaultFocus).toBe('cancel');
    });

    it('后台会话的确认标明后台运行', async () => {
        const { message } = await confirmMessage(
            'computer',
            { action: 'type', text: 'hello' },
            { sessionId: 'session-b' }
        );

        expect(message).toContain('会话：后台下载（后台运行）');
        expect(message).toContain('操作：输入文本「hello」');
    });

    it('命令与文件编辑写出命令和路径', async () => {
        const bash = await confirmMessage('bash', { command: 'ls -la' });
        expect(bash.message).toContain('工具：命令行');
        expect(bash.message).toContain('执行命令：\nls -la');

        const edit = await confirmMessage('str_replace_based_edit_tool', {
            command: 'str_replace',
            path: 'notes.txt',
            old_str: 'a',
            new_str: 'b'
        });
        expect(edit.message).toContain('工具：文件编辑');
        expect(edit.message).toContain('修改文件 notes.txt\n原文：a\n改为：b');

        const insert = await confirmMessage('str_replace_based_edit_tool', {
            command: 'insert',
            path: 'notes.txt',
            insert_line: 3,
            insert_text: 'new line'
        });
        expect(insert.message).toContain('在 notes.txt 第 3 行后插入文本\n内容：new line');
    });

    it('命令描述与实际执行取同一个字段', async () => {
        const { message } = await confirmMessage('computer', {
            action: 'bash',
            text: '',
            command: 'rm -rf build'
        });
        expect(message).toContain('执行命令：\nrm -rf build');
    });

    it('XML 模式内置 computer 工具按 action 描述为命令或文件编辑', async () => {
        const bash = await confirmMessage('computer', { action: 'bash', text: 'whoami' });
        expect(bash.message).toContain('工具：命令行');
        expect(bash.message).toContain('whoami');

        const edit = await confirmMessage('computer', {
            action: 'str_replace_editor',
            command: 'create',
            path: 'a.txt',
            file_text: 'hi'
        });
        expect(edit.message).toContain('工具：文件编辑');
        expect(edit.message).toContain('创建文件 a.txt\n内容：hi');
    });

    it('其他工具保留参数摘要', async () => {
        state.toolPermissions.requireConfirmation = true;
        const { message } = await confirmMessage('search', { q: 'x' });

        expect(message).toContain('工具：search');
        expect(message).toContain('参数：{"q":"x"}');
    });
});

describe('会话授权的生命周期', () => {
    beforeEach(() => {
        state.toolPermissions.requireConfirmation = true;
        showConfirmDialog.mockResolvedValue({ confirmed: true, persistForSession: true });
    });

    const confirmIn = (sessionId, turnId) =>
        confirmToolExecutionIfRequired('search', 'search', {}, { sessionId, turnId });

    it('切换会话不清空授权，后台会话沿用自己的授权', async () => {
        await confirmIn('session-b', 'turn-1');
        state.currentSessionId = 'session-a';
        eventBus.emit(EVENTS.SESSIONS_UPDATED, { sessions: state.sessions });

        await confirmIn('session-b', 'turn-2');

        expect(showConfirmDialog).toHaveBeenCalledTimes(1);
    });

    it('会话被删除后清除它的授权，其他会话不受影响', async () => {
        await confirmIn('session-a', 'turn-1');
        await confirmIn('session-b', 'turn-1');
        state.sessions = state.sessions.filter((session) => session.id !== 'session-b');
        eventBus.emit(EVENTS.SESSIONS_UPDATED, { sessions: state.sessions });

        await confirmIn('session-a', 'turn-2');
        await confirmIn('session-b', 'turn-2');

        expect(showConfirmDialog).toHaveBeenCalledTimes(3);
    });
});

// ========== getPermissions ==========

describe('getPermissions', () => {
    it('返回权限配置副本', () => {
        addToWhitelist('tool1');
        addToBlacklist('tool2');
        const perms = getPermissions();
        expect(perms.whitelist).toContain('tool1');
        expect(perms.blacklist).toContain('tool2');
        // 副本，不是引用
        perms.whitelist.push('extra');
        expect(state.toolPermissions.whitelist).not.toContain('extra');
    });
});

// ========== resetPermissions ==========

describe('resetPermissions', () => {
    it('重置到默认值', () => {
        setPermissionsEnabled(true);
        setPermissionMode('blacklist');
        addToWhitelist('tool1');
        addToBlacklist('tool2');
        resetPermissions();
        expect(state.toolPermissions.enabled).toBe(false);
        expect(state.toolPermissions.mode).toBe('whitelist');
        expect(state.toolPermissions.whitelist).toHaveLength(0);
        expect(state.toolPermissions.blacklist).toHaveLength(0);
    });
});

// ========== exportPermissions / importPermissions ==========

describe('export/import', () => {
    it('导出 JSON', () => {
        addToWhitelist('tool1');
        const json = exportPermissions();
        const parsed = JSON.parse(json);
        expect(parsed.whitelist).toContain('tool1');
    });

    it('导入 JSON', () => {
        const data = JSON.stringify({ enabled: true, mode: 'blacklist', blacklist: ['bad'] });
        importPermissions(data);
        expect(state.toolPermissions.enabled).toBe(true);
        expect(state.toolPermissions.mode).toBe('blacklist');
        expect(state.toolPermissions.blacklist).toContain('bad');
    });

    it('导入非对象抛异常', () => {
        expect(() => importPermissions('"string"')).toThrow('导入数据必须是对象');
    });

    it('导入无效 JSON 抛异常', () => {
        expect(() => importPermissions('invalid')).toThrow('导入权限配置失败');
    });
});

// ========== getPermissionStats ==========

describe('getPermissionStats', () => {
    it('返回统计信息', () => {
        addToWhitelist('a');
        addToWhitelist('b');
        addToBlacklist('c');
        const stats = getPermissionStats();
        expect(stats.whitelistCount).toBe(2);
        expect(stats.blacklistCount).toBe(1);
        expect(stats.enabled).toBe(false);
        expect(stats.mode).toBe('whitelist');
    });
});

// ========== setWhitelist / setBlacklist ==========

describe('批量设置', () => {
    it('追加白名单', () => {
        addToWhitelist('a');
        setWhitelist(['b', 'c']);
        expect(state.toolPermissions.whitelist).toContain('a');
        expect(state.toolPermissions.whitelist).toContain('b');
        expect(state.toolPermissions.whitelist).toContain('c');
    });

    it('替换白名单', () => {
        addToWhitelist('a');
        setWhitelist(['b', 'c'], true);
        expect(state.toolPermissions.whitelist).not.toContain('a');
        expect(state.toolPermissions.whitelist).toContain('b');
    });

    it('追加去重', () => {
        addToWhitelist('a');
        setWhitelist(['a', 'b']);
        expect(state.toolPermissions.whitelist.filter((t) => t === 'a')).toHaveLength(1);
    });

    it('追加黑名单', () => {
        setBlacklist(['x', 'y']);
        expect(state.toolPermissions.blacklist).toContain('x');
        expect(state.toolPermissions.blacklist).toContain('y');
    });

    it('替换黑名单', () => {
        addToBlacklist('a');
        setBlacklist(['b'], true);
        expect(state.toolPermissions.blacklist).not.toContain('a');
        expect(state.toolPermissions.blacklist).toContain('b');
    });
});
