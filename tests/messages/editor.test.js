/**
 * editor.js 内部 helper 测试
 * - preserveStructuralParts：按 thinking/text/media 原相对位置插入新内容，保留 tool_call/file 原顺序，
 *   没改动的思考与文本原样保留
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
import { buildAttachmentParts, preserveStructuralParts } from '../../js/messages/editor.js';

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

    it('思考没改动时原样保留全部思考块（签名、_turn 不丢）', () => {
        const oldParts = [
            { type: PartType.THINKING, text: 'plan', signature: 'sig-A' },
            { type: PartType.THINKING, text: '', signature: 'sig-B', _turn: 1 },
            { type: PartType.TEXT, text: 'answer', _turn: 1 }
        ];
        const out = preserveStructuralParts(oldParts, {
            newThinking: 'plan',
            newText: 'edited answer'
        });

        expect(out[0]).toBe(oldParts[0]);
        expect(out[1]).toBe(oldParts[1]);
        expect(out[2]).toEqual({ type: PartType.TEXT, text: 'edited answer', _turn: 1 });
    });

    it('多轮消息的文本改动后放回最后一轮，原样未改的文本不动', () => {
        const oldParts = [
            { type: PartType.TEXT, text: 'checking' },
            { type: PartType.TEXT, text: 'final', _turn: 2 },
            { type: PartType.TOOL_CALL, id: 'tc_1', name: 'search', args: {}, state: 'done' },
            {
                type: PartType.TOOL_CALL,
                id: 'tc_2',
                name: 'fetch',
                args: {},
                state: 'done',
                _turn: 1
            }
        ];
        const unchanged = preserveStructuralParts(oldParts, { newText: 'checkingfinal' });
        expect(unchanged).toEqual(oldParts);

        const edited = preserveStructuralParts(oldParts, { newText: 'rewritten' });
        expect(edited.filter((p) => p.type === PartType.TEXT)).toEqual([
            { type: PartType.TEXT, text: 'rewritten', _turn: 2 }
        ]);
        expect(edited.filter((p) => p.type === PartType.TOOL_CALL)).toEqual(oldParts.slice(2));
    });

    it('没有文本的消息新增文本时落在最后一轮', () => {
        const oldParts = [
            { type: PartType.TOOL_CALL, id: 'tc_1', name: 'search', args: {}, state: 'done' },
            {
                type: PartType.TOOL_CALL,
                id: 'tc_2',
                name: 'fetch',
                args: {},
                state: 'done',
                _turn: 1
            }
        ];
        const out = preserveStructuralParts(oldParts, { newText: 'added' });
        expect(out[0]).toEqual({ type: PartType.TEXT, text: 'added', _turn: 1 });
    });

    it('文本清空时不留下空文本 part', () => {
        const oldParts = [
            { type: PartType.TEXT, text: 'old' },
            {
                type: PartType.MEDIA,
                media: MediaKind.IMAGE,
                url: 'data:image/png;base64,A',
                mime: 'image/png'
            }
        ];
        const out = preserveStructuralParts(oldParts, {
            newText: '',
            newImages: [{ dataUrl: 'data:image/png;base64,A', mimeType: 'image/png' }]
        });
        expect(out.some((p) => p.type === PartType.TEXT)).toBe(false);
        expect(out).toHaveLength(1);
    });

    it('没有传入思考时思考块保持不变，留空则删除', () => {
        const oldParts = [
            { type: PartType.THINKING, text: 'keep', signature: 'sig' },
            { type: PartType.TEXT, text: 't' }
        ];
        expect(preserveStructuralParts(oldParts, { newText: 't' })[0]).toBe(oldParts[0]);
        expect(
            preserveStructuralParts(oldParts, { newThinking: null, newText: 't' }).some(
                (p) => p.type === PartType.THINKING
            )
        ).toBe(false);
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
// 编辑后清除结束原因
// ============================================================

describe('updateMessageContent 结束原因', () => {
    beforeEach(async () => {
        vi.clearAllMocks();
        const { updateMessageAt } = await import('../../js/core/state-mutations.js');
        const { state } = await import('../../js/core/state.js');
        updateMessageAt.mockImplementation((idx, updates) => {
            state.messages[idx] = { ...state.messages[idx], ...updates };
        });
    });

    it('编辑后移除消息与选中回复上的结束原因，其余 meta 保留', async () => {
        const { state } = await import('../../js/core/state.js');
        const { updateMessageContent } = await import('../../js/messages/editor.js');
        const stop = { kind: 'max_tokens', reason: 'length' };
        state.messages = [
            {
                id: 'm1',
                role: 'assistant',
                parts: [{ type: PartType.TEXT, text: '被截断的回' }],
                meta: { model: 'gpt', raw: {}, stop },
                replies: {
                    selected: 0,
                    all: [
                        {
                            parts: [{ type: PartType.TEXT, text: '被截断的回' }],
                            meta: { model: 'gpt', raw: {}, stop }
                        }
                    ]
                }
            }
        ];

        updateMessageContent(0, '补全后的回答', 'assistant');

        const msg = state.messages[0];
        expect(msg.meta).toEqual({ model: 'gpt', raw: {} });
        expect(msg.replies.all[0].meta).toEqual({ model: 'gpt', raw: {} });
        expect(msg.replies.all[0].parts).toEqual([
            expect.objectContaining({ type: PartType.TEXT, text: '补全后的回答' })
        ]);
    });

    it('没有结束原因时不改写 meta', async () => {
        const { state } = await import('../../js/core/state.js');
        const { updateMessageContent } = await import('../../js/messages/editor.js');
        const { updateMessageAt } = await import('../../js/core/state-mutations.js');
        const meta = { model: 'gpt', raw: {} };
        state.messages = [
            { id: 'm1', role: 'assistant', parts: [{ type: PartType.TEXT, text: 'a' }], meta }
        ];

        updateMessageContent(0, 'b', 'assistant');

        expect(updateMessageAt.mock.calls[0][1]).not.toHaveProperty('meta');
        expect(state.messages[0].meta).toBe(meta);
    });
});
