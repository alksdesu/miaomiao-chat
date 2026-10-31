import { describe, expect, it } from 'vitest';
import {
    applyToolResultsToMessages,
    splitToolResultContent,
    omitToolResultImages
} from '../../js/messages/tool-results.js';

describe('applyToolResultsToMessages', () => {
    it('只更新匹配的工具结果且不修改输入消息', () => {
        const messages = [
            {
                role: 'assistant',
                parts: [
                    { type: 'tool_call', id: 'call-a', state: 'pending', result: null },
                    { type: 'tool_call', id: 'call-b', state: 'pending', result: null }
                ]
            }
        ];

        const applied = applyToolResultsToMessages(messages, [
            { id: 'call-a', result: { content: 'ok' }, isError: false }
        ]);

        expect(applied.matched).toBe(1);
        expect(applied.changedIndexes).toEqual([0]);
        expect(applied.messages[0].parts[0]).toMatchObject({
            state: 'done',
            result: { content: 'ok' }
        });
        expect(applied.messages[0].parts[1].state).toBe('pending');
        expect(messages[0].parts[0].state).toBe('pending');
    });

    it('支持跨多轮工具调用并保留无关消息引用', () => {
        const userMessage = { role: 'user', parts: [{ type: 'text', text: 'next' }] };
        const messages = [
            {
                role: 'assistant',
                parts: [{ type: 'tool_call', id: 'call-a', state: 'pending' }]
            },
            userMessage,
            {
                role: 'assistant',
                parts: [{ type: 'tool_call', id: 'call-b', state: 'pending' }]
            }
        ];

        const applied = applyToolResultsToMessages(messages, [
            { id: 'call-a', result: 'a', isError: false },
            { id: 'call-b', result: 'b', isError: true }
        ]);

        expect(applied.matched).toBe(2);
        expect(applied.messages[0].parts[0].state).toBe('done');
        expect(applied.messages[2].parts[0].state).toBe('error');
        expect(applied.messages[1]).toBe(userMessage);
    });
});

describe('splitToolResultContent', () => {
    it('没有结果时返回中断文本，字符串原样返回', () => {
        expect(splitToolResultContent(null)).toEqual({
            text: 'Tool execution was interrupted',
            images: []
        });
        expect(splitToolResultContent('plain')).toEqual({ text: 'plain', images: [] });
    });

    it('computer 动作的截图拆成图片，文本取 content', () => {
        expect(
            splitToolResultContent({
                content: 'captured',
                media: [{ type: 'image', url: 'data:image/png;base64,AAA', mimeType: 'image/png' }]
            })
        ).toEqual({
            text: 'captured',
            images: [{ url: 'data:image/png;base64,AAA', mimeType: 'image/png' }]
        });
    });

    it('只有媒体字段时文本为空，不把空对象写成 {}', () => {
        expect(
            splitToolResultContent({
                media: [{ type: 'image', url: 'data:image/png;base64,AAA', mimeType: 'image/png' }]
            }).text
        ).toBe('');
        expect(
            splitToolResultContent({
                status: 'ok',
                media: [{ type: 'image', url: 'data:image/png;base64,AAA' }]
            }).text
        ).toBe('{"status":"ok"}');
    });

    it('MCP 结果优先用 orchestrator 转出的 image / images（已按上限裁过），文本取 text', () => {
        const result = splitToolResultContent({
            content: [
                { type: 'text', text: 'two images' },
                { type: 'image', data: 'RAW1', mimeType: 'image/png' },
                { type: 'image', data: 'OVERSIZED', mimeType: 'image/png' }
            ],
            text: 'two images\n[图片已省略：超过 API 单图限制]',
            images: [{ type: 'image_url', url: 'data:image/png;base64,RAW1' }]
        });
        expect(result.text).toBe('two images\n[图片已省略：超过 API 单图限制]');
        expect(result.images).toEqual([
            { url: 'data:image/png;base64,RAW1', mimeType: 'image/png' }
        ]);
    });

    it('未经转换的 MCP content 直接拆出文本与图片，资源取文本，二进制内容不进文本', () => {
        const result = splitToolResultContent({
            content: [
                { type: 'text', text: 'hello' },
                { type: 'image', data: 'IMG', mimeType: 'image/jpeg' },
                { type: 'resource', resource: { uri: 'file:///a', text: 'resource body' } },
                { type: 'audio', data: 'AUDIOBASE64', mimeType: 'audio/wav' }
            ]
        });
        expect(result.text).toBe('hello\nresource body\n[audio 内容已省略]');
        expect(result.text).not.toContain('AUDIOBASE64');
        expect(result.images).toEqual([
            { url: 'data:image/jpeg;base64,IMG', mimeType: 'image/jpeg' }
        ]);
    });

    it('客户端包裹的 { success, result: { content } } 结构同样拆分', () => {
        const result = splitToolResultContent({
            success: true,
            result: { content: [{ type: 'image', data: 'W', mimeType: 'image/png' }] }
        });
        expect(result.images).toEqual([{ url: 'data:image/png;base64,W', mimeType: 'image/png' }]);
        expect(result.text).toBe('');
    });

    it('视频不进文本，只说明数量', () => {
        const result = splitToolResultContent({
            content: [{ type: 'text', text: 'rendered' }],
            text: 'rendered',
            video: 'data:video/mp4;base64,VIDEO',
            videos: [{ type: 'video_url', url: 'data:video/mp4;base64,VIDEO' }]
        });
        expect(result.text).toBe('rendered\n[工具返回了 1 段视频，未发送给模型]');
        expect(result.text).not.toContain('VIDEO');
    });

    it('失败结果与普通对象沿用 stringifyToolResult', () => {
        expect(splitToolResultContent({ error: 'boom', is_error: true }).text).toBe('boom');
        expect(splitToolResultContent({ stdout: 'x' }).text).toBe('{"stdout":"x"}');
    });
});

describe('omitToolResultImages', () => {
    const notice = (count) => `[omitted ${count}]`;

    it('没有图片时原样返回', () => {
        const result = { content: 'ok' };
        expect(omitToolResultImages(result, notice)).toBe(result);
    });

    it('图片换成说明文字，失败结果保留 is_error', () => {
        const media = [{ type: 'image', url: 'data:image/png;base64,A' }];
        expect(omitToolResultImages({ content: 'shot', media }, notice)).toEqual({
            content: 'shot\n[omitted 1]'
        });
        expect(omitToolResultImages({ error: 'failed', is_error: true, media }, notice)).toEqual({
            error: 'failed\n[omitted 1]',
            is_error: true,
            content: 'failed\n[omitted 1]'
        });
    });
});
