/**
 * xml-formatter.js 测试
 */
import { describe, it, expect, beforeEach } from 'vitest';

import {
    escapeXML,
    convertToolsToXML,
    extractXMLToolCalls,
    appendXmlToolResultsForMessage,
    applyXMLToolCalls,
    XMLStreamAccumulator
} from '../../js/tools/xml-formatter.js';

// ========== escapeXML ==========

describe('escapeXML', () => {
    it('转义 &', () => {
        expect(escapeXML('a&b')).toBe('a&amp;b');
    });

    it('转义 <', () => {
        expect(escapeXML('a<b')).toBe('a&lt;b');
    });

    it('转义 >', () => {
        expect(escapeXML('a>b')).toBe('a&gt;b');
    });

    it('转义 "', () => {
        expect(escapeXML('a"b')).toBe('a&quot;b');
    });

    it("转义 '", () => {
        expect(escapeXML("a'b")).toBe('a&apos;b');
    });

    it('转义回车', () => {
        expect(escapeXML('a\rb')).toBe('a&#xD;b');
    });

    it('过滤控制字符', () => {
        expect(escapeXML('a\x00b\x08c')).toBe('abc');
    });

    it('保留 tab/newline', () => {
        expect(escapeXML('a\tb\nc')).toBe('a\tb\nc');
    });

    it('非字符串返回空', () => {
        expect(escapeXML(null)).toBe('');
        expect(escapeXML(123)).toBe('');
        expect(escapeXML(undefined)).toBe('');
    });

    it('空字符串返回空', () => {
        expect(escapeXML('')).toBe('');
    });

    it('& 必须最先转义', () => {
        expect(escapeXML('&<>')).toBe('&amp;&lt;&gt;');
    });
});

// ========== convertToolsToXML ==========

describe('convertToolsToXML', () => {
    it('空数组返回空', () => {
        expect(convertToolsToXML([])).toBe('');
    });

    it('null 返回空', () => {
        expect(convertToolsToXML(null)).toBe('');
    });

    it('生成 XML 描述', () => {
        const tools = [
            { name: 'search', description: 'Search the web', parameters: { type: 'object' } }
        ];
        const xml = convertToolsToXML(tools);
        expect(xml).toContain('search');
        expect(xml).toContain('Search the web');
        expect(xml).toContain('tool_use');
        expect(xml).toContain('Available Tools');
    });

    it('支持 function 格式', () => {
        const tools = [{ function: { name: 'calc', description: 'Calculate', parameters: {} } }];
        const xml = convertToolsToXML(tools);
        expect(xml).toContain('calc');
    });

    it('跳过无 name 的工具', () => {
        const tools = [{ description: 'no name tool' }];
        const xml = convertToolsToXML(tools);
        expect(xml).not.toContain('no name tool');
    });

    it('无 description 使用默认', () => {
        const tools = [{ name: 'tool1' }];
        const xml = convertToolsToXML(tools);
        expect(xml).toContain('No description');
    });

    it('XML 特殊字符转义', () => {
        const tools = [{ name: 'test<tool>', description: 'A & B' }];
        const xml = convertToolsToXML(tools);
        expect(xml).toContain('&lt;tool&gt;');
        expect(xml).toContain('A &amp; B');
    });

    it('包含示例和规则', () => {
        const tools = [{ name: 'test' }];
        const xml = convertToolsToXML(tools);
        expect(xml).toContain('Tool Use Examples');
        expect(xml).toContain('Tool Use Rules');
        expect(xml).toContain('Extended Thinking');
    });
});

// ========== extractXMLToolCalls ==========

