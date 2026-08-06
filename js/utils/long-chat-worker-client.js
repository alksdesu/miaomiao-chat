import { logger } from './logger.js';

const TASK_TIMEOUT_MS = 30000;
export const LONG_CHAT_WORKER_TEXT_THRESHOLD = 16000;
let worker = null;
let requestId = 0;
const pending = new Map();

function normalizeText(text) {
    return typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
}

function extractText(message) {
    if (!Array.isArray(message?.parts)) return '';
    return normalizeText(
        message.parts
            .filter((part) => part?.type === 'text' && typeof part.text === 'string')
            .map((part) => part.text)
            .join(' ')
    );
}

function runFallback(type, payload) {
    if (type === 'build-search-index') {
        const messages = Array.isArray(payload?.messages) ? payload.messages : [];
        const entries = [];
        messages.forEach((message, index) => {
            const text = extractText(message);
            if (!text) return;
            entries.push({
                id: message?.id || `msg_${index}`,
                index,
                role: typeof message?.role === 'string' ? message.role.toLowerCase() : 'unknown',
                text
            });
        });
        return { version: 1, updatedAt: Date.now(), messageCount: messages.length, entries };
    }
    if (type === 'estimate-tokens') {
        const text = String(payload?.text || '');
        const chinese = (text.match(/[\u4e00-\u9fff]/g) || []).length;
        const other = text.replace(/[\u4e00-\u9fff]/g, ' ').trim();
        return chinese + (other ? Math.ceil(other.length / 4) : 0);
    }
    if (type === 'segment-text') {
        const text = String(payload?.text || '');
        const maxLength = Math.max(1, Number(payload?.maxLength) || 16000);
        const segments = [];
        for (let start = 0; start < text.length; start += maxLength) {
            segments.push(text.slice(start, start + maxLength));
        }
        return segments;
    }
    throw new Error(`未知 Worker 任务: ${type}`);
}

function getWorker() {
    if (worker) return worker;
    if (typeof globalThis.Worker === 'undefined') return null;
    try {
        worker = new globalThis.Worker(new URL('../workers/long-chat-worker.js', import.meta.url), {
            type: 'module'
        });
        worker.onmessage = ({ data }) => {
            const task = pending.get(data?.id);
            if (!task) return;
            pending.delete(data.id);
            clearTimeout(task.timeoutId);
            if (data.error) task.reject(new Error(data.error));
            else task.resolve(data.result);
        };
        worker.onerror = (error) => {
            logger.warn('[LongChatWorker] Worker 失效，后续任务回退主线程:', error);
            worker?.terminate();
            worker = null;
            for (const task of pending.values()) {
                clearTimeout(task.timeoutId);
                task.reject(error);
            }
            pending.clear();
        };
        return worker;
    } catch (error) {
        logger.debug('[LongChatWorker] 无法创建 Worker，使用主线程回退:', error);
        return null;
    }
}

export async function runLongChatTask(type, payload, { timeout = TASK_TIMEOUT_MS } = {}) {
    const target = getWorker();
    if (!target) return runFallback(type, payload);
    const id = ++requestId;
    return new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
            pending.delete(id);
            reject(new Error(`Worker 任务超时: ${type}`));
        }, timeout);
        pending.set(id, { resolve, reject, timeoutId });
        target.postMessage({ id, type, payload });
    }).catch((error) => {
        logger.debug(`[LongChatWorker] ${type} 回退主线程:`, error);
        return runFallback(type, payload);
    });
}

export function buildSearchIndexInWorker(messages) {
    return runLongChatTask('build-search-index', { messages });
}

export function estimateTokensInWorker(text) {
    return runLongChatTask('estimate-tokens', { text });
}

export function segmentTextInWorker(text, maxLength) {
    return runLongChatTask('segment-text', { text, maxLength });
}

export function terminateLongChatWorker() {
    worker?.terminate();
    worker = null;
    for (const task of pending.values()) {
        clearTimeout(task.timeoutId);
        task.reject(new Error('Worker 已终止'));
    }
    pending.clear();
}
