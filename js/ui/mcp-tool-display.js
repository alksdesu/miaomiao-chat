/**
 * MCP 配置导入/导出与模板功能
 * 负责 JSON 导入导出、模板选择、配置合并
 */

import { state } from '../core/state.js';
import { mcpClient } from '../tools/mcp/client.js';
import { saveMCPServer, deleteMCPServer } from '../state/storage.js';
import { showNotification } from './notifications.js';
import { getIcon } from '../utils/icons.js';
import {
    applyModalLayerZIndex,
    bindTopmostEscape,
    MODAL_LAYER_Z_INDEX,
    setupModalFocus
} from '../utils/modal-stack.js';
import {
    standardToInternal,
    internalToStandard,
    validateStandardConfig,
    generateTemplate,
    getAvailableTemplates
} from '../tools/mcp/config-converter.js';
import { renderServerList } from './mcp-server-list.js';
import { logger } from '../utils/logger.js';

/**
 * 导出 MCP 配置为 JSON 文件
 */
export async function exportMCPConfig() {
    try {
        const standardConfig = internalToStandard(state.mcpServers || []);
        const jsonString = JSON.stringify(standardConfig, null, 2);
        const blob = new Blob([jsonString], { type: 'application/json' });

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
        const filename = `mcp-config-${timestamp}.json`;

        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = filename;
        link.click();

        setTimeout(() => URL.revokeObjectURL(link.href), 100);

        // showNotification 用 textContent 渲染，禁止拼 getIcon HTML（SVG 会裸显成源码文字）
        showNotification(`配置已导出: ${filename}`, 'success');
    } catch (error) {
        logger.error('[MCP Settings] 导出配置失败:', error);
        showNotification(`导出配置失败: ${error.message}`, 'error');
    }
}

/**
 * 导入 MCP 配置 JSON 文件
 * @param {HTMLElement} modal - 模态框引用（用于刷新列表）
 */
export async function importMCPConfig(modal) {
    const importMethod = await showImportMethodDialog();
    if (!importMethod) return;

    let jsonText;

    if (importMethod === 'file') {
        jsonText = await selectJsonFile();
    } else if (importMethod === 'paste') {
        jsonText = await showJsonPasteDialog();
    }

    if (!jsonText) return;

    await processImportedJson(modal, jsonText);
}

/**
 * 显示导入方式选择对话框
 * @returns {Promise<'file'|'paste'|null>}
 */
async function showImportMethodDialog() {
    return new Promise((resolve) => {
        const dialog = document.createElement('div');
        dialog.className = 'modal active';
        applyModalLayerZIndex(dialog, MODAL_LAYER_Z_INDEX.settingsNested);

        // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
        dialog.innerHTML = `
            <div class="modal-overlay"></div>
            <div class="modal-content modal-mobile-compact" style="--modal-compact-max-width: 500px;">
                <div class="modal-header">
                    <h3 id="mcp-import-method-dialog-title">${getIcon('upload', { size: 18 })} 导入 MCP 配置</h3>
                    <button class="modal-close" aria-label="关闭">&times;</button>
                </div>
                <div class="modal-body">
                    <p>请选择导入方式：</p>
                    <div class="import-method-options" style="margin-top: 16px; display: flex; flex-direction: column; gap: 12px;">
                        <button class="btn btn-primary" id="import-from-file" style="padding: 16px; text-align: left;">
                            ${getIcon('fileText', { size: 18 })} <strong>从文件上传</strong>
                            <small style="display: block; margin-top: 4px; opacity: 0.8;">选择本地 JSON 配置文件</small>
                        </button>
                        <button class="btn btn-primary" id="import-from-paste" style="padding: 16px; text-align: left;">
                            ${getIcon('clipboard', { size: 18 })} <strong>粘贴 JSON 内容</strong>
                            <small style="display: block; margin-top: 4px; opacity: 0.8;">直接粘贴或输入 JSON 配置</small>
                        </button>
                    </div>
                </div>
            </div>
        `;

        document.body.appendChild(dialog);

        let removeEscapeListener = null;
        let removeDialogFocus = setupModalFocus(dialog, {
            labelledBy: 'mcp-import-method-dialog-title',
            initialFocus: '#import-from-file'
        });

        const cleanup = () => {
            removeEscapeListener?.();
            removeEscapeListener = null;
            removeDialogFocus?.();
            removeDialogFocus = null;

            if (dialog.isConnected) {
                document.body.removeChild(dialog);
            }
        };

        dialog.querySelector('#import-from-file').addEventListener('click', () => {
            cleanup();
            resolve('file');
        });

        dialog.querySelector('#import-from-paste').addEventListener('click', () => {
            cleanup();
            resolve('paste');
        });

        dialog.querySelector('.modal-close').addEventListener('click', () => {
            cleanup();
            resolve(null);
        });

        dialog.querySelector('.modal-overlay').addEventListener('click', () => {
            cleanup();
            resolve(null);
        });

        removeEscapeListener = bindTopmostEscape(dialog, () => {
            cleanup();
            resolve(null);
        });
    });
}

