/**
 * 代码编辑器模态框
 * 支持三个标签页：分析、代码、预览
 *
 * 使用 AbortController 管理事件监听器，关闭时统一清理
 */

import { eventBus } from '../core/events.js';
import { escapeHtml } from '../utils/helpers.js';
import {
    generateLanguageOptions,
    initCodeEditor,
    updateCodePreview,
    runLivePreview,
    analyzeCode
} from './code-editor-core.js';
import { trapFocus, openFullscreenPreview } from './code-editor-toolbar.js';
import { bindTopmostEscape } from '../utils/modal-stack.js';

/**
 * 打开代码编辑器模态框
 * @param {string} code - 代码内容
 * @param {string} language - 语言
 * @param {Function} onSave - 保存回调
 * @param {boolean} isReadOnly - 是否只读模式
 */
export function openCodeEditorModal(code, language, onSave, isReadOnly = false) {
    const modal = createCodeEditorModal(code, language, onSave, isReadOnly);
    document.body.appendChild(modal);

    // 焦点陷阱
    trapFocus(modal);

    // 禁用主内容交互
    document.querySelector('.app-container')?.setAttribute('inert', '');

    // 初始化标签页（默认显示「分析」）
    switchTab(modal, 'analysis');

    // 执行代码分析
    analyzeCode(modal, code, language);

    // 初始化代码编辑器（延迟执行确保 DOM 完全渲染）
    setTimeout(() => {
        const textarea = modal.querySelector('#code-editor-textarea');
        if (textarea) {
            initCodeEditor(modal, textarea, language);
        }
    }, 0);
}

/**
 * 创建模态框DOM
 * @param {string} code - 代码内容
 * @param {string} language - 语言
 * @param {Function} onSave - 保存回调
 * @param {boolean} isReadOnly - 是否只读模式
 */
function createCodeEditorModal(code, language, onSave, isReadOnly = false) {
    const modal = document.createElement('div');
    modal.id = 'code-editor-modal';
    modal.className = 'modal active';

    // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
    modal.innerHTML = `
        <div class="modal-overlay"></div>
        <div class="modal-content code-editor-modal-content">
            <!-- 头部 -->
            <div class="modal-header">
                <h2>${isReadOnly ? '代码查看器' : '代码编辑器'}</h2>
                <button class="icon-button close-modal-btn" aria-label="关闭">×</button>
            </div>

            <!-- 标签页导航 -->
            <div class="code-editor-tabs">
                <button class="tab-btn" data-tab="analysis">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <circle cx="12" cy="12" r="10"></circle>
                        <line x1="12" y1="16" x2="12" y2="12"></line>
                        <line x1="12" y1="8" x2="12.01" y2="8"></line>
                    </svg>
                    分析
                </button>
                <button class="tab-btn" data-tab="code">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polyline points="16 18 22 12 16 6"></polyline>
                        <polyline points="8 6 2 12 8 18"></polyline>
                    </svg>
                    代码
                </button>
                <button class="tab-btn" data-tab="preview">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polygon points="5 3 19 12 5 21 5 3"></polygon>
                    </svg>
                    预览
                </button>
            </div>

            <!-- 标签页内容 -->
            <div class="code-editor-body">
                <!-- 分析标签页 -->
                <div class="tab-content" data-tab="analysis">
                    <div id="analysis-container">
                        <div class="analysis-loading">
                            <div class="spinner"></div>
                            <p>正在分析代码...</p>
                        </div>
                    </div>
                </div>

                <!-- 代码标签页 -->
                <div class="tab-content" data-tab="code">
                    <div class="code-editor-container">
                        <!-- 左侧：编辑器 -->
                        <div class="code-editor-panel">
                            <div class="panel-header">
                                <span class="panel-title">编辑器</span>
                                <select class="language-selector" id="editor-language-selector">
                                    ${generateLanguageOptions(language)}
                                </select>
                            </div>
                            <div class="code-editor-wrapper">
                                <div class="code-line-numbers" id="code-line-numbers"></div>
                                <textarea class="code-editor-textarea" id="code-editor-textarea">${escapeHtml(code)}</textarea>
                            </div>
                        </div>

                        <!-- 右侧：预览 -->
                        <div class="code-preview-panel">
                            <div class="panel-header">
                                <span class="panel-title">预览</span>
                                <button class="refresh-preview-btn" title="刷新预览">
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                        <path d="M1 4v6h6M23 20v-6h-6"/>
                                        <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10m22 4l-4.35 4.65A9 9 0 0 1 20.49 9"/>
                                    </svg>
                                </button>
                            </div>
                            <div class="code-preview-content" id="code-preview-content">
                                <iframe id="code-preview-iframe" sandbox="allow-scripts" class="code-preview-iframe"></iframe>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- 预览标签页 -->
                <div class="tab-content" data-tab="preview">
                    <div class="live-preview-container">
                        <div class="live-preview-toolbar">
                            <span class="preview-label">实时预览</span>
                            <div style="display: flex; gap: 8px;">
                                <button class="fullscreen-preview-btn" title="全屏预览">
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                        <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"></path>
                                    </svg>
                                </button>
                                <button class="refresh-live-preview-btn" title="刷新预览">
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                        <path d="M1 4v6h6M23 20v-6h-6"/>
                                        <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10m22 4l-4.35 4.65A9 9 0 0 1 20.49 9"/>
                                    </svg>
                                </button>
                            </div>
                        </div>
                        <iframe id="live-preview-iframe" sandbox="allow-scripts" class="live-preview-iframe"></iframe>
                        <div class="preview-console" id="preview-console">
                            <div class="preview-console-header">
                                <span>控制台输出</span>
                                <button class="clear-console-btn" title="清空">×</button>
                            </div>
                            <div class="preview-console-content" id="preview-console-content"></div>
                        </div>
                    </div>
                </div>
            </div>

            <!-- 底部按钮 -->
            <div class="modal-footer">
                ${
                    isReadOnly
                        ? `
                    <button class="btn-secondary cancel-btn">关闭</button>
                `
                        : `
                    <button class="btn-secondary cancel-btn">取消</button>
                    <button class="btn-primary save-btn">保存修改</button>
                `
                }
            </div>
        </div>
    `;

    // 绑定事件
    bindModalEvents(modal, code, language, onSave, isReadOnly);

    return modal;
}

