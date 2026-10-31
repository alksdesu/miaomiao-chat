import { describe, it, expect } from 'vitest';
import {
    splitPartsByTurn,
    isNativeToolCall,
    isServerToolCall,
    describeServerToolCall
} from '../../../js/api/adapters/history-replay.js';

describe('splitPartsByTurn', () => {
    it('按 _turn 升序分组，没有 _turn 的归第 0 轮并保持组内顺序', () => {
        const a = { type: 'text', text: 'a' };
        const b = { type: 'text', text: 'b', _turn: 2 };
        const c = { type: 'tool_call', id: 'c', _turn: 1 };
        const d = { type: 'tool_call', id: 'd' };
        expect(splitPartsByTurn([b, a, c, d])).toEqual([
            { turn: 0, parts: [a, d] },
            { turn: 1, parts: [c] },
            { turn: 2, parts: [b] }
        ]);
    });

    it('空 parts 返回空数组', () => {
        expect(splitPartsByTurn(undefined)).toEqual([]);
    });
});

describe('isNativeToolCall / isServerToolCall', () => {
    it('XML 模式、多回复拦截与服务端工具不按原生调用回放', () => {
        expect(isNativeToolCall({ type: 'tool_call', mode: 'native', state: 'done' })).toBe(true);
        expect(isNativeToolCall({ type: 'tool_call', mode: 'xml', state: 'done' })).toBe(false);
        expect(isNativeToolCall({ type: 'tool_call', state: 'skipped' })).toBe(false);
        expect(isNativeToolCall({ type: 'tool_call', server: true })).toBe(false);
        expect(isServerToolCall({ type: 'tool_call', server: true })).toBe(true);
    });
});

describe('describeServerToolCall', () => {
    it('web_search 结果只保留标题与链接，加密内容不进文本', () => {
        const text = describeServerToolCall({
            name: 'web_search',
            args: { query: 'paris weather' },
            result: {
                type: 'web_search_tool_result',
                content: [
                    {
                        type: 'web_search_result',
                        title: 'Paris',
                        url: 'https://example.com/paris',
                        encrypted_content: 'SECRET'
                    }
                ]
            }
        });
        expect(text).toBe(
            '[web_search] {"query":"paris weather"}\n- Paris (https://example.com/paris)'
        );
    });

    it('代码执行结果保留 stdout / stderr，错误只保留错误码', () => {
        expect(
            describeServerToolCall({
                name: 'bash_code_execution',
                args: { command: 'ls' },
                result: { content: { stdout: 'a.txt', stderr: '', return_code: 0 } }
            })
        ).toBe('[bash_code_execution] {"command":"ls"}\nstdout:\na.txt');
        expect(
            describeServerToolCall({
                name: 'web_search',
                args: {},
                result: {
                    content: {
                        type: 'web_search_tool_result_error',
                        error_code: 'max_uses_exceeded'
                    }
                }
            })
        ).toBe('[web_search] {}\nerror: max_uses_exceeded');
    });

    it('超长内容截断', () => {
        const text = describeServerToolCall({
            name: 'bash_code_execution',
            args: {},
            result: { content: { stdout: 'x'.repeat(10000) } }
        });
        expect(text.length).toBeLessThan(4100);
        expect(text.endsWith('…')).toBe(true);
    });
});
