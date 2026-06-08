/**
 * think-tag-parser.js 测试
 */
import { describe, it, expect } from 'vitest';

import { ThinkTagParser, parseThinkTags } from '../../js/stream/think-tag-parser.js';

// ========== parseThinkTags (非流式) ==========

describe('parseThinkTags', () => {
    it('无 <think> 标签原样返回', () => {
        const result = parseThinkTags('hello world');
        expect(result.displayText).toBe('hello world');
        expect(result.thinkingContent).toBe('');
    });

    it('null 返回空', () => {
        const result = parseThinkTags(null);
        expect(result.displayText).toBe('');
        expect(result.thinkingContent).toBe('');
    });

    it('空字符串返回空', () => {
        const result = parseThinkTags('');
        expect(result.displayText).toBe('');
        expect(result.thinkingContent).toBe('');
    });

    it('数字类型返回原值', () => {
        const result = parseThinkTags(123);
        // 非字符串时 displayText = text || '' = 123
        expect(result.displayText).toBe(123);
        expect(result.thinkingContent).toBe('');
    });

    it('提取单个 <think> 块', () => {
        const result = parseThinkTags('before<think>thinking</think>after');
        // trim 后 before 和 after 拼接（无空格）
        expect(result.displayText).toBe('beforeafter');
        expect(result.thinkingContent).toBe('thinking');
    });

    it('提取多个 <think> 块', () => {
        const result = parseThinkTags('a<think>t1</think>b<think>t2</think>c');
        expect(result.displayText).toBe('abc');
        expect(result.thinkingContent).toBe('t1t2');
    });

    it('未闭合的 <think> 标签', () => {
        const result = parseThinkTags('before<think>unclosed thinking');
        expect(result.displayText).toBe('before');
        expect(result.thinkingContent).toBe('unclosed thinking');
    });

    it('仅有 <think> 内容', () => {
        const result = parseThinkTags('<think>only thinking</think>');
        expect(result.displayText).toBe('');
        expect(result.thinkingContent).toBe('only thinking');
    });

    it('空 <think> 标签', () => {
        const result = parseThinkTags('before<think></think>after');
        expect(result.displayText).toBe('beforeafter');
        expect(result.thinkingContent).toBe('');
    });

    it('结果会 trim', () => {
        const result = parseThinkTags('  <think> thinking </think>  display  ');
        expect(result.displayText).toBe('display');
        expect(result.thinkingContent).toBe('thinking');
    });
});

// ========== ThinkTagParser (流式) ==========

describe('ThinkTagParser', () => {
    it('创建新实例', () => {
        const parser = new ThinkTagParser();
        expect(parser.buffer).toBe('');
        expect(parser.thinkingContent).toBe('');
        expect(parser.isInsideThink).toBe(false);
    });

    it('纯文本不含 <think>', () => {
        const parser = new ThinkTagParser();
        const result = parser.processDelta('hello world');
        expect(result.displayText).toBe('hello world');
        expect(result.thinkingDelta).toBe('');
    });

    it('完整 <think> 块一次性传入', () => {
        const parser = new ThinkTagParser();
        const result = parser.processDelta('<think>thinking</think>display');
        expect(result.thinkingDelta).toBe('thinking');
        expect(result.displayText).toBe('display');
    });

    it('流式分割 <think> 标签', () => {
        const parser = new ThinkTagParser();

        const r1 = parser.processDelta('<think>thin');
        expect(r1.thinkingDelta).toBe('thin');

        const r2 = parser.processDelta('king</think>answer');
        expect(r2.thinkingDelta).toBe('king');
        expect(r2.displayText).toBe('answer');
    });

    it('部分 <think> 开始标签缓冲', () => {
        const parser = new ThinkTagParser();

        // '<thi' 是部分标签，应该被缓冲
        const r1 = parser.processDelta('hello<thi');
        expect(r1.displayText).toBe('hello');

        // 补全标签
        const r2 = parser.processDelta('nk>content</think>');
        expect(r2.thinkingDelta).toBe('content');
    });

    it('部分 </think> 结束标签缓冲', () => {
        const parser = new ThinkTagParser();

        parser.processDelta('<think>content</thi');
        const r = parser.processDelta('nk>after');
        expect(r.displayText).toBe('after');
    });

    it('getThinkingContent 返回累积内容', () => {
        const parser = new ThinkTagParser();
        parser.processDelta('<think>first</think>');
        expect(parser.getThinkingContent()).toBe('first');
    });

    it('flush 处理未闭合内容', () => {
        const parser = new ThinkTagParser();
        parser.processDelta('<think>uncl');
        // 'uncl' doesn't contain '<', so it's already output as thinkingDelta
        // But if buffer ends with partial '</think>' like '<', it stays buffered
        // Force a partial close tag in buffer:
        parser.processDelta('osed</thi');
        // '</thi' is a partial close, stays in buffer
        const result = parser.flush();
        // flush outputs remaining buffer as thinkingDelta since isInsideThink
        expect(result.thinkingDelta).toBe('</thi');
        expect(result.displayText).toBe('');
        expect(parser.getThinkingContent()).toContain('unclosed');
    });

    it('flush 处理正常残余', () => {
        const parser = new ThinkTagParser();
        // processDelta('text') immediately outputs as displayText since no '<' present
        // So flush gets empty buffer
        const r = parser.processDelta('hello world');
        expect(r.displayText).toBe('hello world');
        const result = parser.flush();
        expect(result.displayText).toBe('');
        expect(result.thinkingDelta).toBe('');
    });

    it('flush 后 buffer 清空', () => {
        const parser = new ThinkTagParser();
        parser.processDelta('some text');
        parser.flush();
        expect(parser.buffer).toBe('');
    });

    it('多次 processDelta 累积思考内容', () => {
        const parser = new ThinkTagParser();
        parser.processDelta('<think>a');
        parser.processDelta('b');
        parser.processDelta('c</think>');
        expect(parser.getThinkingContent()).toBe('abc');
    });

    it('findPartialOpen 返回安全位置', () => {
        const parser = new ThinkTagParser();
        // 以 '<t' 结尾时，安全位置是 '<t' 之前
        expect(parser.findPartialOpen('hello<t')).toBe(5);
        expect(parser.findPartialOpen('hello')).toBe(5);
        // 没有部分标签，全部安全
        expect(parser.findPartialOpen('no tag')).toBe(6);
    });

    it('findPartialClose 返回安全位置', () => {
        const parser = new ThinkTagParser();
        expect(parser.findPartialClose('content</')).toBe(7);
        expect(parser.findPartialClose('content')).toBe(7);
    });

    it('多个 <think> 块流式处理', () => {
        const parser = new ThinkTagParser();
        let allDisplay = '';
        let allThinking = '';

        const chunks = ['<think>t1</think>', 'mid', '<think>t2</think>', 'end'];
        for (const chunk of chunks) {
            const r = parser.processDelta(chunk);
            allDisplay += r.displayText;
            allThinking += r.thinkingDelta;
        }

        expect(allThinking).toBe('t1t2');
        expect(allDisplay).toBe('midend');
    });
});
