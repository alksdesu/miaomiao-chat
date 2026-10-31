/**
 * sync.js 消息同步测试
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// 提供 global document mock（addModelBadge 使用 setTimeout 调用 document）
globalThis.document = {
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => ({ className: '', textContent: '', title: '' })
};

// mock 依赖
vi.mock('../../js/core/state.js', () => ({
    state: {
        messages: [],
        currentSessionId: 'session-1',
        selectedModel: 'gpt-4o',
        isSavingContinuation: false,
        currentAssistantMessage: null,
        sessionDirty: false,
        isToolCallPending: false,
        messageIdMap: new Map()
    }
}));

vi.mock('../../js/core/events.js', () => ({
    eventBus: { emit: vi.fn(), on: vi.fn() }
}));

vi.mock('../../js/core/state-mutations.js', () => ({
    pushMessage: vi.fn(),
    updateMessageAt: vi.fn()
}));

// pushMessage 需要实际修改 state.messages 以让 saveAssistantMessage 计算 index
// 在 import 之后的 beforeEach 中设置 implementation

vi.mock('../../js/providers/manager.js', () => ({
    getCurrentProvider: vi.fn(() => ({ name: 'TestProvider', apiFormat: 'openai' })),
    getModelDisplayName: vi.fn((modelId) => modelId)
}));

vi.mock('../../js/utils/media.js', () => ({
    isVideoMimeType: vi.fn((mime) => mime && mime.startsWith('video/'))
}));

vi.mock('../../js/utils/helpers.js', () => ({
    generateMessageId: () => 'msg_mock_' + Math.random().toString(36).slice(2),
    generateId: (prefix) => `${prefix}_mock_${Math.random().toString(36).slice(2, 8)}`
}));

// 5c-C sync.js 静态 import sessions/storage/tab-sync 后必须 mock 避免传递 tools/mcp/client 链炸
vi.mock('../../js/state/sessions.js', () => ({
    isSessionDeleted: vi.fn(() => false),
    debouncedSaveSession: vi.fn()
}));

vi.mock('../../js/state/storage.js', () => ({
    loadSessionMessages: vi.fn(async () => null),
    saveSessionMessages: vi.fn(async () => {}),
    saveSessionToDB: vi.fn(async () => {}),
    saveSessionAtomic: vi.fn(async () => {}),
    SessionConflictError: class extends Error {}
}));

vi.mock('../../js/state/tab-sync.js', () => ({
    broadcastEvent: vi.fn()
}));

import { state } from '../../js/core/state.js';
import { eventBus } from '../../js/core/events.js';
import { pushMessage, updateMessageAt } from '../../js/core/state-mutations.js';
import {
    saveAssistantMessage,
    saveErrorMessage,
    copyMessageMetadata,
    extractTextContent,
    extractImages,
    mergeContinuationParts,
    writeToolResultsToBackgroundSession,
    saveAssistantMessageToBackground
} from '../../js/messages/sync.js';
import {
    loadSessionMessages,
    saveSessionAtomic,
    SessionConflictError
} from '../../js/state/storage.js';
import { broadcastEvent } from '../../js/state/tab-sync.js';
import {
    buildPartsFromStreamingState,
    buildMetaFromStreamingState
} from '../../js/messages/parts-builder.js';

// 测试 helper：把"旧流式中间状态 options"折叠为主签名 (parts, meta, opts)
// 保留 17 个用例不用逐个改写
function saveAssistantMessageFromStreamingState(options) {
    const {
        sessionId,
        isContinuation,
        isError,
        errorData,
        errorHtml,
        allReplies,
        selectedReplyIndex,
        toolCalls,
        ...streamFields
    } = options;
    return saveAssistantMessage(
        buildPartsFromStreamingState({ ...streamFields, toolCalls }),
        buildMetaFromStreamingState(streamFields),
        {
            sessionId,
            isContinuation,
            isError,
            errorData,
            errorHtml,
            allReplies,
            selectedReplyIndex,
            toolCalls
        }
    );
}

beforeEach(() => {
    state.messages = [];
    state.currentSessionId = 'session-1';
    state.selectedModel = 'gpt-4o';
    state.isSavingContinuation = false;
    state.currentAssistantMessage = null;
    state.sessionDirty = false;
    state.messageIdMap = new Map();
    vi.clearAllMocks();
    // pushMessage 需要实际操作 state.messages 并返回 index（与 state-mutations.pushMessage 契约一致）
    pushMessage.mockImplementation((msg) => {
        state.messages.push(msg);
        return state.messages.length - 1;
    });
    // updateMessageAt：mergeContinuation 测试需要看到真实更新
    updateMessageAt.mockImplementation((idx, updates) => {
        state.messages[idx] = { ...state.messages[idx], ...updates };
    });
});

// ========== extractTextContent ==========

describe('extractTextContent', () => {
    it('字符串直接返回', () => {
        expect(extractTextContent('hello')).toBe('hello');
    });

    it('数组中提取 text 类型', () => {
        const content = [
            { type: 'text', text: 'hello ' },
            { type: 'image_url', image_url: { url: 'data:...' } },
            { type: 'text', text: 'world' }
        ];
        expect(extractTextContent(content)).toBe('hello world');
    });

    it('空数组返回空字符串', () => {
        expect(extractTextContent([])).toBe('');
    });

    it('null 返回空字符串', () => {
        expect(extractTextContent(null)).toBe('');
    });

    it('undefined 返回空字符串', () => {
        expect(extractTextContent(undefined)).toBe('');
    });

    it('数字返回空字符串', () => {
        expect(extractTextContent(123)).toBe('');
    });

    it('无 text 类型元素返回空', () => {
        expect(extractTextContent([{ type: 'image_url' }])).toBe('');
    });
});

// ========== extractImages ==========

describe('extractImages', () => {
    it('非数组返回 null', () => {
        expect(extractImages('text')).toBeNull();
        expect(extractImages(null)).toBeNull();
    });

    it('无图片返回 null', () => {
        expect(extractImages([{ type: 'text', text: 'hello' }])).toBeNull();
    });

    it('提取图片 URL', () => {
        const content = [
            { type: 'image_url', image_url: { url: 'https://example.com/1.png' } },
            { type: 'text', text: 'desc' },
            { type: 'image_url', image_url: { url: 'https://example.com/2.png' } }
        ];
        const images = extractImages(content);
        expect(images).toHaveLength(2);
        expect(images[0]).toBe('https://example.com/1.png');
    });

    it('过滤空 url', () => {
        const content = [
            { type: 'image_url', image_url: { url: '' } },
            { type: 'image_url', image_url: { url: 'https://example.com/1.png' } }
        ];
        expect(extractImages(content)).toHaveLength(1);
    });

    it('image_url 无 url 字段时过滤', () => {
        expect(
            extractImages([{ type: 'image_url', image_url: {} }, { type: 'image_url' }])
        ).toBeNull();
    });
});

// ========== copyMessageMetadata ==========

describe('copyMessageMetadata', () => {
    it('复制 meta 字段', () => {
        const target = {};
        copyMessageMetadata({ meta: { model: 'gpt-4o' } }, target);
        expect(target.meta).toEqual({ model: 'gpt-4o' });
    });

    it('复制 replies', () => {
        const target = {};
        copyMessageMetadata({ replies: { all: [], selected: 0 } }, target);
        expect(target.replies).toBeDefined();
    });

    it('复制 error', () => {
        const target = {};
        copyMessageMetadata({ error: { type: 'timeout' } }, target);
        expect(target.error.type).toBe('timeout');
    });

    it('复制消息 id', () => {
        const target = {};
        copyMessageMetadata({ id: 'msg-1' }, target);
        expect(target.id).toBe('msg-1');
    });

    it('不复制 undefined 字段', () => {
        const target = {};
        copyMessageMetadata({}, target);
        expect(target.meta).toBeUndefined();
    });

    it('返回 target', () => {
        const target = {};
        expect(copyMessageMetadata({}, target)).toBe(target);
    });
});

// ========== saveAssistantMessage ==========

describe('saveAssistantMessage', () => {
    it('保存纯文本消息', () => {
        const index = saveAssistantMessageFromStreamingState({ textContent: 'hello world' });
        expect(index).toBe(0);
        expect(pushMessage).toHaveBeenCalledTimes(1);
        const msg = pushMessage.mock.calls[0][0];
        expect(msg.role).toBe('assistant');
        expect(msg.parts.some((p) => p.type === 'text' && p.text === 'hello world')).toBe(true);
    });

    it('保存带 thinking 的消息', () => {
        saveAssistantMessageFromStreamingState({
            textContent: 'answer',
            thinkingContent: 'let me think...',
            thinkingSignature: 'sig123'
        });
        const msg = pushMessage.mock.calls[0][0];
        const thinkingParts = msg.parts.filter((p) => p.type === 'thinking');
        expect(thinkingParts).toHaveLength(1);
        expect(thinkingParts[0].text).toBe('let me think...');
        expect(thinkingParts[0].signature).toBe('sig123');
    });

    it('保存带多个 thinking blocks', () => {
        saveAssistantMessageFromStreamingState({
            textContent: 'answer',
            thinkingBlocks: ['block1', 'block2'],
            thinkingSignatures: ['sig1', 'sig2']
        });
        const msg = pushMessage.mock.calls[0][0];
        const thinkingParts = msg.parts.filter((p) => p.type === 'thinking');
        expect(thinkingParts).toHaveLength(2);
    });

    it('保存带 contentParts', () => {
        saveAssistantMessageFromStreamingState({
            contentParts: [
                { type: 'text', text: 'hello' },
                {
                    type: 'image_url',
                    complete: true,
                    url: 'data:image/png;base64,abc',
                    mimeType: 'image/png'
                }
            ]
        });
        const msg = pushMessage.mock.calls[0][0];
        expect(msg.parts.filter((p) => p.type === 'text')).toHaveLength(1);
        expect(msg.parts.filter((p) => p.type === 'media')).toHaveLength(1);
    });

    it('contentParts thinking 不与独立 thinkingContent 重复', () => {
        saveAssistantMessageFromStreamingState({
            thinkingContent: 'should be ignored',
            contentParts: [
                { type: 'thinking', text: 'from contentParts' },
                { type: 'text', text: 'answer' }
            ]
        });
        const msg = pushMessage.mock.calls[0][0];
        const thinkingParts = msg.parts.filter((p) => p.type === 'thinking');
        expect(thinkingParts).toHaveLength(1);
        expect(thinkingParts[0].text).toBe('from contentParts');
    });

    it('过滤 "(调用工具)" 文本', () => {
        saveAssistantMessageFromStreamingState({
            textContent: '(调用工具)',
            toolCalls: [{ id: 'tc1', function: { name: 'test', arguments: '{}' } }]
        });
        const msg = pushMessage.mock.calls[0][0];
        expect(msg.parts.filter((p) => p.type === 'text' && p.text === '(调用工具)')).toHaveLength(
            0
        );
    });

    it('保存工具调用', () => {
        saveAssistantMessageFromStreamingState({
            textContent: 'Using tool',
            toolCalls: [
                {
                    id: 'tc1',
                    function: { name: 'web_search', arguments: '{"query":"test"}' },
                    status: 'completed',
                    result: 'search results'
                }
            ]
        });
        const msg = pushMessage.mock.calls[0][0];
        const toolParts = msg.parts.filter((p) => p.type === 'tool_call');
        expect(toolParts).toHaveLength(1);
        expect(toolParts[0].name).toBe('web_search');
        expect(toolParts[0].state).toBe('done');
    });

    it('工具参数字符串解析 JSON', () => {
        saveAssistantMessageFromStreamingState({
            toolCalls: [{ id: 'tc1', function: { name: 'tool', arguments: '{"key":"value"}' } }]
        });
        const msg = pushMessage.mock.calls[0][0];
        expect(msg.parts.find((p) => p.type === 'tool_call').args).toEqual({ key: 'value' });
    });

    it('工具参数无效 JSON 保持字符串', () => {
        saveAssistantMessageFromStreamingState({
            toolCalls: [{ id: 'tc1', function: { name: 'tool', arguments: 'invalid' } }]
        });
        const msg = pushMessage.mock.calls[0][0];
        expect(msg.parts.find((p) => p.type === 'tool_call').args).toBe('invalid');
    });

    it('发出 messages:changed 事件', () => {
        saveAssistantMessageFromStreamingState({ textContent: 'test' });
        expect(eventBus.emit).toHaveBeenCalledWith(
            'messages:changed',
            expect.objectContaining({ action: 'assistant_added' })
        );
    });

    it('错误消息设置 error 字段', () => {
        saveAssistantMessageFromStreamingState({
            textContent: 'partial',
            isError: true,
            errorData: { error: { type: 'rate_limit', message: 'Too many' } }
        });
        const msg = pushMessage.mock.calls[0][0];
        expect(msg.error.type).toBe('rate_limit');
    });

    it('续作轮出错时单独落错误消息，原消息不并入部分内容', () => {
        saveAssistantMessageFromStreamingState({
            textContent: '第一轮',
            toolCalls: [{ id: 'tc_1', name: 'search', arguments: {} }]
        });
        const originalParts = state.messages[0].parts;

        const index = saveAssistantMessageFromStreamingState({
            textContent: '续作轮的部分输出',
            isContinuation: true,
            isError: true,
            errorData: { code: 'network_error', message: '连接中断' },
            errorHtml: '<div>错误</div>'
        });

        expect(index).toBe(1);
        expect(state.messages).toHaveLength(2);
        expect(state.messages[0].parts).toBe(originalParts);
        expect(state.messages[0].error).toBeFalsy();
        expect(state.messages[1].parts).toEqual([
            expect.objectContaining({ type: 'text', text: '续作轮的部分输出' })
        ]);
        expect(state.messages[1].error).toEqual({
            type: 'network_error',
            message: '连接中断',
            html: '<div>错误</div>'
        });
        expect(updateMessageAt).not.toHaveBeenCalled();
    });

    it('续作轮还没收到内容就出错时错误同样落库', () => {
        saveAssistantMessageFromStreamingState({ textContent: '第一轮' });

        saveAssistantMessageFromStreamingState({
            isContinuation: true,
            isError: true,
            errorData: { code: 'overloaded_error', message: 'Overloaded' }
        });

        expect(state.messages).toHaveLength(2);
        expect(state.messages[1].parts).toEqual([]);
        expect(state.messages[1].error).toEqual(
            expect.objectContaining({ type: 'overloaded_error', message: 'Overloaded' })
        );
    });

    it('视频 contentParts 正确转换', () => {
        saveAssistantMessageFromStreamingState({
            contentParts: [
                {
                    type: 'image_url',
                    complete: true,
                    url: 'data:video/mp4;base64,abc',
                    mimeType: 'video/mp4'
                }
            ]
        });
        const msg = pushMessage.mock.calls[0][0];
        expect(msg.parts.filter((p) => p.type === 'media')[0].media).toBe('video');
    });

    it('server_tool_use 转换', () => {
        saveAssistantMessageFromStreamingState({
            contentParts: [
                {
                    type: 'server_tool_use',
                    id: 'stu_1',
                    name: 'web_search',
                    input: { query: 'test' },
                    result: { type: 'text', content: 'results' }
                }
            ]
        });
        const msg = pushMessage.mock.calls[0][0];
        const toolParts = msg.parts.filter((p) => p.type === 'tool_call');
        expect(toolParts[0].server).toBe(true);
        expect(toolParts[0].state).toBe('done');
    });

    it('media 去重', () => {
        saveAssistantMessageFromStreamingState({
            contentParts: [
                {
                    type: 'image_url',
                    complete: true,
                    url: 'data:image/png;base64,same',
                    mimeType: 'image/png'
                },
                {
                    type: 'image_url',
                    complete: true,
                    url: 'data:image/png;base64,same',
                    mimeType: 'image/png'
                }
            ]
        });
        const msg = pushMessage.mock.calls[0][0];
        expect(msg.parts.filter((p) => p.type === 'media')).toHaveLength(1);
    });

    it('meta 包含 model 和 provider', () => {
        saveAssistantMessageFromStreamingState({ textContent: 'test' });
        const msg = pushMessage.mock.calls[0][0];
        expect(msg.meta.model).toBe('gpt-4o');
        expect(msg.meta.provider).toBe('TestProvider');
    });

    it('meta 包含 streamStats', () => {
        saveAssistantMessageFromStreamingState({
            textContent: 'test',
            streamStats: { ttft: '0.5s', tps: '20.0', tokens: 100 }
        });
        const msg = pushMessage.mock.calls[0][0];
        expect(msg.meta.stats).toEqual({ ttft: '0.5s', tps: '20.0', tokens: 100 });
    });

    it('mergeContinuation 同 id tool_call 去重保留新轮', () => {
        // 第一轮：assistant 已有 text + tool_call id='tc_shared' 完成 result
        saveAssistantMessageFromStreamingState({
            textContent: '第一轮文本',
            toolCalls: [{ id: 'tc_shared', name: 'search', arguments: { q: 'old' } }]
        });
        // 手动把第一条 tool_call 标记为 done 模拟已写回 result
        const prevAssistant = state.messages[0];
        const prevToolCall = prevAssistant.parts.find((p) => p.type === 'tool_call');
        prevToolCall.state = 'done';
        prevToolCall.result = { content: 'old result' };

        // 第二轮 continuation：同 id 又出现一次（新轮覆盖）
        saveAssistantMessageFromStreamingState({
            textContent: '第二轮文本',
            isContinuation: true,
            toolCalls: [{ id: 'tc_shared', name: 'search', arguments: { q: 'new' } }]
        });

        const merged = state.messages[0];
        const toolParts = merged.parts.filter((p) => p.type === 'tool_call');
        // 同 id 只能出现 1 次，避免 duplicate tool_use_id
        expect(toolParts.filter((p) => p.id === 'tc_shared')).toHaveLength(1);
        // 保留的是新轮（_turn 应大于 0，prev 已被丢）
        expect(toolParts[0]._turn).toBeGreaterThan(0);
    });

    it('mergeContinuation 跨格式 continuation 按 idMap 三槽并集去重', () => {
        // 第一轮：Claude 格式 tool_call，part.id 是 toolu_xxx
        saveAssistantMessageFromStreamingState({
            textContent: 'claude 轮',
            toolCalls: [
                {
                    id: 'toolu_round1',
                    name: 'search',
                    arguments: { q: 'a' },
                    idMap: {
                        openai: 'call_synth1',
                        claude: 'toolu_round1',
                        gemini: 'gemini_synth1'
                    }
                }
            ]
        });
        const prevAssistant = state.messages[0];
        const prevTc = prevAssistant.parts.find((p) => p.type === 'tool_call');
        prevTc.state = 'done';
        prevTc.result = { content: 'round 1 result' };

        // 第二轮 continuation：切到 OpenAI 格式，part.id 是 call_yyy 但 idMap.openai 命中第一轮的 call_synth1
        saveAssistantMessageFromStreamingState({
            textContent: 'openai 轮',
            isContinuation: true,
            toolCalls: [
                {
                    id: 'call_synth1', // 命中第一轮 idMap.openai
                    name: 'search',
                    arguments: { q: 'a' },
                    idMap: {
                        openai: 'call_synth1',
                        claude: 'toolu_round1_replay',
                        gemini: 'gemini_synth1_replay'
                    }
                }
            ]
        });

        const merged = state.messages[0];
        const toolParts = merged.parts.filter((p) => p.type === 'tool_call');
        // 跨格式同逻辑 call_id 命中应去重保留 1 个新轮
        expect(toolParts).toHaveLength(1);
        expect(toolParts[0].id).toBe('call_synth1');
    });
});

// ========== mergeContinuationParts 结束原因 ==========

describe('mergeContinuationParts 结束原因', () => {
    const prev = {
        role: 'assistant',
        parts: [{ type: 'text', text: '第一轮' }],
        meta: { model: 'm', raw: {}, stop: { kind: 'tool_use', reason: 'tool_use' } }
    };

    it('以最后一轮的结束原因为准', () => {
        const { mergedMeta } = mergeContinuationParts(prev, [{ type: 'text', text: '第二轮' }], {
            raw: {},
            stop: { kind: 'max_tokens', reason: 'max_tokens' }
        });
        expect(mergedMeta.stop).toEqual({ kind: 'max_tokens', reason: 'max_tokens' });
    });

    it('最后一轮没有结束原因时清除旧值', () => {
        const { mergedMeta } = mergeContinuationParts(prev, [{ type: 'text', text: '第二轮' }], {
            raw: {}
        });
        expect(mergedMeta).not.toHaveProperty('stop');
        expect(prev.meta.stop).toEqual({ kind: 'tool_use', reason: 'tool_use' });
    });
});

// ========== saveErrorMessage ==========

describe('saveErrorMessage', () => {
    it('保存错误消息', () => {
        const renderFn = vi.fn(() => '<div>Error</div>');
        const index = saveErrorMessage(
            { error: { type: 'server_error', message: '500' } },
            500,
            renderFn
        );
        expect(index).toBe(0);
        const msg = pushMessage.mock.calls[0][0];
        expect(msg.error.type).toBe('server_error');
        expect(msg.error.status).toBe(500);
        expect(msg.error.html).toBe('<div>Error</div>');
    });

    it('errorData 为 null 时使用默认值', () => {
        saveErrorMessage(
            null,
            null,
            vi.fn(() => '')
        );
        const msg = pushMessage.mock.calls[0][0];
        expect(msg.error.type).toBe('unknown');
    });

    it('发出 messages:changed 事件', () => {
        saveErrorMessage(
            { error: {} },
            null,
            vi.fn(() => '')
        );
        expect(eventBus.emit).toHaveBeenCalledWith(
            'messages:changed',
            expect.objectContaining({ action: 'error_added' })
        );
    });
});

// ========== writeToolResultsToBackgroundSession ==========

describe('writeToolResultsToBackgroundSession 写入冲突', () => {
    const toolResults = [
        { id: 'call_bg', name: 'search', result: { text: 'done' }, isError: false }
    ];
    const userMessage = (id, text) => ({ id, role: 'user', parts: [{ type: 'text', text }] });
    const pendingMessages = () => [
        userMessage('u1', '问题'),
        {
            id: 'a1',
            role: 'assistant',
            parts: [
                { type: 'tool_call', id: 'call_bg', name: 'search', args: {}, state: 'pending' }
            ]
        }
    ];
    const conflict = (actualUpdatedAt) =>
        Object.assign(new SessionConflictError('conflict'), { actualUpdatedAt });

    beforeEach(() => {
        state.sessions = [{ id: 'session-bg', name: '后台会话', updatedAt: 100 }];
        state._lastKnownSessionUpdatedAt = new Map([['session-bg', 100]]);
    });

    afterEach(() => {
        delete state.sessions;
        delete state._lastKnownSessionUpdatedAt;
    });

    it('其他标签页抢先写入时按最新内容重新配对并重试一次', async () => {
        loadSessionMessages
            .mockResolvedValueOnce({ messages: pendingMessages() })
            .mockResolvedValueOnce({
                messages: [...pendingMessages(), userMessage('u2', '另一页追加')]
            });
        saveSessionAtomic.mockRejectedValueOnce(conflict(300)).mockResolvedValueOnce(undefined);

        const matched = await writeToolResultsToBackgroundSession('session-bg', toolResults);

        expect(matched).toBe(1);
        expect(saveSessionAtomic).toHaveBeenCalledTimes(2);
        expect(saveSessionAtomic.mock.calls[0][2]).toEqual({ expectedUpdatedAt: 100 });
        const [meta, payload, options] = saveSessionAtomic.mock.calls[1];
        expect(options).toEqual({ expectedUpdatedAt: 300 });
        expect(payload.messages).toHaveLength(3);
        expect(payload.messages[1].parts[0]).toMatchObject({
            state: 'done',
            result: { text: 'done' }
        });
        expect(payload.messages[2].parts[0].text).toBe('另一页追加');
        expect(meta.messageCount).toBe(3);
        expect(state.sessions[0].updatedAt).toBe(meta.updatedAt);
        expect(state._lastKnownSessionUpdatedAt.get('session-bg')).toBe(meta.updatedAt);
        expect(broadcastEvent).toHaveBeenCalledWith(
            'session-updated',
            expect.objectContaining({ sessionId: 'session-bg', messageCount: 3 })
        );
    });

    it('最新内容里已没有对应的工具调用时放弃写入', async () => {
        loadSessionMessages
            .mockResolvedValueOnce({ messages: pendingMessages() })
            .mockResolvedValueOnce({ messages: [userMessage('u1', '问题')] });
        saveSessionAtomic.mockRejectedValueOnce(conflict(300));

        expect(await writeToolResultsToBackgroundSession('session-bg', toolResults)).toBe(0);

        expect(saveSessionAtomic).toHaveBeenCalledTimes(1);
        expect(state._lastKnownSessionUpdatedAt.get('session-bg')).toBe(100);
        expect(broadcastEvent).not.toHaveBeenCalled();
    });

    it('重试仍冲突时放弃写入，基线保持不动', async () => {
        loadSessionMessages
            .mockResolvedValueOnce({ messages: pendingMessages() })
            .mockResolvedValueOnce({ messages: pendingMessages() });
        saveSessionAtomic.mockRejectedValueOnce(conflict(300)).mockRejectedValueOnce(conflict(400));

        expect(await writeToolResultsToBackgroundSession('session-bg', toolResults)).toBe(0);

        expect(saveSessionAtomic).toHaveBeenCalledTimes(2);
        expect(state._lastKnownSessionUpdatedAt.get('session-bg')).toBe(100);
        expect(broadcastEvent).not.toHaveBeenCalled();
    });
});

// ========== saveAssistantMessageToBackground ==========

describe('saveAssistantMessageToBackground 乐观锁基线', () => {
    beforeEach(() => {
        state.sessions = [{ id: 'session-bg', name: '后台会话', updatedAt: 200 }];
        state._lastKnownSessionUpdatedAt = new Map();
        loadSessionMessages.mockResolvedValue({ messages: [] });
        saveSessionAtomic.mockResolvedValue(undefined);
    });

    afterEach(() => {
        delete state.sessions;
        delete state._lastKnownSessionUpdatedAt;
    });

    it('本页没打开过的会话没有基线时按元数据做冲突检测，不跳过乐观锁', async () => {
        await saveAssistantMessageToBackground(
            'session-bg',
            [{ type: 'text', text: '恢复的内容' }],
            {}
        );

        expect(saveSessionAtomic).toHaveBeenCalledTimes(1);
        expect(saveSessionAtomic.mock.calls[0][2]).toEqual({ expectedUpdatedAt: 200 });
    });

    it('有基线时以基线为准', async () => {
        state._lastKnownSessionUpdatedAt.set('session-bg', 150);

        await saveAssistantMessageToBackground('session-bg', [{ type: 'text', text: 'x' }], {});

        expect(saveSessionAtomic.mock.calls[0][2]).toEqual({ expectedUpdatedAt: 150 });
    });
});
