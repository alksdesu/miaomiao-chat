/**
 * 请求构建器视图 — Postman 风格
 */

import { logger } from '../utils/logger.js';

let container = null;
let abortController = null;

// DOM 引用
let methodSelect = null;
let urlInput = null;
let sendBtn = null;
let configTabs = null;
const configPanels = {};
const responsePanels = {};
let responseStatusEl = null;
let sseToggle = null;

// 媒体预览状态
let currentObjectUrl = null;

const DEFAULT_HEADERS = [
    { enabled: true, key: 'Content-Type', value: 'application/json' },
    { enabled: true, key: 'Authorization', value: '' }
];

const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];
const BODY_FORMATS = ['none', 'JSON', 'Text', 'Form Data', 'x-www-form-urlencoded', 'XML'];
const AUTH_TYPES = ['None', 'Bearer Token', 'API Key'];

let activeConfigTab = 'params';
let activeResponseTab = 'body';
let activeBodyFormat = 'JSON';
let activeAuthType = 'None';

export function renderBuilderView(target) {
    container = target;
    const view = document.createElement('div');
    view.className = 'builder-view';

    const configSection = document.createElement('div');
    configSection.className = 'builder-config';

    const responseSection = document.createElement('div');
    responseSection.className = 'builder-response';

    buildConfigSection(configSection);
    buildResponseSection(responseSection);

    view.appendChild(configSection);
    view.appendChild(responseSection);
    container.appendChild(view);
}

export function abortBuilderRequest() {
    if (abortController) abortController.abort();
}

export function importToBuilder(record) {
    if (!container) return;
    if (methodSelect) {
        methodSelect.value = record.method || 'GET';
    }
    if (urlInput) {
        urlInput.value = record.url || '';
        syncParamsFromURL();
    }
    if (record.requestHeaders) {
        importHeaders(record.requestHeaders);
    }
    if (record.requestBody) {
        importBody(record.requestBody);
    }
    logger.debug('Imported record to builder', record.id);
}

// ── 配置区 ──

function buildConfigSection(parent) {
    // 请求栏
    const requestBar = document.createElement('div');
    requestBar.className = 'builder-request-bar';

    methodSelect = document.createElement('select');
    methodSelect.className = 'builder-method-select';
    METHODS.forEach((m) => {
        const opt = document.createElement('option');
        opt.value = m;
        opt.textContent = m;
        methodSelect.appendChild(opt);
    });

    urlInput = document.createElement('input');
    urlInput.type = 'text';
    urlInput.inputMode = 'url';
    urlInput.className = 'builder-url-input';
    urlInput.placeholder = 'https://api.example.com/v1/messages';
    urlInput.addEventListener('input', syncParamsFromURL);

    sendBtn = document.createElement('button');
    sendBtn.className = 'builder-send-btn';
    sendBtn.textContent = 'Send';
    sendBtn.addEventListener('click', handleSendClick);

    requestBar.appendChild(methodSelect);
    requestBar.appendChild(urlInput);
    requestBar.appendChild(sendBtn);
    parent.appendChild(requestBar);

    // Tabs
    const tabBar = document.createElement('div');
    tabBar.className = 'builder-tabs';
    ['params', 'headers', 'body', 'auth'].forEach((tabId) => {
        const btn = document.createElement('button');
        btn.className = 'builder-tab' + (tabId === activeConfigTab ? ' active' : '');
        btn.textContent = tabId.charAt(0).toUpperCase() + tabId.slice(1);
        btn.dataset.tab = tabId;
        btn.addEventListener('click', () => switchConfigTab(tabId));
        tabBar.appendChild(btn);
    });
    parent.appendChild(tabBar);
    configTabs = tabBar;

    // Tab 面板
    const panelWrap = document.createElement('div');
    panelWrap.className = 'builder-tab-panels';

    configPanels.params = buildParamsPanel();
    configPanels.headers = buildHeadersPanel();
    configPanels.body = buildBodyPanel();
    configPanels.auth = buildAuthPanel();

    Object.entries(configPanels).forEach(([id, el]) => {
        el.className += ' builder-tab-panel';
        el.dataset.panel = id;
        if (id !== activeConfigTab) el.style.display = 'none';
        panelWrap.appendChild(el);
    });
    parent.appendChild(panelWrap);
}

