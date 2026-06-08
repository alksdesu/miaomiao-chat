/**
 * message-filter.js 消息过滤测试
 */
import { describe, it, expect, vi } from 'vitest';

// mock schema.js 的依赖
vi.mock('../../js/messages/schema.js', () => ({
    PartType: {
        TEXT: 'text',
        THINKING: 'thinking',
        MEDIA: 'media',
        TOOL_CALL: 'tool_call',
        FILE: 'file'
    },
    MediaKind: {
        IMAGE: 'image',
        VIDEO: 'video',
        AUDIO: 'audio'
    },
    hasParts: (msg) => Array.isArray(msg.parts) && msg.parts.length > 0 && msg._schemaVersion,
    // QA Round 2 F1: convertAssistantImageToUser / removeImagesFromMessage 现需重建 parts[] 一致性
    textPart: (text) => ({ type: 'text', text }),
    mediaPart: (kind, url, mime = '') => ({ type: 'media', media: kind, url, mime })
}));

import { filterMessagesByCapabilities } from '../../js/utils/message-filter.js';

// 辅助函数
function newFormatMsg(role, parts) {
    return { _schemaVersion: 1, role, parts, content: undefined };
}

function oldFormatMsg(role, content) {
    return { role, content };
}

// ========== filterMessagesByCapabilities ==========

