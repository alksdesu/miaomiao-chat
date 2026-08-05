// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../js/api/current.js', () => ({
    getCurrentProvider: vi.fn(() => ({ name: 'Image Provider' })),
    getModelDisplayName: vi.fn(() => 'custom-image-model')
}));

import {
    OpenAIImageStreamParser,
    parseOpenAIImageStream
} from '../../js/stream/parser-openai-image.js';

function createSink() {
    return {
        isBackground: vi.fn(() => false),
        streamingUpdate: vi.fn(),
        renderFinalContent: vi.fn(),
        renderFinalText: vi.fn(),
        renderError: vi.fn(),
        appendStats: vi.fn(),
        commit: vi.fn(() => 0),
        commitError: vi.fn(() => 0),
        triggerToolCalls: vi.fn(),
        triggerPauseTurnResend: vi.fn()
    };
}

describe('OpenAIImageStreamParser', () => {
    let sink;
    let parser;

    beforeEach(() => {
        sink = createSink();
        parser = new OpenAIImageStreamParser('session-image', sink);
    });

    it('partial 只预览，completed 才提交最终图片和 usage', async () => {
        await parser.processLine('event: image_generation.partial_image');
        await parser.processLine(
            'data: {"type":"image_generation.partial_image","b64_json":"partial","partial_image_index":0}'
        );

        expect(sink.renderFinalContent).toHaveBeenCalledTimes(1);
        expect(parser.contentParts).toEqual([]);

        await parser.processLine('event: image_generation.completed');
        await parser.processLine(
            'data: {"type":"image_generation.completed","b64_json":"final","usage":{"total_tokens":25}}'
        );
        await parser.onStreamEnd();

        expect(sink.commit).toHaveBeenCalledTimes(1);
        const [parts, meta] = sink.commit.mock.calls[0];
        expect(parts[0]).toMatchObject({ type: 'media', media: 'image' });
        expect(parts[0].url).toBe('data:image/png;base64,final');
        expect(meta.usage).toEqual({ total_tokens: 25 });
    });

    it('编辑流支持多张 completed 图片', async () => {
        await parser.processLine('data: {"type":"image_edit.completed","b64_json":"UklGRfirst"}');
        await parser.processLine('data: {"type":"image_edit.completed","b64_json":"UklGRsecond"}');
        await parser.onStreamEnd();

        const [parts] = sink.commit.mock.calls[0];
        expect(parts).toHaveLength(2);
        expect(parts.every((part) => part.mime === 'image/webp')).toBe(true);
    });

    it('兼容忽略 stream 参数后返回的普通 JSON', async () => {
        await parser.processLine(
            '{"output_format":"jpeg","data":[{"b64_json":"/9j/first"},{"url":"https://example.com/second.jpg"}],"usage":{"total_tokens":9}}'
        );
        await parser.onStreamEnd();

        const [parts, meta] = sink.commit.mock.calls[0];
        expect(parts).toHaveLength(2);
        expect(parts[0].mime).toBe('image/jpeg');
        expect(parts[1].url).toBe('https://example.com/second.jpg');
        expect(meta.usage).toEqual({ total_tokens: 9 });
    });

    it('实际 reader 会处理没有尾换行的普通 JSON', async () => {
        const responseBody =
            '{"output_format":"png","data":[{"b64_json":"final-without-newline"}]}';
        const reader = new ReadableStream({
            start(controller) {
                controller.enqueue(new TextEncoder().encode(responseBody));
                controller.close();
            }
        }).getReader();

        await parseOpenAIImageStream(reader, 'session-image', sink);

        expect(sink.commit).toHaveBeenCalledTimes(1);
        expect(sink.commit.mock.calls[0][0][0].url).toBe(
            'data:image/png;base64,final-without-newline'
        );
    });

    it('只有 partial 而无 completed 时以错误结束且不保存预览图', async () => {
        await parser.processLine(
            'data: {"type":"image_generation.partial_image","b64_json":"partial"}'
        );
        await parser.onStreamEnd();

        expect(sink.commit).not.toHaveBeenCalled();
        expect(sink.commitError).toHaveBeenCalledTimes(1);
        const [parts] = sink.commitError.mock.calls[0];
        expect(parts.some((part) => part.type === 'media')).toBe(false);
    });

    it('API error 只完成一次', async () => {
        const shouldStop = await parser.processLine(
            'data: {"error":{"type":"invalid_request_error","message":"bad prompt"}}'
        );
        await parser.onStreamEnd();

        expect(shouldStop).toBe(true);
        expect(sink.commitError).toHaveBeenCalledTimes(1);
    });
});
