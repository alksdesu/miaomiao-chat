/**
 * 工具配置编辑（参数设置、启用/禁用、测试、CRUD）
 * 从 tool-manager.js 拆分
 */

import {
    getTool,
    registerCustomTool,
    removeTool,
    getAllTools,
    isToolEnabled,
    setToolEnabled
} from '../tools/manager.js';
import { getToolHistory, clearToolHistory } from '../tools/history.js';
import { debouncedSaveSession } from '../state/sessions.js';
import { showNotification } from './notifications.js';
import { showConfirmDialog } from '../utils/dialogs.js';
import { escapeHtml } from '../utils/helpers.js';
import { getIcon } from '../utils/icons.js';
import { bindTopmostEscape, getFocusableElements, setupModalFocus } from '../utils/modal-stack.js';
import { logger } from '../utils/logger.js';

// 测试对话框清理句柄
let removeToolTestEscape = null;
let removeToolTestFocus = null;
let cleanupToolTestDialog = null;

/**
 * 获取测试对话框清理函数（供主模块关闭时调用）
 */
export function getTestDialogCleanup() {
    return cleanupToolTestDialog;
}

// ========== 工具详情表单 ==========

/**
 * 显示工具详情表单
 * @param {HTMLElement} modal - 模态框元素
 * @param {string|Object} toolOrId - 工具 ID 或工具对象
 * @param {Object} callbacks - 回调函数集
 * @param {Function} callbacks.onEditingChange - 编辑状态变更回调
 * @param {Function} callbacks.showEmptyState - 显示空状态回调
 * @param {Function} callbacks.bindFormButtons - 绑定表单按钮回调
 * @returns {boolean} 是否成功显示
 */
export function showToolForm(modal, toolOrId, callbacks) {
    const tool = typeof toolOrId === 'string' ? getTool(toolOrId) : toolOrId;
    if (!tool) {
        callbacks.showEmptyState();
        return false;
    }

    const detailContainer = modal.querySelector('#tool-detail-container');
    if (!detailContainer) return false;

    const isEditable = tool.type === 'custom';
    callbacks.onEditingChange(false);

    // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
    detailContainer.innerHTML = `
        <div class="tool-detail-form">
            <h3 class="form-section-title">基本信息</h3>

            <div class="form-group">
                <label>工具名称 ${isEditable ? '<span class="required">*</span>' : ''}</label>
                <input type="text"
                       id="tool-name-input"
                       class="form-control"
                       value="${escapeHtml(tool.name)}"
                       ${!isEditable ? 'readonly' : ''}
                       placeholder="例如: web_search">
                <small class="form-hint">用于 API 调用的唯一标识符（仅限字母、数字、下划线）</small>
            </div>

            <div class="form-group">
                <label>工具描述 ${isEditable ? '<span class="required">*</span>' : ''}</label>
                <textarea id="tool-description-input"
                          class="form-control"
                          rows="3"
                          ${!isEditable ? 'readonly' : ''}
                          placeholder="清晰描述工具功能，帮助 LLM 判断何时使用">${escapeHtml(tool.description || '')}</textarea>
            </div>

            <div class="form-group">
                <label>工具类型</label>
                <input type="text"
                       class="form-control"
                       value="${getToolTypeLabel(tool.type)}"
                       readonly>
            </div>

            <h3 class="form-section-title">参数定义</h3>

            <div class="form-group">
                <label>JSON Schema ${isEditable ? '<span class="required">*</span>' : ''}</label>
                <textarea id="tool-schema-input"
                          class="form-control code-editor"
                          rows="12"
                          ${!isEditable ? 'readonly' : ''}
                          placeholder='{"type": "object", "properties": {...}}'>${escapeHtml(JSON.stringify(tool.parameters || {}, null, 2))}</textarea>
                ${isEditable ? '<button id="validate-schema-btn" class="btn btn-sm btn-secondary">验证 Schema</button>' : ''}
                <small class="form-hint">
                    定义工具接受的参数结构。
                    ${isEditable ? '<a href="#" onclick="showSchemaExamples(); return false;">查看示例</a>' : ''}
                </small>
                <div id="schema-validation-result" class="validation-result"></div>
            </div>

            ${isEditable ? renderPermissionsForm() : ''}
            ${isEditable ? renderRateLimitForm() : ''}

            <div class="form-actions">
                <button id="test-tool-btn" class="btn btn-secondary">🧪 测试工具</button>
                ${isEditable ? '<button id="delete-tool-btn" class="btn btn-danger">删除</button>' : ''}
                ${isEditable ? '<button id="cancel-tool-btn" class="btn btn-default">取消</button>' : ''}
                ${isEditable ? '<button id="save-tool-btn" class="btn btn-primary">保存</button>' : ''}
            </div>
        </div>
    `;

    callbacks.bindFormButtons();

    // 监听输入变化
    if (isEditable) {
        const inputs = detailContainer.querySelectorAll('input, textarea');
        inputs.forEach((input) => {
            input.addEventListener('input', () => {
                callbacks.onEditingChange(true);
            });
        });
    }

    return true;
}

