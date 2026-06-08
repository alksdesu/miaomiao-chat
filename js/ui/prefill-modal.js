/**
 * 预填充预设 Modal
 * 独立的预填充预设管理面板，左右分栏布局
 */

import { state } from '../core/state.js';
import { eventBus } from '../core/events.js';
import { escapeHtml, generateId } from '../utils/helpers.js';
import { saveCurrentConfig } from '../state/config.js';
import { debouncedSaveSession } from '../state/sessions.js';
import { showInputDialog, showConfirmDialog } from '../utils/dialogs.js';
import { logger } from '../utils/logger.js';
import { bindTopmostEscape } from '../utils/modal-stack.js';

let removeEscapeListener = null;
let selectedPresetId = null;
let _saveConfigTimer = null;

function debouncedSaveConfig() {
    clearTimeout(_saveConfigTimer);
    _saveConfigTimer = setTimeout(() => saveCurrentConfig(), 500);
}

function autoResizeTextarea(textarea, minHeight = 60, maxHeight = 300) {
    if (!textarea) return;
    textarea.style.height = 'auto';
    const h = Math.max(minHeight, Math.min(textarea.scrollHeight, maxHeight));
    textarea.style.height = h + 'px';
}

export function initPrefillModal() {
    const toggleBtn = document.getElementById('prefill-toggle');
    const modal = document.getElementById('prefill-modal');
    if (!toggleBtn || !modal) return;

    toggleBtn.addEventListener('click', openPrefillModal);
    document.getElementById('mobile-close-prefill')?.addEventListener('click', closePrefillModal);
    document.getElementById('mobile-back-prefill')?.addEventListener('click', backToPrefillList);
    document.getElementById('add-prefill-preset')?.addEventListener('click', createPreset);
    document
        .getElementById('delete-prefill-preset-btn')
        ?.addEventListener('click', deleteSelectedPreset);

    modal.querySelector('.modal-overlay')?.addEventListener('click', closePrefillModal);

    logger.debug('Prefill modal initialized');
}

function openPrefillModal() {
    const modal = document.getElementById('prefill-modal');
    if (!modal) return;

    selectedPresetId = state.activePrefillPresetId;
    modal.classList.add('active');
    renderPresetList();

    if (selectedPresetId) {
        renderPresetDetail(selectedPresetId);
    } else {
        renderEmptyState();
    }

    removeEscapeListener = bindTopmostEscape(modal, closePrefillModal);
}

function closePrefillModal() {
    const modal = document.getElementById('prefill-modal');
    if (!modal) return;

    clearTimeout(_saveConfigTimer);
    modal.classList.remove('active');
    modal.querySelector('.prefill-modal-content')?.classList.remove('mobile-detail-view');

    if (removeEscapeListener) {
        removeEscapeListener();
        removeEscapeListener = null;
    }
}

function backToPrefillList() {
    document.querySelector('.prefill-modal-content')?.classList.remove('mobile-detail-view');
}

function renderPresetList() {
    const container = document.getElementById('prefill-preset-list');
    if (!container) return;

    if (state.prefillPresets.length === 0) {
        // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML
        container.innerHTML = '<div class="prefill-list-empty">暂无预设</div>';
        return;
    }

    // eslint-disable-next-line no-restricted-syntax -- 已审计：已escapeHtml
    container.innerHTML = state.prefillPresets
        .map(
            (
                p
            ) => `<div class="prefill-item${p.id === selectedPresetId ? ' active' : ''}" data-id="${escapeHtml(p.id)}">
                <span class="prefill-item-name">${escapeHtml(p.name)}</span>
            </div>`
        )
        .join('');

    container.querySelectorAll('.prefill-item').forEach((el) => {
        el.addEventListener('click', () => {
            selectedPresetId = el.dataset.id;
            renderPresetList();
            renderPresetDetail(selectedPresetId);
            document.querySelector('.prefill-modal-content')?.classList.add('mobile-detail-view');
        });
    });
}

function renderEmptyState() {
    const body = document.getElementById('prefill-detail-body');
    if (!body) return;
    // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML
    body.innerHTML = '<div class="prefill-empty-state"><p>选择或新建一个预设开始编辑</p></div>';
    document.getElementById('prefill-detail-title').textContent = '编辑预设';
}

