/**
 * MCP 服务器配置表单
 * 负责表单渲染、字段验证、服务器保存
 */

import { state } from '../core/state.js';
import { saveMCPServer } from '../state/storage.js';
import { showNotification } from './notifications.js';
import { detectPlatform } from '../utils/platform.js';
import { renderServerList, connectToServer } from './mcp-server-list.js';
import { logger } from '../utils/logger.js';

const platform = detectPlatform();

/**
 * 显示添加服务器表单
 * @param {HTMLElement} modal - MCP 设置模态框
 * @param {Function} setFormOpen - 设置表单开启状态的回调
 */
export function showServerForm(modal, setFormOpen) {
    const form = modal.querySelector('#mcp-server-form');
    if (!form) {
        logger.error('[MCP Settings] 未找到服务器表单');
        return;
    }

    // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
    form.innerHTML = `
        <h4>添加 MCP 服务器</h4>

        <div class="form-group">
            <label>服务器类型</label>
            <select id="mcp-server-type" class="form-control">
                <option value="remote">远程服务器 (HTTP/WebSocket)</option>
                ${platform === 'electron' ? '<option value="local">本地服务器 (命令行)</option>' : ''}
            </select>
        </div>

        <div class="form-group">
            <label>服务器名称 <span class="required-indicator">*</span></label>
            <input type="text" id="mcp-server-name" class="form-control" placeholder="例如: GitHub MCP" required aria-required="true">
            <span class="error-message" id="mcp-server-name-error"></span>
        </div>

        <!-- 远程服务器配置 -->
        <div id="mcp-remote-config">
            <div class="form-group">
                <label>服务器 URL <span class="required-indicator">*</span></label>
                <input type="text" id="mcp-server-url" class="form-control" placeholder="https://mcp.example.com 或 ws://mcp.example.com" required aria-required="true">
                <span class="error-message" id="mcp-server-url-error"></span>
            </div>

            <div class="form-group">
                <label>API Key (可选)</label>
                <input type="password" id="mcp-server-apikey" class="form-control" placeholder="mcp_sk_...">
            </div>
        </div>

        <!-- 本地服务器配置（仅 Electron） -->
        ${
            platform === 'electron'
                ? `
        <div id="mcp-local-config" style="display: none;">
            <div class="form-group">
                <label>启动命令 <span class="required-indicator">*</span></label>
                <input type="text" id="mcp-server-command" class="form-control" placeholder="npx" required aria-required="true">
                <span class="error-message" id="mcp-server-command-error"></span>
                <small class="form-text text-muted">例如: npx, node, python</small>
            </div>

            <div class="form-group">
                <label>命令参数</label>
                <input type="text" id="mcp-server-args" class="form-control" placeholder="-y @modelcontextprotocol/server-filesystem /path/to/folder">
                <small class="form-text text-muted">多个参数用空格分隔</small>
            </div>

            <div class="form-group">
                <label>工作目录 (可选)</label>
                <input type="text" id="mcp-server-cwd" class="form-control" placeholder="/home/user">
            </div>
        </div>
        `
                : ''
        }

        <div class="form-actions">
            <button id="mcp-save-server-btn" class="btn btn-success">保存</button>
            <button id="mcp-cancel-server-btn" class="btn btn-secondary">取消</button>
        </div>
    `;

    form.style.display = 'block';
    setFormOpen(true);

    setupInlineValidation(modal);
}

/**
 * 隐藏服务器表单
 * @param {HTMLElement} modal - MCP 设置模态框
 * @param {Function} setFormOpen - 设置表单开启状态的回调
 */
export function hideServerForm(modal, setFormOpen) {
    const form = modal.querySelector('#mcp-server-form');
    if (form) {
        form.style.display = 'none';
        // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
        form.innerHTML = '';
    }
    setFormOpen(false);
}

/**
 * 处理保存服务器
 * @param {HTMLElement} modal - MCP 设置模态框
 * @param {Function} setFormOpen - 设置表单开启状态的回调
 */
export async function handleSaveServer(modal, setFormOpen) {
    const type = modal.querySelector('#mcp-server-type').value;
    const nameInput = modal.querySelector('#mcp-server-name');
    const name = nameInput.value.trim();

    if (!validateServerName(modal, nameInput)) {
        showNotification('请输入服务器名称', 'error');
        nameInput.focus();
        return;
    }

    const config = {
        id: `mcp_${Date.now()}`,
        name,
        type,
        enabled: true
    };

    if (type === 'remote') {
        const urlInput = modal.querySelector('#mcp-server-url');
        const url = urlInput.value.trim();
        const apiKey = modal.querySelector('#mcp-server-apikey').value.trim();

        if (!validateServerURL(modal, urlInput)) {
            showNotification('请输入有效的服务器 URL', 'error');
            urlInput.focus();
            return;
        }

        config.url = url;
        if (apiKey) {
            config.apiKey = apiKey;
        }
    } else if (type === 'local') {
        const commandInput = modal.querySelector('#mcp-server-command');
        const command = commandInput.value.trim();
        const argsStr = modal.querySelector('#mcp-server-args').value.trim();
        const cwd = modal.querySelector('#mcp-server-cwd').value.trim();

        if (!validateServerCommand(modal, commandInput)) {
            showNotification('请输入启动命令', 'error');
            commandInput.focus();
            return;
        }

        config.command = command;
        config.args = argsStr ? argsStr.split(/\s+/) : [];
        if (cwd) {
            config.cwd = cwd;
        }
    }

    try {
        await saveMCPServer(config);
        state.mcpServers.push(config);
        hideServerForm(modal, setFormOpen);
        renderServerList(modal);
        connectToServer(modal, config.id);
        showNotification('服务器添加成功', 'success');
    } catch (error) {
        logger.error('[MCP Settings] 保存服务器失败:', error);
        showNotification('保存失败，请重试', 'error');
    }
}

