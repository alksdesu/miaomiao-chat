/**
 * text-formatter.js 测试
 */
import { describe, it, expect } from 'vitest';

import { textFormatterHandler } from '../../../js/tools/builtin/text-formatter.js';

describe('textFormatterHandler', () => {
    // uppercase
    it('uppercase', async () => {
        const result = await textFormatterHandler({ operation: 'uppercase', text: 'hello' });
        expect(result.output.text).toBe('HELLO');
    });

    // lowercase
    it('lowercase', async () => {
        const result = await textFormatterHandler({ operation: 'lowercase', text: 'HELLO' });
        expect(result.output.text).toBe('hello');
    });

    // capitalize
    it('capitalize', async () => {
        const result = await textFormatterHandler({ operation: 'capitalize', text: 'hello world' });
        expect(result.output.text).toBe('Hello world');
    });

    // title_case
    it('title_case', async () => {
        const result = await textFormatterHandler({
            operation: 'title_case',
            text: 'hello world foo'
        });
        expect(result.output.text).toBe('Hello World Foo');
    });

    // trim
    it('trim', async () => {
        const result = await textFormatterHandler({ operation: 'trim', text: '  hello  ' });
        expect(result.output.text).toBe('hello');
        expect(result.metadata.removed_chars).toBe(4);
    });

    // replace
    it('replace', async () => {
        const result = await textFormatterHandler({
            operation: 'replace',
            text: 'hello world',
            find: 'world',
            replace_with: 'vitest'
        });
        expect(result.output.text).toBe('hello vitest');
    });

    it('replace 多个', async () => {
        const result = await textFormatterHandler({
            operation: 'replace',
            text: 'aXbXc',
            find: 'X',
            replace_with: '-'
        });
        expect(result.output.text).toBe('a-b-c');
    });

    it('replace 无 find 抛异常', async () => {
        await expect(textFormatterHandler({ operation: 'replace', text: 'test' })).rejects.toThrow(
            'find'
        );
    });

    it('replace 无 replace_with 默认空', async () => {
        const result = await textFormatterHandler({
            operation: 'replace',
            text: 'hello world',
            find: ' world'
        });
        expect(result.output.text).toBe('hello');
    });

    // substring
    it('substring', async () => {
        const result = await textFormatterHandler({
            operation: 'substring',
            text: 'hello world',
            start: 0,
            end: 5
        });
        expect(result.output.text).toBe('hello');
    });

    it('substring 默认参数', async () => {
        const result = await textFormatterHandler({ operation: 'substring', text: 'hello' });
        expect(result.output.text).toBe('hello');
    });

    // reverse
    it('reverse', async () => {
        const result = await textFormatterHandler({ operation: 'reverse', text: 'hello' });
        expect(result.output.text).toBe('olleh');
    });

    // encode/decode base64
    it('encode base64', async () => {
        const result = await textFormatterHandler({
            operation: 'encode',
            text: 'hello',
            encoding: 'base64'
        });
        expect(result.output.text).toBe('aGVsbG8=');
    });

    it('decode base64', async () => {
        const result = await textFormatterHandler({
            operation: 'decode',
            text: 'aGVsbG8=',
            encoding: 'base64'
        });
        expect(result.output.text).toBe('hello');
    });

    // encode/decode url
    it('encode url', async () => {
        const result = await textFormatterHandler({
            operation: 'encode',
            text: 'hello world',
            encoding: 'url'
        });
        expect(result.output.text).toBe('hello%20world');
    });

    it('decode url', async () => {
        const result = await textFormatterHandler({
            operation: 'decode',
            text: 'hello%20world',
            encoding: 'url'
        });
        expect(result.output.text).toBe('hello world');
    });

    // encode/decode html
    it('encode html', async () => {
        const result = await textFormatterHandler({
            operation: 'encode',
            text: '<b>test</b>',
            encoding: 'html'
        });
        expect(result.output.text).toBe('&lt;b&gt;test&lt;/b&gt;');
    });

    it('decode html', async () => {
        const result = await textFormatterHandler({
            operation: 'decode',
            text: '&lt;b&gt;test&lt;/b&gt;',
            encoding: 'html'
        });
        expect(result.output.text).toBe('<b>test</b>');
    });

    // encode/decode errors
    it('encode 无 encoding', async () => {
        await expect(textFormatterHandler({ operation: 'encode', text: 'test' })).rejects.toThrow(
            'encoding'
        );
    });

    it('decode 无 encoding', async () => {
        await expect(textFormatterHandler({ operation: 'decode', text: 'test' })).rejects.toThrow(
            'encoding'
        );
    });

    it('encode 未知编码', async () => {
        await expect(
            textFormatterHandler({ operation: 'encode', text: 'test', encoding: 'unknown' })
        ).rejects.toThrow('不支持的编码类型');
    });

    it('decode 未知编码', async () => {
        await expect(
            textFormatterHandler({ operation: 'decode', text: 'test', encoding: 'unknown' })
        ).rejects.toThrow('不支持的解码类型');
    });

    // count
    it('count', async () => {
        const result = await textFormatterHandler({ operation: 'count', text: 'hello world' });
        expect(result.metadata.characters).toBe(11);
        expect(result.metadata.words).toBe(2);
        expect(result.metadata.lines).toBe(1);
    });

    it('count 多行', async () => {
        const result = await textFormatterHandler({
            operation: 'count',
            text: 'line1\nline2\nline3'
        });
        expect(result.metadata.lines).toBe(3);
    });

    // split
    it('split', async () => {
        const result = await textFormatterHandler({
            operation: 'split',
            text: 'a,b,c',
            separator: ','
        });
        expect(result.metadata.parts).toEqual(['a', 'b', 'c']);
        expect(result.metadata.count).toBe(3);
    });

    it('split 默认空格', async () => {
        const result = await textFormatterHandler({ operation: 'split', text: 'hello world' });
        expect(result.metadata.parts).toEqual(['hello', 'world']);
    });

    // join
    it('join', async () => {
        const result = await textFormatterHandler({
            operation: 'join',
            text: '',
            parts: ['a', 'b', 'c'],
            separator: '-'
        });
        expect(result.output.text).toBe('a-b-c');
    });

    it('join 无 parts 抛异常', async () => {
        await expect(textFormatterHandler({ operation: 'join', text: '' })).rejects.toThrow(
            'parts'
        );
    });

    // unknown
    it('未知操作', async () => {
        await expect(textFormatterHandler({ operation: 'unknown', text: '' })).rejects.toThrow(
            '不支持的操作'
        );
    });

    // output format
    it('输出格式正确', async () => {
        const result = await textFormatterHandler({ operation: 'uppercase', text: 'test' });
        expect(result.success).toBe(true);
        expect(result.operation).toBe('uppercase');
        expect(result.input).toBeDefined();
        expect(result.output).toBeDefined();
    });

    // long text truncation in input
    it('长文本输入截断', async () => {
        const longText = 'a'.repeat(200);
        const result = await textFormatterHandler({ operation: 'uppercase', text: longText });
        expect(result.input.text.length).toBeLessThanOrEqual(103); // 100 + '...'
        expect(result.input.length).toBe(200);
    });

    // encode/decode uri alias
    it('encode uri', async () => {
        const result = await textFormatterHandler({
            operation: 'encode',
            text: 'hello world',
            encoding: 'uri'
        });
        expect(result.output.text).toBe('hello%20world');
    });

    it('decode uri', async () => {
        const result = await textFormatterHandler({
            operation: 'decode',
            text: 'hello%20world',
            encoding: 'uri'
        });
        expect(result.output.text).toBe('hello world');
    });
});
