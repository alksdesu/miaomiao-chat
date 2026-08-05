// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { openaiImageAdapter } from '../../../js/api/adapters/openai-image-adapter.js';
import { MediaKind, PartType, Role } from '../../../js/messages/schema.js';

const userMessage = (parts) => ({ role: Role.USER, parts });

describe('openai-image adapter', () => {
    it('只提取最新用户消息并保持自定义模型名原样', () => {
        const messages = openaiImageAdapter.partsToAPIMessages([
            userMessage([{ type: PartType.TEXT, text: '旧提示词' }]),
            { role: Role.ASSISTANT, parts: [{ type: PartType.TEXT, text: '旧回答' }] },
            userMessage([{ type: PartType.TEXT, text: '新提示词' }])
        ]);

        const body = openaiImageAdapter.buildRequestBody({
            messages,
            model: 'vendor/custom-image:model@2',
            modelParams: { quality: 'high' },
            state: { streamEnabled: false }
        });
        expect(body).toEqual({
            model: 'vendor/custom-image:model@2',
            prompt: '新提示词',
            stream: false,
            quality: 'high'
        });
    });

    it('图片附件构建 edits JSON，最多接受 16 张', () => {
        const parts = [
            { type: PartType.TEXT, text: '调整图片' },
            ...Array.from({ length: 16 }, (_, index) => ({
                type: PartType.MEDIA,
                media: MediaKind.IMAGE,
                url: `data:image/png;base64,image-${index}`
            }))
        ];
        const messages = openaiImageAdapter.partsToAPIMessages([userMessage(parts)]);
        const body = openaiImageAdapter.buildRequestBody({
            messages,
            model: 'custom-model',
            modelParams: { input_fidelity: 'high' },
            state: { streamEnabled: true }
        });

        expect(body.images).toHaveLength(16);
        expect(body.input_fidelity).toBe('high');
        expect(
            openaiImageAdapter.resolveEndpoint(
                'https://api.openai.com/v1/images/generations',
                '',
                true,
                body
            )
        ).toBe('https://api.openai.com/v1/images/edits');
    });

    it('超过 16 张编辑图片时拒绝请求', () => {
        const parts = [
            { type: PartType.TEXT, text: '调整图片' },
            ...Array.from({ length: 17 }, (_, index) => ({
                type: PartType.MEDIA,
                media: MediaKind.IMAGE,
                url: `data:image/png;base64,image-${index}`
            }))
        ];
        expect(() => openaiImageAdapter.partsToAPIMessages([userMessage(parts)])).toThrow('16');
    });

    it('纯生成请求去除 input_fidelity 并使用 generations 端点', () => {
        const body = openaiImageAdapter.buildRequestBody({
            messages: [{ prompt: '画图', images: [] }],
            model: 'anything',
            modelParams: { input_fidelity: 'high' },
            state: { streamEnabled: false }
        });

        expect(body).not.toHaveProperty('input_fidelity');
        expect(
            openaiImageAdapter.resolveEndpoint('https://proxy.example/v1', '', false, body)
        ).toBe('https://proxy.example/v1/images/generations');
    });

    it('完整自定义 URL 原样使用，不擅自补全标准图片路径', () => {
        const customEndpoint =
            'https://proxy.example/custom/image-route?channel=gpt-image-2&mode=generate';

        expect(
            openaiImageAdapter.resolveEndpoint(customEndpoint, '', false, {
                prompt: '生成图片'
            })
        ).toBe(customEndpoint);
        expect(
            openaiImageAdapter.resolveEndpoint(customEndpoint, '', false, {
                prompt: '编辑图片',
                images: [{ image_url: 'data:image/png;base64,abc' }]
            })
        ).toBe(customEndpoint);
    });

    it('解析 Base64、URL、多图和 usage', () => {
        const reply = openaiImageAdapter.parseResponse({
            output_format: 'webp',
            usage: { total_tokens: 12 },
            data: [{ b64_json: 'UklGRtest' }, { url: 'https://example.com/image.png' }]
        });

        expect(reply.contentParts).toHaveLength(2);
        expect(reply.contentParts[0]).toMatchObject({
            url: 'data:image/webp;base64,UklGRtest',
            mimeType: 'image/webp',
            complete: true
        });
        expect(reply.usage).toEqual({ total_tokens: 12 });
    });

    it('缺少模型或提示词时拒绝请求', () => {
        expect(() =>
            openaiImageAdapter.buildRequestBody({
                messages: [{ prompt: '画图', images: [] }],
                model: '',
                modelParams: {},
                state: { streamEnabled: false }
            })
        ).toThrow('模型');
        expect(() =>
            openaiImageAdapter.buildRequestBody({
                messages: [{ prompt: '', images: [] }],
                model: 'custom',
                modelParams: {},
                state: { streamEnabled: false }
            })
        ).toThrow('提示词');
    });
});
