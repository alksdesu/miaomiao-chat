/**
 * 会话搜索模块
 * 使用持久化搜索索引为所有会话提供统一的正文搜索来源。
 */

import { state } from '../core/state.js';
import { elements } from '../core/elements.js';
import { eventBus } from '../core/events.js';
import { escapeHtml } from '../utils/helpers.js';
import {
    loadAllSessionSearchIndexes,
    loadSessionMessages,
    saveSessionSearchIndex
} from '../state/storage.js';
import {
    buildSessionSearchIndex,
    buildSessionSearchIndexAsync,
    isSessionSearchIndexUsable
} from '../state/session-search-index.js';
import { logger } from '../utils/logger.js';
import { hasLazyMessages } from '../state/session-message-repository.js';

const SEARCH_DEBOUNCE_DELAY = 300;
const SEARCH_REFRESH_DELAY = 120;
const SEARCH_PREVIEW_LIMIT = 3;
const searchIndexStore = new Map();
const indexBuildFailureIds = new Set();

const searchState = {
    query: '',
    isActive: false,
    results: null,
    indexing: {
        totalCount: 0,
        pendingCount: 0,
        failedCount: 0,
        isRunning: false,
        error: ''
    }
};

let _initialized = false;
let searchDebounceTimer = null;
let searchRefreshTimer = null;
let indexBackfillRunning = false;
let indexBackfillRestartRequested = false;

export function initSessionSearch() {
    if (_initialized) {
        return;
    }

    _initialized = true;
    bindSearchEvents();
    bindSearchStateEvents();
    syncCurrentSessionSearchIndex();
    void hydratePersistedSearchIndexes();
    updateSearchHint();
    logger.debug('Session Search initialized');
}

function bindSearchEvents() {
    elements.sessionSearchInput?.addEventListener('input', (event) => {
        const rawQuery = event.target.value;
        updateClearButtonVisibility(rawQuery);
        scheduleSearch(rawQuery);
    });

    elements.sessionSearchClear?.addEventListener('click', clearSearch);

    elements.sessionSearchInput?.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            clearSearch();
        }
    });
}

function bindSearchStateEvents() {
    eventBus.on('sessions:loaded', () => {
        pruneSearchIndexes();
        void hydratePersistedSearchIndexes();
    });

    eventBus.on('sessions:updated', () => {
        pruneSearchIndexes();
        syncCurrentSessionSearchIndex();
        scheduleSearchIndexBackfill();

        if (searchState.isActive) {
            scheduleActiveSearchRefresh();
        } else {
            refreshIndexingState();
        }
    });

    eventBus.on('session:before-switch', () => {
        syncCurrentSessionSearchIndex();
    });

    eventBus.on('session:switched', () => {
        syncCurrentSessionSearchIndex();
        scheduleSearchIndexBackfill();

        if (searchState.isActive) {
            scheduleActiveSearchRefresh();
        } else {
            refreshIndexingState();
        }
    });

    eventBus.on('messages:changed', () => {
        syncCurrentSessionSearchIndex();
        if (searchState.isActive) {
            scheduleActiveSearchRefresh();
        }
    });

    eventBus.on('state:messages-replaced', () => {
        syncCurrentSessionSearchIndex();
        if (searchState.isActive) {
            scheduleActiveSearchRefresh();
        }
    });

    eventBus.on('session-search:index-updated', ({ sessionId, searchIndex }) => {
        if (!sessionId || !searchIndex) {
            return;
        }

        searchIndexStore.set(sessionId, searchIndex);
        indexBuildFailureIds.delete(sessionId);

        if (searchState.isActive) {
            scheduleActiveSearchRefresh();
        } else {
            refreshIndexingState();
        }
    });
}

function normalizeQuery(query) {
    return typeof query === 'string' ? query.trim() : '';
}

function clearPendingSearchTimers() {
    if (searchDebounceTimer) {
        clearTimeout(searchDebounceTimer);
        searchDebounceTimer = null;
    }

    if (searchRefreshTimer) {
        clearTimeout(searchRefreshTimer);
        searchRefreshTimer = null;
    }
}

function scheduleSearch(rawQuery) {
    clearPendingSearchTimers();

    const normalizedQuery = normalizeQuery(rawQuery);
    if (!normalizedQuery) {
        setSearchInactive();
        return;
    }

    searchDebounceTimer = setTimeout(() => {
        performSearch(normalizedQuery);
    }, SEARCH_DEBOUNCE_DELAY);
}

