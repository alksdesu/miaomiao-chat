/**
 * 主入口文件
 * 初始化所有模块并启动应用
 */

// requestIdleCallback 降级（Safari / 旧 WebView 不支持）
if (typeof window.requestIdleCallback !== 'function') {
    window.requestIdleCallback = (fn) => setTimeout(fn, 1);
    window.cancelIdleCallback = (id) => clearTimeout(id);
}

// ========== 全局错误处理器 ==========
// eventBus 直接 import；window.eventBus 从未挂载导致 if(window.eventBus) 死守门吞 toast
import { eventBus as _globalErrorEventBus } from './core/events.js';
import { escapeHtml } from './utils/helpers.js';
import { isSafeHref } from './utils/uri.js';
import { HLJS_MAX_CODE_LENGTH } from './utils/constants.js';

function _emitGlobalErrorNotification(rawMessage) {
    try {
        _globalErrorEventBus.emit('ui:notification', {
            message: `操作失败: ${escapeHtml(String(rawMessage || '未知错误'))}`,
            type: 'error',
            duration: 8000
        });
    } catch (_) {
        /* eventBus 早期未就绪时 fallback console，已经在 catch 外打过 */
    }
}

/**
 * 全局未捕获的 Promise rejection 处理器
 */
window.addEventListener('unhandledrejection', (event) => {
    console.error('未捕获的 Promise rejection:', event.reason);
    event.preventDefault();
    _emitGlobalErrorNotification(event.reason?.message || event.reason);
});

/**
 * 全局错误处理器（捕获同步错误）
 */
window.addEventListener('error', (event) => {
    console.error('全局错误:', {
        message: event.message,
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno,
        error: event.error
    });
    event.preventDefault();
    _emitGlobalErrorNotification(event.error?.message || event.message);
});

/**
 * 初始化 Electron 自定义标题栏
 */
function initElectronTitlebar() {
    if (!isElectron()) return;

    const titlebar = document.getElementById('electron-titlebar');
    if (!titlebar) return;

    titlebar.style.display = '';

    document.getElementById('titlebar-devtools')?.addEventListener('click', () => {
        window.electronAPI.toggleDevTools();
    });
    document.getElementById('titlebar-network')?.addEventListener('click', () => {
        loadAndCall(() => import('./network/panel.js'), 'toggleNetworkPanel', {
            onError: 'notify',
            context: 'Network 面板'
        });
    });
    document.getElementById('titlebar-minimize')?.addEventListener('click', () => {
        window.electronAPI.windowMinimize();
    });
    document.getElementById('titlebar-maximize')?.addEventListener('click', () => {
        window.electronAPI.windowMaximize();
    });
    document.getElementById('titlebar-close')?.addEventListener('click', () => {
        window.electronAPI.windowClose();
    });
}

// ========== Core Layer ==========
import './core/events.js';
import { eventBus } from './core/events.js';
import { state } from './core/state.js';
import { elements, initElements } from './core/elements.js';

// ========== Utils Layer ==========
import './utils/helpers.js';
import './utils/variables.js';
import './utils/markdown.js';
import './utils/images.js';
import './utils/prefill.js';
import './utils/errors.js';
import { isElectron, isAndroid } from './utils/platform.js';

// ========== UI Layer (Basic) ==========
import { loadTheme, initTheming } from './ui/theming.js';
import './ui/notifications.js';

// ========== State Layer ==========
import {
    initDB,
    loadPreference,
    isIndexedDBAvailable,
    isLocalStorageAvailable,
    migrateMCPServersFromLocalStorage,
    loadAllMCPServers,
    migrateSessionsToV4
} from './state/storage.js';
import { loadConfig, saveCurrentConfigImmediate } from './state/config.js';
import { loadSessions, saveCurrentSessionMessages } from './state/sessions.js';
import { initTabSync } from './state/tab-sync.js';
// initExportImport → 延迟动态加载
import { initQuickMessages } from './state/quick-messages.js';
// 新增：数据迁移
import {
    executeMigration,
    getMigrationStatus,
    acquireMigrationLock,
    releaseMigrationLock,
    MIGRATION_STATES
} from './state/migration.js';
import { runMigrationIfNeeded } from './state/migration-gate.js';

