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
    return msg.parts
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join(' ');
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

        it('assistant 图片消息 - 模型支持输入不支持输出时图片挪到紧随其后的 user 消息', () => {
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
            expect(result).toHaveLength(2);
            expect(result[0].role).toBe('assistant');
            expect(result[0].parts[0]).toEqual({ type: 'text', text: 'here is the image' });
            expect(result[0].parts.some((p) => p.type === 'media')).toBe(false);
            expect(result[1].role).toBe('user');
            expect(result[1]._converted).toBe(true);
            expect(result[1]._originalRole).toBe('assistant');
            expect(result[1].parts[1]).toEqual({
                type: 'media',
                media: 'image',
                url: 'data:image/png;base64,abc'
            });
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

        it('assistant 图片 - 工具调用与文件原样保留在 assistant 里', () => {
            const toolCall = { type: 'tool_call', id: 'tc1', name: 'fn', args: {}, result: 'ok' };
            const file = { type: 'file', name: 'a.pdf', mime: 'application/pdf', url: 'x' };
            const msgs = [
                message('assistant', [
                    { type: 'text', text: 'generated' },
                    { type: 'media', media: 'image', url: 'data:image/png;base64,abc' },
                    toolCall,
                    file
                ])
            ];
            const result = filterMessagesByCapabilities(msgs, {
                imageInput: true,
                imageOutput: false
            });
            expect(result[0].parts[2]).toBe(toolCall);
            expect(result[0].parts[3]).toBe(file);
            expect(result[1].role).toBe('user');
        });
    });

    describe('thinking 内容保留', () => {
        it('转换时思考块连同签名原样保留', () => {
            const thinking = { type: 'thinking', text: 'let me think...', signature: 'sig' };
            const msgs = [
                message('assistant', [
                    thinking,
                    { type: 'text', text: 'result' },
                    { type: 'media', media: 'image', url: 'data:image/png;base64,abc' }
                ])
            ];
            const result = filterMessagesByCapabilities(msgs, {
                imageInput: true,
                imageOutput: false
            });
            expect(result[0].role).toBe('assistant');
            expect(result[0].parts[0]).toBe(thinking);
        });

        it('删除图片时保留 thinking 与文本，图片换成原位置的说明', () => {
            const thinking = { type: 'thinking', text: 'thinking...', signature: 'sig' };
            const msgs = [
                message('assistant', [
                    thinking,
                    { type: 'text', text: 'text' },
                    { type: 'media', media: 'image', url: 'data:image/png;base64,abc' }
                ])
            ];
            const result = filterMessagesByCapabilities(msgs, {
                imageInput: false,
                imageOutput: false
            });
            expect(result[0].parts[0]).toBe(thinking);
            expect(result[0].parts[1]).toEqual({ type: 'text', text: 'text' });
            expect(result[0].parts[2].text).toContain('不支持显示');
        });
    });

    describe('附件与工具结果', () => {
        it('user 图片被删除时文本附件与 PDF 保留', () => {
            const pdf = { type: 'file', name: 'a.pdf', mime: 'application/pdf', url: 'data:x' };
            const msgs = [
                message('user', [
                    { type: 'text', text: 'see' },
                    { type: 'media', media: 'image', url: 'data:image/png;base64,abc' },
                    pdf
                ])
            ];
            const result = filterMessagesByCapabilities(msgs, {
                imageInput: false,
                imageOutput: false
            });
            expect(result[0].parts).toHaveLength(3);
            expect(result[0].parts[1].text).toContain('不支持图片理解');
            expect(result[0].parts[2]).toBe(pdf);
        });

        it('模型不支持图片输入时工具结果里的截图换成说明文字，原消息不变', () => {
            const call = {
                type: 'tool_call',
                id: 'tc1',
                name: 'screenshot',
                args: {},
                state: 'done',
                result: {
                    content: 'captured',
                    media: [{ type: 'image', url: 'data:image/png;base64,abc' }]
                }
            };
            const msgs = [message('assistant', [call])];
            const result = filterMessagesByCapabilities(msgs, {
                imageInput: false,
                imageOutput: false
            });
            expect(result[0].parts[0].result).toEqual({
                content: 'captured\n[工具返回了 1 张图片，当前模型不支持图片输入，已省略]'
            });
            expect(call.result.media).toHaveLength(1);
        });

        it('挪出的图片消息并进紧随其后的用户消息，不产生连续两条 user', () => {
            const msgs = [
                message('assistant', [
                    { type: 'text', text: 'drawn' },
                    { type: 'media', media: 'image', url: 'data:image/png;base64,abc' }
                ]),
                message('user', [{ type: 'text', text: 'make it blue' }])
            ];
            const result = filterMessagesByCapabilities(msgs, {
                imageInput: true,
                imageOutput: false
            });
            expect(result.map((m) => m.role)).toEqual(['assistant', 'user']);
            expect(result[1].parts.map((p) => p.type)).toEqual(['text', 'media', 'text']);
            expect(result[1].parts[2].text).toBe('make it blue');
            expect(msgs[1].parts).toHaveLength(1);
        });

        it('模型支持图片输入时工具结果不变', () => {
            const call = {
                type: 'tool_call',
                id: 'tc1',
                name: 'screenshot',
                args: {},
                result: { content: '', media: [{ type: 'image', url: 'data:image/png;base64,a' }] }
            };
            const msgs = [message('assistant', [call])];
            const result = filterMessagesByCapabilities(msgs, {
                imageInput: true,
                imageOutput: false
            });
            expect(result[0]).toBe(msgs[0]);
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