function scheduleActiveSearchRefresh() {
    if (!searchState.isActive) {
        return;
    }

    if (searchRefreshTimer) {
        clearTimeout(searchRefreshTimer);
    }

    searchRefreshTimer = setTimeout(() => {
        performSearch(searchState.query);
    }, SEARCH_REFRESH_DELAY);
}

function updateClearButtonVisibility(rawQuery) {
    if (!elements.sessionSearchClear) {
        return;
    }

    elements.sessionSearchClear.style.display = rawQuery ? 'block' : 'none';
}

function setSearchInactive() {
    searchState.query = '';
    searchState.isActive = false;
    searchState.results = null;
    emitSearchStateChange();
}

function clearSearch() {
    clearPendingSearchTimers();

    if (elements.sessionSearchInput) {
        elements.sessionSearchInput.value = '';
    }

    updateClearButtonVisibility('');
    setSearchInactive();
}

function performSearch(query) {
    const normalizedQuery = normalizeQuery(query);
    if (!normalizedQuery) {
        setSearchInactive();
        return;
    }

    searchState.query = normalizedQuery;
    searchState.isActive = true;
    searchState.results = searchSessions(normalizedQuery);
    emitSearchStateChange();
}

function emitSearchStateChange() {
    updateSearchHint();
    eventBus.emit('sessions:search-state-changed', getSessionSearchState());
}

function getSearchHintElement() {
    let hint = document.getElementById('session-search-hint');
    if (hint) {
        return hint;
    }

    hint = document.createElement('div');
    hint.id = 'session-search-hint';
    hint.className = 'session-search-hint';
    hint.setAttribute('role', 'status');
    hint.setAttribute('aria-live', 'polite');

    const searchBar = elements.sessionSearchInput?.parentElement;
    if (searchBar) {
        searchBar.after(hint);
    }

    return hint;
}

function buildSearchHintText() {
    const hintParts = [];

    if (searchState.isActive) {
        const resultCount = Array.isArray(searchState.results) ? searchState.results.length : 0;
        hintParts.push(`找到 ${resultCount} / ${state.sessions.length} 个会话`);
    }

    if (searchState.indexing.isRunning && searchState.indexing.totalCount > 0) {
        const completedCount = Math.max(
            0,
            searchState.indexing.totalCount - searchState.indexing.pendingCount
        );
        hintParts.push(`正在建立搜索索引（${completedCount}/${searchState.indexing.totalCount}）`);
    } else if (!searchState.isActive && searchState.indexing.pendingCount > 0) {
        hintParts.push(`待建立搜索索引 ${searchState.indexing.pendingCount} 个会话`);
    }

    if (searchState.indexing.failedCount > 0) {
        hintParts.push(searchState.indexing.error || '部分会话索引建立失败，搜索结果可能不完整');
    }

    return hintParts.join(' · ');
}

function updateSearchHint() {
    const hintText = buildSearchHintText();
    const hint = document.getElementById('session-search-hint');

    if (!hintText) {
        if (hint) {
            hint.style.display = 'none';
        }
        return;
    }

    const targetHint = hint || getSearchHintElement();
    if (!targetHint) {
        return;
    }

    targetHint.textContent = hintText;
    targetHint.style.display = 'block';
}

async function hydratePersistedSearchIndexes() {
    try {
        const records = await loadAllSessionSearchIndexes();
        searchIndexStore.clear();

        records.forEach((record) => {
            if (record?.sessionId) {
                searchIndexStore.set(record.sessionId, record);
            }
        });

        pruneSearchIndexes();
        syncCurrentSessionSearchIndex();
        scheduleSearchIndexBackfill();

        if (searchState.isActive) {
            scheduleActiveSearchRefresh();
        } else {
            refreshIndexingState();
        }
    } catch (error) {
        logger.error('[SessionSearch] 加载会话搜索索引失败:', error);
        searchState.indexing.error = '加载会话搜索索引失败';
        scheduleSearchIndexBackfill();
        emitSearchStateChange();
    }
}

