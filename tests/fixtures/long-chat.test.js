import { describe, expect, it } from 'vitest';
import { PartType } from '../../js/messages/schema.js';
import { createLongChatFixture } from './long-chat.js';

describe('createLongChatFixture', () => {
    it('生成稳定 ID 和可配置的复杂消息', () => {
        const messages = createLongChatFixture(10, {
            imageEvery: 2,
            thinkingEvery: 3,
            codeEvery: 4
        });

        expect(messages).toHaveLength(10);
        expect(messages[9].id).toBe('message-9');
        expect(messages[0].parts.some((part) => part.type === PartType.MEDIA)).toBe(true);
        expect(messages[3].parts[0].type).toBe(PartType.THINKING);
        expect(messages[4].parts[0].text).toContain('```js');
    });
});
