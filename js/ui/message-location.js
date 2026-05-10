/**
 * 共享消息定位能力
 * 统一处理普通渲染与虚拟滚动下的消息滚动、等待渲染与高亮反馈。
 */

import { state, elements } from '../core/state.js';
import { scrollToMessage } from './virtual-scroll.js';

const DEFAULT_HIGHLIGHT_CLASS = 'search-highlighted';
const DEFAULT_HIGHLIGHT_DURATION = 3000;
const DEFAULT_MAX_ATTEMPTS = 40;
const highlightTimerMap = new WeakMap();

function clearExistingHighlights(highlightClass) {
    if (!elements.messagesArea) {
        return;
    }

    elements.messagesArea.querySelectorAll(`.message.${highlightClass}`).forEach((messageEl) => {
        messageEl.classList.remove(highlightClass);
    });
}

function applyHighlight(messageEl, highlightClass, duration) {
    if (!messageEl) {
        return;
    }

    const previousTimer = highlightTimerMap.get(messageEl);
    if (previousTimer) {
        clearTimeout(previousTimer);
    }

    clearExistingHighlights(highlightClass);
    messageEl.classList.add(highlightClass);

    const timerId = setTimeout(() => {
        if (messageEl.isConnected) {
            messageEl.classList.remove(highlightClass);
        }
        highlightTimerMap.delete(messageEl);
    }, duration);

    highlightTimerMap.set(messageEl, timerId);
}

function findMessageElement(index) {
    if (!elements.messagesArea || !Number.isInteger(index) || index < 0) {
        return null;
    }

    return elements.messagesArea.querySelector(`.message[data-message-index="${index}"]`);
}

function waitForMessageElement(index, maxAttempts = DEFAULT_MAX_ATTEMPTS) {
    return new Promise((resolve) => {
        let attempts = 0;

        const check = () => {
            const messageEl = findMessageElement(index);
            if (messageEl) {
                resolve(messageEl);
                return;
            }

            attempts += 1;
            if (attempts >= maxAttempts) {
                resolve(null);
                return;
            }

            requestAnimationFrame(check);
        };

        check();
    });
}

export function resolveMessageIndex({ messageId = '', fallbackIndex = -1 } = {}) {
    if (messageId && state.messageIdMap?.has(messageId)) {
        const resolvedIndex = state.messageIdMap.get(messageId);
        if (Number.isInteger(resolvedIndex)) {
            return resolvedIndex;
        }
    }

    if (Number.isInteger(fallbackIndex)) {
        return fallbackIndex;
    }

    return -1;
}

export async function locateMessageByReference(
    { messageId = '', fallbackIndex = -1 } = {},
    {
        behavior = 'smooth',
        highlightClass = DEFAULT_HIGHLIGHT_CLASS,
        highlightDuration = DEFAULT_HIGHLIGHT_DURATION,
        maxAttempts = DEFAULT_MAX_ATTEMPTS
    } = {}
) {
    if (!elements.messagesArea) {
        return false;
    }

    const messageIndex = resolveMessageIndex({ messageId, fallbackIndex });
    if (
        !Number.isInteger(messageIndex) ||
        messageIndex < 0 ||
        messageIndex >= state.messages.length
    ) {
        return false;
    }

    scrollToMessage(messageIndex, behavior);

    const messageEl = await waitForMessageElement(messageIndex, maxAttempts);
    if (!messageEl) {
        return false;
    }

    messageEl.scrollIntoView({
        behavior,
        block: 'center'
    });

    applyHighlight(messageEl, highlightClass, highlightDuration);
    return true;
}