function switchConfigTab(tabId) {
    activeConfigTab = tabId;
    configTabs.querySelectorAll('.builder-tab').forEach((t) => {
        t.classList.toggle('active', t.dataset.tab === tabId);
    });
    Object.entries(configPanels).forEach(([id, el]) => {
        el.style.display = id === tabId ? '' : 'none';
    });
}

// ── Params Tab ──

function buildParamsPanel() {
    const panel = document.createElement('div');
    const table = document.createElement('div');
    table.className = 'builder-kv-table';
    panel.appendChild(table);

    const addBtn = document.createElement('button');
    addBtn.className = 'builder-add-btn';
    addBtn.textContent = '+ Add';
    addBtn.addEventListener('click', () => {
        addKVRow(table, '', '', { onChangeSync: syncURLFromParams });
    });
    panel.appendChild(addBtn);
    return panel;
}

function syncParamsFromURL() {
    const panel = configPanels.params;
    if (!panel) return;
    const table = panel.querySelector('.builder-kv-table');
    if (!table) return;
    table.innerHTML = ''; // eslint-disable-line no-restricted-syntax
    try {
        const url = new URL(urlInput.value);
        url.searchParams.forEach((v, k) => {
            addKVRow(table, k, v, { onChangeSync: syncURLFromParams });
        });
    } catch {
        // URL 不合法时不解析
    }
}

function syncURLFromParams() {
    try {
        const url = new URL(urlInput.value);
        const params = new URLSearchParams();
        const table = configPanels.params.querySelector('.builder-kv-table');
        table.querySelectorAll('.builder-kv-row').forEach((row) => {
            const k = row.querySelector('.kv-key')?.value?.trim();
            const v = row.querySelector('.kv-value')?.value || '';
            if (k) params.append(k, v);
        });
        url.search = params.toString();
        urlInput.value = url.toString();
    } catch {
        // URL 不合法时忽略
    }
}

// ── Headers Tab ──

function buildHeadersPanel() {
    const panel = document.createElement('div');
    const table = document.createElement('div');
    table.className = 'builder-kv-table';
    DEFAULT_HEADERS.forEach((h) => {
        addKVRow(table, h.key, h.value, { checkbox: true, checked: h.enabled });
    });
    panel.appendChild(table);

    const addBtn = document.createElement('button');
    addBtn.className = 'builder-add-btn';
    addBtn.textContent = '+ Add';
    addBtn.addEventListener('click', () => {
        addKVRow(table, '', '', { checkbox: true, checked: true });
    });
    panel.appendChild(addBtn);
    return panel;
}

// ── Body Tab ──

function buildBodyPanel() {
    const panel = document.createElement('div');

    // 格式选择
    const formatBar = document.createElement('div');
    formatBar.className = 'builder-body-format-bar';
    BODY_FORMATS.forEach((fmt) => {
        const btn = document.createElement('button');
        btn.className = 'builder-format-btn' + (fmt === activeBodyFormat ? ' active' : '');
        btn.textContent = fmt;
        btn.addEventListener('click', () => switchBodyFormat(fmt, panel));
        formatBar.appendChild(btn);
    });
    panel.appendChild(formatBar);

    // 编辑区容器
    const editorWrap = document.createElement('div');
    editorWrap.className = 'builder-body-editor';

    const textarea = document.createElement('textarea');
    textarea.className = 'builder-body-textarea';
    textarea.placeholder = '{ "key": "value" }';
    textarea.spellcheck = false;
    editorWrap.appendChild(textarea);

    // Format JSON 按钮
    const formatBtn = document.createElement('button');
    formatBtn.className = 'builder-format-json-btn';
    formatBtn.textContent = 'Format';
    formatBtn.addEventListener('click', () => {
        try {
            textarea.value = JSON.stringify(JSON.parse(textarea.value), null, 2);
        } catch {
            textarea.style.outline = '2px solid var(--color-error)';
            setTimeout(() => {
                textarea.style.outline = '';
            }, 1500);
        }
    });
    editorWrap.appendChild(formatBtn);

    panel.appendChild(editorWrap);

    // Form Data 表格（默认隐藏）
    const formTable = document.createElement('div');
    formTable.className = 'builder-kv-table builder-form-table';
    formTable.style.display = 'none';

    const addFormBtn = document.createElement('button');
    addFormBtn.className = 'builder-add-btn builder-form-add';
    addFormBtn.textContent = '+ Add';
    addFormBtn.style.display = 'none';
    addFormBtn.addEventListener('click', () => addKVRow(formTable, '', ''));

    panel.appendChild(formTable);
    panel.appendChild(addFormBtn);

    return panel;
}

