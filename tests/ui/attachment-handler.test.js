/**
 * attachment-handler.js 文件附件处理测试
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../js/core/state.js', () => ({
    state: {
        uploadedImages: [],
        pdfMode: 'raw'
    },
    elements: {
        imagePreview: null,
        imagePreviewContainer: null,
        userInput: null,
        attachFileBtn: null
    }
}));

vi.mock('../../js/core/events.js', () => ({
    eventBus: { emit: vi.fn(), on: vi.fn() }
}));

vi.mock('../../js/ui/notifications.js', () => ({
    showNotification: vi.fn()
}));

vi.mock('../../js/utils/file-helpers.js', () => ({
    truncateFileName: vi.fn((name) => name)
}));

vi.mock('../../js/utils/helpers.js', () => ({
    escapeHtml: vi.fn((s) => s)
}));

vi.mock('../../js/utils/constants.js', () => ({
    MAX_ATTACHMENTS: 5,
    MAX_FILE_SIZE: 20 * 1024 * 1024,
    AUTO_DOCUMENT_TOKEN_THRESHOLD: 2000
}));

vi.mock('../../js/stream/stats.js', () => ({
    estimateTokenCount: vi.fn(() => 100)
}));

vi.mock('../../js/utils/pdf.js', () => ({
    renderPdfToImages: vi.fn(() => Promise.resolve([]))
}));

vi.mock('../../js/utils/logger.js', () => ({
    logger: { warn: vi.fn(), debug: vi.fn(), error: vi.fn(), info: vi.fn() }
}));

import { state } from '../../js/core/state.js';
import { getFileCategory, fileToBase64, fileToText } from '../../js/ui/attachment-handler.js';

describe('attachment-handler', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        state.uploadedImages = [];
        state.pdfMode = 'raw';
    });

    // ========== getFileCategory ==========
    describe('getFileCategory', () => {
        it('image/jpeg 返回 image', () => {
            expect(getFileCategory('image/jpeg')).toBe('image');
        });

        it('image/png 返回 image', () => {
            expect(getFileCategory('image/png')).toBe('image');
        });

        it('image/gif 返回 image', () => {
            expect(getFileCategory('image/gif')).toBe('image');
        });

        it('image/webp 返回 image', () => {
            expect(getFileCategory('image/webp')).toBe('image');
        });

        it('application/pdf 返回 pdf', () => {
            expect(getFileCategory('application/pdf')).toBe('pdf');
        });

        it('text/plain 返回 text', () => {
            expect(getFileCategory('text/plain')).toBe('text');
        });

        it('text/markdown 返回 text', () => {
            expect(getFileCategory('text/markdown')).toBe('text');
        });

        it('未知类型返回 unknown', () => {
            expect(getFileCategory('application/octet-stream')).toBe('unknown');
        });

        it('空字符串返回 unknown', () => {
            expect(getFileCategory('')).toBe('unknown');
        });
    });

    // ========== fileToBase64 ==========
    describe('fileToBase64', () => {
        it('将文件转换为 base64', async () => {
            const blob = new Blob(['hello'], { type: 'text/plain' });
            const file = new File([blob], 'test.txt', { type: 'text/plain' });
            const result = await fileToBase64(file);
            expect(result).toContain('data:text/plain');
            expect(result).toContain('base64');
        });
    });

    // ========== fileToText ==========
    describe('fileToText', () => {
        it('读取文本文件内容', async () => {
            const blob = new Blob(['hello world'], { type: 'text/plain' });
            const file = new File([blob], 'test.txt', { type: 'text/plain' });
            const result = await fileToText(file);
            expect(result).toBe('hello world');
        });

        it('读取 UTF-8 中文', async () => {
            const blob = new Blob(['你好世界'], { type: 'text/plain' });
            const file = new File([blob], 'test.txt', { type: 'text/plain' });
            const result = await fileToText(file);
            expect(result).toBe('你好世界');
        });
    });
});
