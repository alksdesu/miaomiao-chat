/**
 * state/migration.js 测试
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../js/core/events.js', () => ({
    eventBus: { emit: vi.fn(), on: vi.fn(), off: vi.fn() }
}));

vi.mock('../../js/state/storage.js', () => ({
    saveConfig: vi.fn(() => Promise.resolve()),
    loadConfig: vi.fn(() => Promise.resolve(null)),
    saveSavedConfigs: vi.fn(() => Promise.resolve()),
    savePreference: vi.fn(() => Promise.resolve()),
    loadPreference: vi.fn(() => Promise.resolve(null)),
    saveQuickMessage: vi.fn(() => Promise.resolve()),
    loadAllQuickMessages: vi.fn(() => Promise.resolve([]))
}));

vi.mock('../../js/utils/logger.js', () => ({
    logger: { warn: vi.fn(), debug: vi.fn(), error: vi.fn(), info: vi.fn() }
}));

import {
    MIGRATION_STATES,
    getMigrationStatus,
    setMigrationStatus,
    acquireMigrationLock,
    releaseMigrationLock,
    logMigrationStep,
    getMigrationLog,
    backupLocalStorage,
    verifyMigration,
    rollbackMigration,
    executeMigration
} from '../../js/state/migration.js';

import {
    savePreference,
    loadPreference,
    loadConfig,
    loadAllQuickMessages,
    saveConfig,
    saveQuickMessage
} from '../../js/state/storage.js';
import { eventBus } from '../../js/core/events.js';

describe('state/migration', () => {
    beforeEach(() => {
        localStorage.clear();
    });

    // ========== MIGRATION_STATES ==========
    describe('MIGRATION_STATES', () => {
        it('包含所有状态', () => {
            expect(MIGRATION_STATES.NOT_STARTED).toBe('not_started');
            expect(MIGRATION_STATES.IN_PROGRESS).toBe('in_progress');
            expect(MIGRATION_STATES.COMPLETED).toBe('completed');
            expect(MIGRATION_STATES.FAILED).toBe('failed');
        });
    });

    // ========== getMigrationStatus ==========
    describe('getMigrationStatus', () => {
        it('默认返回 NOT_STARTED', async () => {
            const status = await getMigrationStatus();
            expect(status).toBe(MIGRATION_STATES.NOT_STARTED);
        });

        it('loadPreference 失败时返回 NOT_STARTED', async () => {
            const { loadPreference } = await import('../../js/state/storage.js');
            loadPreference.mockRejectedValueOnce(new Error('fail'));
            const status = await getMigrationStatus();
            expect(status).toBe(MIGRATION_STATES.NOT_STARTED);
        });

        it('有保存状态时返回该状态', async () => {
            const { loadPreference } = await import('../../js/state/storage.js');
            loadPreference.mockResolvedValueOnce('completed');
            const status = await getMigrationStatus();
            expect(status).toBe('completed');
        });
    });

    // ========== setMigrationStatus ==========
    describe('setMigrationStatus', () => {
        it('保存状态', async () => {
            await setMigrationStatus(MIGRATION_STATES.COMPLETED);
            const { savePreference } = await import('../../js/state/storage.js');
            expect(savePreference).toHaveBeenCalledWith('migration_status', 'completed');
        });
    });

    // ========== acquireMigrationLock ==========
    describe('acquireMigrationLock', () => {
        it('无锁时成功获取', () => {
            expect(() => acquireMigrationLock()).not.toThrow();
            expect(localStorage.getItem('migration_lock')).toBeTruthy();
        });

        it('过期锁可以覆盖', () => {
            localStorage.setItem('migration_lock', '0'); // 很久以前
            expect(() => acquireMigrationLock()).not.toThrow();
        });

        it('未过期锁抛错', () => {
            localStorage.setItem('migration_lock', Date.now().toString());
            expect(() => acquireMigrationLock()).toThrow('其他标签页正在迁移');
        });
    });

    // ========== releaseMigrationLock ==========
    describe('releaseMigrationLock', () => {
        it('释放锁', () => {
            localStorage.setItem('migration_lock', Date.now().toString());
            releaseMigrationLock();
            expect(localStorage.getItem('migration_lock')).toBeNull();
        });

        it('无锁时不抛错', () => {
            expect(() => releaseMigrationLock()).not.toThrow();
        });
    });

    // ========== logMigrationStep / getMigrationLog ==========
    describe('logMigrationStep / getMigrationLog', () => {
        it('记录并获取日志', () => {
            logMigrationStep('test step', 'ok', { foo: 1 });
            const log = getMigrationLog();
            expect(log.length).toBeGreaterThanOrEqual(1);
            const last = log[log.length - 1];
            expect(last.step).toBe('test step');
            expect(last.status).toBe('ok');
            expect(last.details.foo).toBe(1);
        });

        it('getMigrationLog 返回副本', () => {
            const log1 = getMigrationLog();
            const log2 = getMigrationLog();
            expect(log1).not.toBe(log2);
        });
    });

    // ========== backupLocalStorage ==========
    describe('backupLocalStorage', () => {
        it('备份相关 localStorage 键', async () => {
            localStorage.setItem('theme', 'dark');
            localStorage.setItem('sidebarOpen', 'true');
            localStorage.setItem('geminiChatConfig', '{"key":"val"}');

            const backup = await backupLocalStorage();

            expect(backup.data.theme).toBe('dark');
            expect(backup.data.sidebarOpen).toBe('true');
            expect(backup.data.geminiChatConfig).toBe('{"key":"val"}');
            expect(savePreference).toHaveBeenCalledWith('localStorage_backup', expect.any(Object));
        });

        it('缺失键不包含在备份中', async () => {
            localStorage.clear();
            const backup = await backupLocalStorage();
            expect(Object.keys(backup.data).length).toBe(0);
        });
    });

    // ========== verifyMigration ==========
    describe('verifyMigration', () => {
        it('无旧数据时验证成功', async () => {
            localStorage.clear();
            loadConfig.mockResolvedValue(null);
            loadAllQuickMessages.mockResolvedValue([]);
            loadPreference.mockResolvedValue(null);

            const result = await verifyMigration();
            expect(result).toBe(true);
        });

        it('配置不一致时验证失败', async () => {
            localStorage.setItem('geminiChatConfig', '{"key":"val"}');
            loadConfig.mockResolvedValue(null);
            loadAllQuickMessages.mockResolvedValue([]);
            loadPreference.mockResolvedValue(null);

            const result = await verifyMigration();
            expect(result).toBe(false);
        });

        it('快捷消息数量不一致时验证失败', async () => {
            localStorage.setItem('quickMessages', '[{"id":1},{"id":2}]');
            loadConfig.mockResolvedValue(null);
            loadAllQuickMessages.mockResolvedValue([{ id: 1 }]); // 只有 1 个
            loadPreference.mockResolvedValue(null);

            const result = await verifyMigration();
            expect(result).toBe(false);
        });

        it('主题不一致时验证失败', async () => {
            localStorage.setItem('theme', 'dark');
            loadConfig.mockResolvedValue(null);
            loadAllQuickMessages.mockResolvedValue([]);
            loadPreference.mockImplementation(async (key) => {
                if (key === 'theme') return 'light';
                return null;
            });

            const result = await verifyMigration();
            expect(result).toBe(false);
        });
    });

    // ========== rollbackMigration ==========
    describe('rollbackMigration', () => {
        it('从备份恢复 localStorage', async () => {
            loadPreference.mockImplementation(async (key) => {
                if (key === 'localStorage_backup') {
                    return { data: { theme: 'dark', sidebarOpen: 'true' } };
                }
                return null;
            });

            await rollbackMigration();

            expect(localStorage.getItem('theme')).toBe('dark');
            expect(localStorage.getItem('sidebarOpen')).toBe('true');
            expect(savePreference).toHaveBeenCalledWith(
                'migration_status',
                MIGRATION_STATES.NOT_STARTED
            );
        });

        it('无备份数据时不操作', async () => {
            loadPreference.mockResolvedValue(null);
            await rollbackMigration();
            // 不抛错即可
        });

        it('回滚异常时发出通知', async () => {
            loadPreference.mockRejectedValue(new Error('DB error'));

            await rollbackMigration();

            expect(eventBus.emit).toHaveBeenCalledWith(
                'ui:notification',
                expect.objectContaining({
                    type: 'error'
                })
            );
        });
    });

    // ========== executeMigration ==========
    describe('executeMigration', () => {
        it('已完成时跳过', async () => {
            loadPreference.mockImplementation(async (key) => {
                if (key === 'migration_status') return MIGRATION_STATES.COMPLETED;
                return null;
            });

            const result = await executeMigration();
            expect(result).toBe(true);
        });

        it('全流程成功执行', async () => {
            localStorage.setItem('geminiChatConfig', '{"key":"val"}');
            localStorage.setItem('theme', 'dark');

            loadPreference.mockImplementation(async (key) => {
                if (key === 'migration_status') return MIGRATION_STATES.NOT_STARTED;
                if (key === 'theme') return 'dark';
                return null;
            });
            loadConfig.mockResolvedValue({ key: 'val' });
            loadAllQuickMessages.mockResolvedValue([]);

            const result = await executeMigration();
            expect(result).toBe(true);
            expect(saveConfig).toHaveBeenCalled();
        });

        it('迁移失败时回滚', async () => {
            loadPreference.mockImplementation(async (key) => {
                if (key === 'migration_status') return MIGRATION_STATES.NOT_STARTED;
                if (key === 'localStorage_backup') return { data: {} };
                return null;
            });
            // 让 saveConfig 抛错导致迁移失败
            localStorage.setItem('geminiChatConfig', 'invalid json {{');

            const result = await executeMigration();
            expect(result).toBe(false);
        });
    });
});
