/**
 * migration-gate.js 测试
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../js/messages/migration.js', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        migrateSession: vi.fn(actual.migrateSession),
        validateMigration: vi.fn(actual.validateMigration)
    };
});

vi.mock('../../js/state/storage.js', () => ({
    loadAllSessionsFromDB: vi.fn(() => Promise.resolve([])),
    loadSessionMessages: vi.fn(() => Promise.resolve({ messages: [] })),
    saveSessionMessages: vi.fn(() => Promise.resolve()),
    savePreference: vi.fn(() => Promise.resolve()),
    loadPreference: vi.fn(() => Promise.resolve(null))
}));

vi.mock('../../js/utils/logger.js', () => ({
    logger: { warn: vi.fn(), debug: vi.fn(), error: vi.fn(), info: vi.fn() }
}));

import { runMigrationIfNeeded } from '../../js/state/migration-gate.js';
import { SCHEMA_VERSION, createMessage, textPart, Role } from '../../js/messages/schema.js';
import {
    loadAllSessionsFromDB,
    loadSessionMessages,
    saveSessionMessages,
    savePreference,
    loadPreference
} from '../../js/state/storage.js';
import { migrateSession } from '../../js/messages/migration.js';

describe('migration-gate', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // 默认没有 navigator.locks（简化测试）
        if (navigator.locks) {
            vi.spyOn(navigator, 'locks', 'get').mockReturnValue(undefined);
        }
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('版本已最新时跳过迁移', async () => {
        loadPreference.mockResolvedValueOnce(SCHEMA_VERSION);
        const result = await runMigrationIfNeeded();
        expect(result.migrated).toBe(false);
        expect(result.count).toBe(0);
        expect(loadAllSessionsFromDB).not.toHaveBeenCalled();
    });

    it('无会话时保存版本号', async () => {
        loadPreference.mockResolvedValueOnce(null);
        loadAllSessionsFromDB.mockResolvedValueOnce([]);
        const result = await runMigrationIfNeeded();
        expect(result.migrated).toBe(false);
        expect(savePreference).toHaveBeenCalledWith('message_schema_version', SCHEMA_VERSION);
    });

    it('有会话但消息为空时跳过', async () => {
        loadPreference.mockResolvedValueOnce(null);
        // doMigration 内部也会调 loadPreference
        loadPreference.mockResolvedValueOnce(null);
        loadAllSessionsFromDB.mockResolvedValueOnce([{ id: 's1', name: 'test' }]);
        loadSessionMessages.mockResolvedValueOnce({ messages: [] });
        const result = await runMigrationIfNeeded();
        expect(result.migrated).toBe(true);
        expect(result.count).toBe(0);
    });

    it('正常迁移单个会话', async () => {
        loadPreference.mockResolvedValueOnce(null);
        loadPreference.mockResolvedValueOnce(null);
        loadAllSessionsFromDB.mockResolvedValueOnce([{ id: 's1', name: 'Session 1' }]);
        loadSessionMessages.mockResolvedValueOnce({
            messages: [{ role: 'user', content: 'hello' }]
        });
        const result = await runMigrationIfNeeded();
        expect(result.migrated).toBe(true);
        expect(result.count).toBe(1);
        expect(saveSessionMessages).toHaveBeenCalledWith('s1', {
            messages: expect.any(Array),
            messageSchemaVersion: SCHEMA_VERSION
        });
        expect(savePreference).toHaveBeenCalledWith('message_schema_version', SCHEMA_VERSION);
    });

    it('已迁移的会话被跳过', async () => {
        loadPreference.mockResolvedValueOnce(null);
        loadPreference.mockResolvedValueOnce(null);
        loadAllSessionsFromDB.mockResolvedValueOnce([{ id: 's1', name: 'test' }]);
        loadSessionMessages.mockResolvedValueOnce({
            messages: [createMessage(Role.USER, [textPart('hello')])],
            messageSchemaVersion: SCHEMA_VERSION
        });
        const result = await runMigrationIfNeeded();
        expect(result.migrated).toBe(true);
        expect(result.count).toBe(0);
        expect(migrateSession).not.toHaveBeenCalled();
    });

    it('多个会话迁移', async () => {
        loadPreference.mockResolvedValueOnce(null);
        loadPreference.mockResolvedValueOnce(null);
        loadAllSessionsFromDB.mockResolvedValueOnce([
            { id: 's1', name: 'S1' },
            { id: 's2', name: 'S2' }
        ]);
        loadSessionMessages
            .mockResolvedValueOnce({ messages: [{ role: 'user', content: 'a' }] })
            .mockResolvedValueOnce({ messages: [{ role: 'user', content: 'b' }] });
        const result = await runMigrationIfNeeded();
        expect(result.count).toBe(2);
    });

    it('会话迁移失败不更新版本号', async () => {
        loadPreference.mockResolvedValueOnce(null);
        loadPreference.mockResolvedValueOnce(null);
        loadAllSessionsFromDB.mockResolvedValueOnce([{ id: 's1', name: 'bad' }]);
        loadSessionMessages.mockRejectedValueOnce(new Error('db read fail'));
        const result = await runMigrationIfNeeded();
        expect(result.migrated).toBe(true);
        expect(result.errors.length).toBe(1);
        // 有致命错误时不更新版本号
        expect(savePreference).not.toHaveBeenCalledWith('message_schema_version', SCHEMA_VERSION);
    });

    it('loadAllSessionsFromDB 失败返回错误', async () => {
        loadPreference.mockResolvedValueOnce(null);
        loadPreference.mockResolvedValueOnce(null);
        loadAllSessionsFromDB.mockRejectedValueOnce(new Error('no db'));
        const result = await runMigrationIfNeeded();
        expect(result.errors.length).toBe(1);
        expect(result.errors[0].sessionId).toBeNull();
    });

    it('loadPreference 异常时也能执行迁移', async () => {
        loadPreference.mockRejectedValueOnce(new Error('fail'));
        loadPreference.mockRejectedValueOnce(new Error('fail'));
        loadAllSessionsFromDB.mockResolvedValueOnce([]);
        const result = await runMigrationIfNeeded();
        expect(result.migrated).toBe(false);
    });

    it('_pendingMessages 回退', async () => {
        loadPreference.mockResolvedValueOnce(null);
        loadPreference.mockResolvedValueOnce(null);
        loadAllSessionsFromDB.mockResolvedValueOnce([
            {
                id: 's1',
                name: 'old',
                _pendingMessages: [{ role: 'user', content: 'pending' }]
            }
        ]);
        loadSessionMessages.mockResolvedValueOnce({ messages: [] });
        const result = await runMigrationIfNeeded();
        expect(result.count).toBe(1);
    });

    it('迁移有 errors 但不致命时仍更新版本号', async () => {
        loadPreference.mockResolvedValueOnce(null);
        loadPreference.mockResolvedValueOnce(null);
        loadAllSessionsFromDB.mockResolvedValueOnce([{ id: 's1', name: 'test' }]);
        loadSessionMessages.mockResolvedValueOnce({
            messages: [{ role: 'user', content: 'x' }]
        });
        migrateSession.mockReturnValueOnce({
            messages: [createMessage(Role.USER, [textPart('x')])],
            errors: ['some warning'],
            toolMsgCount: 0
        });
        const result = await runMigrationIfNeeded();
        expect(result.count).toBe(1);
        expect(result.errors.length).toBe(1);
        expect(savePreference).toHaveBeenCalledWith('message_schema_version', SCHEMA_VERSION);
    });

    it('长会话名被截断', async () => {
        loadPreference.mockResolvedValueOnce(null);
        loadPreference.mockResolvedValueOnce(null);
        const longName = 'A'.repeat(50);
        loadAllSessionsFromDB.mockResolvedValueOnce([{ id: 's1', name: longName }]);
        loadSessionMessages.mockResolvedValueOnce({ messages: [{ role: 'user', content: 'x' }] });
        // 主要验证不抛错
        const result = await runMigrationIfNeeded();
        expect(result.count).toBe(1);
    });
});
