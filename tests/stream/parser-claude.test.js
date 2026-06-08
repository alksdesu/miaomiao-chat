/**
 * parser-claude.js 流解析器测试
 * 测试 Claude SSE 流式解析
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// mock 依赖
// vi.mock 被 hoist 到文件顶，class 必须定义在 factory 内部
const statsTokenCalls = [];
const statsFirstTokenCalls = [];
vi.mock('../../js/stream/stats.js', () => {
    class MockStreamStats {
        constructor() {
            this.requestStartTime = 0;
            this.firstTokenTime = 0;
            this.endTime = 0;
            this.tokenCount = 0;
            this.isFirstToken = true;
        }
        recordFirstToken() {
            statsFirstTokenCalls.push(Date.now());
        }
        recordTokens(text) {
            statsTokenCalls.push(text);
        }
        finalize() {}
        recalculateTokenCount() {
            return 0;
        }
        getData() {
            return {};
        }
        getPartialData() {
            return {};
        }
        syncToGlobal() {}
    }
    return {
        StreamStats: MockStreamStats,
        estimateTokenCount: vi.fn(() => 0),
        recordFirstToken: vi.fn(),
        recordTokens: vi.fn(),
        finalizeStreamStats: vi.fn(),
        resetStreamStats: vi.fn(),
        recalculateStreamTokenCount: vi.fn(),
        getCurrentStreamStatsData: vi.fn(() => ({})),
        getPartialStreamStatsData: vi.fn(() => ({})),
        getStreamStatsHTML: vi.fn(() => ''),
        renderStreamStatsFromData: vi.fn(() => ''),
        appendStreamStats: vi.fn()
    };
});

vi.mock('../../js/stream/helpers.js', () => ({
    updateStreamingMessage: vi.fn(),
    renderFinalTextWithThinking: vi.fn(),
    renderFinalContentWithThinking: vi.fn(),
    cleanupAllIncompleteImages: vi.fn()
}));

vi.mock('../../js/messages/sync.js', () => ({
    saveAssistantMessage: vi.fn(() => 0)
}));

vi.mock('../../js/providers/manager.js', () => ({
    getCurrentProvider: vi.fn(() => ({ name: 'Test', apiFormat: 'claude' })),
    getActiveApiKey: vi.fn(() => ''),
    getModelDisplayName: vi.fn((id) => id || ''),
    getCurrentModelCapabilities: vi.fn(() => ({})),
    syncProviderState: vi.fn()
}));

vi.mock('../../js/messages/dom-sync.js', () => ({
    setCurrentMessageIndex: vi.fn()
}));

vi.mock('../../js/core/events.js', () => ({
    eventBus: { emit: vi.fn(), on: vi.fn() }
}));

vi.mock('../../js/core/state.js', () => ({
    state: {
        xmlToolCallingEnabled: false,
        currentSessionId: 'test-session',
        isToolCallPending: false,
        currentAssistantMessage: null
    }
}));

vi.mock('../../js/core/request-state-machine.js', () => ({
    requestStateMachine: { transition: vi.fn(), forceReset: vi.fn() },
    RequestState: { TOOL_CALLING: 'TOOL_CALLING' }
}));

vi.mock('../../js/utils/errors.js', () => ({
    renderHumanizedError: vi.fn(() => '<div>error</div>')
}));

vi.mock('../../js/utils/markdown-image-parser.js', () => ({
    parseStreamingMarkdownImages: vi.fn((text, buffer) => ({
        parts: text ? [{ type: 'text', text }] : [],
        newBuffer: buffer || ''
    }))
}));

vi.mock('../../js/tools/orchestrator.js', () => ({
    handleToolCallStream: vi.fn(() => Promise.resolve()),
    startPauseTurnContinuation: vi.fn(() => Promise.resolve())
}));

vi.mock('../../js/stream/think-tag-parser.js', () => {
    class MockThinkTagParser {
        processDelta(text) {
            return { displayText: text, thinkingDelta: '' };
        }
        flush() {
            return { displayText: '', thinkingDelta: '' };
        }
    }
    return { ThinkTagParser: MockThinkTagParser };
});

vi.mock('../../js/tools/xml-formatter.js', () => {
    class MockXMLStreamAccumulator {
        processDelta(delta) {
            return { hasToolCalls: false, displayText: delta, error: null };
        }
        getCompletedCalls() {
            return [];
        }
    }
    return { XMLStreamAccumulator: MockXMLStreamAccumulator };
});

import { parseClaudeStream } from '../../js/stream/parser-claude.js';
import { state } from '../../js/core/state.js';
import { eventBus } from '../../js/core/events.js';
import { saveAssistantMessage } from '../../js/messages/sync.js';

function createMockReader(lines) {
    const encoder = new TextEncoder();
    let idx = 0;
    return {
        read: vi.fn(async () => {
            if (idx >= lines.length) return { done: true, value: undefined };
            const line = lines[idx++];
            return { done: false, value: encoder.encode(line + '\n') };
        }),
        cancel: vi.fn(async () => {}),
        releaseLock: vi.fn()
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    statsTokenCalls.length = 0;
    statsFirstTokenCalls.length = 0;
    state.xmlToolCallingEnabled = false;
    state.currentSessionId = 'test-session';
    state.isToolCallPending = false;
});

describe('parseClaudeStream - 文本内容', () => {
    it('解析 text_delta 事件', async () => {
        const reader = createMockReader([
            'data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}',
            'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}',
            'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" world"}}',
            'data: {"type":"content_block_stop","index":0}',
            'data: {"type":"message_stop"}'
        ]);

        await parseClaudeStream(reader);

        expect(statsFirstTokenCalls.length).toBeGreaterThan(0);
        expect(statsTokenCalls).toContain('Hello');
        expect(statsTokenCalls).toContain(' world');
        expect(saveAssistantMessage).toHaveBeenCalled();
    });

    it('忽略非 data: 前缀行', async () => {
        const reader = createMockReader([
            'event: content_block_delta',
            'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}',
            'data: {"type":"message_stop"}'
        ]);

        await parseClaudeStream(reader);

        expect(statsTokenCalls).toContain('ok');
    });
});

describe('parseClaudeStream - 思维链', () => {
    it('解析 thinking_delta 事件', async () => {
        const reader = createMockReader([
            'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking"}}',
            'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"step 1"}}',
            'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" step 2"}}',
            'data: {"type":"content_block_stop","index":0}',
            'data: {"type":"content_block_start","index":1,"content_block":{"type":"text"}}',
            'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"answer"}}',
            'data: {"type":"content_block_stop","index":1}',
            'data: {"type":"message_stop"}'
        ]);

        await parseClaudeStream(reader);

        expect(statsTokenCalls).toContain('step 1');
        expect(statsTokenCalls).toContain(' step 2');
        const parts = saveAssistantMessage.mock.calls[0][0];
        const thinkingParts = parts.filter((p) => p.type === 'thinking');
        expect(thinkingParts.some((p) => p.text === 'step 1 step 2')).toBe(true);
    });

    it('解析 signature_delta 事件', async () => {
        const reader = createMockReader([
            'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking"}}',
            'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"thought"}}',
            'data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig_abc"}}',
            'data: {"type":"content_block_stop","index":0}',
            'data: {"type":"message_stop"}'
        ]);

        await parseClaudeStream(reader);

        const parts = saveAssistantMessage.mock.calls[0][0];
        const thinkingParts = parts.filter((p) => p.type === 'thinking');
        expect(thinkingParts.some((p) => p.signature === 'sig_abc')).toBe(true);
    });

    it('处理多个独立 thinking 块', async () => {
        const reader = createMockReader([
            'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking"}}',
            'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"block1"}}',
            'data: {"type":"content_block_stop","index":0}',
            'data: {"type":"content_block_start","index":1,"content_block":{"type":"thinking"}}',
            'data: {"type":"content_block_delta","index":1,"delta":{"type":"thinking_delta","thinking":"block2"}}',
            'data: {"type":"content_block_stop","index":1}',
            'data: {"type":"content_block_start","index":2,"content_block":{"type":"text"}}',
            'data: {"type":"content_block_delta","index":2,"delta":{"type":"text_delta","text":"result"}}',
            'data: {"type":"content_block_stop","index":2}',
            'data: {"type":"message_stop"}'
        ]);

        await parseClaudeStream(reader);

        const parts = saveAssistantMessage.mock.calls[0][0];
        const thinkingTexts = parts.filter((p) => p.type === 'thinking').map((p) => p.text);
        expect(thinkingTexts).toEqual(['block1', 'block2']);
    });
});

describe('parseClaudeStream - 工具调用', () => {
    it('解析 tool_use 块', async () => {
        const reader = createMockReader([
            'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tc_1","name":"search"}}',
            'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"q\\":"}}',
            'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\"test\\"}"}}',
            'data: {"type":"content_block_stop","index":0}',
            'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}',
            'data: {"type":"message_stop"}'
        ]);

        await parseClaudeStream(reader);

        const parts = saveAssistantMessage.mock.calls[0][0];
        const toolCalls = parts.filter((p) => p.type === 'tool_call');
        expect(toolCalls.some((p) => p.id === 'tc_1' && p.name === 'search')).toBe(true);
    });

    it('解析 server_tool_use 块', async () => {
        const reader = createMockReader([
            'data: {"type":"content_block_start","index":0,"content_block":{"type":"server_tool_use","id":"stc_1","name":"web_search"}}',
            'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"query\\":\\"test\\"}"}}',
            'data: {"type":"content_block_stop","index":0}',
            'data: {"type":"content_block_start","index":1,"content_block":{"type":"web_search_tool_result","tool_use_id":"stc_1","content":[{"type":"web_search_result"}]}}',
            'data: {"type":"content_block_stop","index":1}',
            'data: {"type":"content_block_start","index":2,"content_block":{"type":"text"}}',
            'data: {"type":"content_block_delta","index":2,"delta":{"type":"text_delta","text":"result"}}',
            'data: {"type":"content_block_stop","index":2}',
            'data: {"type":"message_stop"}'
        ]);

        await parseClaudeStream(reader);

        expect(saveAssistantMessage).toHaveBeenCalled();
    });
});

describe('parseClaudeStream - 错误处理', () => {
    it('处理 error 事件', async () => {
        const reader = createMockReader([
            'data: {"type":"error","error":{"type":"rate_limit_error","message":"Too many requests"}}'
        ]);

        await parseClaudeStream(reader);

        expect(eventBus.emit).toHaveBeenCalledWith(
            'ui:notification',
            expect.objectContaining({ type: 'error' })
        );
        expect(reader.cancel).toHaveBeenCalled();
    });

    it('处理 overloaded_error 529', async () => {
        const reader = createMockReader([
            'data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'
        ]);

        await parseClaudeStream(reader);

        expect(eventBus.emit).toHaveBeenCalledWith(
            'ui:notification',
            expect.objectContaining({
                message: expect.stringContaining('529')
            })
        );
    });

    it('处理 api_error', async () => {
        const reader = createMockReader([
            'data: {"type":"error","error":{"type":"api_error","message":"Internal error"}}'
        ]);

        await parseClaudeStream(reader);

        expect(eventBus.emit).toHaveBeenCalledWith(
            'ui:notification',
            expect.objectContaining({
                message: expect.stringContaining('API')
            })
        );
    });

    it('处理 JSON 解析错误', async () => {
        const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const reader = createMockReader([
            'data: invalid-json',
            'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}',
            'data: {"type":"message_stop"}'
        ]);

        await parseClaudeStream(reader);

        expect(consoleSpy).toHaveBeenCalled();
        consoleSpy.mockRestore();
    });

    it('处理错误时保存已接收内容', async () => {
        const reader = createMockReader([
            'data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}',
            'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}',
            'data: {"type":"error","error":{"type":"api_error","message":"Boom"}}'
        ]);

        await parseClaudeStream(reader);

        // 有部分内容应触发 finalizeStreamWithError
        expect(saveAssistantMessage).toHaveBeenCalled();
    });
});

describe('parseClaudeStream - message_delta', () => {
    it('记录 stop_reason', async () => {
        const reader = createMockReader([
            'data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}',
            'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}',
            'data: {"type":"content_block_stop","index":0}',
            'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}',
            'data: {"type":"message_stop"}'
        ]);

        await parseClaudeStream(reader);

        expect(saveAssistantMessage).toHaveBeenCalled();
    });
});