/**
 * 渲染权限配置表单
 */
function renderPermissionsForm() {
    return `
        <h3 class="form-section-title">权限设置</h3>

        <div class="form-group">
            <label class="checkbox-label">
                <input type="checkbox" id="require-approval-checkbox" class="form-checkbox">
                <span>需要用户确认</span>
            </label>
            <label class="checkbox-label">
                <input type="checkbox" id="allow-filesystem-checkbox" class="form-checkbox">
                <span>允许文件系统访问</span>
            </label>
            <label class="checkbox-label">
                <input type="checkbox" id="allow-network-checkbox" class="form-checkbox">
                <span>允许网络请求</span>
            </label>
        </div>
    `;
}

/**
 * 渲染速率限制表单
 */
function renderRateLimitForm() {
    return `
        <h3 class="form-section-title">速率限制</h3>

        <div class="form-group">
            <div class="rate-limit-inputs">
                <span>最多调用</span>
                <input type="number"
                       id="rate-limit-max-input"
                       class="form-control form-control-sm"
                       min="1"
                       value="10">
                <span>次 /</span>
                <input type="number"
                       id="rate-limit-window-input"
                       class="form-control form-control-sm"
                       min="1"
                       value="1">
                <select id="rate-limit-unit-select" class="form-control form-control-sm">
                    <option value="minute">分钟</option>
                    <option value="hour">小时</option>
                    <option value="day">天</option>
                </select>
            </div>
        </div>
    `;
}

/**
 * 显示空状态
 * @param {HTMLElement} modal - 模态框元素
 */
export function showEmptyState(modal) {
    const detailContainer = modal.querySelector('#tool-detail-container');
    if (!detailContainer) return;

    // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
    detailContainer.innerHTML = `
        <div class="empty-state">
            <svg class="empty-icon" width="64" height="64" viewBox="0 0 24 24" fill="none">
                <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6z"
                      stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                <path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"
                      stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
            <p class="empty-title">选择工具查看详情</p>
            <p class="empty-hint">或点击下方"添加自定义工具"开始配置</p>
        </div>
    `;
}

/**
 * 获取工具类型标签
 */
function getToolTypeLabel(type) {
    const labels = {
        builtin: '内置工具',
        mcp: 'MCP 工具',
        custom: '自定义工具'
    };
    return labels[type] || type;
}

// ========== 表单操作 ==========

/**
 * 处理验证 Schema
 * @param {HTMLElement} modal - 模态框元素
 */
export function handleValidateSchema(modal) {
    const schemaInput = modal.querySelector('#tool-schema-input');
    const resultDiv = modal.querySelector('#schema-validation-result');

    if (!schemaInput || !resultDiv) return;

    try {
        const schema = JSON.parse(schemaInput.value);

        if (schema.type !== 'object') {
            throw new Error('Schema 必须是 object 类型');
        }

        // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
        resultDiv.innerHTML = `<span class="validation-success">${getIcon('checkCircle', { size: 14 })} Schema 格式正确</span>`;
        resultDiv.className = 'validation-result success';

        setTimeout(() => {
            // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
            resultDiv.innerHTML = '';
        }, 3000);
    } catch (error) {
        // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
        resultDiv.innerHTML = `<span class="validation-error">${getIcon('xCircle', { size: 14 })} ${escapeHtml(error.message)}</span>`;
        resultDiv.className = 'validation-result error';
    }
}

/**
 * 处理测试工具
 * @param {string} selectedToolId - 选中的工具 ID
 */
export async function handleTestTool(selectedToolId) {
    if (!selectedToolId) {
        showNotification('请先选择要测试的工具', 'error');
        return;
    }

    const tool = getTool(selectedToolId);
    if (!tool) {
        showNotification('工具不存在', 'error');
        return;
    }

    await showToolTestDialog(tool);
}

/**
 * 处理删除工具
 * @param {string} selectedToolId - 选中的工具 ID
 * @param {Function} onDeleted - 删除完成回调
 */
