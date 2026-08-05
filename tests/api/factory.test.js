/**
 * api/factory.js 测试
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../js/api/openai.js', () => ({
    sendOpenAIRequest: vi.fn()
}));
vi.mock('../../js/api/gemini.js', () => ({
    sendGeminiRequest: vi.fn()
}));
vi.mock('../../js/api/claude.js', () => ({
    sendClaudeRequest: vi.fn()
}));
vi.mock('../../js/api/openclaw.js', () => ({
    sendOpenClawRequest: vi.fn()
}));
vi.mock('../../js/api/openai-image.js', () => ({
    sendOpenAIImageRequest: vi.fn()
}));

import { getSendFunction } from '../../js/api/factory.js';
import { sendOpenAIRequest } from '../../js/api/openai.js';
import { sendGeminiRequest } from '../../js/api/gemini.js';
import { sendClaudeRequest } from '../../js/api/claude.js';
import { sendOpenClawRequest } from '../../js/api/openclaw.js';
import { sendOpenAIImageRequest } from '../../js/api/openai-image.js';

describe('getSendFunction', () => {
    it('openai 格式', () => {
        expect(getSendFunction('openai')).toBe(sendOpenAIRequest);
    });

    it('openai-responses 格式', () => {
        expect(getSendFunction('openai-responses')).toBe(sendOpenAIRequest);
    });

    it('gemini 格式', () => {
        expect(getSendFunction('gemini')).toBe(sendGeminiRequest);
    });

    it('claude 格式', () => {
        expect(getSendFunction('claude')).toBe(sendClaudeRequest);
    });

    it('openclaw 格式', () => {
        expect(getSendFunction('openclaw')).toBe(sendOpenClawRequest);
    });

    it('openai-image 格式', () => {
        expect(getSendFunction('openai-image')).toBe(sendOpenAIImageRequest);
    });

    it('未知格式抛异常', () => {
        expect(() => getSendFunction('unknown')).toThrow('Unsupported API format');
    });
});
