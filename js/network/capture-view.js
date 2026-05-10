/**
 * 抓包视图：请求列表 + 详情
 */

import { getRecords, subscribe, sanitizeHeaderValue } from './store.js';
import { eventBus } from '../core/events.js';
import { escapeHtml } from '../utils/helpers.js';

let container = null;
let listEl = null;
let detailEl = null;
let selectedId = null;
let activeDetailTab = 'headers';
let unsubscribe = null;

export function renderCaptureView(target) {
    container = target;

    const view = document.createElement('div');
    view.className = 'capture-view';

    listEl = document.createElement('div');
    listEl.className = 'capture-list';

    detailEl = document.createElement('div');
    detailEl.className = 'capture-detail';

    view.appendChild(listEl);
    view.appendChild(detailEl);
    container.appendChild(view);

    renderEmptyDetail();
    updateCaptureList();

    if (unsubscribe) unsubscribe();
    unsubscribe = subscribe(() => {
        incrementalUpdateList();
        if (selectedId) incrementalUpdateDetail(selectedId);
    });
}

// 增量更新列表：基于 record.id 匹配，处理淘汰和新增
function incrementalUpdateList() {
    if (!listEl) return;
    const records = getRecords();

    // 清空提示
    const empty = listEl.querySelector('.capture-empty');
    if (records.length > 0 && empty) empty.remove();

    // 构建现有行的 id→DOM 映射
    const existingRows = listEl.querySelectorAll('.capture-row');
    const rowById = new Map();
    existingRows.forEach((row) => {
        const id = parseInt(row.dataset.recordId, 10);
        if (!isNaN(id)) rowById.set(id, row);
    });

    // 记录当前 records 的 id 集合
    const currentIds = new Set(records.map((r) => r.id));

    // 删除不在 records 中的旧行（被 shift 淘汰的）
    for (const [id, row] of rowById) {
        if (!currentIds.has(id)) {
            row.remove();
            rowById.delete(id);
            if (selectedId === id) selectedId = null;
        }
    }

    // 更新已有行 + 追加新行
    for (const record of records) {
        const existing = rowById.get(record.id);
        if (existing) {
            const dot = existing.querySelector('.status-dot');
            if (dot) dot.className = 'status-dot ' + getStatusClass(record);
            const status = existing.querySelector('.capture-status');
            if (status) status.textContent = record.status ?? '...';
            const time = existing.querySelector('.capture-time');
            if (time)
                time.textContent = record.duration ? Math.round(record.duration) + 'ms' : '...';
        } else {
            listEl.appendChild(buildRow(record));
        }
    }

    if (records.length === 0 && !listEl.querySelector('.capture-empty')) {
        const emptyEl = document.createElement('div');
        emptyEl.className = 'capture-empty';
        emptyEl.textContent = '暂无请求记录';
        listEl.appendChild(emptyEl);
    }
}

// 增量更新详情：SSE tab 只追加新 chunk，不全量重建
function incrementalUpdateDetail(recordId) {
    const records = getRecords();
    const record = records.find((r) => r.id === recordId);
    if (!record || !detailEl) return;

    // 只在 SSE tab 时做增量追加
    if (activeDetailTab === 'sse') {
        const contentEl = detailEl.querySelector('.detail-tab-content');
        if (!contentEl) return;
        const existingCount = contentEl.querySelectorAll('.sse-chunk').length;
        if (record.sseChunks.length > existingCount) {
            for (let i = existingCount; i < record.sseChunks.length; i++) {
                const line = document.createElement('div');
                line.className = 'sse-chunk';
                line.textContent = record.sseChunks[i];
                contentEl.appendChild(line);
            }
            requestAnimationFrame(() => {
                contentEl.scrollTop = contentEl.scrollHeight;
            });
        }
        // 流结束标记
        if (record.state === 'done' && !contentEl.querySelector('.sse-done-marker')) {
            const marker = document.createElement('div');
            marker.className = 'sse-done-marker';
            marker.textContent = `-- Stream ended (${record.sseChunks.length} events) --`;
            contentEl.appendChild(marker);
        }
        return;
    }

    // 其他 tab 更新状态相关信息（不全量重建）
    const statusDot = detailEl.querySelector('.status-dot');
    if (statusDot) statusDot.className = 'status-dot ' + getStatusClass(record);
}