/**
 * 选择 JSON 文件
 * @returns {Promise<string|null>}
 */
async function selectJsonFile() {
    return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'application/json,.json';

        input.onchange = async (e) => {
            const file = e.target.files?.[0];
            if (!file) {
                resolve(null);
                return;
            }

            try {
                const text = await file.text();
                resolve(text);
            } catch (error) {
                showNotification(`读取文件失败: ${error.message}`, 'error');
                resolve(null);
            }
        };

        input.click();
    });
}

/**
 * 显示 JSON 粘贴对话框
 * @returns {Promise<string|null>}
 */
async function showJsonPasteDialog() {
    return new Promise((resolve) => {
        const dialog = document.createElement('div');
        dialog.className = 'modal active';
        applyModalLayerZIndex(dialog, MODAL_LAYER_Z_INDEX.settingsNested);

        const exampleJson = `// 示例 JSON (stdio):
// {
//   "mcpServers": {
//     "stdio-server-example": {
//       "command": "npx",
//       "args": ["-y", "mcp-server-example"]
//     }
//   }
// }

// 示例 JSON (sse):
// {
//   "mcpServers": {
//     "sse-server-example": {
//       "type": "sse",
//       "url": "http://localhost:3000"
//     }
//   }
// }

// 示例 JSON (streamable-http):
// {
//   "mcpServers": {
//     "streamable-http-example": {
//       "type": "streamable-http",
//       "url": "http://localhost:3001/mcp",
//       "headers": {
//         "Content-Type": "application/json",
//         "Authorization": "Bearer your-token"
//       }
//     }
//   }
// }`;

        // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
        dialog.innerHTML = `
            <div class="modal-overlay"></div>
            <div class="modal-content modal-mobile-fullscreen json-paste-dialog-content">
                <div class="modal-header">
                    <h3 id="mcp-json-paste-dialog-title">${getIcon('clipboard', { size: 18 })} 从 JSON 导入</h3>
                    <button class="modal-close" aria-label="关闭">&times;</button>
                </div>
                <div class="modal-body">
                    <p style="margin-bottom: 12px;">请从 MCP Servers 的介绍页面复制配置 JSON（优先使用 NPX 或 UVX 配置），并粘贴到输入框中</p>
                    <textarea
                        id="json-paste-textarea"
                        placeholder="粘贴 JSON 内容到这里..."
                        style="
                            width: 100%;
                            height: 400px;
                            padding: 12px;
                            font-family: var(--font-mono);
                            font-size: 13px;
                            line-height: 1.5;
                            background: var(--color-bg-code, #1e1e1e);
                            color: var(--md-text, #e0e0e0);
                            border: var(--border);
                            border-radius: 6px;
                            resize: vertical;
                            tab-size: 2;
                        "
                    >${exampleJson}</textarea>
                </div>
                <div class="modal-footer">
                    <button class="btn btn-secondary" id="json-paste-cancel">取消</button>
                    <button class="btn btn-primary" id="json-paste-confirm">确定</button>
                </div>
            </div>
        `;

        document.body.appendChild(dialog);

        const textarea = dialog.querySelector('#json-paste-textarea');
        let removeEscapeListener = null;
        let removeDialogFocus = setupModalFocus(dialog, {
            labelledBy: 'mcp-json-paste-dialog-title',
            initialFocus: textarea,
            selectText: true
        });

        const cleanup = () => {
            removeEscapeListener?.();
            removeEscapeListener = null;
            removeDialogFocus?.();
            removeDialogFocus = null;

            if (dialog.isConnected) {
                document.body.removeChild(dialog);
            }
        };

        dialog.querySelector('#json-paste-confirm').addEventListener('click', () => {
            const content = textarea.value.trim();
            cleanup();
            resolve(content || null);
        });

        dialog.querySelector('#json-paste-cancel').addEventListener('click', () => {
            cleanup();
            resolve(null);
        });

        dialog.querySelector('.modal-close').addEventListener('click', () => {
            cleanup();
            resolve(null);
        });

        dialog.querySelector('.modal-overlay').addEventListener('click', () => {
            cleanup();
            resolve(null);
        });

        removeEscapeListener = bindTopmostEscape(dialog, () => {
            cleanup();
            resolve(null);
        });
    });
}