describe('extractXMLToolCalls', () => {
    it('空字符串返回空', () => {
        expect(extractXMLToolCalls('')).toEqual([]);
    });

    it('null 返回空', () => {
        expect(extractXMLToolCalls(null)).toEqual([]);
    });

    it('无工具调用返回空', () => {
        expect(extractXMLToolCalls('just plain text')).toEqual([]);
    });

    it('提取 tool_use 格式', () => {
        const text =
            '<tool_use>\n<name>search</name>\n<arguments>{"query":"test"}</arguments>\n</tool_use>';
        const calls = extractXMLToolCalls(text);
        expect(calls).toHaveLength(1);
        expect(calls[0].name).toBe('search');
        expect(calls[0].arguments).toEqual({ query: 'test' });
        expect(calls[0].id).toMatch(/^xml_tool_/);
    });

    it('提取多个 tool_use', () => {
        const text =
            '<tool_use><name>a</name><arguments>{"x":1}</arguments></tool_use>' +
            '<tool_use><name>b</name><arguments>{"y":2}</arguments></tool_use>';
        const calls = extractXMLToolCalls(text);
        expect(calls).toHaveLength(2);
    });

    it('提取 function_call 格式', () => {
        const text =
            '<function_call>\n<name>calc</name>\n<arguments>{"expr":"1+1"}</arguments>\n</function_call>';
        const calls = extractXMLToolCalls(text);
        expect(calls).toHaveLength(1);
        expect(calls[0].name).toBe('calc');
    });

    it('提取 invoke 格式', () => {
        const text = '<invoke name="search"><parameter name="query">test</parameter></invoke>';
        const calls = extractXMLToolCalls(text);
        expect(calls).toHaveLength(1);
        expect(calls[0].name).toBe('search');
        expect(calls[0].arguments.query).toBe('test');
    });

    it('invoke 参数值尝试 JSON 解析', () => {
        const text = '<invoke name="fn"><parameter name="count">42</parameter></invoke>';
        const calls = extractXMLToolCalls(text);
        expect(calls[0].arguments.count).toBe(42);
    });

    it('invoke 无参数', () => {
        const text = '<invoke name="noop"></invoke>';
        const calls = extractXMLToolCalls(text);
        expect(calls).toHaveLength(1);
        expect(calls[0].arguments).toEqual({});
    });

    it('tool_use 无效 JSON 参数', () => {
        const text = '<tool_use><name>test</name><arguments>invalid json</arguments></tool_use>';
        const calls = extractXMLToolCalls(text);
        expect(calls).toHaveLength(1);
        expect(calls[0].name).toBe('test');
        expect(calls[0].arguments).toEqual({});
        expect(calls[0]._parseError).toBeDefined();
    });

    it('function_call 无效 JSON 参数', () => {
        const text = '<function_call><name>test</name><arguments>{bad}</arguments></function_call>';
        const calls = extractXMLToolCalls(text);
        expect(calls).toHaveLength(1);
        expect(calls[0]._parseError).toBeDefined();
    });

    it('混合格式', () => {
        const text =
            '<tool_use><name>a</name><arguments>{"x":1}</arguments></tool_use>' +
            'some text' +
            '<function_call><name>b</name><arguments>{"y":2}</arguments></function_call>';
        const calls = extractXMLToolCalls(text);
        expect(calls).toHaveLength(2);
    });

    it('非字符串返回空', () => {
        expect(extractXMLToolCalls(123)).toEqual([]);
    });

    it('每个调用有唯一 ID', () => {
        const text =
            '<tool_use><name>a</name><arguments>{}</arguments></tool_use>' +
            '<tool_use><name>b</name><arguments>{}</arguments></tool_use>';
        const calls = extractXMLToolCalls(text);
        expect(calls[0].id).not.toBe(calls[1].id);
    });
});

// ========== XMLStreamAccumulator ==========