export function updateCaptureList() {
    if (!listEl) return;
    const records = getRecords();

    listEl.textContent = '';

    if (records.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'capture-empty';
        empty.textContent = '暂无请求记录';
        listEl.appendChild(empty);
        return;
    }

    for (const record of records) {
        listEl.appendChild(buildRow(record));
    }
}

function buildRow(record) {
    const row = document.createElement('div');
    row.className =
        'capture-row' +
        (record.state === 'error' ? ' error' : '') +
        (record.id === selectedId ? ' selected' : '');
    row.dataset.recordId = record.id;

    const dot = document.createElement('span');
    dot.className = 'status-dot ' + getStatusClass(record);
    row.appendChild(dot);

    const method = document.createElement('span');
    method.className = 'capture-method';
    method.textContent = record.method;
    row.appendChild(method);

    const url = document.createElement('span');
    url.className = 'capture-url';
    url.textContent = truncateUrl(record.url);
    url.title = record.url;
    row.appendChild(url);

    const status = document.createElement('span');
    status.className = 'capture-status';
    status.textContent = record.status ?? '…';
    row.appendChild(status);

    const time = document.createElement('span');
    time.className = 'capture-time';
    time.textContent = record.duration ? Math.round(record.duration) + 'ms' : '…';
    row.appendChild(time);

    const replay = document.createElement('button');
    replay.className = 'capture-replay-btn';
    // eslint-disable-next-line no-restricted-syntax -- 静态 SVG
    replay.innerHTML =
        '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>';
    replay.title = '导入请求构建器';
    replay.addEventListener('click', (e) => {
        e.stopPropagation();
        eventBus.emit('network:replay-request', record);
    });
    row.appendChild(replay);

    row.addEventListener('click', () => showCaptureDetail(record.id));
    return row;
}

export function showCaptureDetail(recordId) {
    selectedId = recordId;
    const records = getRecords();
    const record = records.find((r) => r.id === recordId);

    if (!record || !detailEl) {
        renderEmptyDetail();
        return;
    }

    // 移动端显示详情
    detailEl.classList.add('mobile-active');

    // 高亮选中行
    if (listEl) {
        listEl.querySelectorAll('.capture-row').forEach((row, i) => {
            row.classList.toggle('selected', records[i]?.id === recordId);
        });
    }

    detailEl.textContent = '';

    // 移动端返回按钮
    const backBtn = document.createElement('button');
    backBtn.className = 'mobile-back-btn';
    backBtn.textContent = '← 返回';
    backBtn.addEventListener('click', () => {
        detailEl.classList.remove('mobile-active');
        selectedId = null;
        if (listEl)
            listEl
                .querySelectorAll('.capture-row.selected')
                .forEach((r) => r.classList.remove('selected'));
    });
    detailEl.appendChild(backBtn);

    // sub-tabs
    const tabBar = document.createElement('div');
    tabBar.className = 'detail-tabs';

    const tabNames = [
        ['headers', 'Headers'],
        ['request', 'Request'],
        ['response', 'Response'],
        ['sse', 'SSE Stream']
    ];

    for (const [id, label] of tabNames) {
        const tab = document.createElement('button');
        tab.className = 'detail-tab' + (id === activeDetailTab ? ' active' : '');
        tab.textContent = label;
        tab.addEventListener('click', () => {
            activeDetailTab = id;
            showCaptureDetail(recordId);
        });
        tabBar.appendChild(tab);
    }
    detailEl.appendChild(tabBar);

    // 内容
    const contentEl = document.createElement('div');
    contentEl.className = 'detail-tab-content';

    switch (activeDetailTab) {
        case 'headers':
            renderHeaders(contentEl, record);
            break;
        case 'request':
            renderRequestBody(contentEl, record);
            break;
        case 'response':
            renderResponseBody(contentEl, record);
            break;
        case 'sse':
            renderSSEStream(contentEl, record);
            break;
    }

    detailEl.appendChild(contentEl);
}

function renderEmptyDetail() {
    if (!detailEl) return;
    detailEl.textContent = '';
    const hint = document.createElement('div');
    hint.className = 'capture-empty';
    hint.textContent = '选择一条请求查看详情';
    detailEl.appendChild(hint);
}