/**
 * 智能移除 JSON 注释（避免删除字符串中的注释符号）
 * @param {string} jsonText - 带注释的 JSON 文本
 * @returns {string}
 */
function removeJsonComments(jsonText) {
    const lines = jsonText.split('\n');
    const result = [];
    let inMultilineComment = false;

    for (const line of lines) {
        let cleanLine = '';
        let inString = false;
        let stringChar = null;
        let i = 0;

        while (i < line.length) {
            const char = line[i];
            const nextChar = line[i + 1];

            if (inMultilineComment) {
                if (char === '*' && nextChar === '/') {
                    inMultilineComment = false;
                    i += 2;
                    continue;
                }
                i++;
                continue;
            }

            if (char === '"' || char === "'") {
                // 向前数连续反斜杠：偶数个才是真定界符（"C:\\tools\\" 以 \\" 结尾时引号未被转义）
                let backslashes = 0;
                for (let j = i - 1; j >= 0 && line[j] === '\\'; j--) backslashes++;
                if (backslashes % 2 === 0) {
                    if (!inString) {
                        inString = true;
                        stringChar = char;
                    } else if (char === stringChar) {
                        inString = false;
                        stringChar = null;
                    }
                }
                cleanLine += char;
                i++;
                continue;
            }

            if (inString) {
                cleanLine += char;
                i++;
                continue;
            }

            if (char === '/' && nextChar === '/') {
                break;
            }

            if (char === '/' && nextChar === '*') {
                inMultilineComment = true;
                i += 2;
                continue;
            }

            cleanLine += char;
            i++;
        }

        if (cleanLine.trim()) {
            result.push(cleanLine);
        }
    }

    return result.join('\n');
}

/**
 * 处理导入的 JSON 内容
 * @param {HTMLElement} modal - 模态框引用
 * @param {string} jsonText - JSON 文本
 */
async function processImportedJson(modal, jsonText) {
    try {
        const cleanJson = removeJsonComments(jsonText);

        let configData;
        try {
            configData = JSON.parse(cleanJson);
        } catch {
            throw new Error('JSON 格式错误，请检查内容是否正确');
        }

        const validation = validateStandardConfig(configData);
        if (!validation.valid) {
            const errorList = validation.errors.join('\n• ');
            throw new Error(`配置验证失败:\n• ${errorList}`);
        }

        const servers = standardToInternal(configData);

        if (servers.length === 0) {
            throw new Error('配置文件中没有有效的服务器');
        }

        const action = await showImportMergeDialog(servers.length);

        if (action === 'cancel') return;

        let toImport = servers;

        if (action === 'replace') {
            for (const server of state.mcpServers || []) {
                if (mcpClient.hasConnection(server.id)) {
                    try {
                        await mcpClient.disconnect(server.id);
                    } catch (error) {
                        logger.error(`[MCP Settings] 断开服务器 ${server.id} 失败:`, error);
                    }
                }
            }

            // 删除失败的保留在内存，否则 DB 与 state 永久分叉且无法重试
            const failedDeletes = [];
            for (const server of state.mcpServers || []) {
                try {
                    await deleteMCPServer(server.id);
                } catch (error) {
                    logger.error(`[MCP Settings] 删除服务器 ${server.id} 失败:`, error);
                    failedDeletes.push(server);
                }
            }

            state.mcpServers = failedDeletes;
            if (failedDeletes.length > 0) {
                showNotification(`${failedDeletes.length} 个旧服务器删除失败，已保留`, 'warning');
            }
        } else if (action === 'merge') {
            // 重复导入同一配置会无限堆积同名服务器，按 name + 连接目标查重跳过
            const existingKeys = new Set(
                (state.mcpServers || []).map((s) => `${s.name}|${s.url || s.command || ''}`)
            );
            const skipped = [];
            toImport = servers.filter((server) => {
                const key = `${server.name}|${server.url || server.command || ''}`;
                if (existingKeys.has(key)) {
                    skipped.push(server.name);
                    return false;
                }
                return true;
            });

            if (skipped.length > 0) {
                showNotification(
                    `已跳过 ${skipped.length} 个重复服务器: ${skipped.join('、')}`,
                    'info'
                );
            }
            if (toImport.length === 0) {
                renderServerList(modal);
                return;
            }
        }

        let importedCount = 0;
        const failedImports = [];
        for (const server of toImport) {
            try {
                await saveMCPServer(server);
                state.mcpServers.push(server);
                importedCount++;
            } catch (error) {
                logger.error(`[MCP Settings] 保存服务器 ${server.name} 失败:`, error);
                failedImports.push(server.name);
            }
        }

        renderServerList(modal);

        if (failedImports.length > 0) {
            showNotification(
                `成功导入 ${importedCount} 个，失败 ${failedImports.length} 个（${failedImports.join('、')}）`,
                'warning'
            );
        } else {
            showNotification(`成功导入 ${importedCount} 个 MCP 服务器`, 'success');
        }
    } catch (error) {
        logger.error('[MCP Settings] 导入配置失败:', error);
        showNotification(`导入配置失败: ${error.message}`, 'error');
    }
}

