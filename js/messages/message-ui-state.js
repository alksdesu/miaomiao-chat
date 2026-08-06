import { state } from '../core/state.js';
import { eventBus } from '../core/events.js';
import { EVENTS } from '../core/events-registry.js';

const messageUiStates = new Map();

function createDefaultState() {
    return {
        thinkingExpanded: [],
        selectedReply: null,
        editing: false,
        codeBlocksExpanded: [],
        toolCardsExpanded: [],
        mediaPlayback: null,
        measuredHeight: 0,
        pinned: false
    };
}

export function getMessageUiState(messageId) {
    if (!messageId) return createDefaultState();
    if (!messageUiStates.has(messageId)) {
        messageUiStates.set(messageId, createDefaultState());
    }
    return messageUiStates.get(messageId);
}

export function peekMessageUiState(messageId) {
    return messageUiStates.get(messageId) || null;
}

export function updateMessageUiState(messageId, patch) {
    if (!messageId || !patch || typeof patch !== 'object') return null;
    const next = { ...getMessageUiState(messageId), ...patch };
    messageUiStates.set(messageId, next);
    return next;
}

export function removeMessageUiState(messageId) {
    return messageUiStates.delete(messageId);
}

export function retainMessageUiStates(messageIds) {
    const retained = new Set(messageIds);
    for (const messageId of messageUiStates.keys()) {
        if (!retained.has(messageId)) messageUiStates.delete(messageId);
    }
}

export function clearMessageUiStates() {
    messageUiStates.clear();
}

export function getMessageUiStateCount() {
    return messageUiStates.size;
}

eventBus.on(EVENTS.STATE_MESSAGES_REPLACED, () => {
    retainMessageUiStates(state.messages.map((message) => message.id).filter(Boolean));
});