describe('XMLStreamAccumulator', () => {
    let acc;

    beforeEach(() => {
        acc = new XMLStreamAccumulator();
    });

    it('初始状态', () => {
        expect(acc.buffer).toBe('');
        expect(acc.displayText).toBe('');
        expect(acc.inToolUse).toBe(false);
        expect(acc.completedCalls).toEqual([]);
    });

    it('纯文本输出', () => {
        const r = acc.processDelta('hello world');
        expect(r.displayText).toBe('hello world');
        expect(r.hasToolCalls).toBe(false);
        expect(r.error).toBeNull();
    });

    it('空 delta 不报错', () => {
        const r = acc.processDelta('');
        expect(r.displayText).toBe('');
        expect(r.hasToolCalls).toBe(false);
    });

    it('null delta 不报错', () => {
        const r = acc.processDelta(null);
        expect(r.hasToolCalls).toBe(false);
    });

    it('完整 tool_use 检测', () => {
        acc.processDelta('text before ');
        acc.processDelta('<tool_use><name>test</name><arguments>{"a":1}</arguments></tool_use>');
        acc.processDelta(' text after');
        expect(acc.completedCalls).toHaveLength(1);
        expect(acc.completedCalls[0].name).toBe('test');
        expect(acc.displayText).toContain('text before');
    });

    it('流式 tool_use 累积', () => {
        acc.processDelta('start ');
        acc.processDelta('<tool_use>');
        acc.processDelta('<name>search</name>');
        acc.processDelta('<arguments>{"q":"test"}</arguments>');
        const r = acc.processDelta('</tool_use>');
        expect(r.hasToolCalls).toBe(true);
        expect(acc.completedCalls[0].name).toBe('search');
    });

    it('getCompletedCalls 清空缓存', () => {
        // Need multiple calls since processDelta processes tags incrementally
        acc.processDelta('<tool_use>');
        acc.processDelta('<name>test</name><arguments>{}</arguments>');
        acc.processDelta('</tool_use>');
        const calls1 = acc.getCompletedCalls();
        expect(calls1).toHaveLength(1);
        const calls2 = acc.getCompletedCalls();
        expect(calls2).toHaveLength(0);
    });

    it('thinking 块检测', () => {
        acc.processDelta('before ');
        acc.processDelta('<thinking>');
        acc.processDelta('let me think');
        acc.processDelta('</thinking>');
        expect(acc.thinkingBlocks).toHaveLength(1);
        expect(acc.thinkingBlocks[0]).toContain('let me think');
    });

    it('getThinkingBlocks', () => {
        acc.processDelta('<thinking>');
        acc.processDelta('block1');
        acc.processDelta('</thinking>');
        expect(acc.getThinkingBlocks()).toHaveLength(1);
    });

    it('reset 清空所有', () => {
        acc.processDelta('text');
        acc.reset();
        expect(acc.buffer).toBe('');
        expect(acc.displayText).toBe('');
        expect(acc.completedCalls).toEqual([]);
        expect(acc.thinkingBlocks).toEqual([]);
        expect(acc.inToolUse).toBe(false);
        expect(acc.inThinking).toBe(false);
    });

    it('多次 processDelta 累积 displayText', () => {
        acc.processDelta('hello ');
        acc.processDelta('world');
        expect(acc.displayText).toBe('hello world');
    });
});

// ========== appendXmlToolResultsForMessage ==========

