/**
 * message-filter.js 消息过滤测试
 */
import { describe, it, expect } from 'vitest';

import { filterMessagesByCapabilities } from '../../js/utils/message-filter.js';

// 辅助函数
function message(role, parts) {
    return { _schemaVersion: 1, role, parts };
}

function getText(msg) {
    return msg.parts.find((part) => part.type === 'text')?.text || '';
}

// ========== filterMessagesByCapabilities ==========

describe('filterMessagesByCapabilities', () => {
    it('无能力配置时返回原数组', () => {
        const msgs = [message('user', [{ type: 'text', text: 'hello' }])];
        const result = filterMessagesByCapabilities(msgs, null);
        expect(result).toBe(msgs);
    });

    it('system 消息不被修改', () => {
        const msgs = [
            {
                role: 'system',
                parts: [{ type: 'media', media: 'image', url: 'data:image/png;base64,abc' }]
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
                message('user', [{ type: 'text', text: 'hello' }]),
                message('assistant', [{ type: 'text', text: 'hi' }])
            ];
            const result = filterMessagesByCapabilities(msgs, {
                imageInput: true,
                imageOutput: false
            });
            expect(result[0]).toBe(msgs[0]);
            expect(result[1]).toBe(msgs[1]);
        });
    });

    describe('标准图片消息', () => {
        it('user 图片消息 - 模型支持 vision 时保留', () => {
            const msgs = [
                message('user', [
                    { type: 'text', text: 'look at this' },
                    { type: 'media', media: 'image', url: 'data:image/png;base64,abc' }
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
                message('user', [
                    { type: 'text', text: 'look' },
                    { type: 'media', media: 'image', url: 'data:image/png;base64,abc' }
                ])
            ];
            const result = filterMessagesByCapabilities(msgs, {
                imageInput: false,
                imageOutput: false
            });
            expect(result[0].role).toBe('user');
            expect(getText(result[0])).toContain('look');
            expect(getText(result[0])).toContain('不支持图片理解');
        });

        it('assistant 图片消息 - 模型支持输入不支持输出时转为 user', () => {
            const msgs = [
                message('assistant', [
                    { type: 'text', text: 'here is the image' },
                    { type: 'media', media: 'image', url: 'data:image/png;base64,abc' }
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
                message('assistant', [
                    { type: 'text', text: 'generated image' },
                    { type: 'media', media: 'image', url: 'data:image/png;base64,abc' }
                ])
            ];
            const result = filterMessagesByCapabilities(msgs, {
                imageInput: false,
                imageOutput: false
            });
            expect(result[0].role).toBe('assistant');
            expect(getText(result[0])).toContain('generated image');
            expect(getText(result[0])).toContain('不支持显示');
        });

        it('assistant 图片消息 - 模型支持图片输出时保留', () => {
            const msgs = [
                message('assistant', [
                    { type: 'text', text: 'here' },
                    { type: 'media', media: 'image', url: 'data:image/png;base64,abc' }
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
                message('user', [
                    { type: 'text', text: 'look' },
                    { type: 'media', media: 'image', url: 'data:image/png;base64,abc' }
                ])
            ];
            const result = filterMessagesByCapabilities(msgs, {
                imageInput: false,
                imageOutput: false
            });
            expect(getText(result[0])).toContain('look');
        });

        it('assistant 图片 - 模型支持输入不支持输出时转为 user', () => {
            const msgs = [
                message('assistant', [
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
                message('assistant', [
                    { type: 'thinking', text: 'let me think...' },
                    { type: 'text', text: 'result' },
                    { type: 'media', media: 'image', url: 'data:image/png;base64,abc' }
                ])
            ];
            const result = filterMessagesByCapabilities(msgs, {
                imageInput: true,
                imageOutput: false
            });
            expect(result[0].role).toBe('user');
            // 转换后的内容应包含思维链
            expect(getText(result[0])).toContain('思考过程');
            expect(getText(result[0])).toContain('let me think...');
        });

        it('删除图片时保留 thinking', () => {
            const msgs = [
                message('assistant', [
                    { type: 'thinking', text: 'thinking...' },
                    { type: 'text', text: 'text' },
                    { type: 'media', media: 'image', url: 'data:image/png;base64,abc' }
                ])
            ];
            const result = filterMessagesByCapabilities(msgs, {
                imageInput: false,
                imageOutput: false
            });
            expect(getText(result[0])).toContain('thinking...');
            expect(getText(result[0])).toContain('text');
        });
    });

    describe('多条消息混合', () => {
        it('正确处理混合消息', () => {
            const msgs = [
                message('system', [{ type: 'text', text: 'system prompt' }]),
                message('user', [{ type: 'text', text: 'hello' }]),
                message('user', [
                    { type: 'text', text: 'image here' },
                    { type: 'media', media: 'image', url: 'data:image/png;base64,abc' }
                ]),
                message('assistant', [{ type: 'text', text: 'text reply' }])
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
            expect(getText(result[2])).toContain('image here');
            // 纯文本 assistant 不变
            expect(result[3]).toBe(msgs[3]);
        });
    });

    describe('边界情况', () => {
        it('纯文本 assistant 消息不被修改', () => {
            const msgs = [message('assistant', [{ type: 'text', text: 'just text' }])];
            const result = filterMessagesByCapabilities(msgs, {
                imageInput: false,
                imageOutput: false
            });
            expect(result[0]).toBe(msgs[0]);
        });

        it('空 parts 不被修改', () => {
            const msgs = [message('user', [])];
            const result = filterMessagesByCapabilities(msgs, {
                imageInput: false,
                imageOutput: false
            });
            expect(result[0]).toBe(msgs[0]);
        });
    });
});
