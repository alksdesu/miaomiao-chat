/**
 * 主题切换功能
 * 管理明暗主题，集成主题引擎
 */

import { elements } from '../core/elements.js';
import { eventBus } from '../core/events.js';
import { state } from '../core/state.js';
import { savePreference } from '../state/storage.js';
import {
    applyTheme as applyCustomTheme,
    restoreThemeFromCache,
    getActiveThemeId,
    getBuiltinTheme,
    resetTheme,
    cacheThemeToLocalStorage
} from './theme-engine.js';
import { loadTheme as loadThemeFromStore } from '../state/theme-storage.js';
import { updateVisibleMermaidTheme } from '../utils/mermaid.js';
import { logger } from '../utils/logger.js';

let mermaidThemeRefreshTaskId = 0;

function enqueueMicrotask(task) {
    Promise.resolve().then(task);
}

function getAppliedTheme() {
    return document.documentElement.classList.contains('dark-theme') ? 'dark' : 'light';
}

function scheduleMermaidThemeRefresh(expectedTheme) {
    mermaidThemeRefreshTaskId += 1;
    const taskId = mermaidThemeRefreshTaskId;

    enqueueMicrotask(async () => {
        try {
            const { failedCount } = await updateVisibleMermaidTheme();
            if (taskId !== mermaidThemeRefreshTaskId || expectedTheme !== getAppliedTheme()) {
                return;
            }

            if (failedCount > 0) {
                eventBus.emit('ui:notification', {
                    message: '部分 Mermaid 图表主题更新失败',
                    type: 'warning'
                });
            }
        } catch (error) {
            if (taskId !== mermaidThemeRefreshTaskId || expectedTheme !== getAppliedTheme()) {
                return;
            }

            logger.error('Mermaid 主题刷新失败:', error);
            eventBus.emit('ui:notification', {
                message: 'Mermaid 图表主题刷新失败',
                type: 'warning'
            });
        }
    });
}

function getSystemTheme() {
    if (window.matchMedia?.('(prefers-color-scheme: light)')?.matches) return 'light';
    return 'dark';
}

/**
 * 切换主题（明暗模式）
 */
export async function toggleTheme() {
    const html = document.documentElement;
    const isDark = html.classList.contains('dark-theme');
    const newBase = isDark ? 'light' : 'dark';

    html.classList.add('theme-transition');
    setTimeout(() => html.classList.remove('theme-transition'), 300);

    const activeId = getActiveThemeId();
    if (activeId && !activeId.startsWith('__')) {
        // 自定义主题：从存储加载完整数据，切换 base 后重新 apply
        try {
            const theme = await loadThemeFromStore(activeId);
            if (theme) {
                theme.base = newBase;
                await applyCustomTheme(theme, { skipMermaid: true });
                cacheThemeToLocalStorage(theme);
            } else {
                await applyCustomTheme({ base: newBase });
            }
        } catch {
            await applyCustomTheme({ base: newBase });
        }
        localStorage.setItem('theme', newBase);
    } else if (activeId && activeId.startsWith('__')) {
        // 内置预设：切换到对应 base 的内置预设
        const preset = getBuiltinTheme(newBase === 'dark' ? '__dark__' : '__light__');
        resetTheme();
        cacheThemeToLocalStorage(preset);
        await applyCustomTheme(preset);
    } else {
        // 无自定义主题
        await applyCustomTheme({ base: newBase });
        localStorage.setItem('theme', newBase);
    }

    try {
        if (state.storageMode !== 'localStorage') {
            await savePreference('theme', newBase);
        }
    } catch (error) {
        logger.error('保存主题失败:', error);
    }

    scheduleMermaidThemeRefresh(newBase);
}

/**
 * 加载保存的主题设置（同步，在 IndexedDB 初始化前调用）
 */
export function loadTheme() {
    const savedTheme = localStorage.getItem('theme');
    const theme = savedTheme === 'light' || savedTheme === 'dark' ? savedTheme : getSystemTheme();

    // 同步设 base class（防 FOUC）
    document.documentElement.classList.toggle('dark-theme', theme !== 'light');

    // 同步恢复自定义主题缓存
    restoreThemeFromCache();

    // 异步刷新 Mermaid（不阻塞首屏）
    scheduleMermaidThemeRefresh(theme);
}

/**
 * 初始化主题切换
 */
export function initTheming() {
    elements.themeToggle?.addEventListener('click', toggleTheme);

    const media = window.matchMedia?.('(prefers-color-scheme: light)');
    media?.addEventListener?.('change', () => {
        const savedTheme = localStorage.getItem('theme');
        if (savedTheme === 'light' || savedTheme === 'dark') return;

        applyCustomTheme({ base: getSystemTheme() })
            .then(() => {
                scheduleMermaidThemeRefresh(getSystemTheme());
            })
            .catch((e) => {
                logger.error('系统主题切换失败:', e);
            });
    });

    // 跨标签页主题同步：监听 localStorage 变更
    window.addEventListener('storage', (e) => {
        if (e.key === 'activeThemeCache' || e.key === 'theme') {
            const savedTheme = localStorage.getItem('theme');
            if (savedTheme === 'light' || savedTheme === 'dark') {
                document.documentElement.classList.toggle('dark-theme', savedTheme === 'dark');
            }
            resetTheme();
            restoreThemeFromCache();
            scheduleMermaidThemeRefresh(getAppliedTheme());
        }
    });

    logger.debug('主题切换已初始化');
}
