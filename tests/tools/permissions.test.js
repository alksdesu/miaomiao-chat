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
        }
    }
}));

vi.mock('../../js/state/sessions.js', () => ({
    debouncedSaveSession: vi.fn()
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
    setBlacklist
} from '../../js/tools/permissions.js';

beforeEach(() => {
    state.toolPermissions = {
        enabled: false,
        mode: 'whitelist',
        whitelist: [],
        blacklist: [],
        requireConfirmation: false
    };
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