function renderHeaders(el, record) {
    // Request Headers
    const reqTitle = document.createElement('div');
    reqTitle.className = 'header-section-title';
    reqTitle.textContent = 'Request Headers';
    el.appendChild(reqTitle);
    appendHeaderTable(el, record.requestHeaders);

    // Response Headers
    const resTitle = document.createElement('div');
    resTitle.className = 'header-section-title';
    resTitle.textContent = 'Response Headers';
    el.appendChild(resTitle);
    appendHeaderTable(el, record.responseHeaders);
}

function appendHeaderTable(parent, headers) {
    if (!headers || Object.keys(headers).length === 0) {
        const empty = document.createElement('div');
        empty.className = 'header-empty';
        empty.textContent = '(无)';
        parent.appendChild(empty);
        return;
    }

    const table = document.createElement('div');
    table.className = 'header-table';

    for (const [key, value] of Object.entries(headers)) {
        const row = document.createElement('div');
        row.className = 'header-kv-row';

        const keyEl = document.createElement('span');
        keyEl.className = 'header-key';
        keyEl.textContent = key;

        const valEl = document.createElement('span');
        valEl.className = 'header-value';
        valEl.textContent = sanitizeHeaderValue(key, String(value));

        row.appendChild(keyEl);
        row.appendChild(valEl);
        table.appendChild(row);
    }

    parent.appendChild(table);
}

function renderRequestBody(el, record) {
    const body = record.requestBody;
    if (!body) {
        el.textContent = '(无请求体)';
        return;
    }
    try {
        const parsed = typeof body === 'string' ? JSON.parse(body) : body;
        el.textContent = JSON.stringify(parsed, null, 2);
    } catch {
        el.textContent = typeof body === 'string' ? body : String(body);
    }
}

function renderResponseBody(el, record) {
    if (record.isStream) {
        el.textContent = '(流式响应，请查看 SSE Stream 标签)';
        return;
    }
    const body = record.responseBody;
    if (!body) {
        el.textContent = record.state === 'pending' ? '(等待响应中…)' : '(无响应体)';
        return;
    }
    try {
        const parsed = typeof body === 'string' ? JSON.parse(body) : body;
        const jsonStr = JSON.stringify(parsed, null, 2);
        renderHighlightedJSON(el, jsonStr);
    } catch {
        el.textContent = typeof body === 'string' ? body : String(body);
    }
}

function renderHighlightedJSON(container, jsonStr) {
    const escaped = escapeHtml(jsonStr);
    const highlighted = escaped
        .replace(/"([^"]*)"(?=\s*:)/g, '<span class="json-key">"$1"</span>')
        .replace(/:\s*"([^"]*?)"/g, ': <span class="json-string">"$1"</span>')
        .replace(/:\s*(-?\d+\.?\d*(?:[eE][+-]?\d+)?)/g, ': <span class="json-number">$1</span>')
        .replace(/:\s*(true|false|null)\b/g, ': <span class="json-boolean">$1</span>');
    const pre = document.createElement('pre');
    pre.className = 'json-highlighted';
    // eslint-disable-next-line no-restricted-syntax -- 已审计：escapeHtml 后的静态正则替换，无注入风险
    pre.innerHTML = highlighted;
    container.appendChild(pre);
}

function renderSSEStream(el, record) {
    if (!record.sseChunks || record.sseChunks.length === 0) {
        el.textContent =
            record.isStream && record.state === 'pending' ? '(等待 SSE 数据…)' : '(无 SSE 数据)';
        return;
    }

    for (const chunk of record.sseChunks) {
        const line = document.createElement('div');
        line.className = 'sse-chunk';
        line.textContent = chunk;
        el.appendChild(line);
    }

    // 自动滚动到底部
    requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight;
    });
}

function getStatusClass(record) {
    if (record.state === 'pending' || record.state === 'streaming') return 'pending';
    if (record.state === 'error' || (record.status && record.status >= 400)) return 'error';
    return 'success';
}

function truncateUrl(url) {
    try {
        const u = new URL(url);
        const path = u.pathname.length > 30 ? u.pathname.slice(0, 27) + '…' : u.pathname;
        return u.host + path;
    } catch {
        return url.length > 40 ? url.slice(0, 37) + '…' : url;
    }
}