/**
 * 显示导入合并对话框
 * @param {number} serverCount - 要导入的服务器数量
 * @returns {Promise<'replace'|'merge'|'cancel'>}
 */
async function showImportMergeDialog(serverCount) {
    return new Promise((resolve) => {
        const dialog = document.createElement('div');
        dialog.className = 'modal active';
        applyModalLayerZIndex(dialog, MODAL_LAYER_Z_INDEX.settingsNested);

        // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
        dialog.innerHTML = `
            <div class="modal-overlay"></div>
            <div class="modal-content modal-mobile-compact" style="--modal-compact-max-width: 500px;">
                <div class="modal-header">
                    <h3 id="mcp-import-merge-dialog-title">${getIcon('upload', { size: 18 })} 导入 MCP 配置</h3>
                </div>
                <div class="modal-body">
                    <p>即将导入 <strong>${serverCount}</strong> 个 MCP 服务器。</p>
                    <p>请选择导入方式：</p>
                    <div class="import-options" style="margin-top: 16px;">
                        <button class="btn btn-warning" id="import-replace">
                            ${getIcon('refreshCw', { size: 14 })} 替换现有配置
                            <small style="display: block; margin-top: 4px; opacity: 0.8;">删除所有现有服务器，替换为导入的配置</small>
                        </button>
                        <button class="btn btn-primary" id="import-merge" style="margin-top: 8px;">
                            ${getIcon('plus', { size: 14 })} 合并到现有配置
                            <small style="display: block; margin-top: 4px; opacity: 0.8;">保留现有服务器，添加导入的配置</small>
                        </button>
                    </div>
                </div>
                <div class="modal-footer">
                    <button class="btn btn-secondary" id="import-cancel">取消</button>
                </div>
            </div>
        `;

        document.body.appendChild(dialog);

        let removeEscapeListener = null;
        let removeDialogFocus = setupModalFocus(dialog, {
            labelledBy: 'mcp-import-merge-dialog-title',
            initialFocus: '#import-cancel'
        });

        const cleanup = () => {
            removeEscapeListener?.();
            removeEscapeListener = null;
            removeDialogFocus?.();
            removeDialogFocus = null;

            if (dialog.isConnected) {
                document.body.removeChild(dialog);
            }
        };

        dialog.querySelector('#import-replace').addEventListener('click', () => {
            cleanup();
            resolve('replace');
        });

        dialog.querySelector('#import-merge').addEventListener('click', () => {
            cleanup();
            resolve('merge');
        });

        dialog.querySelector('#import-cancel').addEventListener('click', () => {
            cleanup();
            resolve('cancel');
        });

        dialog.querySelector('.modal-overlay').addEventListener('click', () => {
            cleanup();
            resolve('cancel');
        });

        removeEscapeListener = bindTopmostEscape(dialog, () => {
            cleanup();
            resolve('cancel');
        });
    });
}

