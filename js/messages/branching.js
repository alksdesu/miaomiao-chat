import { state } from '../core/state.js';
import { eventBus } from '../core/events.js';
import { requestTaskRegistry } from '../core/request-task-registry.js';
import {
    createNewSession,
    saveCurrentSessionMessages,
    switchToSession
} from '../state/sessions.js';
import { materializeCurrentSessionMessages } from '../state/session-message-repository.js';
import { replaceAllMessages } from '../core/state-mutations.js';
import { renderSessionMessages } from './restore.js';
import { showNotification } from '../ui/notifications.js';

let initialized = false;
let branchInFlight = false;

function cloneMessages(messages) {
    if (typeof globalThis.structuredClone === 'function') {
        return globalThis.structuredClone(messages);
    }
    return JSON.parse(JSON.stringify(messages));
}

function getMessageIndex(messageEl) {
    const messageId = messageEl?.dataset?.messageId;
    if (messageId && state.messageStore) {
        const index = state.messageStore.findIndexById(messageId);
        if (index !== -1) return index;
    }

    const fallbackIndex = Number.parseInt(messageEl?.dataset?.messageIndex || '', 10);
    return Number.isInteger(fallbackIndex) ? fallbackIndex : -1;
}

export function getBranchName(sourceName) {
    const baseName = (sourceName || '未命名会话').trim() || '未命名会话';
    const suffix = ' · 分支';
    const maxBaseLength = 48 - suffix.length;
    return `${baseName.slice(0, maxBaseLength)}${suffix}`;
}

export async function branchFromMessage(messageEl) {
    if (branchInFlight) return;
    if (state.isLoading) {
        showNotification('请等待当前回复完成后再创建分支', 'warning');
        return;
    }

    const activeTask = state.currentSessionId
        ? requestTaskRegistry.getBySession(state.currentSessionId)
        : null;
    if (activeTask && requestTaskRegistry.isActive(activeTask)) {
        showNotification('当前会话仍在生成中，暂时不能创建分支', 'warning');
        return;
    }

    const sourceSessionId = state.currentSessionId;
    const sourceSession = state.sessions.find((session) => session.id === sourceSessionId);
    const messageIndex = getMessageIndex(messageEl);
    if (!sourceSession || messageIndex < 0 || messageIndex >= state.messages.length) {
        showNotification('找不到要分支的消息', 'error');
        return;
    }

    branchInFlight = true;
    try {
        await materializeCurrentSessionMessages();
        if (state.currentSessionId !== sourceSessionId || state.isSwitchingSession) return;

        const branchMessages = cloneMessages(state.messages.slice(0, messageIndex + 1));
        const branchSession = await createNewSession(false);
        if (!branchSession) return;

        branchSession.name = getBranchName(sourceSession.name);
        branchSession.customName = true;
        await switchToSession(branchSession.id, false);
        if (state.currentSessionId !== branchSession.id || state.isSwitchingSession) return;

        replaceAllMessages(branchMessages);
        state.sessionDirty = true;
        renderSessionMessages();
        await saveCurrentSessionMessages(true);
        eventBus.emit('sessions:updated', { sessions: state.sessions });
        showNotification(`已创建分支：${branchSession.name}`, 'success');
    } catch (error) {
        showNotification(`创建分支失败：${error.message || '未知错误'}`, 'error');
    } finally {
        branchInFlight = false;
    }
}

export function initMessageBranching() {
    if (initialized) return;
    initialized = true;
    eventBus.on('message:branch-requested', ({ messageEl } = {}) => {
        void branchFromMessage(messageEl);
    });
}
