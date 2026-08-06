import { state } from '../core/state.js';
import { eventBus } from '../core/events.js';
import { EVENTS } from '../core/events-registry.js';
import {
    loadAllPagedSessionMessages,
    loadMessageManifest,
    loadSessionMessageRange
} from './message-page-repository.js';

const DEFAULT_TAIL_COUNT = 300;
const WINDOW_THRESHOLD = 500;

function createLazyMessage(sessionId, summary, index) {
    return {
        id: summary?.id || `lazy-${sessionId}-${index}`,
        role: summary?.role || 'assistant',
        ts: summary?.ts || null,
        parts: [],
        meta: {
            model: summary?.model || null,
            provider: summary?.provider || null,
            lazy: true
        },
        error: summary?.isError ? { type: 'stored', message: '' } : null,
        _lazy: { sessionId, index }
    };
}

export function isLazyMessage(message) {
    return Boolean(message?._lazy?.sessionId && Number.isInteger(message?._lazy?.index));
}

export function hasLazyMessages(messages = state.messages) {
    return Array.isArray(messages) && messages.some(isLazyMessage);
}

export async function loadSessionMessageWindow(sessionId, { tailCount = DEFAULT_TAIL_COUNT } = {}) {
    const manifest = await loadMessageManifest(sessionId);
    if (!manifest || manifest.state !== 'complete' || !Array.isArray(manifest.summaries)) {
        return null;
    }
    if (manifest.messageCount <= WINDOW_THRESHOLD) {
        const all = await loadAllPagedSessionMessages(sessionId);
        return all ? { messages: all.messages, manifest, windowed: false } : null;
    }

    const start = Math.max(0, manifest.messageCount - tailCount);
    const tail = await loadSessionMessageRange(sessionId, start, manifest.messageCount);
    if (!tail) return null;
    const messages = manifest.summaries
        .slice(0, start)
        .map((summary, index) => createLazyMessage(sessionId, summary, index));
    messages.push(...tail.messages);
    return {
        messages,
        manifest,
        windowed: true,
        loadedRange: { start, end: manifest.messageCount }
    };
}

export async function loadStoredMessageAt(sessionId, index) {
    const result = await loadSessionMessageRange(sessionId, index, index + 1);
    return result?.messages?.[0] || null;
}

export async function materializeSessionMessages(sessionId, currentMessages = state.messages) {
    if (!hasLazyMessages(currentMessages)) return currentMessages;
    const stored = await loadAllPagedSessionMessages(sessionId);
    if (!stored) return currentMessages;

    const merged = stored.messages.map((storedMessage, index) => {
        const current = currentMessages[index];
        return current && !isLazyMessage(current) ? current : storedMessage;
    });
    if (currentMessages.length > stored.manifest.messageCount) {
        merged.push(...currentMessages.slice(stored.manifest.messageCount));
    }
    return merged;
}

export async function materializeCurrentSessionMessages() {
    const sessionId = state.currentSessionId;
    const messageWindow = state.messageStore?.toArray?.() || [...(state.messages || [])];
    if (!sessionId || !hasLazyMessages(messageWindow)) return state.messages;
    const messages = await materializeSessionMessages(sessionId, messageWindow);
    if (state.currentSessionId !== sessionId) return state.messages;
    if (messages === messageWindow) return state.messages;
    state.messageStore.replaceAll(messages);
    eventBus.emit(EVENTS.STATE_MESSAGES_REPLACED, {
        newLength: messages.length,
        materialized: true
    });
    return state.messages;
}

export async function getCurrentSessionMessagesSnapshot() {
    const sessionId = state.currentSessionId;
    const messageWindow = state.messageStore?.toArray?.() || [...(state.messages || [])];
    if (!sessionId || !hasLazyMessages(messageWindow)) return messageWindow;
    return materializeSessionMessages(sessionId, messageWindow);
}
