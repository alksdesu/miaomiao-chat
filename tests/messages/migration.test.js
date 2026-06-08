/**
 * migration.js 迁移函数测试
 */
import { describe, it, expect, vi } from 'vitest';

// mock generateMessageId
vi.mock('../../js/utils/helpers.js', () => ({
    generateMessageId: () => 'msg_mock_mig'
}));

import { migrateSession, validateMigration } from '../../js/messages/migration.js';
import { PartType, ToolState } from '../../js/messages/schema.js';

// ========== migrateSession ==========

describe('migrateSession', () => {
    it('空数组返回空结果', () => {
        const result = migrateSession([]);
        expect(result.messages).toEqual([]);
        expect(result.toolMsgCount).toBe(0);
        expect(result.errors).toEqual([]);
    });

    it('null 输入返回空结果', () => {
        const result = migrateSession(null);
        expect(result.messages).toEqual([]);
    });

    it('迁移简单文本消息', () => {
        const msgs = [
            { id: 'u1', role: 'user', content: '你好', timestamp: 1000 },
            { id: 'a1', role: 'assistant', content: '你好！', timestamp: 2000 }
        ];
        const result = migrateSession(msgs);
        expect(result.messages).toHaveLength(2);
        expect(result.messages[0].role).toBe('user');
        expect(result.messages[0].parts[0].type).toBe(PartType.TEXT);
        expect(result.messages[0].parts[0].text).toBe('你好');
        expect(result.messages[1].role).toBe('assistant');
        expect(result.messages[1].parts[0].text).toBe('你好！');
    });

    it('迁移带思维链的消息', () => {
        const msgs = [
            {
                id: 'a1',
                role: 'assistant',
                content: '回答',
                thinkingContent: '让我想想',
                thinkingSignature: 'sig_1',
                timestamp: 1000
            }
        ];
        const result = migrateSession(msgs);
        const msg = result.messages[0];
        const thinkingParts = msg.parts.filter((p) => p.type === PartType.THINKING);
        expect(thinkingParts).toHaveLength(1);
        expect(thinkingParts[0].text).toBe('让我想想');
        expect(thinkingParts[0].signature).toBe('sig_1');
    });

    it('tool 消息合并到 assistant 的 tool_call', () => {
        const msgs = [
            { id: 'u1', role: 'user', content: '搜索', timestamp: 1000 },
            {
                id: 'a1',
                role: 'assistant',
                content: '',
                tool_calls: [
                    {
                        id: 'tc_1',
                        type: 'function',
                        function: { name: 'search', arguments: '{"q":"test"}' }
                    }
                ],
                timestamp: 2000
            },
            {
                id: 't1',
                role: 'tool',
                tool_call_id: 'tc_1',
                content: '{"text":"找到了"}',
                timestamp: 3000
            }
        ];
        const result = migrateSession(msgs);
        // tool 消息被合并，不会出现在结果中
        expect(result.messages).toHaveLength(2);
        expect(result.toolMsgCount).toBe(1);

        // assistant 消息的 tool_call part 应包含结果
        const assistantMsg = result.messages[1];
        const tcPart = assistantMsg.parts.find((p) => p.type === PartType.TOOL_CALL);
        expect(tcPart).toBeDefined();
        expect(tcPart.name).toBe('search');
        expect(tcPart.state).toBe(ToolState.DONE);
        expect(tcPart.result).toBeDefined();
    });

    it('迁移旧消息生成 tool_call idMap 三槽（前缀启发式归位）', () => {
        const msgs = [
            {
                id: 'a1',
                role: 'assistant',
                content: '',
                tool_calls: [{ id: 'toolu_origin', function: { name: 'fn', arguments: '{}' } }],
                timestamp: 1000
            }
        ];
        const result = migrateSession(msgs);
        const tcPart = result.messages[0].parts.find((p) => p.type === PartType.TOOL_CALL);
        expect(tcPart.idMap).toBeDefined();
        expect(tcPart.idMap.openai).toMatch(/^call_/);
        expect(tcPart.idMap.claude).toBe('toolu_origin'); // 原前缀归位
        expect(tcPart.idMap.gemini).toMatch(/^gemini_/);
    });

    it('迁移时已有 idMap 短路保留不重生成（v1 导出再导入）', () => {
        const preset = { openai: 'call_pre', claude: 'toolu_pre', gemini: 'gemini_pre' };
        const msgs = [
            {
                id: 'a1',
                role: 'assistant',
                content: '',
                tool_calls: [
                    {
                        id: 'toolu_orig',
                        function: { name: 'fn', arguments: '{}' },
                        idMap: preset
                    }
                ],
                timestamp: 1000
            }
        ];
        const result = migrateSession(msgs);
        const tcPart = result.messages[0].parts.find((p) => p.type === PartType.TOOL_CALL);
        // 已有 idMap 完整三槽，迁移不重生成
        expect(tcPart.idMap).toEqual(preset);
    });

    it('role model 映射为 assistant', () => {
        const msgs = [{ id: 'm1', role: 'model', content: 'gemini回答', timestamp: 1000 }];
        const result = migrateSession(msgs);
        expect(result.messages[0].role).toBe('assistant');
    });

    it('contentParts 多模态迁移', () => {
        const msgs = [
            {
                id: 'u1',
                role: 'user',
                contentParts: [
                    { type: 'text', text: '看这张图' },
                    { type: 'image_url', url: 'data:image/png;base64,abc', mimeType: 'image/png' }
                ],
                timestamp: 1000
            }
        ];
        const result = migrateSession(msgs);
        const parts = result.messages[0].parts;
        expect(parts).toHaveLength(2);
        expect(parts[0].type).toBe(PartType.TEXT);
        expect(parts[1].type).toBe(PartType.MEDIA);
        expect(parts[1].media).toBe('image');
    });

    it('过滤 "(调用工具)" 占位文本', () => {
        const msgs = [
            {
                id: 'a1',
                role: 'assistant',
                content: '(调用工具)',
                tool_calls: [{ id: 'tc_1', function: { name: 'fn', arguments: '{}' } }],
                timestamp: 1000
            }
        ];
        const result = migrateSession(msgs);
        const textParts = result.messages[0].parts.filter((p) => p.type === PartType.TEXT);
        expect(textParts).toHaveLength(0);
    });

    it('meta 包含 model 和 provider', () => {
        const msgs = [
            {
                id: 'a1',
                role: 'assistant',
                content: 'hi',
                modelName: 'gpt-4',
                providerName: 'openai',
                timestamp: 1000
            }
        ];
        const result = migrateSession(msgs);
        expect(result.messages[0].meta.model).toBe('gpt-4');
        expect(result.messages[0].meta.provider).toBe('openai');
    });

    it('error 消息迁移', () => {
        const msgs = [
            {
                id: 'a1',
                role: 'assistant',
                content: '出错了',
                isError: true,
                errorData: { error: { type: 'rate_limit', message: '限流' } },
                httpStatus: 429,
                timestamp: 1000
            }
        ];
        const result = migrateSession(msgs);
        expect(result.messages[0].error).toEqual({
            type: 'rate_limit',
            message: '限流',
            status: 429
        });
    });

    it('allReplies 迁移为 replies', () => {
        const msgs = [
            {
                id: 'a1',
                role: 'assistant',
                content: '回答1',
                allReplies: [
                    { content: '回答1', timestamp: 1000 },
                    { content: '回答2', timestamp: 2000 }
                ],
                selectedReplyIndex: 1,
                timestamp: 1000
            }
        ];
        const result = migrateSession(msgs);
        const msg = result.messages[0];
        expect(msg.replies).not.toBeNull();
        expect(msg.replies.all).toHaveLength(2);
        expect(msg.replies.selected).toBe(1);
        // reply 中的 parts
        expect(msg.replies.all[0].parts[0].text).toBe('回答1');
    });

    it('OpenAI content 数组格式', () => {
        const msgs = [
            {
                id: 'u1',
                role: 'user',
                content: [
                    { type: 'text', text: '描述' },
                    { type: 'image_url', image_url: { url: 'https://img.png' } }
                ],
                timestamp: 1000
            }
        ];
        const result = migrateSession(msgs);
        const parts = result.messages[0].parts;
        expect(parts[0].type).toBe(PartType.TEXT);
        expect(parts[1].type).toBe(PartType.MEDIA);
    });
});

