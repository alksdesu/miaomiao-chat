import { describe, expect, it } from 'vitest';
import {
    normalizeSessionRecord,
    assertCanonicalMessages
} from '../../js/messages/compat/gateway.js';
import { detectSessionSchema } from '../../js/messages/compat/detector.js';
import { SCHEMA_VERSION, createMessage, textPart, toolCallPart } from '../../js/messages/schema.js';

describe('legacy compatibility gateway', () => {
    it('当前格式走快速路径并保持对象引用', () => {
        const message = createMessage('user', [textPart('hello')], { id: 'current', ts: 1 });
        const result = normalizeSessionRecord({ messages: [message], messageSchemaVersion: 1 });

        expect(result.status).toBe('unchanged');
        expect(result.changed).toBe(false);
        expect(result.messages[0]).toBe(message);
    });

    it('没有版本戳的 parts 消息只补齐标准字段', () => {
        const input = { id: 'parts-only', role: 'user', ts: 1, parts: [textPart('hello')] };
        const result = normalizeSessionRecord({ messages: [input] }, { sessionId: 'session-a' });

        expect(result.status).toBe('upgraded');
        expect(result.messages[0]._schemaVersion).toBe(SCHEMA_VERSION);
        expect(result.messages[0].meta).toEqual({});
        expect(result.messages[0].replies).toBeNull();
        expect(input._schemaVersion).toBeUndefined();
    });

    it('会话级迁移合并独立 tool 结果且不修改输入', () => {
        const input = [
            {
                id: 'assistant-old',
                role: 'assistant',
                ts: 1,
                content: '',
                tool_calls: [
                    {
                        id: 'call-1',
                        function: { name: 'lookup', arguments: '{"q":"x"}' }
                    }
                ]
            },
            { role: 'tool', tool_call_id: 'call-1', content: '{"answer":42}' }
        ];
        const snapshot = structuredClone(input);
        const result = normalizeSessionRecord({ messages: input }, { sessionId: 'session-b' });

        expect(result.status).toBe('upgraded');
        expect(result.messages).toHaveLength(1);
        expect(result.toolMessageCount).toBe(1);
        expect(result.messages[0].parts[0]).toMatchObject({
            type: 'tool_call',
            id: 'call-1',
            name: 'lookup',
            state: 'done',
            result: { content: '{"answer":42}', error: null, media: [] }
        });
        expect(input).toEqual(snapshot);
    });

    it('支持同一会话混合新旧消息', () => {
        const current = createMessage('assistant', [textPart('new')], { id: 'new', ts: 2 });
        const result = normalizeSessionRecord(
            {
                messages: [{ id: 'old', role: 'user', ts: 1, content: 'legacy' }, current]
            },
            { sessionId: 'session-c' }
        );

        expect(result.messages).toHaveLength(2);
        expect(result.messages[0].parts).toContainEqual(
            expect.objectContaining({ text: 'legacy' })
        );
        expect(result.messages[1].parts).toContainEqual(expect.objectContaining({ text: 'new' }));
        expect(result.messages[1]).not.toBe(current);
    });

    it('重复 ID 使用确定性 ID 修复', () => {
        const first = createMessage('user', [textPart('a')], { id: 'same', ts: 1 });
        const second = createMessage('assistant', [textPart('b')], { id: 'same', ts: 2 });
        const result = normalizeSessionRecord({ messages: [first, second] }, { sessionId: 'dup' });

        expect(result.messages[0].id).toBe('same');
        expect(result.messages[1].id).toBe('compat-dup-1');
        expect(new Set(result.messages.map((message) => message.id)).size).toBe(2);
    });

    it('格式检测不会把流式字段之外的标准 parts 判为旧格式', () => {
        const assistant = createMessage(
            'assistant',
            [
                toolCallPart(
                    'id',
                    'tool',
                    {},
                    {
                        idMap: { openai: 'call-id', claude: 'toolu-id', gemini: 'gemini-id' }
                    }
                )
            ],
            { id: 'assistant', ts: 1 }
        );
        const detection = detectSessionSchema([assistant], SCHEMA_VERSION);

        expect(detection.canonical).toBe(true);
        expect(detection.version).toBe(SCHEMA_VERSION);
        expect(assertCanonicalMessages([assistant], 'test')).toBe(true);
    });

    it('标准 tool_call 缺少 idMap 时在边界补齐且不修改输入', () => {
        const message = createMessage('assistant', [toolCallPart('id', 'tool')], {
            id: 'assistant',
            ts: 1
        });
        const result = normalizeSessionRecord({ messages: [message] }, { sessionId: 'tool-map' });

        expect(result.status).toBe('upgraded');
        expect(result.messages[0].parts[0].idMap).toMatchObject({
            openai: expect.any(String),
            claude: expect.any(String),
            gemini: expect.any(String)
        });
        expect(message.parts[0].idMap).toBeUndefined();
    });

    it('损坏的当前版本消息降级为可读标准消息', () => {
        const broken = {
            id: 'broken',
            role: 'assistant',
            ts: 1,
            parts: [{ type: 'unknown', text: 'unreadable' }],
            meta: {},
            replies: null,
            error: null,
            _schemaVersion: SCHEMA_VERSION
        };
        const result = normalizeSessionRecord(
            { messages: [broken], messageSchemaVersion: SCHEMA_VERSION },
            { sessionId: 'broken-session' }
        );

        expect(result.status).toBe('salvaged');
        expect(result.messages[0]).toMatchObject({
            id: 'broken',
            role: 'assistant',
            _schemaVersion: SCHEMA_VERSION
        });
        expect(result.messages[0].parts[0]).toMatchObject({
            type: 'text',
            text: '[旧消息无法完整恢复]'
        });
        expect(assertCanonicalMessages(result.messages, 'salvaged')).toBe(true);
    });

    it('标准化旧回复字段后再次读取保持快速路径', () => {
        const message = createMessage('assistant', [textPart('selected')], {
            id: 'with-replies',
            ts: 1,
            replies: {
                all: [{ parts: [textPart('reply')], timestamp: 2 }],
                selected: 0
            }
        });
        const first = normalizeSessionRecord({ messages: [message] }, { sessionId: 'replies' });
        const second = normalizeSessionRecord(
            { messages: first.messages, messageSchemaVersion: SCHEMA_VERSION },
            { sessionId: 'replies' }
        );

        expect(first.status).toBe('upgraded');
        expect(first.messages[0].replies.all[0]).toMatchObject({
            ts: 2,
            meta: {},
            error: null
        });
        expect(second.status).toBe('unchanged');
        expect(second.messages[0]).toBe(first.messages[0]);
    });

    it('修复越界的回复索引并保持重复执行幂等', () => {
        const message = createMessage('assistant', [textPart('selected')], {
            id: 'bounded-replies',
            ts: 1,
            replies: {
                all: [
                    { parts: [textPart('one')], meta: {}, ts: 1, error: null },
                    { parts: [textPart('two')], meta: {}, ts: 2, error: null }
                ],
                selected: 99
            }
        });

        const first = normalizeSessionRecord(
            { messages: [message], messageSchemaVersion: SCHEMA_VERSION },
            { sessionId: 'bounded' }
        );
        const second = normalizeSessionRecord(
            { messages: first.messages, messageSchemaVersion: SCHEMA_VERSION },
            { sessionId: 'bounded' }
        );

        expect(first.messages[0].replies.selected).toBe(1);
        expect(first.status).toBe('upgraded');
        expect(second.status).toBe('unchanged');
        expect(second.messages[0]).toBe(first.messages[0]);
    });

    it('跨分页规模的旧工具结果仍按会话级调用 ID 配对', () => {
        const messages = [
            {
                id: 'tool-owner',
                role: 'assistant',
                ts: 1,
                content: '',
                tool_calls: [{ id: 'cross-page', function: { name: 'lookup', arguments: '{}' } }]
            },
            ...Array.from({ length: 100 }, (_, index) => ({
                id: `filler-${index}`,
                role: 'user',
                ts: index + 2,
                content: `filler-${index}`
            })),
            { role: 'tool', tool_call_id: 'cross-page', content: 'done' }
        ];

        const result = normalizeSessionRecord({ messages }, { sessionId: 'paged-tools' });
        const toolCall = result.messages[0].parts.find((part) => part.type === 'tool_call');

        expect(result.toolMessageCount).toBe(1);
        expect(toolCall).toMatchObject({ state: 'done', result: { content: 'done' } });
    });

    it('未知角色会归一为 user 且 provider 原始元数据保持不变', () => {
        const raw = { custom: { requestId: 'request-1' } };
        const result = normalizeSessionRecord(
            {
                messages: [
                    {
                        id: 'unknown-role',
                        role: 'alien',
                        ts: 1,
                        parts: [textPart('hello')],
                        meta: { raw },
                        replies: null,
                        error: null,
                        _schemaVersion: SCHEMA_VERSION
                    }
                ],
                messageSchemaVersion: SCHEMA_VERSION
            },
            { sessionId: 'unknown-role' }
        );

        expect(result.messages[0].role).toBe('user');
        expect(result.messages[0].meta.raw).toBe(raw);
    });
});
