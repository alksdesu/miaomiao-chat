import {
    SCHEMA_VERSION,
    Role,
    PartType,
    createMessage,
    textPart,
    isSchemaFormatParts,
    validateMessages
} from '../schema.js';
import { ensureIdMap } from '../../api/format-converter.js';
import { migrateReply, migrateSession } from '../migration.js';
import { logger } from '../../utils/logger.js';
import { LEGACY_MESSAGE_FIELDS, detectSessionSchema, hasLegacyMessageFields } from './detector.js';
import { validateCanonicalMessages } from './validator.js';
import { getMigration } from './migrations/registry.js';
import { CompatibilityStatus, createCompatibilityResult } from './result.js';

function normalizeRole(role) {
    if (role === Role.USER || role === Role.ASSISTANT || role === Role.SYSTEM) return role;
    if (role === 'model') return Role.ASSISTANT;
    return Role.USER;
}

function createStableId(sessionId, index, usedIds) {
    const base = `compat-${sessionId || 'session'}-${index}`;
    let id = base;
    let suffix = 2;
    while (usedIds.has(id)) id = `${base}-${suffix++}`;
    return id;
}

function omitLegacyFields(value) {
    const copy = { ...value };
    for (const field of LEGACY_MESSAGE_FIELDS) delete copy[field];
    return copy;
}

function normalizeError(value) {
    if (value?.error && typeof value.error === 'object') return value.error;
    if (!value?.isError && !value?.errorData && !value?.errorHtml) return null;
    return {
        type: value.errorType || value.errorData?.error?.type || 'unknown',
        message:
            value.errorMessage ||
            value.errorData?.error?.message ||
            (typeof value.content === 'string' ? value.content : ''),
        status: value.httpStatus || 0,
        ...(value.errorHtml ? { html: value.errorHtml } : {})
    };
}

function normalizeParts(parts) {
    let changed = false;
    const normalized = parts.map((part) => {
        if (part?.type !== PartType.TOOL_CALL) return part;
        if (part.idMap?.openai && part.idMap?.claude && part.idMap?.gemini) return part;
        const copy = { ...part, ...(part.idMap ? { idMap: { ...part.idMap } } : {}) };
        ensureIdMap(copy);
        changed = true;
        return copy;
    });
    return { parts: changed ? normalized : parts, changed };
}

function normalizeReply(reply) {
    const current = reply && typeof reply === 'object' ? reply : {};
    const canonicalParts =
        Array.isArray(current.parts) &&
        (current.parts.length === 0 || isSchemaFormatParts(current.parts));
    if (!canonicalParts) return { reply: migrateReply(current), changed: true };

    const normalizedParts = normalizeParts(current.parts);
    const hasLegacy = hasLegacyMessageFields(current);
    const meta = current.meta && typeof current.meta === 'object' ? current.meta : {};
    const ts =
        typeof current.ts === 'number'
            ? current.ts
            : typeof current.timestamp === 'number'
              ? current.timestamp
              : 0;
    const error = normalizeError(current);
    const changed =
        hasLegacy ||
        normalizedParts.changed ||
        current.meta !== meta ||
        current.ts !== ts ||
        current.error !== error;
    if (!changed) return { reply: current, changed: false };
    return {
        reply: {
            ...omitLegacyFields(current),
            parts: normalizedParts.parts,
            meta,
            ts,
            error
        },
        changed: true
    };
}

function normalizeCanonicalMessages(messages, sessionId) {
    const usedIds = new Set();
    let changed = false;
    const normalized = messages.map((message, index) => {
        const current = message && typeof message === 'object' ? message : {};
        let id = typeof current.id === 'string' && current.id ? current.id : null;
        if (!id || usedIds.has(id)) {
            id = createStableId(sessionId, index, usedIds);
            changed = true;
        }
        usedIds.add(id);

        const role = normalizeRole(current.role);
        const ts =
            typeof current.ts === 'number' && current.ts > 0 ? current.ts : Date.now() + index;
        const meta = current.meta && typeof current.meta === 'object' ? current.meta : {};
        const normalizedParts = normalizeParts(Array.isArray(current.parts) ? current.parts : []);
        let replies = current.replies ?? null;
        if (replies?.all && Array.isArray(replies.all)) {
            let repliesChanged = false;
            const all = replies.all.map((reply) => {
                const normalizedReply = normalizeReply(reply);
                repliesChanged ||= normalizedReply.changed;
                return normalizedReply.reply;
            });
            const selected = Math.max(
                0,
                Math.min(Number.isInteger(replies.selected) ? replies.selected : 0, all.length - 1)
            );
            if (selected !== replies.selected || repliesChanged) {
                replies = { ...replies, all, selected };
                changed = true;
            }
        } else if (replies !== null) {
            replies = null;
            changed = true;
        }
        const error = normalizeError(current);
        const legacyFields = LEGACY_MESSAGE_FIELDS.filter((field) => current[field] !== undefined);
        const needsClone =
            legacyFields.length > 0 ||
            current._schemaVersion !== SCHEMA_VERSION ||
            current.id !== id ||
            current.role !== role ||
            current.ts !== ts ||
            normalizedParts.changed ||
            current.meta !== meta ||
            current.replies !== replies ||
            current.error !== error;
        if (!needsClone) return current;
        changed = true;
        return {
            ...omitLegacyFields(current),
            id,
            role,
            ts,
            _schemaVersion: SCHEMA_VERSION,
            parts: normalizedParts.parts,
            meta,
            replies,
            error
        };
    });
    return { messages: normalized, changed };
}