export async function handleDeleteTool(selectedToolId, onDeleted) {
    if (!selectedToolId) return;

    const tool = getTool(selectedToolId);
    if (!tool) return;

    const confirmed = await showConfirmDialog(`确定要删除工具 "${tool.name}" 吗？`, '删除工具');

    if (!confirmed) return;

    removeTool(selectedToolId);
    debouncedSaveSession();

    showNotification(`已删除工具: ${tool.name}`, 'success');
    onDeleted();

    logger.debug('[Tool Manager] 删除工具:', selectedToolId);
}

/**
 * 处理保存工具
 * @param {HTMLElement} modal - 模态框元素
 * @param {string} selectedToolId - 选中的工具 ID
 * @param {Function} onSaved - 保存完成回调
 */
export async function handleSaveTool(modal, selectedToolId, onSaved) {
    const nameInput = modal.querySelector('#tool-name-input');
    const descInput = modal.querySelector('#tool-description-input');
    const schemaInput = modal.querySelector('#tool-schema-input');

    if (!nameInput || !descInput || !schemaInput) return;

    const name = nameInput.value.trim();
    const description = descInput.value.trim();

    if (!name) {
        showNotification('请输入工具名称', 'error');
        nameInput.focus();
        return;
    }

    if (!description) {
        showNotification('请输入工具描述', 'error');
        descInput.focus();
        return;
    }

    let schema;
    try {
        schema = JSON.parse(schemaInput.value);
        if (schema.type !== 'object') {
            throw new Error('Schema 必须是 object 类型');
        }
    } catch (error) {
        showNotification(`Schema 格式错误: ${error.message}`, 'error');
        schemaInput.focus();
        return;
    }

    const permissions = {
        requireApproval: modal.querySelector('#require-approval-checkbox')?.checked || false,
        allowFilesystem: modal.querySelector('#allow-filesystem-checkbox')?.checked || false,
        allowNetwork: modal.querySelector('#allow-network-checkbox')?.checked || false
    };

    const rateLimit = {
        max: parseInt(modal.querySelector('#rate-limit-max-input')?.value || '10'),
        window: parseInt(modal.querySelector('#rate-limit-window-input')?.value || '1'),
        unit: modal.querySelector('#rate-limit-unit-select')?.value || 'minute'
    };

    const toolConfig = {
        name,
        description,
        parameters: schema,
        permissions,
        rateLimit
    };

    try {
        registerCustomTool({
            id: selectedToolId,
            ...toolConfig
        });
        debouncedSaveSession();

        showNotification('工具已保存', 'success');
        onSaved();

        logger.debug('[Tool Manager] 保存工具:', selectedToolId, toolConfig);
    } catch (error) {
        showNotification(`保存失败: ${error.message}`, 'error');
        logger.error('[Tool Manager] 保存工具失败:', error);
    }
}

// ========== 权限 Tab ==========

/**
 * 加载权限管理 Tab 内容
 */
export function loadPermissionsTab() {
    const container = document.getElementById('permissions-list-container');
    if (!container) return;

    const tools = getAllTools().filter((t) => !t.hidden);
    if (tools.length === 0) {
        // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
        container.innerHTML = '<p class="no-data-hint">暂无工具</p>';
        return;
    }

    let html = '<div class="permissions-list">';
    tools.forEach((tool) => {
        const enabled = isToolEnabled(tool.id);
        html += `
            <div class="permission-item">
                <div class="permission-info">
                    <span class="permission-name">${escapeHtml(tool.name || tool.id)}</span>
                    <span class="permission-type type-${escapeHtml(tool.type)}">${escapeHtml(tool.type)}</span>
                </div>
                <div class="permission-controls">
                    <label class="switch">
                        <input type="checkbox" ${enabled ? 'checked' : ''} data-tool-id="${escapeHtml(tool.id)}">
                        <span class="slider"></span>
                    </label>
                </div>
            </div>
        `;
    });
    html += '</div>';
    // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
    container.innerHTML = html;

    container.querySelectorAll('input[type="checkbox"]').forEach((checkbox) => {
        checkbox.addEventListener('change', (e) => {
            const toolId = e.target.dataset.toolId;
            setToolEnabled(toolId, e.target.checked);
            showNotification(`工具 "${toolId}" 已${e.target.checked ? '启用' : '禁用'}`, 'success');
        });
    });
}

// ========== 历史 Tab ==========

/**
 * 加载执行历史 Tab 内容
 */