function switchBodyFormat(fmt, panel) {
    activeBodyFormat = fmt;
    panel.querySelectorAll('.builder-format-btn').forEach((b) => {
        b.classList.toggle('active', b.textContent === fmt);
    });

    const editorWrap = panel.querySelector('.builder-body-editor');
    const formTable = panel.querySelector('.builder-form-table');
    const formAdd = panel.querySelector('.builder-form-add');
    const formatBtn = panel.querySelector('.builder-format-json-btn');

    const isForm = fmt === 'Form Data' || fmt === 'x-www-form-urlencoded';
    const isNone = fmt === 'none';
    const isJSON = fmt === 'JSON';

    editorWrap.style.display = isForm || isNone ? 'none' : '';
    formTable.style.display = isForm ? '' : 'none';
    formAdd.style.display = isForm ? '' : 'none';
    formatBtn.style.display = isJSON ? '' : 'none';

    const textarea = editorWrap.querySelector('textarea');
    if (fmt === 'XML') textarea.placeholder = '<root></root>';
    else if (fmt === 'Text') textarea.placeholder = '';
    else textarea.placeholder = '{ "key": "value" }';
}

// ── Auth Tab ──

function buildAuthPanel() {
    const panel = document.createElement('div');

    const typeSelect = document.createElement('select');
    typeSelect.className = 'builder-auth-type';
    AUTH_TYPES.forEach((t) => {
        const opt = document.createElement('option');
        opt.value = t;
        opt.textContent = t;
        typeSelect.appendChild(opt);
    });
    panel.appendChild(typeSelect);

    const authFields = document.createElement('div');
    authFields.className = 'builder-auth-fields';
    panel.appendChild(authFields);

    typeSelect.addEventListener('change', () => {
        activeAuthType = typeSelect.value;
        renderAuthFields(authFields);
    });
    renderAuthFields(authFields);
    return panel;
}

function renderAuthFields(container) {
    container.innerHTML = ''; // eslint-disable-line no-restricted-syntax
    if (activeAuthType === 'Bearer Token') {
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'builder-auth-input';
        input.placeholder = 'Token';
        input.dataset.authField = 'bearer';
        container.appendChild(input);
    } else if (activeAuthType === 'API Key') {
        const nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.className = 'builder-auth-input';
        nameInput.placeholder = 'Key Name (e.g. X-API-Key)';
        nameInput.dataset.authField = 'apikey-name';

        const valueInput = document.createElement('input');
        valueInput.type = 'text';
        valueInput.className = 'builder-auth-input';
        valueInput.placeholder = 'Value';
        valueInput.dataset.authField = 'apikey-value';

        const posSelect = document.createElement('select');
        posSelect.className = 'builder-auth-pos';
        posSelect.dataset.authField = 'apikey-pos';
        ['Header', 'Query'].forEach((p) => {
            const opt = document.createElement('option');
            opt.value = p;
            opt.textContent = p;
            posSelect.appendChild(opt);
        });

        container.appendChild(nameInput);
        container.appendChild(valueInput);
        container.appendChild(posSelect);
    }
}

// ── 响应区 ──