function pruneSearchIndexes() {
    const activeSessionIds = new Set(state.sessions.map((session) => session.id));

    for (const sessionId of searchIndexStore.keys()) {
        if (!activeSessionIds.has(sessionId)) {
            searchIndexStore.delete(sessionId);
        }
    }

    for (const sessionId of indexBuildFailureIds) {
        if (!activeSessionIds.has(sessionId)) {
            indexBuildFailureIds.delete(sessionId);
        }
    }
}

function getMissingSearchIndexSessions() {
    return state.sessions.filter((session) => {
        if (!session?.id) {
            return false;
        }

        if (indexBuildFailureIds.has(session.id)) {
            return false;
        }

        const expectedMessageCount = Number.isFinite(session.messageCount)
            ? session.messageCount
            : null;
        const storedIndex = searchIndexStore.get(session.id);
        return !isSessionSearchIndexUsable(storedIndex, expectedMessageCount);
    });
}

function getIndexingErrorText() {
    const failedCount = indexBuildFailureIds.size;
    if (failedCount === 0) {
        return '';
    }

    return `${failedCount} 个会话索引建立失败，搜索结果可能不完整`;
}

function refreshIndexingState() {
    const pendingCount = getMissingSearchIndexSessions().length;

    searchState.indexing.pendingCount = pendingCount;
    searchState.indexing.failedCount = indexBuildFailureIds.size;
    searchState.indexing.error = getIndexingErrorText() || searchState.indexing.error;

    if (!searchState.indexing.isRunning) {
        searchState.indexing.totalCount = pendingCount;
    }

    if (searchState.indexing.failedCount === 0) {
        searchState.indexing.error = '';
    }

    emitSearchStateChange();
}

function scheduleSearchIndexBackfill() {
    if (indexBackfillRunning) {
        indexBackfillRestartRequested = true;
        return;
    }

    void backfillMissingSearchIndexes();
}

async function backfillMissingSearchIndexes() {
    indexBackfillRunning = true;
    searchState.indexing.error = getIndexingErrorText();

    try {
        do {
            indexBackfillRestartRequested = false;
            const missingSessions = getMissingSearchIndexSessions();

            if (missingSessions.length === 0) {
                searchState.indexing.isRunning = false;
                searchState.indexing.totalCount = 0;
                searchState.indexing.pendingCount = 0;
                searchState.indexing.failedCount = indexBuildFailureIds.size;
                searchState.indexing.error = getIndexingErrorText();
                emitSearchStateChange();
                continue;
            }

            searchState.indexing.isRunning = true;
            searchState.indexing.totalCount = missingSessions.length;
            searchState.indexing.pendingCount = missingSessions.length;
            searchState.indexing.failedCount = indexBuildFailureIds.size;
            searchState.indexing.error = getIndexingErrorText();
            emitSearchStateChange();

            for (const session of missingSessions) {
                if (indexBackfillRestartRequested) {
                    break;
                }

                try {
                    await buildAndPersistSessionSearchIndex(session);
                } catch (error) {
                    logger.error(`[SessionSearch] 建立会话 ${session.id} 搜索索引失败:`, error);
                    indexBuildFailureIds.add(session.id);
                }

                searchState.indexing.pendingCount = getMissingSearchIndexSessions().length;
                searchState.indexing.failedCount = indexBuildFailureIds.size;
                searchState.indexing.error = getIndexingErrorText();
                emitSearchStateChange();
                await yieldToMainThread();
            }
        } while (indexBackfillRestartRequested);
    } finally {
        indexBackfillRunning = false;
        searchState.indexing.isRunning = false;
        searchState.indexing.pendingCount = getMissingSearchIndexSessions().length;
        searchState.indexing.totalCount = searchState.indexing.pendingCount;
        searchState.indexing.failedCount = indexBuildFailureIds.size;
        searchState.indexing.error = getIndexingErrorText();
        emitSearchStateChange();
    }
}