function getPresetById(id) {
    return state.prefillPresets.find((p) => p.id === id);
}

function updatePreset(id, key, value) {
    const idx = state.prefillPresets.findIndex((p) => p.id === id);
    if (idx === -1) return;
    const updated = { ...state.prefillPresets[idx], [key]: value };
    const presets = [...state.prefillPresets];
    presets[idx] = updated;
    state.prefillPresets = presets;
    debouncedSaveConfig();
}

function renderPresetDetail(presetId) {
    const body = document.getElementById('prefill-detail-body');
    const title = document.getElementById('prefill-detail-title');
    if (!body) return;

    const preset = getPresetById(presetId);
    if (!preset) {
        renderEmptyState();
        return;
    }

    title.textContent = preset.name;

    // eslint-disable-next-line no-restricted-syntax -- 已审计：已escapeHtml/静态结构
    body.innerHTML = `
        <div class="prefill-form">
            <div class="prefill-form-group">
                <label class="prefill-form-label">预设名称</label>
                <input type="text" class="prefill-form-input" id="pf-name" value="${escapeHtml(preset.name)}" />
            </div>

            <div class="prefill-form-group">
                <div class="toggle-row">
                    <label class="switch">
                        <input type="checkbox" id="pf-enabled" ${preset.prefillEnabled ? 'checked' : ''} />
                        <span class="slider"></span>
                    </label>
                    <span>启用预填充</span>
                </div>
            </div>

            <div class="prefill-form-group">
                <label class="prefill-form-label">System Prompt</label>
                <textarea id="pf-system-prompt" class="prefill-textarea" rows="4" placeholder="系统指令...&#10;支持变量: {{char}}, {{user}}, {{date}}, {{time}}">${escapeHtml(preset.systemPrompt || '')}</textarea>
            </div>

            <div class="prefill-form-group">
                <div class="prefill-vars-row">
                    <div class="var-input">
                        <label>{{char}}</label>
                        <input type="text" id="pf-char-name" value="${escapeHtml(preset.charName || 'Assistant')}" placeholder="角色名" />
                    </div>
                    <div class="var-input">
                        <label>{{user}}</label>
                        <input type="text" id="pf-user-name" value="${escapeHtml(preset.userName || 'User')}" placeholder="用户名" />
                    </div>
                </div>
            </div>

            <details class="prefill-details">
                <summary class="prefill-summary">
                    <svg class="details-arrow" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>
                    开场对话 <span class="hint">(System Prompt 之后插入)</span>
                </summary>
                <div class="prefill-details-content">
                    <div id="pf-system-prefill-list" class="prefill-messages-list"></div>
                    <button class="prefill-add-btn" id="pf-add-system-prefill">+ 添加开场消息</button>
                </div>
            </details>

            <details class="prefill-details" style="margin-top: 12px">
                <summary class="prefill-summary">
                    <svg class="details-arrow" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>
                    预填充对话 <span class="hint">(用户输入之后插入)</span>
                </summary>
                <div class="prefill-details-content">
                    <div id="pf-prefill-messages-list" class="prefill-messages-list"></div>
                    <button class="prefill-add-btn" id="pf-add-prefill-msg">+ 添加消息</button>
                </div>
            </details>

            <details class="prefill-details" style="margin-top: 12px">
                <summary class="prefill-summary">
                    <svg class="details-arrow" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>
                    Gemini System Parts
                </summary>
                <div class="prefill-details-content">
                    <div class="toggle-row" style="margin-bottom: 8px">
                        <label class="switch">
                            <input type="checkbox" id="pf-gemini-parts-enabled" ${preset.geminiSystemPartsEnabled ? 'checked' : ''} />
                            <span class="slider"></span>
                        </label>
                        <span>启用 Gemini System Parts</span>
                    </div>
                    <div id="pf-gemini-parts-list" class="prefill-messages-list"></div>
                    <button class="prefill-add-btn" id="pf-add-gemini-part">+ 添加 Part</button>
                </div>
            </details>

            <p class="settings-hint">变量: {{char}}=角色名, {{user}}=用户名, {{date}}=日期, {{time}}=时间</p>

            <button class="prefill-apply-btn" id="pf-apply-btn">应用到当前会话</button>
        </div>
    `;

    bindDetailEvents(preset);
    renderMessageList(
        'pf-system-prefill-list',
        preset.systemPrefillMessages,
        preset,
        'systemPrefillMessages'
    );
    renderMessageList(
        'pf-prefill-messages-list',
        preset.prefillMessages,
        preset,
        'prefillMessages'
    );
    renderGeminiPartsList(preset);
}

