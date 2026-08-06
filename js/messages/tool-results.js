import { PartType, Role, ToolState } from './schema.js';

export function applyToolResultsToMessages(messages, toolResults) {
    if (!Array.isArray(messages) || !Array.isArray(toolResults) || toolResults.length === 0) {
        return { messages, matched: 0, changedIndexes: [] };
    }

    const resultsById = new Map(
        toolResults.filter((result) => result?.id).map((result) => [result.id, result])
    );
    let matched = 0;
    const changedIndexes = [];
    const nextMessages = messages.map((message, index) => {
        if (message?.role !== Role.ASSISTANT || !Array.isArray(message.parts)) return message;

        let changed = false;
        const parts = message.parts.map((part) => {
            if (part.type !== PartType.TOOL_CALL || !part.id) return part;
            const result = resultsById.get(part.id);
            if (!result) return part;
            changed = true;
            matched++;
            return {
                ...part,
                result: result.result,
                state: result.isError ? ToolState.ERROR : ToolState.DONE
            };
        });

        if (!changed) return message;
        changedIndexes.push(index);
        return { ...message, parts };
    });

    return { messages: nextMessages, matched, changedIndexes };
}