async function buildAndPersistSessionSearchIndex(session) {
    if (!session?.id || !state.sessions.some((item) => item.id === session.id)) {
        return;
    }

    let messages = [];

    if (session.id === state.currentSessionId) {
        if (hasLazyMessages()) {
            const storedMessages = await loadSessionMessages(session.id);
            messages = storedMessages?.messages || [];
        } else {
            messages = state.messages;
        }
    } else {
        const storedMessages = await loadSessionMessages(session.id);
        if (storedMessages?.messages) {
            messages = storedMessages.messages;
        } else if (Array.isArray(session._pendingMessages)) {
            messages = session._pendingMessages;
        } else if ((session.messageCount || 0) > 0) {
            throw new Error('会话元数据存在消息计数，但找不到对应消息数据');
        }
    }

    const searchIndex = await buildSessionSearchIndexAsync(messages);
    searchIndexStore.set(session.id, {
        sessionId: session.id,
        ...searchIndex
    });
    indexBuildFailureIds.delete(session.id);

    if (session.id === state.currentSessionId && state.sessionDirty) {
        return;
    }

    await saveSessionSearchIndex(session.id, searchIndex);
}

function yieldToMainThread() {
    return new Promise((resolve) => {
        requestIdleCallback(() => resolve(), { timeout: 50 });
    });
}

function syncCurrentSessionSearchIndex() {
    if (!state.currentSessionId) {
        return null;
    }

    const currentSession = state.sessions.find((session) => session.id === state.currentSessionId);
    if (!currentSession) {
        return null;
    }

    if (hasLazyMessages()) {
        return searchIndexStore.get(state.currentSessionId) || null;
    }

    const searchIndex = buildSessionSearchIndex(state.messages);
    searchIndexStore.set(state.currentSessionId, {
        sessionId: state.currentSessionId,
        ...searchIndex
    });
    indexBuildFailureIds.delete(state.currentSessionId);
    return searchIndex;
}

function buildPreviewText(text, lowerQuery) {
    const lowerText = text.toLowerCase();
    const matchIndex = lowerText.indexOf(lowerQuery);
    const contextStart = Math.max(0, matchIndex - 50);
    const contextEnd = Math.min(text.length, matchIndex + lowerQuery.length + 50);

    let preview = text.slice(contextStart, contextEnd);
    if (contextStart > 0) {
        preview = `...${preview}`;
    }
    if (contextEnd < text.length) {
        preview = `${preview}...`;
    }

    return preview;
}

export function searchSessions(query) {
    const normalizedQuery = normalizeQuery(query);
    if (!normalizedQuery) {
        return [];
    }

    const lowerQuery = normalizedQuery.toLowerCase();
    const results = [];

    for (const session of state.sessions) {
        let matchCount = 0;
        let matchedInName = false;
        const matchedMessages = [];

        if (session.name && session.name.toLowerCase().includes(lowerQuery)) {
            matchCount += 10;
            matchedInName = true;
        }

        const searchIndex = searchIndexStore.get(session.id);
        const entries = Array.isArray(searchIndex?.entries) ? searchIndex.entries : [];

        for (const entry of entries) {
            const text = entry.text || '';
            const lowerText = text.toLowerCase();
            if (!lowerText.includes(lowerQuery)) {
                continue;
            }

            matchCount += 1;
            if (matchedMessages.length < SEARCH_PREVIEW_LIMIT) {
                matchedMessages.push({
                    index: entry.index,
                    messageId: entry.id || `msg_${entry.index}`,
                    role: entry.role || 'unknown',
                    preview: buildPreviewText(text, lowerQuery),
                    fullText: text
                });
            }
        }

        if (matchCount > 0) {
            results.push({
                session,
                matchCount,
                matchedInName,
                matchedMessages
            });
        }
    }

    results.sort((left, right) => {
        if (left.matchedInName && !right.matchedInName) return -1;
        if (!left.matchedInName && right.matchedInName) return 1;
        if (right.matchCount !== left.matchCount) return right.matchCount - left.matchCount;
        return (right.session.updatedAt || 0) - (left.session.updatedAt || 0);
    });

    return results;
}

export function highlightMatch(text, query) {
    if (!query || !text) return escapeHtml(text);

    const escapedText = escapeHtml(text);
    const escapedQuery = escapeHtml(query).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`(${escapedQuery})`, 'gi');
    return escapedText.replace(regex, '<mark>$1</mark>');
}

export function getSessionSearchState() {
    return {
        query: searchState.query,
        isActive: searchState.isActive,
        results: searchState.results,
        indexing: {
            totalCount: searchState.indexing.totalCount,
            pendingCount: searchState.indexing.pendingCount,
            failedCount: searchState.indexing.failedCount,
            isRunning: searchState.indexing.isRunning,
            error: searchState.indexing.error
        }
    };
}

export function getCurrentQuery() {
    return searchState.query;
}