describe('appendXmlToolResultsForMessage', () => {
    const buildUserMessage = (text, images) => ({ role: 'user', content: text, images });

    it('XML mode tool_call 配对追加 <tool_use> + <tool_use_result>', () => {
        const out = [{ role: 'assistant', content: '<tool_use>...' }];
        const msg = {
            role: 'assistant',
            parts: [
                { type: 'text', text: '<tool_use>...' },
                {
                    type: 'tool_call',
                    id: 'tc_1',
                    name: 'search',
                    args: { q: 'test' },
                    mode: 'xml',
                    result: { content: 'found' }
                }
            ]
        };

        appendXmlToolResultsForMessage(out, msg, buildUserMessage);

        expect(out).toHaveLength(2);
        expect(out[1].role).toBe('user');
        // 配对追加：先 tool_use（含 arguments）再 tool_use_result
        expect(out[1].content).toContain('<tool_use>');
        expect(out[1].content).toContain('<arguments>');
        expect(out[1].content).toContain('<tool_use_result>');
        expect(out[1].content).toContain('<result>found</result>');
        // tool_use 应在 tool_use_result 之前（顺序对称）
        expect(out[1].content.indexOf('<tool_use>')).toBeLessThan(
            out[1].content.indexOf('<tool_use_result>')
        );
    });

    it('args 为字符串时原样写入 arguments', () => {
        const out = [];
        const msg = {
            role: 'assistant',
            parts: [
                {
                    type: 'tool_call',
                    id: 'tc_1',
                    name: 'tool',
                    args: '{"raw":"json"}',
                    mode: 'xml',
                    result: 'ok'
                }
            ]
        };

        appendXmlToolResultsForMessage(out, msg, buildUserMessage);

        expect(out).toHaveLength(1);
        expect(out[0].content).toContain('{&quot;raw&quot;:&quot;json&quot;}');
    });

    it('结果里的图片交给各家组装，不写进 XML 文本', () => {
        const out = [];
        const msg = {
            parts: [
                {
                    type: 'tool_call',
                    id: 'tc_1',
                    name: 'computer',
                    args: { action: 'screenshot' },
                    mode: 'xml',
                    result: {
                        content: 'captured',
                        media: [{ type: 'image', url: 'data:image/png;base64,shot' }]
                    }
                }
            ]
        };

        appendXmlToolResultsForMessage(out, msg, buildUserMessage);

        expect(out[0].content).toContain('<result>captured</result>');
        expect(out[0].content).not.toContain('base64');
        expect(out[0].images).toEqual([
            { url: 'data:image/png;base64,shot', mimeType: 'image/png' }
        ]);
    });

    it('native mode tool_call 默认不命中', () => {
        const out = [{ role: 'assistant', content: 'ok' }];
        const msg = {
            role: 'assistant',
            parts: [
                {
                    type: 'tool_call',
                    id: 'tc_1',
                    name: 'search',
                    mode: 'native',
                    result: { content: 'found' }
                }
            ]
        };

        appendXmlToolResultsForMessage(out, msg, buildUserMessage);

        expect(out).toHaveLength(1); // 不追加
    });

    it('指定的原生调用转成 XML 文本，没有结果时按中断处理', () => {
        const out = [];
        const nativeCall = {
            type: 'tool_call',
            id: 'tc_1',
            name: 'left_click',
            args: { coordinate: [1, 2] },
            mode: 'native',
            result: null
        };

        appendXmlToolResultsForMessage(
            out,
            { parts: [nativeCall] },
            buildUserMessage,
            (p) => p === nativeCall
        );

        expect(out).toHaveLength(1);
        expect(out[0].content).toContain('<name>left_click</name>');
        expect(out[0].content).toContain('<result>Tool execution was interrupted</result>');
    });

    it('result == null 不命中', () => {
        const out = [];
        const msg = {
            role: 'assistant',
            parts: [
                {
                    type: 'tool_call',
                    id: 'tc_1',
                    name: 'search',
                    mode: 'xml',
                    result: null
                }
            ]
        };

        appendXmlToolResultsForMessage(out, msg, buildUserMessage);

        expect(out).toHaveLength(0);
    });
});

describe('applyXMLToolCalls', () => {
    const xml =
        'Let me check.\n<tool_use>\n  <name>search</name>\n  <arguments>{"q":"x"}</arguments>\n</tool_use>';

    it('正文去掉调用块，思考与媒体保留，调用标为 XML 模式', () => {
        const reply = {
            content: xml,
            thinkingContent: 'plan',
            contentParts: [
                { type: 'thinking', text: 'plan', signature: 'sig' },
                { type: 'text', text: xml },
                { type: 'image_url', url: 'data:image/png;base64,A', complete: true }
            ],
            stop: null
        };
        const result = applyXMLToolCalls(reply, xml);
        expect(result.content).toBe('Let me check.\n');
        expect(result.contentParts).toEqual([
            { type: 'thinking', text: 'plan', signature: 'sig' },
            { type: 'text', text: 'Let me check.\n' },
            { type: 'image_url', url: 'data:image/png;base64,A', complete: true }
        ]);
        expect(result.toolCalls).toEqual([
            expect.objectContaining({ name: 'search', arguments: { q: 'x' }, mode: 'xml' })
        ]);
        expect(result.hasToolCalls).toBe(true);
        expect(result.thinkingContent).toBe('plan');
    });

    it('没有 XML 调用时返回 null', () => {
        expect(applyXMLToolCalls({ content: 'plain' }, 'plain')).toBeNull();
    });
});