describe('filterMessagesByCapabilities', () => {
    it('无能力配置时返回原数组', () => {
        const msgs = [{ role: 'user', content: 'hello' }];
        const result = filterMessagesByCapabilities(msgs, null);
        expect(result).toBe(msgs);
    });

    it('system 消息不被修改', () => {
        const msgs = [
            {
                role: 'system',
                content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } }]
            }
        ];
        const result = filterMessagesByCapabilities(msgs, {
            imageInput: false,
            imageOutput: false
        });
        expect(result[0]).toBe(msgs[0]);
    });

    describe('纯文本消息', () => {
        it('文本消息不被修改', () => {
            const msgs = [
                { role: 'user', content: 'hello' },
                { role: 'assistant', content: 'hi' }
            ];
            const result = filterMessagesByCapabilities(msgs, {
                imageInput: true,
                imageOutput: false
            });
            expect(result[0]).toBe(msgs[0]);
            expect(result[1]).toBe(msgs[1]);
        });
    });

    describe('旧格式图片消息', () => {
        it('user 图片消息 - 模型支持 vision 时保留', () => {
            const msgs = [
                oldFormatMsg('user', [
                    { type: 'text', text: 'look at this' },
                    { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } }
                ])
            ];
            const result = filterMessagesByCapabilities(msgs, {
                imageInput: true,
                imageOutput: false
            });
            expect(result[0]).toBe(msgs[0]);
        });

        it('user 图片消息 - 模型不支持 vision 时删除图片', () => {
            const msgs = [
                oldFormatMsg('user', [
                    { type: 'text', text: 'look' },
                    { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } }
                ])
            ];
            const result = filterMessagesByCapabilities(msgs, {
                imageInput: false,
                imageOutput: false
            });
            expect(result[0].role).toBe('user');
            expect(typeof result[0].content).toBe('string');
            expect(result[0].content).toContain('look');
            expect(result[0].content).toContain('不支持图片理解');
        });

        it('assistant 图片消息 - 模型支持输入不支持输出时转为 user', () => {
            const msgs = [
                oldFormatMsg('assistant', [
                    { type: 'text', text: 'here is the image' },
                    { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } }
                ])
            ];
            const result = filterMessagesByCapabilities(msgs, {
                imageInput: true,
                imageOutput: false
            });
            expect(result[0].role).toBe('user');
            expect(result[0]._converted).toBe(true);
            expect(result[0]._originalRole).toBe('assistant');
        });

        it('assistant 图片消息 - 模型都不支持时删除图片保留文本', () => {
            const msgs = [
                oldFormatMsg('assistant', [
                    { type: 'text', text: 'generated image' },
                    { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } }
                ])
            ];
            const result = filterMessagesByCapabilities(msgs, {
                imageInput: false,
                imageOutput: false
            });
            expect(result[0].role).toBe('assistant');
            expect(typeof result[0].content).toBe('string');
            expect(result[0].content).toContain('generated image');
            expect(result[0].content).toContain('不支持显示');
        });

        it('assistant 图片消息 - 模型支持图片输出时保留', () => {
            const msgs = [
                oldFormatMsg('assistant', [
                    { type: 'text', text: 'here' },
                    { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } }
                ])
            ];
            const result = filterMessagesByCapabilities(msgs, {
                imageInput: true,
                imageOutput: true
            });
            expect(result[0]).toBe(msgs[0]);
        });
    });

    describe('新格式图片消息 (parts)', () => {
        it('user 图片 - 模型不支持时删除', () => {
            const msgs = [
                newFormatMsg('user', [
                    { type: 'text', text: 'look' },
                    { type: 'media', media: 'image', url: 'data:image/png;base64,abc' }
                ])
            ];
            const result = filterMessagesByCapabilities(msgs, {
                imageInput: false,
                imageOutput: false
            });
            expect(typeof result[0].content).toBe('string');
            expect(result[0].content).toContain('look');
        });

        it('assistant 图片 - 模型支持输入不支持输出时转为 user', () => {
            const msgs = [
                newFormatMsg('assistant', [
                    { type: 'text', text: 'generated' },
                    { type: 'media', media: 'image', url: 'data:image/png;base64,abc' }
                ])
            ];
            const result = filterMessagesByCapabilities(msgs, {
                imageInput: true,
                imageOutput: false
            });
            expect(result[0].role).toBe('user');
            expect(result[0]._converted).toBe(true);
        });
    });

    describe('thinking 内容保留', () => {
        it('转换时保留 thinking 内容', () => {
            const msgs = [
                oldFormatMsg('assistant', [
                    { type: 'thinking', text: 'let me think...' },
                    { type: 'text', text: 'result' },
                    { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } }
                ])
            ];
            const result = filterMessagesByCapabilities(msgs, {
                imageInput: true,
                imageOutput: false
            });
            expect(result[0].role).toBe('user');
            // 转换后的内容应包含思维链
            const content = result[0].content;
            const textPart = content.find((p) => p.type === 'text');
            expect(textPart.text).toContain('思考过程');
            expect(textPart.text).toContain('let me think...');
        });

        it('删除图片时保留 thinking', () => {
            const msgs = [
                oldFormatMsg('assistant', [
                    { type: 'thinking', text: 'thinking...' },
                    { type: 'text', text: 'text' },
                    { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } }
                ])
            ];
            const result = filterMessagesByCapabilities(msgs, {
                imageInput: false,
                imageOutput: false
            });
            expect(result[0].content).toContain('thinking...');
            expect(result[0].content).toContain('text');
        });
    });

    describe('多条消息混合', () => {
        it('正确处理混合消息', () => {
            const msgs = [
                { role: 'system', content: 'system prompt' },
                { role: 'user', content: 'hello' },
                oldFormatMsg('user', [
                    { type: 'text', text: 'image here' },
                    { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } }
                ]),
                { role: 'assistant', content: 'text reply' }
            ];
            const result = filterMessagesByCapabilities(msgs, {
                imageInput: false,
                imageOutput: false
            });
            // system 不变
            expect(result[0]).toBe(msgs[0]);
            // 纯文本不变
            expect(result[1]).toBe(msgs[1]);
            // 图片消息被过滤
            expect(typeof result[2].content).toBe('string');
            // 纯文本 assistant 不变
            expect(result[3]).toBe(msgs[3]);
        });
    });

    describe('边界情况', () => {
        it('字符串 content 的 assistant 消息不被修改', () => {
            const msgs = [{ role: 'assistant', content: 'just text' }];
            const result = filterMessagesByCapabilities(msgs, {
                imageInput: false,
                imageOutput: false
            });
            expect(result[0]).toBe(msgs[0]);
        });

        it('空数组 content 不被修改', () => {
            const msgs = [{ role: 'user', content: [] }];
            const result = filterMessagesByCapabilities(msgs, {
                imageInput: false,
                imageOutput: false
            });
            expect(result[0]).toBe(msgs[0]);
        });
    });
});
