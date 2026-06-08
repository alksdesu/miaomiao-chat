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
