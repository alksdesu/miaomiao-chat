// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from 'vitest';
import { state } from '../../js/core/state.js';
import { createWelcomeMessage, getWelcomeName } from '../../js/ui/welcome-message.js';

describe('welcome-message', () => {
    beforeEach(() => {
        state.charName = 'Assistant';
    });

    it('统一默认欢迎名称', () => {
        expect(getWelcomeName()).toBe('AI 助手');
        expect(createWelcomeMessage()).toContain('你好，我是 AI 助手');
    });

    it('使用自定义名称并转义 HTML', () => {
        state.charName = '<script>alert(1)</script>';
        const message = createWelcomeMessage();
        expect(message).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
        expect(message).not.toContain('<script>');
    });
});
