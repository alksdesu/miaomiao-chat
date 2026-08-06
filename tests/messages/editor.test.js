/**
 * editor.js 内部 helper 测试
 * - preserveStructuralParts：按 thinking/text/media 原相对位置插入新内容，保留 tool_call/file 原顺序
 * - ensureTurnConsistency：跨 family 编辑守卫（claude/openclaw 清 _turn；openai-responses 仅 warn）
 *
 * 两个 helper 在 editor.js 中以 // @internal 标记 export，仅供测试 import
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// editor.js 在 import 时通过 eventBus.on 订阅事件，必须先把链路依赖 mock 干净
vi.mock('../../js/core/state.js', () => ({
    state: {
        messages: [],
        uploadedImages: [],
        messageStore: { findByEl: vi.fn(() => null), findIndexById: vi.fn(() => -1) }
    }
}));

vi.mock('../../js/core/elements.js', () => ({
    elements: {}
}));

vi.mock('../../js/core/events.js', () => ({
    eventBus: { on: vi.fn(), off: vi.fn(), emit: vi.fn() }
}));

vi.mock('../../js/core/state-mutations.js', () => ({
    removeMessagesAfter: vi.fn(),
    popLastAssistantMessage: vi.fn(),
    updateMessageAt: vi.fn()
}));

vi.mock('../../js/utils/dialogs.js', () => ({
    showConfirmDialog: vi.fn(() => Promise.resolve(true))
}));

vi.mock('../../js/tools/message-compat.js', () => ({
    canEditMessage: vi.fn(() => true),
    safeDeleteMessage: vi.fn(() => true)
}));

vi.mock('../../js/api/format-converter.js', () => ({
    clearThoughtSignatures: vi.fn(),
    hasThoughtSignatures: vi.fn(() => false)
}));

vi.mock('../../js/utils/file-helpers.js', () => ({
    categorizeFile: vi.fn(() => 'other')
}));

vi.mock('../../js/utils/helpers.js', () => ({
    escapeHtml: (s) => String(s),
    generateMessageId: () => 'msg_mock_' + Math.random().toString(36).slice(2),
    generateId: (prefix) => `${prefix}_mock`
}));

vi.mock('../../js/messages/renderer.js', () => ({
    rerenderMessageContent: vi.fn()
}));

vi.mock('../../js/messages/user-content-parser.js', () => ({
    parseUserContent: vi.fn(() => ({ text: '', images: [], files: [] }))
}));

vi.mock('../../js/utils/logger.js', () => ({
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

import { PartType, MediaKind } from '../../js/messages/schema.js';
import {
    buildAttachmentParts,
    preserveStructuralParts,
    ensureTurnConsistency
} from '../../js/messages/editor.js';

// ============================================================
// preserveStructuralParts
// ============================================================

describe('preserveStructuralParts', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('preserves tool_call original position when text only is replaced', () => {
        const oldParts = [
            { type: PartType.TEXT, text: 'old' },
            { type: PartType.TOOL_CALL, id: 'tc_1', name: 'shell', args: {}, state: 'done' }
        ];
        const out = preserveStructuralParts(oldParts, { newText: 'NEW' });

        // text 落在原位置（index 0），tool_call 保留原 index 1
        expect(out).toHaveLength(2);
        expect(out[0]).toMatchObject({ type: PartType.TEXT, text: 'NEW' });
        expect(out[1]).toMatchObject({ type: PartType.TOOL_CALL, id: 'tc_1', name: 'shell' });
    });

    it('preserves file original position', () => {
        const oldParts = [
            { type: PartType.FILE, name: 'a.pdf', mime: 'application/pdf', url: 'http://x/a.pdf' },
            { type: PartType.TEXT, text: 'old' }
        ];
        const out = preserveStructuralParts(oldParts, { newText: 'NEW' });

        // file 保留原相对位置（在 text 之前）
        expect(out).toHaveLength(2);
        expect(out[0]).toMatchObject({ type: PartType.FILE, name: 'a.pdf' });
        expect(out[1]).toMatchObject({ type: PartType.TEXT, text: 'NEW' });
    });

    it('inserts thinking before first existing thinking', () => {
        const oldParts = [
            { type: PartType.THINKING, text: 'old-think', signature: 'sig-A' },
            { type: PartType.TEXT, text: 'old-text' }
        ];
        const out = preserveStructuralParts(oldParts, {
            newThinking: 'NEW-THINK',
            newText: 'NEW-TEXT'
        });

        // thinking 落在第一个原 thinking 的位置；不保留旧 signature
        expect(out).toHaveLength(2);
        expect(out[0]).toMatchObject({
            type: PartType.THINKING,
            text: 'NEW-THINK',
            _edited: true
        });
        expect(out[0].signature).toBeUndefined();
        expect(out[1]).toMatchObject({ type: PartType.TEXT, text: 'NEW-TEXT' });
    });

    it('inserts text at first existing text position', () => {
        const oldParts = [
            { type: PartType.TEXT, text: 'first' },
            { type: PartType.TEXT, text: 'second' },
            { type: PartType.TEXT, text: 'third' }
        ];
        const out = preserveStructuralParts(oldParts, { newText: 'ONLY' });

        // 多个旧 text 被合并为单个新 text（落在第一个位置）
        expect(out).toHaveLength(1);
        expect(out[0]).toMatchObject({ type: PartType.TEXT, text: 'ONLY' });
    });

    it('inserts new images at first existing media position', () => {
        const oldParts = [
            { type: PartType.TEXT, text: 't' },
            {
                type: PartType.MEDIA,
                media: MediaKind.IMAGE,
                url: 'data:image/png;base64,OLD',
                mime: 'image/png'
            },
            {
                type: PartType.MEDIA,
                media: MediaKind.IMAGE,
                url: 'data:image/png;base64,OLD2',
                mime: 'image/png'
            }
        ];
        const newImages = [
            { dataUrl: 'data:image/jpeg;base64,A', mimeType: 'image/jpeg' },
            { dataUrl: 'data:image/jpeg;base64,B', mimeType: 'image/jpeg' }
        ];
        const out = preserveStructuralParts(oldParts, { newText: 't', newImages });

        // 旧 media 全部被新 images 替换；新 images 落在第一个旧 media 的位置
        const mediaParts = out.filter((p) => p.type === PartType.MEDIA);
        expect(mediaParts).toHaveLength(2);
        expect(mediaParts[0]).toMatchObject({
            type: PartType.MEDIA,
            media: MediaKind.IMAGE,
            url: 'data:image/jpeg;base64,A',
            mime: 'image/jpeg'
        });
        expect(mediaParts[1].url).toBe('data:image/jpeg;base64,B');
        // text 保留
        expect(out.find((p) => p.type === PartType.TEXT)).toMatchObject({ text: 't' });
    });

    it('保留外置图片的 mediaId，不把临时 Blob URL 写回消息', () => {
        const out = preserveStructuralParts(
            [{ type: PartType.MEDIA, media: MediaKind.IMAGE, mediaId: 'media-1' }],
            {
                newText: 'edited',
                newImages: [
                    {
                        dataUrl: 'blob:temporary-preview',
                        mimeType: 'image/png',
                        mediaId: 'media-1'
                    }
                ]
            }
        );

        expect(out.find((part) => part.type === PartType.MEDIA)).toEqual({
            type: PartType.MEDIA,
            media: MediaKind.IMAGE,
            mime: 'image/png',
            mediaId: 'media-1'
        });
    });

    it('prepends thinking when no thinking exists in oldParts', () => {
        const oldParts = [{ type: PartType.TEXT, text: 'old' }];
        const out = preserveStructuralParts(oldParts, {
            newThinking: 'NEW-THINK',
            newText: 'NEW-TEXT'
        });

        // 旧 parts 无 thinking → 新 thinking 走 prefix 路径，落在最前
        expect(out).toHaveLength(2);
        expect(out[0]).toMatchObject({ type: PartType.THINKING, text: 'NEW-THINK', _edited: true });
        expect(out[1]).toMatchObject({ type: PartType.TEXT, text: 'NEW-TEXT' });
    });

    it('marks new thinking with _edited:true', () => {
        const oldParts = [{ type: PartType.TEXT, text: 'x' }];
        const out = preserveStructuralParts(oldParts, {
            newThinking: 'reasoning',
            newText: 'x'
        });
        const thinking = out.find((p) => p.type === PartType.THINKING);
        expect(thinking).toBeDefined();
        expect(thinking._edited).toBe(true);
    });

    it('preserves tool_call after thinking and before text (real Claude case)', () => {
        // 真实 Claude 场景：thinking → tool_call → tool_result(隐式) → text
        const oldParts = [
            { type: PartType.THINKING, text: 'old-think', signature: 'sig-A' },
            {
                type: PartType.TOOL_CALL,
                id: 'tc_1',
                name: 'web_search',
                args: { q: 'x' },
                state: 'done',
                result: 'r'
            },
            { type: PartType.TEXT, text: 'old-answer' }
        ];
        const out = preserveStructuralParts(oldParts, {
            newThinking: 'NEW-THINK',
            newText: 'NEW-ANSWER'
        });

        // 顺序保留：thinking(新) → tool_call(原) → text(新)
        expect(out).toHaveLength(3);
        expect(out[0]).toMatchObject({ type: PartType.THINKING, text: 'NEW-THINK', _edited: true });
        expect(out[1]).toMatchObject({ type: PartType.TOOL_CALL, id: 'tc_1', name: 'web_search' });
        expect(out[1].result).toBe('r');
        expect(out[2]).toMatchObject({ type: PartType.TEXT, text: 'NEW-ANSWER' });
    });
});

describe('buildAttachmentParts', () => {
    it('保留外置文件引用', () => {
        const parts = buildAttachmentParts([
            {
                name: 'notes.txt',
                type: 'text/plain',
                category: 'text',
                data: 'blob:temporary-preview',
                mediaId: 'media-file'
            }
        ]);

        expect(parts).toEqual([
            {
                type: PartType.FILE,
                name: 'notes.txt',
                mime: 'text/plain',
                encoding: 'text',
                mediaId: 'media-file'
            }
        ]);
    });
});

// ============================================================
// ensureTurnConsistency
// ============================================================

describe('ensureTurnConsistency', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('returns ok=true and clears _turn when format=claude + hasMultiTurn', () => {
        const msg = {
            role: 'assistant',
            parts: [
                { type: PartType.THINKING, text: 't1', _turn: 1 },
                { type: PartType.TEXT, text: 'a1', _turn: 1 },
                { type: PartType.THINKING, text: 't2', _turn: 2 },
                { type: PartType.TEXT, text: 'a2', _turn: 2 }
            ]
        };
        const result = ensureTurnConsistency(msg, 'claude');

        expect(result).toEqual({ ok: true });
        // _turn 全部被 delete
        for (const p of msg.parts) {
            expect(p._turn).toBeUndefined();
        }
    });

    it('returns ok=true and clears _turn when format=openclaw', () => {
        const msg = {
            role: 'assistant',
            parts: [
                { type: PartType.TEXT, text: 'a', _turn: 1 },
                { type: PartType.TEXT, text: 'b', _turn: 2 }
            ]
        };
        const result = ensureTurnConsistency(msg, 'openclaw');

        expect(result).toEqual({ ok: true });
        expect(msg.parts.every((p) => p._turn === undefined)).toBe(true);
    });

    it('returns warning=reasoning_chain_at_risk when format=openai-responses + hasMultiTurn', () => {
        const msg = {
            role: 'assistant',
            parts: [
                { type: PartType.TEXT, text: 'a', _turn: 1 },
                { type: PartType.TEXT, text: 'b', _turn: 2 }
            ]
        };
        const result = ensureTurnConsistency(msg, 'openai-responses');

        expect(result.ok).toBe(true);
        expect(result.warning).toBe('reasoning_chain_at_risk');
        // _turn 应保留（reasoningItems 一一对应）
        expect(msg.parts[0]._turn).toBe(1);
        expect(msg.parts[1]._turn).toBe(2);
    });

    it('returns ok=true unchanged when no _turn in parts', () => {
        const msg = {
            role: 'assistant',
            parts: [
                { type: PartType.THINKING, text: 't' },
                { type: PartType.TEXT, text: 'a' }
            ]
        };
        const result = ensureTurnConsistency(msg, 'claude');

        expect(result).toEqual({ ok: true });
        // 无任何修改
        expect(msg.parts[0]._turn).toBeUndefined();
        expect(msg.parts[1]._turn).toBeUndefined();
    });

    it('clears _turn from meta.raw.openai.reasoningItems too when claude family', () => {
        const msg = {
            role: 'assistant',
            parts: [{ type: PartType.TEXT, text: 'a', _turn: 1 }],
            meta: {
                raw: {
                    openai: {
                        reasoningItems: [
                            { id: 'r1', type: 'reasoning', _turn: 1 },
                            { id: 'r2', type: 'reasoning', _turn: 2 },
                            null, // 防御性：null 不应报错
                            'string-item' // 非对象不应报错
                        ]
                    }
                }
            }
        };
        const result = ensureTurnConsistency(msg, 'claude');

        expect(result).toEqual({ ok: true });
        const items = msg.meta.raw.openai.reasoningItems;
        expect(items[0]._turn).toBeUndefined();
        expect(items[1]._turn).toBeUndefined();
        // null / string 元素未被破坏
        expect(items[2]).toBeNull();
        expect(items[3]).toBe('string-item');
    });
});
