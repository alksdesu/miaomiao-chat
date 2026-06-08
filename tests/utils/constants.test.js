/**
 * constants.js 测试
 */
import { describe, it, expect } from 'vitest';

import {
    MAX_FILE_SIZE,
    API_FILE_SIZE_LIMITS,
    MAX_MARKDOWN_LENGTH,
    MAX_ATTACHMENTS,
    AUTO_DOCUMENT_TOKEN_THRESHOLD,
    IMAGE_COMPRESSION_TIMEOUT,
    XML_MAX_BUFFER_SIZE,
    XML_MAX_TOOL_CONTENT_LENGTH,
    TOOL_ID_COUNTER_MAX
} from '../../js/utils/constants.js';

describe('constants', () => {
    it('MAX_FILE_SIZE 是 20MB', () => {
        expect(MAX_FILE_SIZE).toBe(20 * 1024 * 1024);
    });

    it('API_FILE_SIZE_LIMITS 包含三种格式', () => {
        expect(API_FILE_SIZE_LIMITS.gemini).toBeDefined();
        expect(API_FILE_SIZE_LIMITS.openai).toBeDefined();
        expect(API_FILE_SIZE_LIMITS.claude).toBeDefined();
    });

    it('MAX_MARKDOWN_LENGTH 是正数', () => {
        expect(MAX_MARKDOWN_LENGTH).toBeGreaterThan(0);
    });

    it('MAX_ATTACHMENTS 是正数', () => {
        expect(MAX_ATTACHMENTS).toBeGreaterThan(0);
    });

    it('AUTO_DOCUMENT_TOKEN_THRESHOLD 是正数', () => {
        expect(AUTO_DOCUMENT_TOKEN_THRESHOLD).toBeGreaterThan(0);
    });

    it('IMAGE_COMPRESSION_TIMEOUT 是正数', () => {
        expect(IMAGE_COMPRESSION_TIMEOUT).toBeGreaterThan(0);
    });

    it('XML_MAX_BUFFER_SIZE 是正数', () => {
        expect(XML_MAX_BUFFER_SIZE).toBeGreaterThan(0);
    });

    it('XML_MAX_TOOL_CONTENT_LENGTH 是正数', () => {
        expect(XML_MAX_TOOL_CONTENT_LENGTH).toBeGreaterThan(0);
    });

    it('TOOL_ID_COUNTER_MAX 是正数', () => {
        expect(TOOL_ID_COUNTER_MAX).toBeGreaterThan(0);
    });
});
