/**
 * 快捷开关功能
 * 处理顶部快捷开关（流式/思维链/网络搜索）
 */

import { state } from '../core/state.js';
import { eventBus } from '../core/events.js';
import { saveCurrentConfig } from '../state/config.js';
import { handleAttachFile } from './input.js';
import { showNotification } from './notifications.js';
import { isElectron } from '../utils/platform.js';
import {
    setStreamEnabled,
    setThinkingEnabled,
    setWebSearchEnabled,
    setCodeExecutionEnabled,
    setComputerUseEnabled
} from '../core/state-mutations.js';
import { logger } from '../utils/logger.js';

/**
 * 同步快捷开关状态
 */
export function syncQuickToggles() {
    document.getElementById('toggle-stream')?.classList.toggle('active', state.streamEnabled);
    document.getElementById('toggle-thinking')?.classList.toggle('active', state.thinkingEnabled);
    document.getElementById('toggle-websearch')?.classList.toggle('active', state.webSearchEnabled);
    document
        .getElementById('toggle-code-exec')
        ?.classList.toggle('active', state.codeExecutionEnabled);
    document
        .getElementById('toggle-computer-use')
        ?.classList.toggle('active', state.computerUseEnabled);
    document.getElementById('toggle-ai-monitor')?.classList.toggle('active', state.monitorEnabled);
}

/**
 * 初始化快捷开关
 */