export function loadHistoryTab() {
    const container = document.getElementById('history-list-container');
    if (!container) return;

    const history = getToolHistory({ limit: 50 });
    if (!history || history.length === 0) {
        // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
        container.innerHTML = '<p class="no-data-hint">暂无执行历史</p>';
        return;
    }

    let html = '<div class="history-list">';
    history.forEach((record) => {
        const time = new Date(record.timestamp).toLocaleString();
        const statusClass = record.success ? 'success' : 'error';
        const statusText = record.success ? '成功' : '失败';

        html += `
            <div class="history-item ${statusClass}">
                <div class="history-info">
                    <span class="history-name">${escapeHtml(record.toolName || record.toolId)}</span>
                    <span class="history-time">${time}</span>
                </div>
                <div class="history-status">
                    <span class="status-badge ${statusClass}">${statusText}</span>
                    ${record.duration ? `<span class="history-duration">${record.duration}ms</span>` : ''}
                </div>
            </div>
        `;
    });
    html += '</div>';
    // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
    container.innerHTML = html;

    const clearBtn = document.getElementById('clear-history-btn');
    if (clearBtn) {
        clearBtn.onclick = async () => {
            const confirmed = await showConfirmDialog('确定要清空所有执行历史吗？', '清空历史');
            if (confirmed) {
                clearToolHistory();
                loadHistoryTab();
                showNotification('执行历史已清空', 'success');
            }
        };
    }
}

// ========== 工具测试对话框 ==========

/**
 * 显示工具测试对话框
 * @param {Object} tool - 工具定义
 */
async function showToolTestDialog(tool) {
    const modal = document.getElementById('tool-test-dialog-modal');
    const title = document.getElementById('tool-test-dialog-title');
    const description = document.getElementById('tool-test-description');
    const formContainer = document.getElementById('tool-test-form-container');
    const resultContainer = document.getElementById('tool-test-result-container');
    const resultContent = document.getElementById('tool-test-result-content');
    const executeBtn = document.getElementById('tool-test-execute-btn');
    const closeBtn = document.getElementById('tool-test-close-btn');
    const closeBtnX = document.getElementById('close-tool-test-dialog');
    const overlay = modal?.querySelector('.modal-overlay');
    cleanupToolTestDialog?.();

    title.textContent = `测试工具: ${tool.name || tool.id}`;
    description.textContent = tool.description || '无描述';

    const schema = tool.inputSchema;
    if (!schema || !schema.properties || Object.keys(schema.properties).length === 0) {
        // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
        formContainer.innerHTML = '<p class="no-params-hint">此工具无参数</p>';
    } else {
        // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
        formContainer.innerHTML = generateFormFromSchema(schema);
    }

    resultContainer.style.display = 'none';
    // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
    resultContent.innerHTML = '';

    modal.style.display = 'flex';

    const handleExecute = async () => {
        try {
            const args = collectFormData(formContainer, schema);

            executeBtn.disabled = true;
            executeBtn.textContent = '执行中...';
            resultContainer.style.display = 'none';

            const { executeTool } = await import('../tools/executor.js');
            const result = await executeTool(tool.id, args);

            // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
            resultContent.innerHTML = `
                <div class="test-result-success">
                    <h4>执行成功</h4>
                    <pre class="result-data">${escapeHtml(JSON.stringify(result, null, 2))}</pre>
                </div>
            `;
            resultContainer.style.display = 'block';
            showNotification('工具执行成功', 'success');
        } catch (error) {
            // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
            resultContent.innerHTML = `
                <div class="test-result-error">
                    <h4>执行失败</h4>
                    <pre class="error-message">${escapeHtml(error.message)}</pre>
                </div>
            `;
            resultContainer.style.display = 'block';
            showNotification('工具执行失败', 'error');
        } finally {
            executeBtn.disabled = false;
            executeBtn.textContent = '执行测试';
        }
    };

    const getInitialFocusTarget = () => getFocusableElements(formContainer)[0] ?? closeBtn;

    let isClosed = false;
    const cleanup = () => {
        if (isClosed) return;
        isClosed = true;

        removeToolTestEscape?.();
        removeToolTestEscape = null;
        removeToolTestFocus?.();
        removeToolTestFocus = null;

        modal.style.display = 'none';
        executeBtn.removeEventListener('click', handleExecute);
        closeBtn.removeEventListener('click', handleClose);
        closeBtnX.removeEventListener('click', handleClose);
        overlay?.removeEventListener('click', handleClose);

        if (cleanupToolTestDialog === cleanup) {
            cleanupToolTestDialog = null;
        }
    };

    const handleClose = () => {
        cleanup();
    };

    executeBtn.addEventListener('click', handleExecute);
    closeBtn.addEventListener('click', handleClose);
    closeBtnX.addEventListener('click', handleClose);
    overlay?.addEventListener('click', handleClose);
    removeToolTestEscape = bindTopmostEscape(modal, handleClose);
    removeToolTestFocus = setupModalFocus(modal, {
        initialFocus: getInitialFocusTarget
    });
    cleanupToolTestDialog = cleanup;
}