// ========== Providers Layer ==========
import { migrateFromLegacyConfig } from './providers/manager.js';
// initProvidersUI → 延迟动态加载

// ========== Messages Layer ==========
import './messages/sync.js';
import './messages/renderer.js';
import './messages/editor.js';
import './messages/restore.js';
import { initReplySelector } from './messages/reply-selector.js';

// ========== API Layer ==========
import './api/params.js';
import './api/openai.js';
import './api/gemini.js';
import './api/claude.js';
import './api/factory.js';
import { initAPIHandler } from './api/handler.js';

// ========== Stream Layer ==========
import './stream/stats.js';
import './stream/helpers.js';
import './stream/parser-openai.js';
import './stream/parser-claude.js';
import './stream/parser-gemini.js';
import './tools/orchestrator.js';

// ========== Tools Layer (第10层) ==========
import { initTools } from './tools/init.js';
import './tools/message-compat.js';

// ========== UI Layer (Critical — 首屏交互必需) ==========
import { initInputHandlers } from './ui/input.js';
import { initSidebar } from './ui/sidebar.js';
import { initScrollControl } from './ui/scroll.js';
import { initClearChat } from './ui/clear.js';
import { initKeyboard } from './ui/keyboard.js';
import { initInputResize, initPanelResize } from './ui/resize.js';
import { initModels } from './ui/models.js';
import { initFormatSwitcher } from './ui/format-switcher.js';
import { initQuickToggles, exposeToggleFunctions } from './ui/quick-toggles.js';
import { initPasswordToggles, initRippleEffects } from './ui/enhancements.js';
import { initMobileOverflowMenu } from './ui/mobile-overflow-menu.js';
import { initAndroidBackHandler } from './ui/android-back-handler.js';

// ========== UI Layer (Deferred — 非首屏，动态加载) ==========
// settings, viewer, prefill, config-helpers, custom-headers,
// session-search, mcp-settings, tool-manager, quick-messages-ui,
// tools-quick-selector, update-modal, export-import
// → 改为 init() 中延迟动态 import

// ========== Performance & Memory ==========
import { initMemoryManager } from './utils/memory-manager.js';
import { logger } from './utils/logger.js';
import { loadModule, loadAndCall } from './utils/dynamic-import.js';

/**
 * 初始化应用
 */