function buildResponseSection(parent) {
    responseStatusEl = document.createElement('div');
    responseStatusEl.className = 'builder-response-status';
    responseStatusEl.textContent = 'Ready';
    parent.appendChild(responseStatusEl);

    // SSE 开关
    const sseBar = document.createElement('div');
    sseBar.className = 'builder-sse-bar';

    const sseLabel = document.createElement('label');
    sseLabel.className = 'builder-sse-label';
    sseToggle = document.createElement('input');
    sseToggle.type = 'checkbox';
    sseToggle.className = 'builder-sse-toggle';
    sseLabel.appendChild(sseToggle);
    sseLabel.appendChild(document.createTextNode(' SSE Stream'));
    sseBar.appendChild(sseLabel);

    // 响应 tabs
    const tabBar = document.createElement('div');
    tabBar.className = 'builder-response-tabs';
    ['body', 'headers', 'sse'].forEach((tabId) => {
        const btn = document.createElement('button');
        const labels = { body: 'Body', headers: 'Headers', sse: 'SSE Stream' };
        btn.className = 'builder-tab' + (tabId === activeResponseTab ? ' active' : '');
        btn.textContent = labels[tabId];
        btn.dataset.tab = tabId;
        btn.addEventListener('click', () => switchResponseTab(tabId, parent));
        tabBar.appendChild(btn);
    });

    const topBar = document.createElement('div');
    topBar.className = 'builder-response-topbar';
    topBar.appendChild(tabBar);
    topBar.appendChild(sseBar);
    parent.appendChild(topBar);

    // 面板
    const panelWrap = document.createElement('div');
    panelWrap.className = 'builder-response-panels';

    // Body 面板：包含 Raw/Preview 切换 + 内容区
    responsePanels.body = document.createElement('div');
    responsePanels.body.className = 'builder-response-body-wrap';

    const modeToggle = document.createElement('div');
    modeToggle.className = 'response-mode-toggle';
    ['raw', 'preview'].forEach((mode) => {
        const btn = document.createElement('button');
        btn.className = 'response-mode-btn' + (mode === 'raw' ? ' active' : '');
        btn.textContent = mode === 'raw' ? 'Raw' : 'Preview';
        btn.dataset.mode = mode;
        btn.addEventListener('click', () => switchResponseMode(mode));
        modeToggle.appendChild(btn);
    });
    responsePanels.body.appendChild(modeToggle);

    responsePanels.bodyRaw = document.createElement('pre');
    responsePanels.bodyRaw.className = 'builder-response-body';
    responsePanels.body.appendChild(responsePanels.bodyRaw);

    responsePanels.bodyPreview = document.createElement('div');
    responsePanels.bodyPreview.className = 'media-preview';
    responsePanels.bodyPreview.style.display = 'none';
    responsePanels.body.appendChild(responsePanels.bodyPreview);

    responsePanels.headers = document.createElement('div');
    responsePanels.headers.className = 'builder-response-headers';

    responsePanels.sse = document.createElement('div');
    responsePanels.sse.className = 'builder-response-sse';

    [
        ['body', responsePanels.body],
        ['headers', responsePanels.headers],
        ['sse', responsePanels.sse]
    ].forEach(([id, el]) => {
        if (id !== activeResponseTab) el.style.display = 'none';
        panelWrap.appendChild(el);
    });
    parent.appendChild(panelWrap);
}

function switchResponseTab(tabId, parent) {
    activeResponseTab = tabId;
    parent.querySelectorAll('.builder-response-tabs .builder-tab').forEach((t) => {
        t.classList.toggle('active', t.dataset.tab === tabId);
    });
    const visibleIds = ['body', 'headers', 'sse'];
    visibleIds.forEach((id) => {
        const el = responsePanels[id];
        if (el) el.style.display = id === tabId ? '' : 'none';
    });
}

// ── KV 行工具 ──

function addKVRow(table, key, value, opts = {}) {
    const row = document.createElement('div');
    row.className = 'builder-kv-row';

    if (opts.checkbox) {
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.className = 'kv-enabled';
        cb.checked = opts.checked !== false;
        row.appendChild(cb);
    }

    const kInput = document.createElement('input');
    kInput.type = 'text';
    kInput.className = 'kv-key';
    kInput.value = key;
    kInput.placeholder = 'Key';
    if (opts.onChangeSync) kInput.addEventListener('input', opts.onChangeSync);

    const vInput = document.createElement('input');
    vInput.type = 'text';
    vInput.className = 'kv-value';
    vInput.value = value;
    vInput.placeholder = 'Value';
    if (opts.onChangeSync) vInput.addEventListener('input', opts.onChangeSync);

    const delBtn = document.createElement('button');
    delBtn.className = 'kv-delete';
    delBtn.textContent = '×';
    delBtn.addEventListener('click', () => {
        row.remove();
        if (opts.onChangeSync) opts.onChangeSync();
    });

    row.appendChild(kInput);
    row.appendChild(vInput);
    row.appendChild(delBtn);
    table.appendChild(row);
}

// ── 请求发送 ──

function handleSendClick() {
    if (abortController) {
        abortController.abort();
        return;
    }
    sendRequest();
}

