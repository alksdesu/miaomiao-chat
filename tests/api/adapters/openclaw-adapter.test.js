/**
 * openclaw-adapter.js 测试
 * 从旧 response-parser.test.js 1:1 迁移
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

// mock 依赖
vi.mock('../../../js/core/state.js', () => ({
    state: { xmlToolCallingEnabled: false }
}));

vi.mock('../../../js/utils/markdown-image-parser.js', () => ({
    parseMarkdownImages: (text) => [{ type: 'text', text }]
}));

vi.mock('../../../js/tools/xml-formatter.js', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        extractXMLToolCalls: () => []
    };
});

vi.mock('../../../js/stream/think-tag-parser.js', () => ({
    parseThinkTags: (text) => ({ displayText: text || '', thinkingContent: '' })
}));

vi.mock('../../../js/utils/media.js', () => ({
    isVideoMimeType: (mime) => mime?.startsWith('video/'),
    isAudioMimeType: (mime) => mime?.startsWith('audio/'),
    isVideoUrl: () => false
}));

import { openclawAdapter } from '../../../js/api/adapters/openclaw-adapter.js';
import { state } from '../../../js/core/state.js';

beforeEach(() => {
    state.xmlToolCallingEnabled = false;
});

// ========== OpenClaw 格式 ==========

describe('parseApiResponse - OpenClaw 格式', () => {
    it('复用 OpenAI 解析', () => {
        const data = { choices: [{ message: { content: 'openclaw result' } }] };
        const result = openclawAdapter.parseResponse(data);
        expect(result.content).toBe('openclaw result');
    });
});
