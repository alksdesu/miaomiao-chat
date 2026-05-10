/**
 * 主题存储
 * IndexedDB 持久化 + JSON 导入导出
 */

import { getDB, initDB, withDBLock } from './storage.js';
import { downloadJSON } from './config.js';
import { generateId } from '../utils/helpers.js';
import { THEME_PROPERTIES, BUILTIN_THEMES, sanitizeCustomCSS } from '../ui/theme-engine.js';
import { logger } from '../utils/logger.js';

const STORE_NAME = 'themes';

/* ===== 验证 ===== */

/**
 * 验证主题对象，白名单过滤
 */
export function validateTheme(obj) {
    const warnings = [];

    if (!obj || typeof obj !== 'object') {
        return { valid: false, theme: null, warnings: ['无效的主题数据'] };
    }

    if (!obj.name || typeof obj.name !== 'string') {
        return { valid: false, theme: null, warnings: ['主题必须有名称'] };
    }

    if (obj.base !== 'light' && obj.base !== 'dark') {
        warnings.push('base 必须是 "light" 或 "dark"，已默认为 "dark"');
        obj.base = 'dark';
    }

    const theme = {
        name: obj.name.trim().substring(0, 64),
        id: obj.id || generateId('theme'),
        base: obj.base,
        version: 1,
        createdAt: obj.createdAt || Date.now(),
        updatedAt: Date.now()
    };

    for (const section of Object.keys(THEME_PROPERTIES)) {
        if (obj[section] && typeof obj[section] === 'object') {
            theme[section] = {};
            for (const key of Object.keys(obj[section])) {
                if (Object.hasOwn(THEME_PROPERTIES[section], key)) {
                    theme[section][key] = String(obj[section][key]);
                } else {
                    warnings.push(`忽略未知属性: ${section}.${key}`);
                }
            }
        }
    }

    if (obj.customCSS && typeof obj.customCSS === 'string') {
        const { css, warnings: cssWarnings } = sanitizeCustomCSS(obj.customCSS);
        theme.customCSS = css;
        warnings.push(...cssWarnings);
    } else {
        theme.customCSS = '';
    }

    return { valid: true, theme, warnings };
}

/* ===== IDB 操作（themes store keyPath:'id'） ===== */

async function ensureDB() {
    let db = getDB();
    if (!db) {
        try {
            await initDB();
        } catch (e) {
            logger.error('主题存储: 数据库初始化失败:', e);
        }
        db = getDB();
    }
    if (!db) throw new Error('数据库未初始化');
    return db;
}

function withStore(db, mode, callback) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction([STORE_NAME], mode);
        const store = tx.objectStore(STORE_NAME);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('事务被中断'));
        callback(store, resolve, reject);
    });
}

export async function saveTheme(themeData) {
    themeData.updatedAt = Date.now();
    return withDBLock('theme-write', async () => {
        const db = await ensureDB();
        return withStore(db, 'readwrite', (store, resolve, reject) => {
            const req = store.put(themeData);
            req.onsuccess = () => resolve(themeData);
            req.onerror = () => reject(req.error);
        });
    });
}

export async function loadTheme(themeId) {
    const builtin = BUILTIN_THEMES.find((t) => t.id === themeId);
    if (builtin) return builtin;
    const db = await ensureDB();
    return withStore(db, 'readonly', (store, resolve, reject) => {
        const req = store.get(themeId);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
    });
}

export async function deleteTheme(themeId) {
    if (themeId.startsWith('__')) throw new Error('不能删除内置主题');
    return withDBLock('theme-write', async () => {
        const db = await ensureDB();
        return withStore(db, 'readwrite', (store, resolve, reject) => {
            const req = store.delete(themeId);
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
        });
    });
}

export async function listThemes() {
    const db = await ensureDB();
    const custom = await withStore(db, 'readonly', (store, resolve, reject) => {
        const req = store.getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
    });
    return [...BUILTIN_THEMES, ...custom];
}

/* ===== 导入导出 ===== */

export function exportThemeAsJSON(themeData) {
    downloadJSON(themeData, `${themeData.name || 'theme'}.json`);
}

export function importThemeFromFile() {
    return new Promise((resolve, reject) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';

        input.addEventListener('change', async () => {
            const file = input.files?.[0];
            if (!file) {
                reject(new Error('未选择文件'));
                return;
            }

            try {
                const text = await file.text();
                const raw = JSON.parse(text);
                const { valid, theme, warnings } = validateTheme(raw);

                if (!valid) {
                    reject(new Error(warnings.join('; ')));
                    return;
                }

                theme.id = generateId('theme');
                theme.createdAt = Date.now();
                theme.updatedAt = Date.now();

                resolve({ theme, warnings });
            } catch (e) {
                reject(new Error(`主题文件解析失败: ${e.message}`));
            }
        });

        // 兜底：某些浏览器不触发 cancel 事件，通过 focus 检测
        let handled = false;

        input.addEventListener('cancel', () => {
            handled = true;
            reject(new Error('用户取消选择'));
        });

        input.addEventListener('change', () => {
            handled = true;
        });
        window.addEventListener(
            'focus',
            function onFocus() {
                setTimeout(() => {
                    window.removeEventListener('focus', onFocus);
                    if (!handled && input.files?.length === 0) {
                        reject(new Error('用户取消选择'));
                    }
                }, 300);
            },
            { once: false }
        );

        input.click();
    });
}