async function sendRequest() {
    const method = methodSelect.value;
    const url = urlInput.value.trim();
    if (!url) {
        urlInput.style.outline = '2px solid var(--color-error)';
        setTimeout(() => {
            urlInput.style.outline = '';
        }, 1500);
        return;
    }

    // 追加 Auth 到 headers/params
    const headers = collectHeaders();
    applyAuth(headers);

    const body = collectBody(method);

    // FormData 需要浏览器自动设置 Content-Type（含 boundary），手动设置会冲突
    if (body instanceof FormData) {
        delete headers['Content-Type'];
        delete headers['content-type'];
    }

    abortController = new AbortController();
    toggleSendState(true);
    clearResponse();

    const startTime = performance.now();

    try {
        const fetchOpts = {
            method,
            headers,
            signal: abortController.signal
        };
        if (body !== null) fetchOpts.body = body;

        const response = await fetch(url, fetchOpts);
        const elapsed = ((performance.now() - startTime) / 1000).toFixed(2);

        showResponseStatus(response.status, response.statusText, elapsed);
        showResponseHeaders(response.headers);

        // 收集响应头
        const respHeaders = {};
        response.headers.forEach((v, k) => {
            respHeaders[k] = v;
        });

        const contentType = response.headers.get('content-type') || '';

        if (isMediaType(contentType)) {
            const blob = await response.blob();
            const objectUrl = URL.createObjectURL(blob);
            currentObjectUrl = objectUrl;
            updateResponseSize(blob.size);
            renderMediaPreview(contentType, objectUrl, blob.size);
            switchResponseMode('preview');
            if (contentType.startsWith('image/svg') || contentType === 'application/pdf') {
                const text = await blob.text();
                responsePanels.bodyRaw.textContent = text;
                return {
                    status: response.status,
                    statusText: response.statusText,
                    responseHeaders: respHeaders,
                    responseBody: text,
                    duration: elapsed
                };
            } else {
                responsePanels.bodyRaw.textContent = `[Binary ${contentType} — ${formatSize(blob.size)}]`;
                return {
                    status: response.status,
                    statusText: response.statusText,
                    responseHeaders: respHeaders,
                    responseBody: `[Binary ${contentType}]`,
                    duration: elapsed
                };
            }
        } else if (sseToggle.checked && response.body) {
            switchResponseTab('sse', responsePanels.sse.parentElement.parentElement);
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            const sseChunks = [];
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                const chunk = decoder.decode(value, { stream: true });
                sseChunks.push(chunk);
                appendSSELine(chunk);
            }
            return {
                status: response.status,
                statusText: response.statusText,
                responseHeaders: respHeaders,
                isStream: true,
                sseChunks,
                duration: elapsed
            };
        } else {
            const text = await response.text();
            const size = new Blob([text]).size;
            updateResponseSize(size);
            showResponseBody(text);
            renderTextPreview(contentType, text);
            return {
                status: response.status,
                statusText: response.statusText,
                responseHeaders: respHeaders,
                responseBody: text,
                duration: elapsed
            };
        }
    } catch (error) {
        const elapsed = ((performance.now() - startTime) / 1000).toFixed(2);
        if (error.name === 'AbortError') {
            showResponseStatus(0, 'Cancelled', elapsed);
        } else {
            showResponseError(error.message, elapsed);
        }
        return { error: error.message || String(error) };
    } finally {
        toggleSendState(false);
        abortController = null;
    }
}

function collectHeaders() {
    const headers = {};
    const table = configPanels.headers.querySelector('.builder-kv-table');
    table.querySelectorAll('.builder-kv-row').forEach((row) => {
        const enabled = row.querySelector('.kv-enabled');
        if (enabled && !enabled.checked) return;
        const k = row.querySelector('.kv-key')?.value?.trim();
        const v = row.querySelector('.kv-value')?.value || '';
        if (k) headers[k] = v;
    });
    return headers;
}

function applyAuth(headers) {
    if (activeAuthType === 'Bearer Token') {
        const token = configPanels.auth.querySelector('[data-auth-field="bearer"]')?.value?.trim();
        if (token) headers['Authorization'] = `Bearer ${token}`;
    } else if (activeAuthType === 'API Key') {
        const name = configPanels.auth
            .querySelector('[data-auth-field="apikey-name"]')
            ?.value?.trim();
        const value = configPanels.auth
            .querySelector('[data-auth-field="apikey-value"]')
            ?.value?.trim();
        const pos = configPanels.auth.querySelector('[data-auth-field="apikey-pos"]')?.value;
        if (name && value) {
            if (pos === 'Query') {
                try {
                    const url = new URL(urlInput.value);
                    url.searchParams.set(name, value);
                    urlInput.value = url.toString();
                } catch {
                    /* ignore */
                }
            } else {
                headers[name] = value;
            }
        }
    }
}