function bindDetailEvents(preset) {
    const nameInput = document.getElementById('pf-name');
    nameInput?.addEventListener('input', (e) => {
        updatePreset(preset.id, 'name', e.target.value);
        document.getElementById('prefill-detail-title').textContent = e.target.value;
        renderPresetList();
    });

    document.getElementById('pf-enabled')?.addEventListener('change', (e) => {
        updatePreset(preset.id, 'prefillEnabled', e.target.checked);
    });

    const spTextarea = document.getElementById('pf-system-prompt');
    if (spTextarea) {
        autoResizeTextarea(spTextarea);
        spTextarea.addEventListener('input', (e) => {
            updatePreset(preset.id, 'systemPrompt', e.target.value);
            autoResizeTextarea(e.target);
        });
    }

    document.getElementById('pf-char-name')?.addEventListener('input', (e) => {
        updatePreset(preset.id, 'charName', e.target.value);
    });

    document.getElementById('pf-user-name')?.addEventListener('input', (e) => {
        updatePreset(preset.id, 'userName', e.target.value);
    });

    document.getElementById('pf-add-system-prefill')?.addEventListener('click', () => {
        preset.systemPrefillMessages.push({ role: 'user', content: '' });
        renderMessageList(
            'pf-system-prefill-list',
            preset.systemPrefillMessages,
            preset,
            'systemPrefillMessages'
        );
        saveCurrentConfig();
    });

    document.getElementById('pf-add-prefill-msg')?.addEventListener('click', () => {
        preset.prefillMessages.push({ role: 'user', content: '' });
        renderMessageList(
            'pf-prefill-messages-list',
            preset.prefillMessages,
            preset,
            'prefillMessages'
        );
        saveCurrentConfig();
    });

    document.getElementById('pf-gemini-parts-enabled')?.addEventListener('change', (e) => {
        updatePreset(preset.id, 'geminiSystemPartsEnabled', e.target.checked);
    });

    document.getElementById('pf-add-gemini-part')?.addEventListener('click', () => {
        preset.geminiSystemParts.push({ text: '' });
        renderGeminiPartsList(preset);
        saveCurrentConfig();
    });

    document.getElementById('pf-apply-btn')?.addEventListener('click', () => {
        applyPresetToSession(preset);
    });
}

function renderMessageList(containerId, messages, preset, field) {
    const container = document.getElementById(containerId);
    if (!container) return;

    if (messages.length === 0) {
        // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML
        container.innerHTML =
            '<div class="prefill-list-empty" style="font-size: 12px; padding: 8px; text-align: center; color: var(--md-muted);">暂无消息</div>';
        return;
    }

    // eslint-disable-next-line no-restricted-syntax -- 已审计：已escapeHtml
    container.innerHTML = messages
        .map(
            (msg, idx) => `
        <div class="prefill-message-item" data-index="${idx}">
            <div class="prefill-message-header">
                <span class="prefill-msg-index">#${idx + 1}</span>
                <select class="prefill-role-select" data-index="${idx}">
                    <option value="user" ${msg.role === 'user' ? 'selected' : ''}>user</option>
                    <option value="assistant" ${msg.role === 'assistant' ? 'selected' : ''}>assistant</option>
                </select>
                <button class="delete-prefill-msg" data-index="${idx}" title="删除">\u00d7</button>
            </div>
            <textarea class="prefill-msg-content" data-index="${idx}" placeholder="消息内容...">${escapeHtml(msg.content)}</textarea>
        </div>`
        )
        .join('');

    container.querySelectorAll('.prefill-role-select').forEach((sel) => {
        sel.addEventListener('change', (e) => {
            messages[parseInt(e.target.dataset.index)].role = e.target.value;
            saveCurrentConfig();
        });
    });

    container.querySelectorAll('.prefill-msg-content').forEach((textarea) => {
        autoResizeTextarea(textarea);
        textarea.addEventListener('input', (e) => {
            messages[parseInt(e.target.dataset.index)].content = e.target.value;
            debouncedSaveConfig();
            autoResizeTextarea(e.target);
        });
    });

    container.querySelectorAll('.delete-prefill-msg').forEach((btn) => {
        btn.addEventListener('click', (e) => {
            messages.splice(parseInt(e.target.dataset.index), 1);
            renderMessageList(containerId, messages, preset, field);
            saveCurrentConfig();
        });
    });
}

