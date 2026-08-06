import { PartType, isSchemaFormatParts, validateMessages } from '../schema.js';
import { LEGACY_MESSAGE_FIELDS } from './detector.js';

export function validateCanonicalMessages(messages) {
    const validation = validateMessages(messages);
    const errors = [...validation.errors];
    const warnings = [];
    const seenIds = new Map();

    if (!Array.isArray(messages)) {
        return { valid: false, errors: validation.errors, warnings };
    }

    messages.forEach((message, index) => {
        const firstIndex = seenIds.get(message?.id);
        if (message?.id && firstIndex !== undefined) {
            warnings.push({ index, code: 'duplicate-id', firstIndex, id: message.id });
        } else if (message?.id) {
            seenIds.set(message.id, index);
        }
        const fields = LEGACY_MESSAGE_FIELDS.filter((field) => message?.[field] !== undefined);
        if (fields.length > 0) {
            warnings.push({ index, code: 'legacy-fields', fields });
        }
        const toolParts = (message?.parts || []).filter(
            (part) => part?.type === PartType.TOOL_CALL
        );
        if (
            toolParts.some(
                (part) => !part.idMap?.openai || !part.idMap?.claude || !part.idMap?.gemini
            )
        ) {
            errors.push({ index, errors: ['tool_call 缺少完整 idMap'] });
        }
        if (Array.isArray(message?.replies?.all)) {
            if (
                message.replies.all.length > 0 &&
                (message.replies.selected < 0 ||
                    message.replies.selected >= message.replies.all.length)
            ) {
                errors.push({ index, errors: ['replies.selected 越界'] });
            }
            message.replies.all.forEach((reply, replyIndex) => {
                if (
                    !Array.isArray(reply?.parts) ||
                    (reply.parts.length > 0 && !isSchemaFormatParts(reply.parts))
                ) {
                    errors.push({ index, replyIndex, errors: ['reply.parts 不是标准 parts'] });
                    return;
                }
                const missingIdMap = reply.parts.some(
                    (part) =>
                        part?.type === PartType.TOOL_CALL &&
                        (!part.idMap?.openai || !part.idMap?.claude || !part.idMap?.gemini)
                );
                if (missingIdMap) {
                    errors.push({ index, replyIndex, errors: ['reply tool_call 缺少完整 idMap'] });
                }
            });
        }
    });

    return { valid: errors.length === 0, errors, warnings };
}