// ========== Stage 5a 孤儿 tool_call 改 ERROR ==========

describe('Stage 5a 孤儿 tool_call 改 ERROR', () => {
    it('orphan PENDING without matching tool result becomes ERROR + is_error:true + content empty', () => {
        // assistant 发起 tool_call，但没有后续 role:tool 消息（流被中断/导出截断）
        const msgs = [
            { id: 'u1', role: 'user', content: '搜', timestamp: 1000 },
            {
                id: 'a1',
                role: 'assistant',
                content: '',
                tool_calls: [
                    { id: 'tc_orphan', function: { name: 'search', arguments: '{"q":"x"}' } }
                ],
                timestamp: 2000
            }
        ];
        const result = migrateSession(msgs);
        // tool 消息数 = 0，不参与合并
        expect(result.toolMsgCount).toBe(0);
        expect(result.messages).toHaveLength(2);

        const assistantMsg = result.messages[1];
        const tcPart = assistantMsg.parts.find((p) => p.type === PartType.TOOL_CALL);
        expect(tcPart).toBeDefined();
        // 孤儿 PENDING 翻 ERROR
        expect(tcPart.state).toBe(ToolState.ERROR);
        // 透传 is_error 让 adapter 输出 tool_result block 时打 is_error:true
        expect(tcPart.result).toEqual({
            error: '工具结果未保存',
            is_error: true,
            content: ''
        });
    });

    it('旧导出数据（无 tc.status 字段）的 tool_call 在没有匹配结果时迁移为 ERROR (backward compat)', () => {
        // 历史版本导出时只存了 tool_calls 数组但没存 status/result（早期 schema），
        // 也没有同会话的 role:tool 消息可合并；migration 必须把它当孤儿翻 ERROR
        const msgs = [
            {
                id: 'a_old',
                role: 'assistant',
                content: '思考中',
                tool_calls: [
                    {
                        id: 'toolu_legacy',
                        function: { name: 'legacy_fn', arguments: '{}' }
                        // 注意：没有 status / result 字段，模拟旧导出数据
                    }
                ],
                timestamp: 5000
            }
        ];
        const result = migrateSession(msgs);
        expect(result.messages).toHaveLength(1);
        const tcPart = result.messages[0].parts.find((p) => p.type === PartType.TOOL_CALL);
        // 默认进 PENDING（toolCallPart 默认状态），孤儿逻辑翻为 ERROR
        expect(tcPart.state).toBe(ToolState.ERROR);
        expect(tcPart.result.is_error).toBe(true);
        expect(tcPart.result.error).toBe('工具结果未保存');
        expect(tcPart.result.content).toBe('');
    });

    it('normal DONE+result tool_call 不被孤儿逻辑影响（正常路径回归保护）', () => {
        const msgs = [
            { id: 'u1', role: 'user', content: '查', timestamp: 1000 },
            {
                id: 'a1',
                role: 'assistant',
                content: '',
                tool_calls: [{ id: 'tc_ok', function: { name: 'lookup', arguments: '{"k":"v"}' } }],
                timestamp: 2000
            },
            {
                id: 't1',
                role: 'tool',
                tool_call_id: 'tc_ok',
                content: '{"text":"OK"}',
                timestamp: 3000
            }
        ];
        const result = migrateSession(msgs);
        // tool 消息合并掉，剩 user + assistant
        expect(result.messages).toHaveLength(2);
        expect(result.toolMsgCount).toBe(1);

        const tcPart = result.messages[1].parts.find((p) => p.type === PartType.TOOL_CALL);
        expect(tcPart.state).toBe(ToolState.DONE);
        // 不应携带 is_error 字段
        expect(tcPart.result.is_error).toBeUndefined();
        // 正常结果保留 content
        expect(tcPart.result.content).toBe('OK');
    });
});

// ========== validateMigration ==========

describe('validateMigration', () => {
    it('数量一致返回 valid', () => {
        const r = validateMigration(10, 8, 2);
        expect(r.valid).toBe(true);
    });

    it('数量不一致返回 invalid + 错误信息', () => {
        const r = validateMigration(10, 7, 2);
        expect(r.valid).toBe(false);
        expect(r.error).toContain('不匹配');
    });
});
