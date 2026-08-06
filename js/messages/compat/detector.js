import { SCHEMA_VERSION, isSchemaFormatParts } from '../schema.js';

export const LEGACY_MESSAGE_FIELDS = Object.freeze([
    'content',
    'contentParts',
    'thinkingContent',
    'thinkingSignature',
    'thoughtSignature',
    'toolCalls',
    'tool_calls',
    'allReplies',
    'selectedReplyIndex',
    'timestamp',
    'modelName',
    'providerName',
    'streamStats',
    'encryptedContent',
    'groundingMetadata',
    'isError',
    'errorData',
    'httpStatus',
    'errorHtml'
]);

export function hasLegacyMessageFields(message) {
    if (!message || typeof message !== 'object') return false;
    if (message.role === 'tool') return true;
    return LEGACY_MESSAGE_FIELDS.some((field) => message[field] !== undefined);
}

export function detectMessageSchema(message) {
    if (!message || typeof message !== 'object') {
        return { version: 0, canonical: false, needsStamp: false, reason: 'not-object' };
    }
    const hasLegacyFields = hasLegacyMessageFields(message);
    const hasCanonicalParts =
        Array.isArray(message.parts) &&
        message.parts.length > 0 &&
        isSchemaFormatParts(message.parts, message);
    if (
        Array.isArray(message.parts) &&
        (hasCanonicalParts || (message._schemaVersion >= SCHEMA_VERSION && !hasLegacyFields))
    ) {
        return {
            version: Math.max(message._schemaVersion || 0, SCHEMA_VERSION),
            canonical: true,
            needsStamp: message._schemaVersion !== SCHEMA_VERSION,
            needsCleanup: hasLegacyFields,
            reason: hasLegacyFields ? 'parts-with-legacy-fields' : 'declared'
        };
    }
    if (hasLegacyFields) {
        return { version: 0, canonical: false, needsStamp: false, reason: 'legacy-fields' };
    }
    if (Array.isArray(message.parts) && message.parts.length === 0) {
        return {
            version: SCHEMA_VERSION,
            canonical: true,
            needsStamp: true,
            needsCleanup: false,
            reason: 'empty-parts'
        };
    }
    return { version: 0, canonical: false, needsStamp: false, reason: 'legacy-shape' };
}

export function detectSessionSchema(messages, declaredVersion = null) {
    const source = Array.isArray(messages) ? messages : [];
    const detections = source.map(detectMessageSchema);
    const hasLegacy = detections.some((item) => !item.canonical);
    const needsStamp = detections.some((item) => item.needsStamp);
    const needsCleanup = detections.some((item) => item.needsCleanup);
    const declared = Number.isInteger(declaredVersion) ? declaredVersion : null;
    const version = hasLegacy
        ? 0
        : (declared ??
          detections.reduce(
              (lowest, item) => Math.min(lowest, item.version || SCHEMA_VERSION),
              SCHEMA_VERSION
          ));
    return {
        version,
        canonical: !hasLegacy,
        needsStamp,
        needsCleanup,
        mixed: hasLegacy && detections.some((item) => item.canonical),
        detections
    };
}