/**
 * 从 JSON Schema 生成表单 HTML
 */
function generateFormFromSchema(schema) {
    const properties = schema.properties || {};
    const required = schema.required || [];

    let html = '<div class="tool-test-form">';

    for (const [key, prop] of Object.entries(properties)) {
        const isRequired = required.includes(key);
        const safeKey = escapeHtml(key);
        const label = escapeHtml(prop.title || key);
        const description = prop.description ? escapeHtml(prop.description) : '';
        const safeDefault = prop.default !== undefined ? escapeHtml(String(prop.default)) : '';

        html += `
            <div class="form-field">
                <label for="test-param-${safeKey}">
                    ${label}
                    ${isRequired ? '<span class="required">*</span>' : ''}
                </label>
                ${description ? `<p class="field-description">${description}</p>` : ''}
        `;

        if (prop.type === 'string') {
            if (prop.enum) {
                html += `<select id="test-param-${safeKey}" ${isRequired ? 'required' : ''}>`;
                html += '<option value="">-- 请选择 --</option>';
                prop.enum.forEach((value) => {
                    const safeValue = escapeHtml(String(value));
                    html += `<option value="${safeValue}">${safeValue}</option>`;
                });
                html += '</select>';
            } else if (prop.format === 'textarea' || (prop.maxLength && prop.maxLength > 100)) {
                html += `<textarea id="test-param-${safeKey}" rows="3" placeholder="${safeDefault}" ${isRequired ? 'required' : ''}></textarea>`;
            } else {
                html += `<input type="text" id="test-param-${safeKey}" placeholder="${safeDefault}" ${isRequired ? 'required' : ''} />`;
            }
        } else if (prop.type === 'number' || prop.type === 'integer') {
            html += `<input type="number" id="test-param-${safeKey}" placeholder="${safeDefault}" ${isRequired ? 'required' : ''} />`;
        } else if (prop.type === 'boolean') {
            html += `
                <label class="checkbox-label">
                    <input type="checkbox" id="test-param-${safeKey}" ${prop.default ? 'checked' : ''} />
                    ${safeDefault ? `(默认: ${safeDefault})` : ''}
                </label>
            `;
        } else if (prop.type === 'array' || prop.type === 'object') {
            html += `<textarea id="test-param-${safeKey}" rows="5" class="code-editor" placeholder="${prop.type === 'array' ? '[]' : '{}'}" ${isRequired ? 'required' : ''}></textarea>`;
            html += `<p class="field-hint">请输入有效的 JSON 格式</p>`;
        } else {
            html += `<input type="text" id="test-param-${safeKey}" placeholder="${safeDefault}" ${isRequired ? 'required' : ''} />`;
        }

        html += '</div>';
    }

    html += '</div>';
    return html;
}

/**
 * 收集并验证表单数据
 */
function collectFormData(container, schema) {
    if (!schema || !schema.properties) {
        return {};
    }

    const properties = schema.properties;
    const required = schema.required || [];
    const args = {};

    for (const [key, prop] of Object.entries(properties)) {
        const input = container.querySelector(`#test-param-${key}`);
        if (!input) continue;

        let value;

        if (prop.type === 'boolean') {
            value = input.checked;
        } else if (prop.type === 'number' || prop.type === 'integer') {
            value = input.value ? parseFloat(input.value) : undefined;
        } else if (prop.type === 'array' || prop.type === 'object') {
            const jsonStr = input.value.trim();
            if (jsonStr) {
                try {
                    value = JSON.parse(jsonStr);
                } catch (error) {
                    throw new Error(`参数 "${key}" 的 JSON 格式无效: ${error.message}`);
                }
            }
        } else {
            value = input.value;
        }

        if (required.includes(key) && (value === undefined || value === '' || value === null)) {
            throw new Error(`参数 "${key}" 为必填项`);
        }

        if (value !== undefined && value !== '' && value !== null) {
            args[key] = value;
        }
    }

    return args;
}
