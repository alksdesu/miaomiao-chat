import { state } from './state.js';
import { eventBus } from './events.js';
import { EVENTS } from './events-registry.js';

const TERMINAL_PHASES = new Set(['completed', 'error', 'cancelled']);
let requestSequence = 0;

function nextRequestId() {
    requestSequence += 1;
    return `request_${Date.now()}_${requestSequence}`;
}

function emitTaskListChanged() {
    eventBus.emit(EVENTS.SESSIONS_UPDATED, { sessions: state.sessions });
}

export class RequestTaskRegistry {
    constructor() {
        this.tasksBySession = new Map();
        this.tasksById = new Map();
    }

    create({ sessionId, abortController, requestContext = null }) {
        if (!sessionId) throw new Error('创建请求任务时 sessionId 必传');

        const existing = this.tasksBySession.get(sessionId);
        if (existing && !TERMINAL_PHASES.has(existing.phase)) return null;
        if (existing) this.finish(existing, existing.phase, { reason: 'terminal-replaced' });

        const id = nextRequestId();
        let resolveCompletion;
        const completionPromise = new Promise((resolve) => {
            resolveCompletion = resolve;
        });
        const now = Date.now();
        const task = {
            id,
            generation: id,
            sessionId,
            phase: 'sending',
            abortController,
            toolAbortController: null,
            requestContext,
            assistantMessageEl: null,
            messageElement: null,
            partialRender: null,
            isDetached: false,
            isToolCallPending: false,
            isSavingContinuation: false,
            isImageRetry: false,
            createdAt: now,
            lastActivityAt: now,
            completionPromise,
            resolveCompletion
        };

        this.tasksBySession.set(sessionId, task);
        this.tasksById.set(id, task);
        return task;
    }

    getBySession(sessionId) {
        return sessionId ? this.tasksBySession.get(sessionId) || null : null;
    }

    getById(requestId) {
        return requestId ? this.tasksById.get(requestId) || null : null;
    }

    owns(task) {
        return !!task && this.tasksBySession.get(task.sessionId) === task;
    }

    isActive(task) {
        return (
            this.owns(task) &&
            !TERMINAL_PHASES.has(task.phase) &&
            !task.abortController?.signal?.aborted
        );
    }

    touch(task) {
        if (!this.owns(task)) return false;
        task.lastActivityAt = Date.now();
        return true;
    }

    setPhase(task, phase) {
        if (!this.owns(task)) return false;
        task.phase = phase;
        task.lastActivityAt = Date.now();
        return true;
    }

    setAssistantElement(task, assistantMessageEl) {
        if (!this.owns(task)) return false;
        task.assistantMessageEl = assistantMessageEl || null;
        task.messageElement = assistantMessageEl?.classList?.contains('message')
            ? assistantMessageEl
            : assistantMessageEl?.closest?.('.message') || null;
        return true;
    }

    setToolAbortController(task, abortController) {
        if (!this.owns(task)) return false;
        task.toolAbortController = abortController || null;
        return true;
    }

    setAbortController(task, abortController) {
        if (!this.owns(task) || !abortController) return false;
        task.abortController = abortController;
        task.lastActivityAt = Date.now();
        return true;
    }

    setPartialRender(task, partialRender) {
        if (!this.owns(task)) return false;
        task.partialRender = partialRender || null;
        task.lastActivityAt = Date.now();
        return true;
    }

    detach(task) {
        if (!this.isActive(task)) return false;
        task.isDetached = true;
        state.backgroundTasks.set(task.sessionId, task);
        emitTaskListChanged();
        return true;
    }

    attach(task) {
        if (!this.isActive(task)) return false;
        task.isDetached = false;
        if (state.backgroundTasks.get(task.sessionId) === task) {
            state.backgroundTasks.delete(task.sessionId);
            emitTaskListChanged();
        }
        return true;
    }

    abort(task, reason = undefined) {
        if (!this.owns(task)) return false;
        const controllers = [task.toolAbortController, task.abortController];
        for (const controller of controllers) {
            if (!controller || controller.signal?.aborted) continue;
            try {
                controller.abort(reason);
            } catch {
                // AbortController 在部分旧 WebView 中可能拒绝重复 reason。
            }
        }
        return true;
    }

    finish(task, phase, detail = null) {
        if (!this.owns(task)) return false;
        task.phase = phase;
        task.lastActivityAt = Date.now();
        if (state.backgroundTasks.get(task.sessionId) === task) {
            state.backgroundTasks.delete(task.sessionId);
            emitTaskListChanged();
        }
        this.tasksBySession.delete(task.sessionId);
        this.tasksById.delete(task.id);
        task.resolveCompletion?.({ phase, detail, task });
        task.resolveCompletion = null;
        return true;
    }

    clearForTests() {
        this.tasksBySession.clear();
        this.tasksById.clear();
    }
}

export const requestTaskRegistry = new RequestTaskRegistry();
