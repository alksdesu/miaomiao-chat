/**
 * base-parser.js 可隔离纯函数测试
 * 测试 mergeContentPart / processXmlDetection / isOverLimit 等
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// mock 所有外部依赖
// StreamStats class mock：base-parser 构造函数 new StreamStats() 需要的最小契约
// vi.mock 被 hoist 到文件顶，class 必须定义在 factory 内部
vi.mock('../../js/stream/stats.js', () => {
    class MockStreamStats {
        constructor() {
            this.requestStartTime = 0;
            this.firstTokenTime = 0;
            this.endTime = 0;
            this.tokenCount = 0;
            this.isFirstToken = true;
        }
        recordFirstToken() {}
        recordTokens() {}
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
        recalculateStreamTokenCount: vi.fn(),
        finalizeStreamStats: vi.fn(),
        resetStreamStats: vi.fn(),
        getCurrentStreamStatsData: vi.fn(() => ({})),
        getPartialStreamStatsData: vi.fn(() => ({})),
        getStreamStatsHTML: vi.fn(() => ''),
        renderStreamStatsFromData: vi.fn(() => ''),
        appendStreamStats: vi.fn()
    };
});

vi.mock('../../js/stream/helpers.js', () => ({
    renderFinalTextWithThinking: vi.fn(),
    renderFinalContentWithThinking: vi.fn(),
    cleanupAllIncompleteImages: vi.fn()
}));

vi.mock('../../js/messages/sync.js', () => ({
    saveAssistantMessage: vi.fn(() => 0)
}));

vi.mock('../../js/messages/dom-sync.js', () => ({
    setCurrentMessageIndex: vi.fn()
}));

vi.mock('../../js/core/events.js', () => ({
    eventBus: { emit: vi.fn(), on: vi.fn() }
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
    handleToolCallStream: vi.fn()
}));

vi.mock('../../js/tools/xml-formatter.js', () => {
    class MockXMLStreamAccumulator {
        processDelta(delta) {
            return { hasToolCalls: false, displayText: delta, error: null };
        }
    }
    return { XMLStreamAccumulator: MockXMLStreamAccumulator };
});

vi.mock('../../js/core/state.js', () => ({
    state: {
        xmlToolCallingEnabled: false,
        isToolCallPending: false,
        currentSessionId: 'session_1'
    }
}));

vi.mock('../../js/stream/think-tag-parser.js', () => {
    class MockThinkTagParser {
        processDelta(delta) {
            return { displayText: delta, thinkingDelta: '' };
        }
        flush() {
            return { displayText: '', thinkingDelta: '' };
        }
    }
    return { ThinkTagParser: MockThinkTagParser };
});

vi.mock('../../js/core/request-state-machine.js', () => ({
    requestStateMachine: { transition: vi.fn() },
    RequestState: { TOOL_CALLING: 'tool_calling' }
}));

vi.mock('../../js/api/current.js', () => ({
    getCurrentProvider: vi.fn(() => ({ name: 'Test' })),
    getModelDisplayName: vi.fn((id) => id || '')
}));

import { BaseStreamParser } from '../../js/stream/base-parser.js';
import { state } from '../../js/core/state.js';

// ========== mergeContentPart ==========

describe('mergeContentPart', () => {
    let parser;

    beforeEach(() => {
        parser = new BaseStreamParser();
    });

    it('首个 part 直接添加', () => {
        parser.mergeContentPart('text', 'hello');
        expect(parser.contentParts).toEqual([{ type: 'text', text: 'hello' }]);
    });

    it('同类型 part 合并', () => {
        parser.mergeContentPart('text', 'hello');
        parser.mergeContentPart('text', ' world');
        expect(parser.contentParts).toHaveLength(1);
        expect(parser.contentParts[0].text).toBe('hello world');
    });

    it('不同类型 part 不合并', () => {
        parser.mergeContentPart('text', 'hello');
        parser.mergeContentPart('thinking', '思考');
        parser.mergeContentPart('text', 'world');
        expect(parser.contentParts).toHaveLength(3);
    });

    it('交替类型正确处理', () => {
        parser.mergeContentPart('thinking', 'step1');
        parser.mergeContentPart('thinking', 'step2');
        parser.mergeContentPart('text', 'answer');
        expect(parser.contentParts).toHaveLength(2);
        expect(parser.contentParts[0]).toEqual({ type: 'thinking', text: 'step1step2' });
        expect(parser.contentParts[1]).toEqual({ type: 'text', text: 'answer' });
    });
});

// ========== isOverLimit ==========

describe('isOverLimit', () => {
    it('未超限返回 false', () => {
        const parser = new BaseStreamParser();
        parser.totalReceived = 100;
        expect(parser.isOverLimit()).toBe(false);
    });

    it('超限返回 true', () => {
        const parser = new BaseStreamParser();
        parser.totalReceived = 200001;
        expect(parser.isOverLimit()).toBe(true);
    });

    it('刚好等于限制不超限', () => {
        const parser = new BaseStreamParser();
        parser.totalReceived = 200000;
        expect(parser.isOverLimit()).toBe(false);
    });
});

// ========== maxResponseLength ==========

describe('maxResponseLength', () => {
    it('默认 200000', () => {
        const parser = new BaseStreamParser();
        expect(parser.maxResponseLength).toBe(200000);
    });
});

// ========== processXmlDetection ==========

describe('processXmlDetection', () => {
    it('XML 未启用时直接返回', () => {
        state.xmlToolCallingEnabled = false;
        const parser = new BaseStreamParser();
        const result = parser.processXmlDetection('hello');
        expect(result).toEqual({ deltaText: 'hello', hasXML: false, xmlParseResult: null });
    });

    it('xmlParsingDisabled 时直接返回', () => {
        state.xmlToolCallingEnabled = true;
        const parser = new BaseStreamParser();
        parser.xmlParsingDisabled = true;
        const result = parser.processXmlDetection('hello');
        expect(result).toEqual({ deltaText: 'hello', hasXML: false, xmlParseResult: null });
    });

    it('XML 启用时调用 accumulator', () => {
        state.xmlToolCallingEnabled = true;
        const parser = new BaseStreamParser();
        parser.xmlParsingDisabled = false;
        const result = parser.processXmlDetection('some text');
        expect(result.deltaText).toBe('some text');
        expect(result.hasXML).toBe(false);
    });
});

// ========== 构造函数 ==========

describe('BaseStreamParser 构造函数', () => {
    it('初始化默认状态', () => {
        const parser = new BaseStreamParser();
        expect(parser.sessionId).toBeNull();
        expect(parser.buffer).toBe('');
        expect(parser.textContent).toBe('');
        expect(parser.thinkingContent).toBe('');
        expect(parser.contentParts).toEqual([]);
        expect(parser.totalReceived).toBe(0);
        expect(parser.markdownBuffer).toBe('');
    });

    it('接受 sessionId', () => {
        const parser = new BaseStreamParser('session_123');
        expect(parser.sessionId).toBe('session_123');
    });
});

// ========== appendThinking ==========

describe('appendThinking', () => {
    it('追加到 thinkingContent', () => {
        const parser = new BaseStreamParser();
        parser.appendThinking('step1');
        parser.appendThinking('step2');
        expect(parser.thinkingContent).toBe('step1step2');
    });
});

// ========== flushThinkTagParser ==========

describe('flushThinkTagParser', () => {
    it('不报错', () => {
        const parser = new BaseStreamParser();
        expect(() => parser.flushThinkTagParser()).not.toThrow();
    });
});

// ========== processLine / onStreamEnd 抽象方法 ==========

describe('抽象方法', () => {
    it('processLine 抛出错误', async () => {
        const parser = new BaseStreamParser();
        await expect(parser.processLine('line')).rejects.toThrow('子类必须实现');
    });

    it('onStreamEnd 抛出错误', async () => {
        const parser = new BaseStreamParser();
        await expect(parser.onStreamEnd()).rejects.toThrow('子类必须实现');
    });
});

// ========== processThinkAndMarkdown ==========

describe('processThinkAndMarkdown', () => {
    it('纯文本追加到 textContent 和 contentParts', () => {
        const parser = new BaseStreamParser();
        parser.processThinkAndMarkdown('hello');
        expect(parser.textContent).toBe('hello');
        expect(parser.totalReceived).toBe(5);
        expect(parser.contentParts).toEqual([{ type: 'text', text: 'hello' }]);
    });

    it('空文本不改变状态', () => {
        const parser = new BaseStreamParser();
        parser.processThinkAndMarkdown('');
        expect(parser.textContent).toBe('');
        expect(parser.contentParts).toEqual([]);
    });
});

// ========== finalize 与结束原因 ==========

function createFakeSink({ continuation = false } = {}) {
    return {
        task: continuation ? { isSavingContinuation: true } : null,
        isBackground: vi.fn(() => false),
        renderFinalContent: vi.fn(),
        renderFinalText: vi.fn(),
        renderError: vi.fn(),
        renderStopNotice: vi.fn(),
        appendStats: vi.fn(),
        commit: vi.fn(() => 0),
        commitError: vi.fn(() => 0)
    };
}

describe('finalizeStream 结束原因', () => {
    beforeEach(() => {
        state.xmlToolCallingEnabled = false;
    });

    it('有正文时正常落库，提示并记录结束原因', () => {
        const sink = createFakeSink();
        const parser = new BaseStreamParser('session_1', sink);
        parser.textContent = '被截断的回';
        parser.stop = { kind: 'max_tokens', reason: 'length' };

        parser.finalizeStream(parser.collectExtraSaveFields());

        expect(sink.renderStopNotice).toHaveBeenCalledWith(parser.stop);
        expect(sink.commitError).not.toHaveBeenCalled();
        const [parts, meta] = sink.commit.mock.calls[0];
        expect(parts).toEqual([expect.objectContaining({ type: 'text', text: '被截断的回' })]);
        expect(meta.stop).toEqual({ kind: 'max_tokens', reason: 'length' });
    });

    it('没有正文时按结束原因落错误消息，正文不写入错误文案', () => {
        const sink = createFakeSink();
        const parser = new BaseStreamParser('session_1', sink);
        parser.stop = { kind: 'safety', reason: 'SAFETY' };

        parser.finalizeStream(parser.collectExtraSaveFields());

        expect(sink.commit).not.toHaveBeenCalled();
        expect(sink.renderStopNotice).not.toHaveBeenCalled();
        const [parts, meta, , errorInfo] = sink.commitError.mock.calls[0];
        expect(parts).toEqual([]);
        expect(meta.stop).toEqual(parser.stop);
        expect(errorInfo.errorCode).toBe('safety');
        expect(errorInfo.errorMessage).toContain('（SAFETY）');
        expect(sink.renderError.mock.calls[0][0]).not.toContain('stream-error-partial-save');
    });

    it('正常结束却没有正文时按空回复落错误消息', () => {
        const sink = createFakeSink();
        const parser = new BaseStreamParser('session_1', sink);
        parser.stop = { kind: 'end', reason: 'stop' };

        parser.finalizeStream({});

        expect(sink.commitError.mock.calls[0][3].errorCode).toBe('empty_reply');
    });

    it('续作轮次没有正文时并入原消息，只提示结束原因', () => {
        const sink = createFakeSink({ continuation: true });
        const parser = new BaseStreamParser('session_1', sink);
        parser.stop = { kind: 'max_tokens', reason: 'max_tokens' };

        parser.finalizeStream(parser.collectExtraSaveFields());

        expect(sink.commitError).not.toHaveBeenCalled();
        expect(sink.commit).toHaveBeenCalledTimes(1);
        expect(sink.commit.mock.calls[0][1].stop).toEqual(parser.stop);
        expect(sink.renderStopNotice).toHaveBeenCalledWith(parser.stop);
    });
});

describe('finalizeStreamWithError 部分内容', () => {
    beforeEach(() => {
        state.xmlToolCallingEnabled = false;
    });

    it('有部分内容时只保存模型的实际输出，错误文案不进正文', () => {
        const sink = createFakeSink();
        const parser = new BaseStreamParser('session_1', sink);
        parser.textContent = '部分';

        parser.finalizeStreamWithError('network_error', '连接中断');

        expect(sink.renderError.mock.calls[0][0]).toContain('stream-error-partial-save');
        const [parts, , , errorInfo] = sink.commitError.mock.calls[0];
        expect(parts).toEqual([expect.objectContaining({ type: 'text', text: '部分' })]);
        expect(errorInfo).toEqual(
            expect.objectContaining({ errorCode: 'network_error', errorMessage: '连接中断' })
        );
    });

    it('渲染与落库之前先让 sink 切换续作轮的错误渲染目标', () => {
        const sink = createFakeSink({ continuation: true });
        const calls = [];
        sink.beginErrorReply = vi.fn(() => calls.push('begin'));
        sink.renderFinalText.mockImplementation(() => calls.push('render'));
        sink.commitError.mockImplementation(() => calls.push('commit'));
        const parser = new BaseStreamParser('session_1', sink);
        parser.textContent = '续作轮的部分输出';

        parser.finalizeStreamWithError('network_error', '连接中断');

        expect(calls).toEqual(['begin', 'render', 'commit']);
    });

    it('没有任何内容时只展示错误块', () => {
        const sink = createFakeSink();
        const parser = new BaseStreamParser('session_1', sink);

        parser.finalizeStreamWithError('network_error', '连接中断');

        expect(sink.renderError.mock.calls[0][0]).not.toContain('stream-error-partial-save');
        expect(sink.commitError.mock.calls[0][0]).toEqual([]);
    });
});

describe('流内错误提示', () => {
    beforeEach(async () => {
        const { eventBus } = await import('../../js/core/events.js');
        eventBus.emit.mockClear();
        state.sessions = [{ id: 'session_2', name: '写作助手' }];
    });

    it('前台会话原样提示', async () => {
        const { eventBus } = await import('../../js/core/events.js');
        const parser = new BaseStreamParser('session_1', createFakeSink());

        parser.notifyStreamError('API 错误 (429): 限流');

        expect(eventBus.emit).toHaveBeenCalledWith('ui:notification', {
            message: 'API 错误 (429): 限流',
            type: 'error',
            duration: 8000
        });
    });

    it('后台会话的提示带上会话名', async () => {
        const { eventBus } = await import('../../js/core/events.js');
        const sink = createFakeSink();
        sink.isBackground.mockReturnValue(true);
        const parser = new BaseStreamParser('session_2', sink);

        parser.notifyStreamError('API 错误 (429): 限流');

        expect(eventBus.emit).toHaveBeenCalledWith(
            'ui:notification',
            expect.objectContaining({ message: '「写作助手」API 错误 (429): 限流' })
        );
    });
});

describe('collectExtraSaveFields', () => {
    it('带出结束原因', () => {
        const parser = new BaseStreamParser('session_1', createFakeSink());
        expect(parser.collectExtraSaveFields()).toEqual({});
        parser.stop = { kind: 'end', reason: 'stop' };
        expect(parser.collectExtraSaveFields()).toEqual({ stop: parser.stop });
    });
});