function readableLegacyContent(message) {
    if (typeof message?.content === 'string') return message.content;
    if (Array.isArray(message?.content)) {
        return message.content
            .map((part) => (typeof part?.text === 'string' ? part.text : ''))
            .filter(Boolean)
            .join('\n');
    }
    if (message?.role === 'tool') {
        if (typeof message.content === 'string') return message.content;
        try {
            return JSON.stringify(message.content ?? '');
        } catch {
            return '';
        }
    }
    return '';
}

function salvageSession(messages, sessionId, cause) {
    const salvaged = [];
    const usedIds = new Set();
    const reserveId = (candidate, index) => {
        const id =
            typeof candidate === 'string' && candidate && !usedIds.has(candidate)
                ? candidate
                : createStableId(sessionId, index, usedIds);
        usedIds.add(id);
        return id;
    };
    for (let index = 0; index < messages.length; index++) {
        const message = messages[index];
        try {
            const migrated = migrateSession([message]);
            if (migrated.messages.length > 0 && validateMessages(migrated.messages).valid) {
                for (const item of migrated.messages) {
                    const id = reserveId(item.id, index);
                    salvaged.push(item.id === id ? item : { ...item, id });
                }
                continue;
            }
        } catch {
            // 下面创建最小可读消息
        }
        const text = readableLegacyContent(message) || '[旧消息无法完整恢复]';
        salvaged.push(
            createMessage(normalizeRole(message?.role), [textPart(text)], {
                id: reserveId(message?.id, index),
                ts: typeof message?.ts === 'number' ? message.ts : Date.now() + index,
                error: {
                    type: 'legacy_migration',
                    message: cause?.message || '旧消息迁移失败'
                }
            })
        );
    }
    return salvaged;
}

export function normalizeSessionRecord(record, options = {}) {
    const input = Array.isArray(record) ? { messages: record } : record || {};
    const messages = Array.isArray(input.messages) ? input.messages : [];
    const sessionId = options.sessionId || input.sessionId || null;
    const source = options.source || input.source || 'unknown';
    const declaredVersion = options.declaredVersion ?? input.messageSchemaVersion ?? null;
    const detection = detectSessionSchema(messages, declaredVersion);

    if (detection.canonical) {
        const canonical = normalizeCanonicalMessages(messages, sessionId);
        const validation = validateCanonicalMessages(canonical.messages);
        if (!validation.valid) {
            const salvaged = salvageSession(
                canonical.messages,
                sessionId,
                new Error('标准消息校验失败')
            );
            const salvageValidation = validateCanonicalMessages(salvaged);
            return createCompatibilityResult({
                messages: salvaged,
                sourceVersion: detection.version,
                targetVersion: SCHEMA_VERSION,
                status: salvageValidation.valid
                    ? CompatibilityStatus.SALVAGED
                    : CompatibilityStatus.FAILED,
                changed: true,
                warnings: salvageValidation.warnings,
                errors: validation.errors,
                writeBackRequired: salvageValidation.valid
            });
        }
        return createCompatibilityResult({
            messages: canonical.messages,
            sourceVersion: detection.version,
            targetVersion: SCHEMA_VERSION,
            status: canonical.changed
                ? CompatibilityStatus.UPGRADED
                : CompatibilityStatus.UNCHANGED,
            changed: canonical.changed,
            warnings: validation.warnings,
            errors: validation.errors,
            writeBackRequired: canonical.changed
        });
    }

    try {
        let currentVersion = detection.version;
        let currentRecord = { ...input, messages };
        let toolMessageCount = 0;
        const migrationErrors = [];

        while (currentVersion < SCHEMA_VERSION) {
            const migration = getMigration(currentVersion);
            if (!migration)
                throw new Error(`缺少消息迁移路径: ${currentVersion} → ${SCHEMA_VERSION}`);
            const migrated = migration.migrate(currentRecord);
            currentRecord = { messages: migrated.messages };
            toolMessageCount += migrated.toolMsgCount || 0;
            migrationErrors.push(...(migrated.errors || []));
            currentVersion = migration.to;
        }

        const canonical = normalizeCanonicalMessages(currentRecord.messages, sessionId);
        const validation = validateCanonicalMessages(canonical.messages);
        return createCompatibilityResult({
            messages: canonical.messages,
            sourceVersion: detection.version,
            targetVersion: SCHEMA_VERSION,
            status:
                migrationErrors.length > 0
                    ? CompatibilityStatus.SALVAGED
                    : CompatibilityStatus.UPGRADED,
            changed: true,
            toolMessageCount,
            warnings: validation.warnings,
            errors: [...migrationErrors, ...validation.errors],
            writeBackRequired: true
        });
    } catch (error) {
        logger.error(`[Compatibility] ${source} 会话 ${sessionId || '<unknown>'} 迁移失败:`, error);
        const salvaged = salvageSession(messages, sessionId, error);
        const validation = validateMessages(salvaged);
        return createCompatibilityResult({
            messages: salvaged,
            sourceVersion: detection.version,
            targetVersion: SCHEMA_VERSION,
            status: validation.valid ? CompatibilityStatus.SALVAGED : CompatibilityStatus.FAILED,
            changed: true,
            warnings: [],
            errors: [{ error: error.message }, ...validation.errors],
            writeBackRequired: validation.valid
        });
    }
}

export function assertCanonicalMessages(messages, context = 'runtime') {
    const result = validateCanonicalMessages(messages);
    if (!result.valid) {
        logger.error(`[Compatibility] ${context} 收到非标准消息:`, result.errors);
        return false;
    }
    return true;
}