async function init() {
    // 尽早安装 fetch 代理，捕获所有网络请求
    loadAndCall(() => import('./network/interceptor.js'), 'installFetchProxy', {
        onError: 'log',
        context: 'fetch 代理'
    });

    // 安装 console 拦截器（尽早，捕获所有日志；工具注册在 initTools 中完成）
    loadAndCall(() => import('./devtools/console-interceptor.js'), 'installConsoleInterceptor', {
        onError: 'log',
        context: 'console 拦截器'
    });

    logger.debug('[init] 启动...');

    const currentPlatform = isElectron() ? 'electron' : isAndroid() ? 'android' : 'web';
    document.documentElement.dataset.platform = currentPlatform;

    // Chii DevTools（Web/Android 端，Electron 用原生 DevTools）
    if (!isElectron()) {
        // 用户主动点开发者工具，加载失败要让用户感知（按钮无反应是最糟体验）
        const showOpts = { onError: 'notify', context: 'Chii DevTools' };
        eventBus.on('devtools:show', () => {
            loadAndCall(() => import('./devtools/chii.js'), 'showChii', showOpts);
        });
        eventBus.on('devtools:toggle', () => {
            loadAndCall(() => import('./devtools/chii.js'), 'toggleChii', showOpts);
        });
        document.getElementById('mobile-devtools-btn')?.addEventListener('click', () => {
            loadAndCall(() => import('./devtools/chii.js'), 'showChii', showOpts);
        });
    }

    // Network 面板按钮（三平台通用）
    document.getElementById('network-toggle')?.addEventListener('click', () => {
        loadAndCall(() => import('./network/panel.js'), 'toggleNetworkPanel', {
            onError: 'notify',
            context: 'Network 面板'
        });
    });

    // 抓包重放 → 打开构建器（用户主动从抓包列表点重放，失败需提示）
    eventBus.on('network:replay-request', async (record) => {
        const panel = await loadModule(() => import('./network/panel.js'), {
            onError: 'notify',
            context: '抓包重放打开面板'
        });
        if (!panel) return;
        panel.openNetworkPanel();
        panel.switchTab('builder');
        setTimeout(async () => {
            const builder = await loadModule(() => import('./network/builder-view.js'), {
                onError: 'notify',
                context: '抓包重放导入构建器'
            });
            builder?.importToBuilder(record);
        }, 100);
    });

    // 初始化 Electron 自定义标题栏（仅桌面端）
    if (currentPlatform === 'electron') {
        initElectronTitlebar();
    }

    try {
        // 检查存储可用性（处理跟踪保护）
        const hasIndexedDB = isIndexedDBAvailable();
        const hasLocalStorage = isLocalStorageAvailable();

        if (!hasIndexedDB && !hasLocalStorage) {
            // ❌ 两种存储都不可用（严格跟踪保护模式）
            throw new Error(
                '存储功能被浏览器跟踪保护阻止\n\n' +
                    '请尝试以下操作：\n' +
                    '1. 关闭浏览器的严格跟踪保护（Safari: 设置 → 隐私 → 防止跨网站跟踪）\n' +
                    '2. 将本站点添加到跟踪保护白名单\n' +
                    '3. 使用其他浏览器（Chrome, Edge, Firefox）'
            );
        }

        if (!hasIndexedDB && hasLocalStorage) {
            logger.warn('⚠️ IndexedDB 被阻止，将使用 localStorage 降级模式');
            state.storageMode = 'localStorage';
        }

        // 1. 初始化 DOM 元素引用（必须最先执行）

        initElements();

        // 1. 配置 Marked.js（代码高亮）
        if (typeof marked !== 'undefined') {
            // 自定义链接渲染器：外部链接在新标签页打开
            // 必须 escapeHtml(href/title)：marked v15 默认 renderer 会做该处理，自定义覆写需补回
            // 否则 [click](https://x "a\" style=\"background:url(javascript:alert(1))\"") 可注入属性
            const renderer = new marked.Renderer();
            renderer.link = function ({ href, title, text }) {
                // isSafeHref 拦截 javascript:/vbscript:/data:text/html，escapeHtml 防属性注入
                const safeHrefStr = href && isSafeHref(href) ? escapeHtml(href) : '';
                const safeTitleAttr = title ? ` title="${escapeHtml(title)}"` : '';
                // 判断是否为外部链接（http/https 开头）
                if (href && /^https?:\/\//i.test(href)) {
                    return `<a href="${safeHrefStr}"${safeTitleAttr} target="_blank" rel="noopener noreferrer">${text}</a>`;
                }
                // 内部链接或其他协议，正常渲染
                return `<a href="${safeHrefStr}"${safeTitleAttr}>${text}</a>`;
            };

            marked.setOptions({
                breaks: true,
                gfm: true,
                renderer: renderer,
                highlight: function (code, lang) {
                    // 超长代码同步高亮会在 marked.parse 内冻结主线程，交给默认转义展示
                    if (
                        typeof hljs !== 'undefined' &&
                        code.length <= HLJS_MAX_CODE_LENGTH &&
                        hljs.getLanguage(lang)
                    ) {
                        return hljs.highlight(code, { language: lang }).value;
                    }
                    return code;
                }
            });
        }

        // 2. 核心层（同步）

        loadTheme();

        // 3. 存储层

        let dbReady = false;
        try {
            const dbInstance = await initDB();
            if (dbInstance) {
                dbReady = true;
            } else {
                logger.warn('IndexedDB 初始化返回空实例，启用 localStorage 降级模式');
                state.storageMode = 'localStorage';
            }
        } catch (error) {
            logger.error('IndexedDB 初始化失败，启用 localStorage 降级模式:', error);
            state.storageMode = 'localStorage';
            eventBus.emit('ui:notification', {
                message: 'IndexedDB 不可用，数据将保存到 localStorage',
                type: 'warning',
                duration: 5000
            });
        }

        // 3.4. v4 消息分离存储迁移（将 session 中嵌入的消息提取到独立 store）
        if (dbReady) {
            try {
                const v4Count = await migrateSessionsToV4();
                if (v4Count > 0) logger.debug(`[v4] 迁移完成: ${v4Count} 个会话`);
            } catch (e) {
                logger.error('[v4] 消息分离迁移失败:', e);
            }
        }

        // 3.5. 消息格式迁移（三格式 → 统一 parts[] 格式）
        if (dbReady) {
            try {
                const migrationResult = await runMigrationIfNeeded();
                if (migrationResult.migrated) {
                    logger.debug(`[schema] 消息格式迁移完成: ${migrationResult.count} 个会话`);
                    if (migrationResult.errors.length > 0) {
                        logger.warn(`[schema] ${migrationResult.errors.length} 个会话有迁移错误`);
                    }
                }
            } catch (e) {
                logger.error('[schema] 消息格式迁移失败:', e);
            }
        }

        // 3.6. 迁移检查与配置加载并行（迁移已完成时省去串行等待）
        if (state.storageMode !== 'localStorage') {
            const [migrationStatus] = await Promise.all([
                getMigrationStatus(),
                // 乐观并行：多数情况迁移已完成，loadConfig 可以安全并行
                (async () => {
                    await loadConfig();
                })()
            ]);

            if (migrationStatus !== MIGRATION_STATES.COMPLETED) {
                logger.debug(`迁移状态: ${migrationStatus}，执行迁移...`);
                try {
                    acquireMigrationLock();
                } catch (lockError) {
                    logger.warn('迁移锁获取失败:', lockError.message);
                }
                if (localStorage.getItem('migration_lock')) {
                    try {
                        await executeMigration();
                        // 迁移完成后重新加载配置（覆盖乐观加载的结果）
                        await loadConfig();
                    } catch (migrationError) {
                        logger.error('迁移失败:', migrationError);
                    } finally {
                        releaseMigrationLock();
                    }
                }
            }
        } else {
            logger.debug('⚙️  Step 3/9: Loading configuration...');
            await loadConfig();
        }

        // 迁移旧配置到提供商系统 (如果需要)

        migrateFromLegacyConfig();

        // Electron: 通过 IPC 将初始化设置发送给主进程（替代 executeJavaScript）
        if (window.electronAPI?.sendInitSettings) {
            try {
                const settingsJson = await loadPreference('appSettings');
                const appSettings = settingsJson ? JSON.parse(settingsJson) : {};
                await window.electronAPI.sendInitSettings(appSettings);
                logger.debug('[Main] 已通过 IPC 发送初始化设置');
            } catch (err) {
                logger.error('[Main] 发送初始化设置失败:', err);
            }
        }

        // 并行加载会话、快捷消息、MCP 配置（三者互不依赖，都只依赖 IndexedDB）

        const loadMCPConfig = async () => {
            if (state.storageMode !== 'localStorage') {
                try {
                    const migratedCount = await migrateMCPServersFromLocalStorage();
                    if (migratedCount > 0) {
                        logger.debug(`[Main] 迁移 ${migratedCount} 个 MCP 服务器`);
                    }
                    state.mcpServers = await loadAllMCPServers();
                    logger.debug(`[Main] 加载 ${state.mcpServers.length} 个 MCP 服务器`);
                } catch (error) {
                    logger.error('[Main] 加载 MCP 配置失败:', error);
                    try {
                        const saved = localStorage.getItem('mcpServers');
                        if (saved) {
                            state.mcpServers = JSON.parse(saved);
                            logger.debug(
                                `[Main] 从 localStorage 加载 ${state.mcpServers.length} 个 MCP 服务器`
                            );
                        }
                    } catch (fallbackError) {
                        logger.error('[Main] 从 localStorage 加载失败:', fallbackError);
                    }
                }
            } else {
                try {
                    const saved = localStorage.getItem('mcpServers');
                    if (saved) {
                        state.mcpServers = JSON.parse(saved);
                        logger.debug(
                            `[Main] 从 localStorage 加载 ${state.mcpServers.length} 个 MCP 服务器`
                        );
                    }
                } catch (error) {
                    logger.error('[Main] 从 localStorage 加载 MCP 配置失败:', error);
                }
            }
        };

        await Promise.all([loadSessions(), initQuickMessages(), loadMCPConfig()]);

        initTabSync();
        initMemoryManager();

        // 会话消息已渲染，移除骨架屏
        const skeleton = document.getElementById('app-skeleton');
        if (skeleton) skeleton.remove();

        // API 层
        initAPIHandler();
        initReplySelector();

        // 工具系统
        await initTools();

        // 恢复当前会话的 AI Monitor 状态（必须在 initTools 注册完工具之后）
        loadAndCall(() => import('./devtools/init.js'), 'restoreMonitorState', {
            onError: 'log',
            context: 'AI Monitor 状态恢复'
        });

        // 监听工具执行状态变化，保存结果到消息历史
        eventBus.on('tool:status:changed', ({ toolId, status, result }) => {
            if (status === 'completed' || status === 'failed') {
                loadModule(() => import('./messages/sync.js'), {
                    onError: 'log',
                    context: '工具结果保存'
                }).then((mod) => mod?.updateToolCallResult(toolId, status, result));
            }
        });

        // 首屏关键 UI
        initTheming();
        initKeyboard();
        initPasswordToggles();
        initRippleEffects();
        initInputHandlers();
        initClearChat();
        initModels();
        initFormatSwitcher();
        initQuickToggles();
        exposeToggleFunctions();
        initSidebar();
        initScrollControl();
        initMobileOverflowMenu();

        // 安卓返回属于基础交互能力，需要早于延迟模块注册；
        // 当前实现建立在"相关弹层只能在所属模块初始化后由用户正常打开"的前提上，
        // 因此这里按界面层查询与现有关闭入口分发即可，不需要静态接入所有延迟模块。
        await initAndroidBackHandler();

        // 需要 await 的调整尺寸操作
        await Promise.all([initInputResize(), initPanelResize()]);

        // 非首屏 UI（延迟动态加载，不阻塞首次交互）
        requestIdleCallback(
            async () => {
                try {
                    const [
                        { initSettings },
                        { initImageViewer },
                        {
                            initEndpointInputListeners,
                            initThinkingControls,
                            initConfigManagement,
                            initOtherConfigInputs
                        },
                        { initGeminiSystemParts },
                        { initPrefillModal },
                        { initCustomHeaders },
                        { initQuickMessagesUI },
                        { initSessionSearch },
                        { initMCPSettings },
                        { initToolManager },
                        { initToolsQuickSelector },
                        { initUpdateModal },
                        { initExportImport },
                        { initProvidersUI }
                    ] = await Promise.all([
                        import('./ui/settings.js'),
                        import('./ui/viewer.js'),
                        import('./ui/config-helpers.js'),
                        import('./ui/prefill.js'),
                        import('./ui/prefill-modal.js'),
                        import('./ui/enhancements.js'),
                        import('./ui/quick-messages.js'),
                        import('./ui/session-search.js'),
                        import('./ui/mcp-settings.js'),
                        import('./ui/tool-manager.js'),
                        import('./ui/tools-quick-selector.js'),
                        import('./update/update-modal.js'),
                        import('./state/export-import.js'),
                        import('./providers/ui.js')
                    ]);

                    initSettings();
                    initImageViewer();
                    initEndpointInputListeners();
                    initThinkingControls();
                    initConfigManagement();
                    initOtherConfigInputs();
                    initGeminiSystemParts();
                    initPrefillModal();
                    initCustomHeaders();
                    initQuickMessagesUI();
                    initSessionSearch();
                    initProvidersUI();
                    initMCPSettings();
                    initToolManager();
                    initToolsQuickSelector();
                    initUpdateModal();
                    initExportImport();

                    // MCP 增强
                    loadAndCall(
                        () => import('./ui/tool-manager-mcp-enhancements.js'),
                        'initToolManagerMCPEnhancements',
                        { onError: 'log', context: '工具管理器 MCP 增强' }
                    );
                    loadAndCall(
                        () => import('./ui/tools-quick-selector-enhancements.js'),
                        'initQuickSelectorEnhancements',
                        { onError: 'log', context: '快速工具选择器增强' }
                    );

                    // 主题编辑器
                    loadAndCall(() => import('./ui/theme-editor.js'), 'initThemeEditor', {
                        onError: 'log',
                        context: '主题编辑器'
                    });

                    // OpenClaw 模块（审批、屏幕截图、定时任务）
                    loadAndCall(() => import('./ui/openclaw-approval.js'), 'initOpenClawApproval', {
                        onError: 'log',
                        context: 'OpenClaw 审批模块'
                    });
                    loadAndCall(() => import('./ui/openclaw-screen.js'), 'initOpenClawScreen', {
                        onError: 'log',
                        context: 'OpenClaw 屏幕模块'
                    });
                    loadAndCall(() => import('./ui/openclaw-cron.js'), 'initOpenClawCron', {
                        onError: 'log',
                        context: 'OpenClaw 定时任务模块'
                    });

                    // APK 更新（仅 Android）
                    if (isAndroid()) {
                        await loadAndCall(
                            () => import('./update/apk-updater.js'),
                            'initAPKUpdater',
                            {
                                onError: 'log',
                                context: 'APK 更新模块'
                            }
                        );
                    }
                } catch (error) {
                    logger.error('延迟加载 UI 模块失败:', error);
                }
            },
            { timeout: 1000 }
        );

        // 会话恢复已由 loadSessions() 处理（Line 183）
        // loadSessions() 中已包含：
        //   - 加载 currentSessionId（IndexedDB 优先）
        //   - switchToSession(currentId) 或 switchToSession(sessions[0].id)
        // 无需在此重复恢复

        // 恢复侧边栏状态
        try {
            let savedSidebarState = null;
            if (state.storageMode !== 'localStorage') {
                savedSidebarState = await loadPreference('sidebarOpen');
            }
            // 降级：从 localStorage 读取
            if (savedSidebarState === null || savedSidebarState === undefined) {
                savedSidebarState = localStorage.getItem('sidebarOpen');
            }

            const shouldOpenSidebar = savedSidebarState === true || savedSidebarState === 'true';
            if (
                shouldOpenSidebar &&
                elements.sidebar &&
                !elements.sidebar.classList.contains('open')
            ) {
                setTimeout(() => {
                    loadModule(() => import('./ui/sidebar.js'), {
                        onError: 'log',
                        context: '侧边栏状态恢复'
                    }).then((mod) => mod?.toggleSidebar(true)); // skipSave = true，避免循环
                }, 100);
            }
        } catch (error) {
            logger.error('恢复侧边栏状态失败:', error);
            // 降级处理
            const savedSidebarState = localStorage.getItem('sidebarOpen');
            const shouldOpenSidebar = savedSidebarState === true || savedSidebarState === 'true';
            if (
                shouldOpenSidebar &&
                elements.sidebar &&
                !elements.sidebar.classList.contains('open')
            ) {
                setTimeout(() => {
                    loadModule(() => import('./ui/sidebar.js'), {
                        onError: 'log',
                        context: '侧边栏状态恢复（降级）'
                    }).then((mod) => mod?.toggleSidebar(true));
                }, 100);
            }
        }

        logger.debug('[init] 完成');

        // 延迟执行非关键任务
        // 请求持久化存储（不影响功能，延迟执行）
        if (dbReady) {
            loadAndCall(() => import('./state/storage.js'), 'requestPersistentStorage', {
                onError: 'log',
                context: '持久化存储请求'
            });
        }

        // 自动连接 MCP 服务器（MCP 工具不可用会显著影响业务，需用户感知）
        loadModule(() => import('./ui/mcp-auto-connect.js'), {
            onError: 'notify',
            context: 'MCP 自动连接'
        }).then((mod) => mod?.initMCPAutoConnect(1000));

        // Electron 环境下初始化 MCP IPC 桥接
        if (isElectron()) {
            loadAndCall(() => import('./tools/mcp/electron-bridge.js'), 'initElectronMCPBridge', {
                onError: 'log',
                context: 'MCP IPC 桥接'
            });
        }

        // 关闭/隐藏前 flush 未保存的会话 dirty。
        // visibilitychange='hidden' 在用户切走 tab 时触发但页面不立即销毁，await 是有意义的；
        // beforeunload 则是同步事件，async 操作大概率被浏览器 kill，仅作为保底入口
        const flushOnHidden = async () => {
            saveCurrentConfigImmediate();
            try {
                await saveCurrentSessionMessages(true);
            } catch (_e) {
                /* 后台路径吞掉异常 */
            }
        };

        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                // 用户切 tab/锁屏时页面还活着，可 await 完整 IDB 事务
                flushOnHidden();
            }
        });

        // beforeunload 是浏览器关页前最后机会。IDB readwrite 事务在 unload 期间是 best-effort
        // 完成（Chrome 实现允许 in-flight tx commit），但 async/await 的 microtask 链会断。
        // 主要保存路径已由 visibilitychange 覆盖，此处仅同步入口启动事务
        window.addEventListener('beforeunload', () => {
            saveCurrentConfigImmediate();
            try {
                // 不 await：fire-and-forget 让浏览器最后一拍捎带提交
                saveCurrentSessionMessages(true);
            } catch (_e) {
                /* 关闭路径吞掉异常 */
            }
        });

        // pagehide 在移动 Safari / BFCache 场景下比 beforeunload 可靠（unload 不一定触发）
        window.addEventListener('pagehide', () => {
            saveCurrentConfigImmediate();
            try {
                saveCurrentSessionMessages(true);
            } catch (_e) {
                /* 隐藏路径吞掉异常 */
            }
        });

        // 死事件检测：emit 过但无 on() 监听者的事件名首次出现时 warn 一次
        eventBus.startDeadEventScanner();
    } catch (error) {
        logger.error('初始化失败:', error);
        logger.error('Stack trace:', error.stack);
        throw error;
    }
}

// 启动应用
init().catch((error) => {
    logger.error('Fatal error during initialization:', error);
    // 转义 error 内容，防止 XSS
    const div = document.createElement('div');
    div.textContent = error.message || '';
    const safeMsg = div.innerHTML;
    div.textContent = error.stack || '无堆栈信息';
    const safeStack = div.innerHTML;
    // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
    document.body.innerHTML = `
        <div style="padding: 20px; color: #b42318; line-height: 1.6; font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', '微软雅黑', sans-serif;">
            <h1 style="margin: 0 0 12px; font-size: 28px;">初始化失败</h1>
            <p style="margin: 0 0 12px;"><strong>错误信息：</strong>${safeMsg}</p>
            <pre style="margin: 0 0 16px; padding: 12px 16px; overflow: auto; border-radius: 8px; background: rgba(180, 35, 24, 0.08); border: 1px solid rgba(180, 35, 24, 0.2); color: #7a0916; font-family: 'Space Mono', 'JetBrains Mono', 'Cascadia Code', 'SF Mono', 'Consolas', monospace;">${safeStack}</pre>
            <p style="margin: 0;">请打开控制台查看更多详情。</p>
        </div>
    `;
});