/**
 * 切换远程/本地配置区域
 * @param {HTMLElement} modal - MCP 设置模态框
 * @param {boolean} isLocal - 是否为本地服务器
 */
export function toggleConfigSection(modal, isLocal) {
    const remoteConfig = modal.querySelector('#mcp-remote-config');
    const localConfig = modal.querySelector('#mcp-local-config');

    if (remoteConfig) {
        remoteConfig.style.display = isLocal ? 'none' : 'block';
    }

    if (localConfig) {
        localConfig.style.display = isLocal ? 'block' : 'none';
    }
}

// ========== 字段验证 ==========

/**
 * 设置内联验证监听器
 * @param {HTMLElement} modal - MCP 设置模态框
 */
function setupInlineValidation(modal) {
    const nameInput = modal.querySelector('#mcp-server-name');
    if (nameInput) {
        nameInput.addEventListener('blur', () => validateServerName(modal, nameInput));
        nameInput.addEventListener('input', () => clearFieldError(modal, 'mcp-server-name'));
    }

    const urlInput = modal.querySelector('#mcp-server-url');
    if (urlInput) {
        urlInput.addEventListener('blur', () => validateServerURL(modal, urlInput));
        urlInput.addEventListener('input', () => clearFieldError(modal, 'mcp-server-url'));
    }

    const commandInput = modal.querySelector('#mcp-server-command');
    if (commandInput) {
        commandInput.addEventListener('blur', () => validateServerCommand(modal, commandInput));
        commandInput.addEventListener('input', () => clearFieldError(modal, 'mcp-server-command'));
    }
}

/**
 * 验证服务器名称
 * @param {HTMLElement} modal - 模态框
 * @param {HTMLInputElement} input - 输入框
 * @returns {boolean}
 */
function validateServerName(modal, input) {
    const value = input.value.trim();
    if (!value) {
        setFieldError(modal, 'mcp-server-name', '请输入服务器名称');
        return false;
    }
    clearFieldError(modal, 'mcp-server-name');
    return true;
}

/**
 * 验证服务器 URL
 * @param {HTMLElement} modal - 模态框
 * @param {HTMLInputElement} input - 输入框
 * @returns {boolean}
 */
function validateServerURL(modal, input) {
    const value = input.value.trim();
    if (!value) {
        setFieldError(modal, 'mcp-server-url', '请输入服务器 URL');
        return false;
    }

    const urlPattern = /^(https?|wss?):\/\/.+/i;
    if (!urlPattern.test(value)) {
        setFieldError(
            modal,
            'mcp-server-url',
            '请输入有效的 URL（支持 http://, https://, ws://, wss://）'
        );
        return false;
    }

    clearFieldError(modal, 'mcp-server-url');
    return true;
}

/**
 * 验证启动命令
 * @param {HTMLElement} modal - 模态框
 * @param {HTMLInputElement} input - 输入框
 * @returns {boolean}
 */
function validateServerCommand(modal, input) {
    const value = input.value.trim();
    if (!value) {
        setFieldError(modal, 'mcp-server-command', '请输入启动命令');
        return false;
    }
    clearFieldError(modal, 'mcp-server-command');
    return true;
}

/**
 * 设置字段错误样式和消息
 * @param {HTMLElement} modal - 模态框
 * @param {string} fieldId - 字段 ID
 * @param {string} message - 错误消息
 */
function setFieldError(modal, fieldId, message) {
    const input = modal.querySelector(`#${fieldId}`);
    const errorSpan = modal.querySelector(`#${fieldId}-error`);

    if (input) {
        input.classList.add('error');
        input.setAttribute('aria-invalid', 'true');
    }

    if (errorSpan) {
        errorSpan.textContent = message;
        errorSpan.style.display = 'block';
    }
}

/**
 * 清除字段错误样式和消息
 * @param {HTMLElement} modal - 模态框
 * @param {string} fieldId - 字段 ID
 */
function clearFieldError(modal, fieldId) {
    const input = modal.querySelector(`#${fieldId}`);
    const errorSpan = modal.querySelector(`#${fieldId}-error`);

    if (input) {
        input.classList.remove('error');
        input.removeAttribute('aria-invalid');
    }

    if (errorSpan) {
        errorSpan.textContent = '';
        errorSpan.style.display = 'none';
    }
}