function renderGeminiPartsList(preset) {
    const container = document.getElementById('pf-gemini-parts-list');
    if (!container) return;

    const parts = preset.geminiSystemParts;
    if (parts.length === 0) {
        // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML
        container.innerHTML =
            '<div class="prefill-list-empty" style="font-size: 12px; padding: 8px; text-align: center; color: var(--md-muted);">暂无 Parts</div>';
        return;
    }

    // eslint-disable-next-line no-restricted-syntax -- 已审计：已escapeHtml
    container.innerHTML = parts
        .map(
            (part, idx) => `
        <div class="prefill-message-item" data-index="${idx}">
            <div class="prefill-message-header">
                <span class="prefill-msg-index">Part #${idx + 1}</span>
                <button class="delete-prefill-msg" data-index="${idx}" title="删除">\u00d7</button>
            </div>
            <textarea class="prefill-msg-content" data-index="${idx}" placeholder="System Part 内容...">${escapeHtml(part.text || '')}</textarea>
        </div>`
        )
        .join('');

    container.querySelectorAll('.prefill-msg-content').forEach((textarea) => {
        autoResizeTextarea(textarea);
        textarea.addEventListener('input', (e) => {
            parts[parseInt(e.target.dataset.index)].text = e.target.value;
            debouncedSaveConfig();
            autoResizeTextarea(e.target);
        });
    });

    container.querySelectorAll('.delete-prefill-msg').forEach((btn) => {
        btn.addEventListener('click', (e) => {
            parts.splice(parseInt(e.target.dataset.index), 1);
            renderGeminiPartsList(preset);
            saveCurrentConfig();
        });
    });
}

async function createPreset() {
    const name = await showInputDialog('请输入预设名称:', '新预设', '新建预设');
    if (!name) return;

    const newPreset = {
        id: generateId('prefill'),
        name,
        prefillEnabled: true,
        systemPrompt: '',
        prefillMessages: [],
        charName: 'Assistant',
        userName: 'User',
        systemPrefillMessages: [],
        geminiSystemPartsEnabled: false,
        geminiSystemParts: [],
        createdAt: Date.now()
    };

    state.prefillPresets = [...state.prefillPresets, newPreset];
    selectedPresetId = newPreset.id;
    saveCurrentConfig();
    renderPresetList();
    renderPresetDetail(newPreset.id);
    document.querySelector('.prefill-modal-content')?.classList.add('mobile-detail-view');
}

async function deleteSelectedPreset() {
    if (!selectedPresetId) return;

    const preset = getPresetById(selectedPresetId);
    if (!preset) return;

    const confirmed = await showConfirmDialog(`确定删除预设 "${preset.name}" 吗？`, '确认删除');
    if (!confirmed) return;

    state.prefillPresets = state.prefillPresets.filter((p) => p.id !== selectedPresetId);

    if (state.activePrefillPresetId === selectedPresetId) {
        state.activePrefillPresetId = null;
    }

    selectedPresetId = null;
    saveCurrentConfig();
    renderPresetList();
    renderEmptyState();
    backToPrefillList();
}

function applyPresetToSession(preset) {
    state.prefillEnabled = preset.prefillEnabled;
    state.systemPrompt = preset.systemPrompt || '';
    state.prefillMessages = JSON.parse(JSON.stringify(preset.prefillMessages || []));
    state.charName = preset.charName || 'Assistant';
    state.userName = preset.userName || 'User';
    state.systemPrefillMessages = JSON.parse(JSON.stringify(preset.systemPrefillMessages || []));
    state.geminiSystemPartsEnabled = preset.geminiSystemPartsEnabled || false;
    state.geminiSystemParts = JSON.parse(JSON.stringify(preset.geminiSystemParts || []));

    state.activePrefillPresetId = preset.id;
    saveCurrentConfig();
    debouncedSaveSession();
    eventBus.emit('config:sync-prefill-ui');
    closePrefillModal();
    logger.info(`[Prefill] 预设 "${preset.name}" 已应用到当前会话`);
}