/**
 * 从模板创建配置
 * @param {HTMLElement} modal - 模态框引用
 * @param {string} templateId - 模板 ID
 */
export async function createFromTemplate(modal, templateId) {
    try {
        const templateConfig = generateTemplate(templateId);
        const servers = standardToInternal(templateConfig);

        if (servers.length === 0) {
            throw new Error('模板无效');
        }

        for (const server of servers) {
            await saveMCPServer(server);
            state.mcpServers.push(server);
        }

        renderServerList(modal);

        showNotification(`已从模板创建 ${servers.length} 个服务器`, 'success');
    } catch (error) {
        logger.error('[MCP Settings] 从模板创建失败:', error);
        showNotification(`从模板创建失败: ${error.message}`, 'error');
    }
}

/**
 * 显示模板选择对话框
 * @param {HTMLElement} modal - 模态框引用
 * @returns {Promise<string|null>}
 */
export async function showTemplateDialog(modal) {
    return new Promise((resolve) => {
        const templates = getAvailableTemplates();

        const dialog = document.createElement('div');
        dialog.className = 'modal active';
        applyModalLayerZIndex(dialog, MODAL_LAYER_Z_INDEX.settingsNested);

        const templateHTML = templates
            .map(
                (t) => `
            <button type="button" class="template-item" data-template-id="${t.id}">
                <div class="template-name">${t.name}</div>
                <div class="template-description">${t.description}</div>
            </button>
        `
            )
            .join('');

        // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
        dialog.innerHTML = `
            <div class="modal-overlay"></div>
            <div class="modal-content modal-mobile-compact" style="--modal-compact-max-width: 600px;">
                <div class="modal-header">
                    <h3 id="mcp-template-dialog-title">${getIcon('package', { size: 18 })} 选择配置模板</h3>
                    <button class="modal-close" aria-label="关闭">&times;</button>
                </div>
                <div class="modal-body">
                    <div class="template-list">
                        ${templateHTML}
                    </div>
                </div>
                <div class="modal-footer">
                    <button class="btn btn-secondary" id="template-cancel">取消</button>
                </div>
            </div>
        `;

        document.body.appendChild(dialog);

        let removeEscapeListener = null;

        const style = document.createElement('style');
        style.textContent = `
            .template-list {
                display: flex;
                flex-direction: column;
                gap: 12px;
            }

            .template-item {
                padding: 12px 16px;
                border: var(--border);
                border-radius: 8px;
                cursor: pointer;
                transition: all 0.2s;
                width: 100%;
                background: var(--color-bg-primary);
                color: inherit;
                text-align: left;
                font: inherit;
                appearance: none;
            }

            .template-item:hover {
                background: var(--md-surface);
                border-color: var(--md-blue);
            }

            .template-item:focus-visible {
                outline: 2px solid var(--md-blue);
                outline-offset: 2px;
            }

            .template-name {
                font-weight: 600;
                margin-bottom: 4px;
                color: var(--md-text);
            }

            .template-description {
                font-size: 13px;
                color: var(--md-muted);
            }
        `;
        document.head.appendChild(style);

        let removeDialogFocus = setupModalFocus(dialog, {
            labelledBy: 'mcp-template-dialog-title',
            initialFocus: '.template-item'
        });

        const cleanup = () => {
            removeEscapeListener?.();
            removeEscapeListener = null;
            removeDialogFocus?.();
            removeDialogFocus = null;

            if (dialog.isConnected) {
                document.body.removeChild(dialog);
            }
            if (style.isConnected) {
                document.head.removeChild(style);
            }
        };

        dialog.querySelectorAll('.template-item').forEach((item) => {
            item.addEventListener('click', async () => {
                const templateId = item.dataset.templateId;
                cleanup();
                await createFromTemplate(modal, templateId);
                resolve(templateId);
            });
        });

        dialog.querySelector('#template-cancel').addEventListener('click', () => {
            cleanup();
            resolve(null);
        });

        dialog.querySelector('.modal-close').addEventListener('click', () => {
            cleanup();
            resolve(null);
        });

        dialog.querySelector('.modal-overlay').addEventListener('click', () => {
            cleanup();
            resolve(null);
        });

        removeEscapeListener = bindTopmostEscape(dialog, () => {
            cleanup();
            resolve(null);
        });
    });
}