function collectKVFromTable(table) {
    const entries = [];
    table.querySelectorAll('.builder-kv-row').forEach((row) => {
        const k = row.querySelector('.kv-key')?.value?.trim();
        const v = row.querySelector('.kv-value')?.value || '';
        if (k) entries.push([k, v]);
    });
    return entries;
}

function collectBody(method) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return null;
    if (activeBodyFormat === 'none') return null;

    if (activeBodyFormat === 'Form Data') {
        const fd = new FormData();
        const table = configPanels.body.querySelector('.builder-form-table');
        for (const [k, v] of collectKVFromTable(table)) fd.append(k, v);
        return fd;
    }

    if (activeBodyFormat === 'x-www-form-urlencoded') {
        const params = new URLSearchParams();
        const table = configPanels.body.querySelector('.builder-form-table');
        for (const [k, v] of collectKVFromTable(table)) params.append(k, v);
        return params.toString();
    }

    // JSON / Text / XML
    return configPanels.body.querySelector('.builder-body-textarea')?.value || null;
}

// ── 响应显示 ──

function toggleSendState(sending) {
    sendBtn.textContent = sending ? 'Cancel' : 'Send';
    sendBtn.classList.toggle('cancelling', sending);
}

export async function programmaticSend() {
    return sendRequest();
}

export function clearResponse() {
    if (currentObjectUrl) {
        URL.revokeObjectURL(currentObjectUrl);
        currentObjectUrl = null;
    }
    responseStatusEl.textContent = 'Sending...';
    responseStatusEl.className = 'builder-response-status pending';
    responsePanels.bodyRaw.textContent = '';
    responsePanels.bodyPreview.textContent = '';
    responsePanels.bodyPreview.style.display = 'none';
    responsePanels.bodyRaw.style.display = '';
    // 重置切换按钮
    const toggle = responsePanels.body.querySelector('.response-mode-toggle');
    if (toggle) {
        toggle.querySelectorAll('.response-mode-btn').forEach((b) => {
            b.classList.toggle('active', b.dataset.mode === 'raw');
        });
    }
    responsePanels.headers.innerHTML = ''; // eslint-disable-line no-restricted-syntax
    responsePanels.sse.innerHTML = ''; // eslint-disable-line no-restricted-syntax
}

function showResponseStatus(status, statusText, elapsed) {
    const cls =
        status >= 200 && status < 300
            ? 'success'
            : status >= 400
              ? 'error'
              : status === 0
                ? 'error'
                : '';
    responseStatusEl.className = `builder-response-status ${cls}`;
    responseStatusEl.textContent = `${status} ${statusText}  ${elapsed}s`;
}

function updateResponseSize(bytes) {
    const sizeStr = bytes > 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`;
    responseStatusEl.textContent += `  ${sizeStr}`;
}

function showResponseBody(text) {
    try {
        const parsed = JSON.parse(text);
        responsePanels.bodyRaw.textContent = JSON.stringify(parsed, null, 2);
    } catch {
        responsePanels.bodyRaw.textContent = text;
    }
}

function showResponseHeaders(headers) {
    const frag = document.createDocumentFragment();
    headers.forEach((value, key) => {
        const row = document.createElement('div');
        row.className = 'builder-header-row';

        const keyEl = document.createElement('span');
        keyEl.className = 'builder-header-key';
        keyEl.textContent = key;

        const valEl = document.createElement('span');
        valEl.className = 'builder-header-val';
        valEl.textContent = value;

        row.appendChild(keyEl);
        row.appendChild(valEl);
        frag.appendChild(row);
    });
    responsePanels.headers.appendChild(frag);
}

function showResponseError(message, elapsed) {
    responseStatusEl.className = 'builder-response-status error';
    responseStatusEl.textContent = `Error  ${elapsed}s`;
    responsePanels.bodyRaw.textContent = message;
}

function appendSSELine(text) {
    const line = document.createElement('div');
    line.className = 'sse-chunk new';
    line.textContent = text;
    responsePanels.sse.appendChild(line);
    responsePanels.sse.scrollTop = responsePanels.sse.scrollHeight;
}

// ── Raw / Preview 切换 ──

function switchResponseMode(mode) {
    const toggle = responsePanels.body.querySelector('.response-mode-toggle');
    if (toggle) {
        toggle.querySelectorAll('.response-mode-btn').forEach((b) => {
            b.classList.toggle('active', b.dataset.mode === mode);
        });
    }
    responsePanels.bodyRaw.style.display = mode === 'raw' ? '' : 'none';
    responsePanels.bodyPreview.style.display = mode === 'preview' ? '' : 'none';
}

function isMediaType(ct) {
    return (
        ct.startsWith('image/') ||
        ct.startsWith('video/') ||
        ct.startsWith('audio/') ||
        ct === 'application/pdf'
    );
}

function formatSize(bytes) {
    if (bytes > 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
    if (bytes > 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${bytes} B`;
}

