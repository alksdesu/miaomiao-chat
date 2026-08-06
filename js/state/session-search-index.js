/**
 * 会话搜索索引工具
 * 负责把消息抽取为轻量可搜索结构，供持久化与侧边栏搜索复用。
 */

import { PartType } from '../messages/schema.js';
import { buildSearchIndexInWorker } from '../utils/long-chat-worker-client.js';

export const SESSION_SEARCH_INDEX_VERSION = 1;

function normalizeSearchText(text) {
    if (typeof text !== 'string') {
        return '';
    }

    return text.replace(/\s+/g, ' ').trim();
}

function normalizeMessageRole(role) {
    if (typeof role !== 'string' || role.trim() === '') {
        return 'unknown';
    }

    return role.trim().toLowerCase();
}

export function extractMessageSearchText(message) {
    if (!message) {
        return '';
    }

    if (!Array.isArray(message.parts)) return '';
    return normalizeSearchText(
        message.parts
            .filter((part) => part?.type === PartType.TEXT && typeof part.text === 'string')
            .map((part) => part.text)
            .join(' ')
    );
}

export function buildSessionSearchIndex(messages = []) {
    const safeMessages = Array.isArray(messages) ? messages : [];
    const entries = [];

    safeMessages.forEach((message, index) => {
        const text = extractMessageSearchText(message);
        if (!text) {
            return;
        }

        entries.push({
            id: message?.id || `msg_${index}`,
            index,
            role: normalizeMessageRole(message?.role),
            text
        });
    });

    return {
        version: SESSION_SEARCH_INDEX_VERSION,
        updatedAt: Date.now(),
        messageCount: safeMessages.length,
        entries
    };
}

export async function buildSessionSearchIndexAsync(messages = []) {
    const safeMessages = Array.isArray(messages) ? messages : [];
    if (safeMessages.length < 200) return buildSessionSearchIndex(safeMessages);
    return buildSearchIndexInWorker(safeMessages);
}

export function isSessionSearchIndexUsable(searchIndex, expectedMessageCount = null) {
    if (!searchIndex || typeof searchIndex !== 'object') {
        return false;
    }

    if (searchIndex.version !== SESSION_SEARCH_INDEX_VERSION) {
        return false;
    }

    if (!Array.isArray(searchIndex.entries)) {
        return false;
    }

    if (
        expectedMessageCount !== null &&
        Number.isFinite(expectedMessageCount) &&
        searchIndex.messageCount !== expectedMessageCount
    ) {
        return false;
    }

    return true;
}

export function createSessionSearchIndexRecord(sessionId, messages = [], searchIndex = null) {
    const safeMessages = Array.isArray(messages) ? messages : null;
    const expectedMessageCount = safeMessages ? safeMessages.length : null;
    const normalizedIndex = isSessionSearchIndexUsable(searchIndex, expectedMessageCount)
        ? searchIndex
        : buildSessionSearchIndex(safeMessages || []);

    return {
        sessionId,
        version: normalizedIndex.version,
        updatedAt: normalizedIndex.updatedAt,
        messageCount: normalizedIndex.messageCount,
        entries: normalizedIndex.entries
    };
}
