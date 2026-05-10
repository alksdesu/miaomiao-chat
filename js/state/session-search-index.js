/**
 * 会话搜索索引工具
 * 负责把消息抽取为轻量可搜索结构，供持久化与侧边栏搜索复用。
 */

import { PartType, hasParts, getTextContent } from '../messages/schema.js';

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

    if (hasParts(message)) {
        return normalizeSearchText(
            message.parts
                .filter((part) => {
                    if (typeof part?.text !== 'string') {
                        return false;
                    }

                    return part.type === PartType.TEXT || part.type === undefined;
                })
                .map((part) => part.text)
                .join(' ')
        );
    }

    if (typeof message.content === 'string') {
        return normalizeSearchText(message.content);
    }

    // 旧格式 content 数组或未经 schema 检测的 parts：用 getTextContent 统一提取
    const text = getTextContent(message);
    if (text) return normalizeSearchText(text);

    // 兜底：Gemini 原始 parts（无 type 标记）
    if (Array.isArray(message.parts)) {
        return normalizeSearchText(
            message.parts
                .filter((part) => typeof part.text === 'string')
                .map((part) => part.text)
                .join(' ')
        );
    }

    return '';
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
