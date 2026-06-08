/**
 * state/preferences-storage.js 偏好设置存储测试
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../js/state/indexeddb.js', () => ({
    STORES: { PREFERENCES: 'preferences' },
    saveToStore: vi.fn(async () => {}),
    loadFromStore: vi.fn(async () => null),
    loadAllFromStore: vi.fn(async () => []),
    safeLocalStorageGet: vi.fn(() => null),
    safeLocalStorageSet: vi.fn(() => true),
    getDB: vi.fn(() => ({})) // 默认 IDB 可用
}));

import {
    savePreference,
    loadPreference,
    loadAllPreferences
} from '../../js/state/preferences-storage.js';
import {
    saveToStore,
    loadFromStore,
    loadAllFromStore,
    safeLocalStorageGet,
    safeLocalStorageSet,
    getDB
} from '../../js/state/indexeddb.js';

beforeEach(() => {
    vi.clearAllMocks();
    getDB.mockReturnValue({});
    safeLocalStorageSet.mockReturnValue(true);
    safeLocalStorageGet.mockReturnValue(null);
});

describe('savePreference', () => {
    it('IndexedDB 可用时写入 IDB', async () => {
        await savePreference('theme', 'dark');
        expect(saveToStore).toHaveBeenCalledWith('preferences', 'theme', 'dark');
    });

    it('IDB 写入失败时降级 localStorage', async () => {
        saveToStore.mockRejectedValueOnce(new Error('IDB failed'));
        const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        await savePreference('theme', 'dark');

        expect(safeLocalStorageSet).toHaveBeenCalledWith('theme', 'dark');
        consoleSpy.mockRestore();
    });

    it('IDB 不可用时直接写 localStorage', async () => {
        getDB.mockReturnValue(null);
        await savePreference('key', 'value');

        expect(saveToStore).not.toHaveBeenCalled();
        expect(safeLocalStorageSet).toHaveBeenCalledWith('key', 'value');
    });

    it('IDB 不可用且 localStorage 也不可用时抛错', async () => {
        getDB.mockReturnValue(null);
        safeLocalStorageSet.mockReturnValue(false);

        await expect(savePreference('key', 'value')).rejects.toThrow('保存偏好设置失败');
    });

    it('对象值序列化为 JSON', async () => {
        getDB.mockReturnValue(null);
        await savePreference('config', { a: 1 });
        expect(safeLocalStorageSet).toHaveBeenCalledWith('config', '{"a":1}');
    });

    it('字符串值直接存储', async () => {
        getDB.mockReturnValue(null);
        await savePreference('name', 'test');
        expect(safeLocalStorageSet).toHaveBeenCalledWith('name', 'test');
    });

    it('IDB + localStorage 都失败时抛出原始错误', async () => {
        const idbError = new Error('QuotaExceeded');
        saveToStore.mockRejectedValueOnce(idbError);
        safeLocalStorageSet.mockReturnValue(false);
        const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        await expect(savePreference('big', 'data')).rejects.toThrow('QuotaExceeded');
        consoleSpy.mockRestore();
    });
});

describe('loadPreference', () => {
    it('从 IDB 加载值', async () => {
        loadFromStore.mockResolvedValue('dark');
        const result = await loadPreference('theme');
        expect(result).toBe('dark');
    });

    it('IDB 无值时回退 localStorage', async () => {
        loadFromStore.mockResolvedValue(null);
        safeLocalStorageGet.mockReturnValue('light');

        const result = await loadPreference('theme');
        expect(result).toBe('light');
    });

    it('IDB undefined 时回退 localStorage', async () => {
        loadFromStore.mockResolvedValue(undefined);
        safeLocalStorageGet.mockReturnValue('fallback');

        const result = await loadPreference('key');
        expect(result).toBe('fallback');
    });

    it('IDB 失败时降级 localStorage', async () => {
        loadFromStore.mockRejectedValue(new Error('read error'));
        safeLocalStorageGet.mockReturnValue('backup');
        const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        const result = await loadPreference('key');
        expect(result).toBe('backup');
        consoleSpy.mockRestore();
    });

    it('IDB 不可用时直接读 localStorage', async () => {
        getDB.mockReturnValue(null);
        safeLocalStorageGet.mockReturnValue('local-value');

        const result = await loadPreference('key');
        expect(result).toBe('local-value');
        expect(loadFromStore).not.toHaveBeenCalled();
    });
});

describe('loadAllPreferences', () => {
    it('从 IDB 加载所有偏好', async () => {
        loadAllFromStore.mockResolvedValue([
            { key: 'theme', value: 'dark' },
            { key: 'lang', value: 'zh' }
        ]);

        const result = await loadAllPreferences();
        expect(result).toEqual({ theme: 'dark', lang: 'zh' });
    });

    it('空存储返回空对象', async () => {
        loadAllFromStore.mockResolvedValue([]);
        const result = await loadAllPreferences();
        expect(result).toEqual({});
    });
});
