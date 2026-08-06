import { MediaKind, PartType, Role } from '../../js/messages/schema.js';

export function createLongChatFixture(
    count,
    { imageEvery = 0, thinkingEvery = 0, codeEvery = 0 } = {}
) {
    return Array.from({ length: count }, (_, index) => {
        const role = index % 2 === 0 ? Role.USER : Role.ASSISTANT;
        const parts = [{ type: PartType.TEXT, text: `message-${index}` }];
        if (thinkingEvery > 0 && index % thinkingEvery === 0) {
            parts.unshift({ type: PartType.THINKING, text: `thinking-${index}` });
        }
        if (imageEvery > 0 && index % imageEvery === 0) {
            parts.push({
                type: PartType.MEDIA,
                media: MediaKind.IMAGE,
                mime: 'image/png',
                url: `data:image/png;base64,image-${index}`
            });
        }
        if (codeEvery > 0 && index % codeEvery === 0) {
            const text = parts.find((part) => part.type === PartType.TEXT);
            text.text += `\n\n\`\`\`js\nconst value = ${index};\n\`\`\``;
        }
        return {
            id: `message-${index}`,
            role,
            ts: index,
            parts,
            meta: {},
            replies: null,
            error: null
        };
    });
}