function renderMediaPreview(contentType, objectUrl, size) {
    const el = responsePanels.bodyPreview;
    el.textContent = '';

    if (contentType.startsWith('image/')) {
        const img = document.createElement('img');
        img.src = objectUrl;
        img.alt = 'Response image';
        el.appendChild(img);
    } else if (contentType.startsWith('video/')) {
        const video = document.createElement('video');
        video.src = objectUrl;
        video.controls = true;
        el.appendChild(video);
    } else if (contentType.startsWith('audio/')) {
        const audio = document.createElement('audio');
        audio.src = objectUrl;
        audio.controls = true;
        el.appendChild(audio);
    } else if (contentType === 'application/pdf') {
        const tip = document.createElement('div');
        tip.className = 'media-info';
        tip.textContent = 'PDF 文件，无法内联预览';
        el.appendChild(tip);
    }

    const info = document.createElement('div');
    info.className = 'media-info';
    info.textContent = `${contentType} | ${formatSize(size)}`;
    el.appendChild(info);
}

function renderTextPreview(contentType, text) {
    const el = responsePanels.bodyPreview;
    el.textContent = '';

    if (contentType.includes('application/json') || contentType.includes('+json')) {
        try {
            const parsed = JSON.parse(text);
            const formatted = JSON.stringify(parsed, null, 2);
            const pre = document.createElement('pre');
            pre.className = 'json-preview';
            pre.innerHTML = syntaxHighlightJson(formatted); // eslint-disable-line no-restricted-syntax
            el.appendChild(pre);
        } catch {
            el.textContent = text;
        }
    } else if (contentType.includes('text/html')) {
        const iframe = document.createElement('iframe');
        iframe.sandbox = 'allow-same-origin';
        iframe.className = 'html-preview-iframe';
        iframe.srcdoc = text;
        el.appendChild(iframe);
    } else {
        el.textContent = text;
    }
}

function syntaxHighlightJson(json) {
    const { escapeHtml } = window.__builderHelpers || {};
    const escape =
        escapeHtml || ((s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'));
    return escape(json)
        .replace(/("(?:\\.|[^"\\])*")\s*:/g, '<span class="json-key">$1</span>:')
        .replace(/:\s*("(?:\\.|[^"\\])*")/g, ': <span class="json-string">$1</span>')
        .replace(/:\s*(\d+\.?\d*)/g, ': <span class="json-number">$1</span>')
        .replace(/:\s*(true|false)/g, ': <span class="json-boolean">$1</span>')
        .replace(/:\s*(null)/g, ': <span class="json-null">$1</span>');
}

// ── 导入辅助 ──

function importHeaders(headersObj) {
    const table = configPanels.headers.querySelector('.builder-kv-table');
    table.innerHTML = ''; // eslint-disable-line no-restricted-syntax
    Object.entries(headersObj).forEach(([k, v]) => {
        addKVRow(table, k, v, { checkbox: true, checked: true });
    });
}

function importBody(body) {
    if (typeof body === 'string') {
        try {
            JSON.parse(body);
            switchBodyFormat('JSON', configPanels.body);
        } catch {
            switchBodyFormat('Text', configPanels.body);
        }
        const textarea = configPanels.body.querySelector('.builder-body-textarea');
        if (textarea) textarea.value = body;
    }
}