export function initQuickToggles() {
    // 流式开关
    const toggleStream = document.getElementById('toggle-stream');
    if (toggleStream) {
        toggleStream.classList.toggle('active', state.streamEnabled);
        toggleStream.addEventListener('click', () => {
            setStreamEnabled(!state.streamEnabled);
            toggleStream.classList.toggle('active', state.streamEnabled);
            // 同步设置面板开关
            const panelSwitch = document.getElementById('stream-enabled');
            if (panelSwitch) panelSwitch.checked = state.streamEnabled;
            saveCurrentConfig();
        });
    }

    // 思维链开关
    const toggleThinking = document.getElementById('toggle-thinking');
    if (toggleThinking) {
        toggleThinking.classList.toggle('active', state.thinkingEnabled);
        toggleThinking.addEventListener('click', () => {
            setThinkingEnabled(!state.thinkingEnabled);
            toggleThinking.classList.toggle('active', state.thinkingEnabled);
            // 同步设置面板开关
            const panelSwitch = document.getElementById('thinking-enabled');
            if (panelSwitch) panelSwitch.checked = state.thinkingEnabled;
            // 显示/隐藏强度选择
            const strengthGroup = document.getElementById('thinking-strength-group');
            if (strengthGroup)
                strengthGroup.style.display = state.thinkingEnabled ? 'flex' : 'none';
            // 同步 thinkingHint 显隐
            const thinkingHint = document.getElementById('thinking-hint');
            if (thinkingHint) thinkingHint.style.display = state.thinkingEnabled ? 'block' : 'none';
            // 同步 Claude Adaptive 行显隐
            const claudeAdaptiveRow = document.getElementById('claude-adaptive-row');
            if (claudeAdaptiveRow)
                claudeAdaptiveRow.style.display = state.thinkingEnabled ? 'flex' : 'none';
            // 同步自定义 budget 输入框显隐
            const budgetInput = document.getElementById('thinking-budget-group');
            if (budgetInput)
                budgetInput.style.display =
                    state.thinkingEnabled && state.thinkingStrength === 'custom' ? 'flex' : 'none';
            saveCurrentConfig();
        });
    }

    // 网络搜索开关
    const toggleWebsearch = document.getElementById('toggle-websearch');
    if (toggleWebsearch) {
        toggleWebsearch.classList.toggle('active', state.webSearchEnabled);
        toggleWebsearch.addEventListener('click', () => {
            setWebSearchEnabled(!state.webSearchEnabled);
            toggleWebsearch.classList.toggle('active', state.webSearchEnabled);
            // 同步设置面板开关
            const panelSwitch = document.getElementById('web-search-enabled');
            if (panelSwitch) panelSwitch.checked = state.webSearchEnabled;
            saveCurrentConfig();
        });
    }

    // 上传按钮（复用 handleAttachFile）
    const attachFileMini = document.getElementById('attach-file-mini');
    if (attachFileMini) {
        attachFileMini.addEventListener('click', handleAttachFile);
    }

    // ========== Code Execution 快捷按钮 ==========
    const toggleCodeExec = document.getElementById('toggle-code-exec');
    if (toggleCodeExec) {
        // 初始状态
        toggleCodeExec.classList.toggle('active', state.codeExecutionEnabled);

        // 点击事件
        toggleCodeExec.addEventListener('click', async () => {
            setCodeExecutionEnabled(!state.codeExecutionEnabled);
            toggleCodeExec.classList.toggle('active', state.codeExecutionEnabled);

            // 同步设置面板开关
            const panelSwitch = document.getElementById('code-execution-enabled');
            if (panelSwitch) panelSwitch.checked = state.codeExecutionEnabled;

            // ⭐ 同步到工具管理器（Code Execution 不在工具管理器中，无需同步）
            // Code Execution 是通过 API 直接传递的特殊工具，不注册到 toolRegistry

            saveCurrentConfig();
        });
    }

    // ========== Computer Use 快捷按钮 ==========
    const toggleComputerUse = document.getElementById('toggle-computer-use');
    if (toggleComputerUse) {
        // 仅在 Electron 环境显示
        if (isElectron()) {
            toggleComputerUse.style.display = '';
        }

        // 初始状态
        toggleComputerUse.classList.toggle('active', state.computerUseEnabled);

        // 点击事件
        toggleComputerUse.addEventListener('click', async () => {
            setComputerUseEnabled(!state.computerUseEnabled);
            toggleComputerUse.classList.toggle('active', state.computerUseEnabled);

            // 同步设置面板开关
            const panelSwitch = document.getElementById('computer-use-enabled');
            if (panelSwitch) panelSwitch.checked = state.computerUseEnabled;

            // ⭐ 同步到工具管理器（Computer Use 工具 ID 为 'computer'）
            try {
                const { setToolEnabled } = await import('../tools/manager.js');
                setToolEnabled('computer', state.computerUseEnabled);
                logger.debug(
                    `[Quick Toggle] Computer Use 工具已${state.computerUseEnabled ? '启用' : '禁用'}`
                );
            } catch (error) {
                logger.error('[Quick Toggle] 同步 Computer Use 状态失败:', error);
                showNotification('Computer Use 状态同步失败', 'error');
            }

            saveCurrentConfig();
        });
    }

    // ========== AI Monitor 快捷按钮 ==========
    const toggleMonitor = document.getElementById('toggle-ai-monitor');
    if (toggleMonitor) {
        toggleMonitor.classList.toggle('active', state.monitorEnabled);
        toggleMonitor.addEventListener('click', async () => {
            const newVal = !state.monitorEnabled;
            const { setMonitorEnabled } = await import('../devtools/monitor-state.js');
            await setMonitorEnabled(newVal);
            toggleMonitor.classList.toggle('active', state.monitorEnabled);
            state.sessionDirty = true;
            showNotification(
                state.monitorEnabled ? 'AI Monitor 已启用' : 'AI Monitor 已关闭',
                state.monitorEnabled ? 'success' : 'info'
            );
        });
    }

    // ========== OpenClaw 自动化 + 状态条 ==========
    const toggleCron = document.getElementById('toggle-cron');
    const statusBar = document.getElementById('openclaw-status-bar');
    const statusCronBtn = document.getElementById('openclaw-sb-cron');

    // 打开定时任务面板
    const openCron = async () => {
        const { openCronPanel } = await import('./openclaw-cron.js');
        openCronPanel();
    };

    if (toggleCron) toggleCron.addEventListener('click', openCron);
    if (statusCronBtn) statusCronBtn.addEventListener('click', openCron);

    // 条件显隐：apiFormat === 'openclaw' && connected
    const updateOpenClawUI = () => {
        import('../api/openclaw.js').then(({ openclawClient }) => {
            const visible = state.apiFormat === 'openclaw' && openclawClient.connected;
            if (toggleCron) toggleCron.style.display = visible ? '' : 'none';
            if (statusBar) statusBar.style.display = visible ? 'flex' : 'none';
        });
    };

    eventBus.on('openclaw:connected', updateOpenClawUI);
    eventBus.on('openclaw:disconnected', updateOpenClawUI);
    eventBus.on('config:format-change-requested', updateOpenClawUI);
    updateOpenClawUI();

    logger.debug('Quick toggles initialized');
}

/**
 * 暴露到全局供 HTML 使用
 */
export function exposeToggleFunctions() {
    // 思维链折叠/展开
    window.toggleThinking = function (header) {
        const block = header.parentElement;
        const isCollapsed = block.classList.toggle('collapsed');
        header.setAttribute('aria-expanded', !isCollapsed);
    };

    // 思维链键盘事件
    window.handleThinkingKeydown = function (event, header) {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            window.toggleThinking(header);
        }
    };
}

// 监听配置同步事件
eventBus.on('config:sync-quick-toggles', () => {
    syncQuickToggles();
});