/**
 * 绑定模态框事件
 * @param {HTMLElement} modal - 模态框元素
 * @param {string} originalCode - 原始代码
 * @param {string} originalLanguage - 原始语言
 * @param {Function} onSave - 保存回调
 * @param {boolean} isReadOnly - 是否只读模式
 */
function bindModalEvents(modal, originalCode, originalLanguage, onSave, isReadOnly = false) {
    // 使用 AbortController 统一管理事件监听器生命周期
    const ac = new AbortController();
    const signal = ac.signal;

    const closeBtn = modal.querySelector('.close-modal-btn');
    const cancelBtn = modal.querySelector('.cancel-btn');
    const saveBtn = modal.querySelector('.save-btn');
    const overlay = modal.querySelector('.modal-overlay');

    // 关闭模态框
    let unbindEscape = null;
    const closeModal = () => {
        unbindEscape?.();
        ac.abort(); // 清理所有事件监听器
        modal.remove();
        document.body.style.overflow = '';
        document.querySelector('.app-container')?.removeAttribute('inert');
    };

    closeBtn.addEventListener('click', closeModal, { signal });
    cancelBtn.addEventListener('click', closeModal, { signal });
    overlay.addEventListener('click', closeModal, { signal });

    // ESC 关闭（叠层场景仅响应最顶层 modal）
    unbindEscape = bindTopmostEscape(modal, closeModal);

    // 保存按钮（只在非只读模式下绑定）
    if (!isReadOnly && saveBtn) {
        const handleSave = () => {
            const textarea = modal.querySelector('#code-editor-textarea');
            const newCode = textarea.value;
            const newLanguage = modal.querySelector('#editor-language-selector').value;

            // 验证
            if (!newCode.trim()) {
                eventBus.emit('ui:notification', {
                    message: '代码不能为空',
                    type: 'warning'
                });
                return;
            }

            // 调用保存回调
            onSave(newCode, newLanguage);

            closeModal();

            eventBus.emit('ui:notification', {
                message: '代码已保存',
                type: 'success'
            });
        };
        saveBtn.addEventListener('click', handleSave, { signal });
    }

    // 只读模式：禁用编辑功能
    if (isReadOnly) {
        const textarea = modal.querySelector('#code-editor-textarea');
        const langSelector = modal.querySelector('#editor-language-selector');

        if (textarea) {
            textarea.setAttribute('readonly', 'readonly');
            textarea.style.cursor = 'default';
        }

        if (langSelector) {
            langSelector.setAttribute('disabled', 'disabled');
        }
    }

    // 标签页切换
    const tabBtns = modal.querySelectorAll('.tab-btn');
    tabBtns.forEach((btn) => {
        const handleTabClick = () => {
            const tab = btn.dataset.tab;
            switchTab(modal, tab);

            const textarea = modal.querySelector('#code-editor-textarea');
            const language =
                modal.querySelector('#editor-language-selector')?.value || originalLanguage;

            // 切换到代码标签页时刷新预览
            if (tab === 'code') {
                setTimeout(() => {
                    updateCodePreview(modal, textarea.value, language);
                }, 50);
            }

            // 切换到预览标签页时自动运行实时预览
            if (tab === 'preview') {
                runLivePreview(modal, textarea.value, language);
            }
        };
        btn.addEventListener('click', handleTabClick, { signal });
    });

    // 刷新预览按钮
    const refreshBtn = modal.querySelector('.refresh-preview-btn');
    if (refreshBtn) {
        const handleRefresh = () => {
            const textarea = modal.querySelector('#code-editor-textarea');
            const language = modal.querySelector('#editor-language-selector').value;
            updateCodePreview(modal, textarea.value, language);
        };
        refreshBtn.addEventListener('click', handleRefresh, { signal });
    }

    // 语言选择器变化
    const langSelector = modal.querySelector('#editor-language-selector');
    if (langSelector) {
        const handleLangChange = () => {
            const textarea = modal.querySelector('#code-editor-textarea');
            updateCodePreview(modal, textarea.value, langSelector.value);
        };
        langSelector.addEventListener('change', handleLangChange, { signal });
    }

    // 刷新实时预览按钮
    const refreshLivePreviewBtn = modal.querySelector('.refresh-live-preview-btn');
    if (refreshLivePreviewBtn) {
        const handleRefreshLive = () => {
            const textarea = modal.querySelector('#code-editor-textarea');
            const language = modal.querySelector('#editor-language-selector').value;
            runLivePreview(modal, textarea.value, language);
        };
        refreshLivePreviewBtn.addEventListener('click', handleRefreshLive, { signal });
    }

    // 清空控制台按钮
    const clearConsoleBtn = modal.querySelector('.clear-console-btn');
    if (clearConsoleBtn) {
        const handleClearConsole = () => {
            const consoleContent = modal.querySelector('#preview-console-content');
            if (consoleContent) {
                // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
                consoleContent.innerHTML = '';
            }
        };
        clearConsoleBtn.addEventListener('click', handleClearConsole, { signal });
    }

    // 全屏预览按钮
    const fullscreenBtn = modal.querySelector('.fullscreen-preview-btn');
    if (fullscreenBtn) {
        const handleFullscreen = () => {
            const iframe = modal.querySelector('#live-preview-iframe');
            if (iframe) {
                openFullscreenPreview(iframe.srcdoc);
            }
        };
        fullscreenBtn.addEventListener('click', handleFullscreen, { signal });
    }
}

/**
 * 切换标签页
 * @param {HTMLElement} modal - 模态框元素
 * @param {string} tabName - 标签页名称
 */
function switchTab(modal, tabName) {
    // 更新按钮状态
    modal.querySelectorAll('.tab-btn').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.tab === tabName);
    });

    // 更新内容显示
    modal.querySelectorAll('.tab-content').forEach((content) => {
        content.classList.toggle('active', content.dataset.tab === tabName);
    });
}
