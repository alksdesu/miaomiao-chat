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
    extractImages
} from '../../js/messages/sync.js';
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

    it('复制保留字段', () => {
        const target = {};
        copyMessageMetadata({ id: 'msg-1', errorHtml: '<div/>', isError: true }, target);
        expect(target.id).toBe('msg-1');
        expect(target.errorHtml).toBe('<div/>');
        expect(target.isError).toBe(true);
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
        expect(msg.errorHtml).toBe('<div>Error</div>');
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
