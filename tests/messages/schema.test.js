/**
 * schema.js 核心函数测试
 */
import { describe, it, expect, vi } from 'vitest';

// mock generateMessageId，避免依赖 helpers.js 的完整 import 链
vi.mock('../../js/utils/helpers.js', () => ({
    generateMessageId: () => 'msg_mock_123'
}));

import {
    createMessage,
    createMeta,
    textPart,
    thinkingPart,
    mediaPart,
    toolCallPart,
    filePart,
    filterParts,
    getTextContent,
    getThinkingContent,
    isNewFormat,
    hasParts,
    validateMessage,
    validateMessages,
    validateToolPairings,
    agePendingToolCallsInPlace,
    Role,
    PartType,
    MediaKind,
    ToolState,
    ToolMode,
    SCHEMA_VERSION
} from '../../js/messages/schema.js';

// ========== createMessage ==========

describe('createMessage', () => {
    it('创建默认消息结构', () => {
        const msg = createMessage(Role.USER, [textPart('hello')]);
        expect(msg.id).toBe('msg_mock_123');
        expect(msg.role).toBe('user');
        expect(msg.ts).toBeTypeOf('number');
        expect(msg.parts).toHaveLength(1);
        expect(msg.parts[0]).toEqual({ type: 'text', text: 'hello' });
        expect(msg.meta).toEqual({ model: '', provider: '', usage: null, stats: null, raw: {} });
        expect(msg.replies).toBeNull();
        expect(msg.error).toBeNull();
        expect(msg._schemaVersion).toBe(SCHEMA_VERSION);
    });

    it('接受自定义 options', () => {
        const msg = createMessage(Role.ASSISTANT, [], {
            id: 'custom_id',
            ts: 1000,
            meta: createMeta({ model: 'gpt-4' }),
            replies: { all: ['a', 'b'], selected: 0 },
            error: { type: 'timeout', message: '超时' }
        });
        expect(msg.id).toBe('custom_id');
        expect(msg.ts).toBe(1000);
        expect(msg.meta.model).toBe('gpt-4');
        expect(msg.replies.all).toEqual(['a', 'b']);
        expect(msg.error.type).toBe('timeout');
    });

    it('空 parts 默认为空数组', () => {
        const msg = createMessage(Role.SYSTEM);
        expect(msg.parts).toEqual([]);
    });
});

// ========== Part 工厂函数 ==========

describe('Part 工厂函数', () => {
    it('textPart', () => {
        expect(textPart('abc')).toEqual({ type: 'text', text: 'abc' });
    });

    it('thinkingPart 无签名', () => {
        expect(thinkingPart('思考内容')).toEqual({ type: 'thinking', text: '思考内容' });
    });

    it('thinkingPart 有签名', () => {
        const p = thinkingPart('思考', 'sig123');
        expect(p.signature).toBe('sig123');
    });

    it('mediaPart', () => {
        const p = mediaPart(MediaKind.IMAGE, 'https://img.png', 'image/png', { name: 'photo' });
        expect(p.type).toBe('media');
        expect(p.media).toBe('image');
        expect(p.url).toBe('https://img.png');
        expect(p.name).toBe('photo');
    });

    it('toolCallPart', () => {
        const p = toolCallPart('tc_1', 'search', { q: 'test' });
        expect(p.type).toBe('tool_call');
        expect(p.id).toBe('tc_1');
        expect(p.name).toBe('search');
        expect(p.args).toEqual({ q: 'test' });
        expect(p.state).toBe('pending');
        expect(p.result).toBeNull();
        // 缺省 mode = 'native'（兼容缺少 mode 的历史消息）
        expect(p.mode).toBe('native');
    });

    it('toolCallPart opts.mode 透传', () => {
        const xmlPart = toolCallPart('tc_1', 'search', { q: 'test' }, { mode: 'xml' });
        expect(xmlPart.mode).toBe('xml');

        const nativePart = toolCallPart('tc_2', 'fn', {}, { mode: 'native' });
        expect(nativePart.mode).toBe('native');
    });

    it('filePart', () => {
        const p = filePart('doc.pdf', 'application/pdf', 'https://file.pdf');
        expect(p.type).toBe('file');
        expect(p.name).toBe('doc.pdf');
    });
});

// ========== filterParts ==========

describe('filterParts', () => {
    const parts = [textPart('a'), thinkingPart('b'), textPart('c'), toolCallPart('1', 'fn')];

    it('按类型过滤', () => {
        expect(filterParts(parts, PartType.TEXT)).toHaveLength(2);
        expect(filterParts(parts, PartType.THINKING)).toHaveLength(1);
        expect(filterParts(parts, PartType.TOOL_CALL)).toHaveLength(1);
        expect(filterParts(parts, PartType.MEDIA)).toHaveLength(0);
    });

    it('parts 为 null/undefined 返回空数组', () => {
        expect(filterParts(null, PartType.TEXT)).toEqual([]);
        expect(filterParts(undefined, PartType.TEXT)).toEqual([]);
    });
});

// ========== getTextContent ==========

describe('getTextContent', () => {
    it('从新格式 parts 提取文本', () => {
        const msg = createMessage(Role.ASSISTANT, [
            thinkingPart('think'),
            textPart('Hello '),
            textPart('World')
        ]);
        expect(getTextContent(msg)).toBe('Hello World');
    });

    it('不读取兼容层之外的旧字段', () => {
        expect(getTextContent({ content: '旧格式文本' })).toBe('');
    });

    it('无内容返回空字符串', () => {
        expect(getTextContent({})).toBe('');
        expect(getTextContent({ parts: [] })).toBe('');
    });
});

// ========== getThinkingContent ==========

describe('getThinkingContent', () => {
    it('从新格式提取思维链', () => {
        const msg = createMessage(Role.ASSISTANT, [
            thinkingPart('step1'),
            textPart('回答'),
            thinkingPart('step2')
        ]);
        expect(getThinkingContent(msg)).toBe('step1step2');
    });

    it('不读取兼容层之外的旧字段', () => {
        expect(getThinkingContent({ thinkingContent: '旧思维链' })).toBe('');
    });

    it('无思维链返回空字符串', () => {
        expect(getThinkingContent({})).toBe('');
    });
});

// ========== 格式检测 ==========

describe('格式检测', () => {
    it('isNewFormat 检测 _schemaVersion', () => {
        expect(isNewFormat({ _schemaVersion: 1 })).toBe(true);
        expect(isNewFormat({ _schemaVersion: 0 })).toBe(false);
        expect(isNewFormat({})).toBe(false);
        expect(isNewFormat(null)).toBe(false);
    });

    it('hasParts 检测非空 parts 数组', () => {
        expect(hasParts({ parts: [textPart('a')] })).toBe(true);
        expect(hasParts({ parts: [] })).toBe(false);
        expect(hasParts({})).toBe(false);
        expect(hasParts(null)).toBe(false);
    });
});

// ========== validateMessage ==========

describe('validateMessage', () => {
    it('合法消息返回空错误数组', () => {
        const msg = createMessage(Role.USER, [textPart('hi')]);
        expect(validateMessage(msg)).toEqual([]);
    });

    it('允许持久化媒体仅包含 mediaId', () => {
        const msg = createMessage(Role.USER, [
            { type: PartType.MEDIA, media: MediaKind.IMAGE, mediaId: 'media-1' }
        ]);
        expect(validateMessage(msg)).toEqual([]);
    });

    it('非对象返回错误', () => {
        expect(validateMessage(null)).toEqual(['消息不是对象']);
        expect(validateMessage('str')).toEqual(['消息不是对象']);
    });

    it('缺少 id', () => {
        const msg = createMessage(Role.USER, [textPart('hi')]);
        msg.id = '';
        expect(validateMessage(msg)).toContain('缺少有效的 id');
    });

    it('无效 role', () => {
        const msg = createMessage(Role.USER, [textPart('hi')]);
        msg.role = 'invalid';
        const errs = validateMessage(msg);
        expect(errs.some((e) => e.includes('无效的 role'))).toBe(true);
    });

    it('无效 ts', () => {
        const msg = createMessage(Role.USER, [textPart('hi')], { ts: -1 });
        expect(validateMessage(msg).some((e) => e.includes('无效的 ts'))).toBe(true);
    });

    it('parts 不是数组', () => {
        const msg = createMessage(Role.USER);
        msg.parts = 'not array';
        expect(validateMessage(msg)).toContain('parts 不是数组');
    });

    it('parts 中无效 type', () => {
        const msg = createMessage(Role.USER, [{ type: 'unknown' }]);
        expect(validateMessage(msg).some((e) => e.includes('无效的 type'))).toBe(true);
    });

    it('thinking part text 为空报错', () => {
        const msg = createMessage(Role.USER, [thinkingPart('')]);
        // thinkingPart('') 的 text 是空字符串
        expect(validateMessage(msg).some((e) => e.includes('thinking.text 为空'))).toBe(true);
    });

    it('tool_call 缺少 name 报错', () => {
        const msg = createMessage(Role.USER, [
            { type: 'tool_call', id: '1', name: '', args: {}, state: 'pending', result: null }
        ]);
        expect(validateMessage(msg).some((e) => e.includes('缺少 tool_call name'))).toBe(true);
    });

    it('tool_call mode 字段合法值 (native/xml)', () => {
        const nativeMsg = createMessage(Role.USER, [
            toolCallPart('1', 'fn', {}, { mode: 'native' })
        ]);
        expect(validateMessage(nativeMsg)).toEqual([]);

        const xmlMsg = createMessage(Role.USER, [toolCallPart('1', 'fn', {}, { mode: 'xml' })]);
        expect(validateMessage(xmlMsg)).toEqual([]);
    });

    it('tool_call 缺失 mode 字段视为合法（兼容历史消息）', () => {
        const msg = createMessage(Role.USER, [
            { type: 'tool_call', id: '1', name: 'fn', args: {}, state: 'pending', result: null }
        ]);
        // 不传 mode 字段，validateMessage 不应报错
        expect(validateMessage(msg)).toEqual([]);
    });

    it('tool_call 非法 mode 值报错', () => {
        const msg = createMessage(Role.USER, [
            {
                type: 'tool_call',
                id: '1',
                name: 'fn',
                args: {},
                state: 'pending',
                result: null,
                mode: 'invalid_mode'
            }
        ]);
        expect(validateMessage(msg).some((e) => e.includes('无效的 mode'))).toBe(true);
    });
});

// ========== validateMessages ==========

describe('validateMessages', () => {
    it('合法消息数组', () => {
        const msgs = [createMessage(Role.USER, [textPart('hi')])];
        const result = validateMessages(msgs);
        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
    });

    it('非数组返回无效', () => {
        const result = validateMessages('not array');
        expect(result.valid).toBe(false);
    });

    it('包含无效消息', () => {
        const msgs = [createMessage(Role.USER, [textPart('ok')]), null];
        const result = validateMessages(msgs);
        expect(result.valid).toBe(false);
        expect(result.errors.length).toBeGreaterThan(0);
    });
});

// ========== validateToolPairings ==========

describe('validateToolPairings', () => {
    const NOW = 1700000000000;
    const FRESH_TS = NOW - 1000; // 1 秒前
    const OLD_TS = NOW - 60_000; // 60 秒前
    const AGE_THRESHOLD = 30_000; // 30 秒

    it('returns valid for empty messages array', () => {
        const result = validateToolPairings([]);
        expect(result.valid).toBe(true);
        expect(result.orphans).toEqual([]);
    });

    it('returns valid for assistant with all DONE+result+idMap tool_calls', () => {
        const msg = createMessage(
            Role.ASSISTANT,
            [
                toolCallPart(
                    'tc_1',
                    'search',
                    { q: 'x' },
                    {
                        state: ToolState.DONE,
                        result: { ok: true },
                        mode: ToolMode.NATIVE,
                        idMap: { openai: 'tc_1', claude: 'tc_1', gemini: 'tc_1' }
                    }
                )
            ],
            { ts: FRESH_TS }
        );
        const result = validateToolPairings([msg], {
            ageThresholdMs: AGE_THRESHOLD,
            nowMs: NOW
        });
        expect(result.valid).toBe(true);
        expect(result.orphans).toEqual([]);
    });

    it('returns orphan_pending for PENDING tool_call beyond ageThresholdMs', () => {
        const msg = createMessage(
            Role.ASSISTANT,
            [toolCallPart('tc_1', 'search', {}, { state: ToolState.PENDING })],
            { ts: OLD_TS }
        );
        const result = validateToolPairings([msg], {
            ageThresholdMs: AGE_THRESHOLD,
            nowMs: NOW
        });
        expect(result.valid).toBe(false);
        expect(result.orphans).toHaveLength(1);
        expect(result.orphans[0]).toMatchObject({
            msgIndex: 0,
            partIndex: 0,
            partId: 'tc_1',
            reason: 'orphan_pending'
        });
        expect(result.orphans[0].age).toBe(60_000);
    });

    it('returns orphan_running for RUNNING tool_call beyond ageThresholdMs', () => {
        const msg = createMessage(
            Role.ASSISTANT,
            [toolCallPart('tc_2', 'fn', {}, { state: ToolState.RUNNING })],
            { ts: OLD_TS }
        );
        const result = validateToolPairings([msg], {
            ageThresholdMs: AGE_THRESHOLD,
            nowMs: NOW
        });
        expect(result.valid).toBe(false);
        expect(result.orphans).toHaveLength(1);
        expect(result.orphans[0].reason).toBe('orphan_running');
        expect(result.orphans[0].partId).toBe('tc_2');
    });

    it('skips SKIPPED state by default (treatSkippedAsValid:true)', () => {
        const msg = createMessage(
            Role.ASSISTANT,
            [toolCallPart('tc_3', 'fn', {}, { state: ToolState.SKIPPED })],
            { ts: OLD_TS }
        );
        const result = validateToolPairings([msg], {
            ageThresholdMs: AGE_THRESHOLD,
            nowMs: NOW
        });
        expect(result.valid).toBe(true);
        expect(result.orphans).toEqual([]);
    });

    it('returns valid for PENDING tool_call without ageThresholdMs/nowMs (无时间判定路径)', () => {
        // canAge=false 时 pending/running 不会被判为孤儿
        const msg = createMessage(
            Role.ASSISTANT,
            [toolCallPart('tc_4', 'fn', {}, { state: ToolState.PENDING })],
            { ts: OLD_TS }
        );
        const result = validateToolPairings([msg]);
        expect(result.valid).toBe(true);
        expect(result.orphans).toEqual([]);
    });

    it('returns missing_result when state=DONE but result=null', () => {
        const msg = createMessage(
            Role.ASSISTANT,
            [
                toolCallPart(
                    'tc_5',
                    'fn',
                    {},
                    {
                        state: ToolState.DONE,
                        result: null,
                        idMap: { openai: 'tc_5', claude: 'tc_5', gemini: 'tc_5' }
                    }
                )
            ],
            { ts: FRESH_TS }
        );
        const result = validateToolPairings([msg], {
            ageThresholdMs: AGE_THRESHOLD,
            nowMs: NOW
        });
        expect(result.valid).toBe(false);
        expect(result.orphans).toHaveLength(1);
        expect(result.orphans[0]).toMatchObject({
            msgIndex: 0,
            partIndex: 0,
            partId: 'tc_5',
            reason: 'missing_result'
        });
    });

    it('returns missing_result when state=ERROR but result=undefined', () => {
        // 手工构造跳过 toolCallPart 的 result??null 兜底
        const msg = createMessage(Role.ASSISTANT, [], { ts: FRESH_TS });
        msg.parts.push({
            type: PartType.TOOL_CALL,
            id: 'tc_6',
            name: 'fn',
            args: {},
            state: ToolState.ERROR,
            mode: ToolMode.NATIVE
            // result 故意不设置 -> undefined
        });
        const result = validateToolPairings([msg], {
            ageThresholdMs: AGE_THRESHOLD,
            nowMs: NOW
        });
        expect(result.valid).toBe(false);
        expect(result.orphans).toHaveLength(1);
        expect(result.orphans[0].reason).toBe('missing_result');
        expect(result.orphans[0].partId).toBe('tc_6');
    });

    it('returns idmap_missing when state=DONE + mode=NATIVE + no idMap', () => {
        const msg = createMessage(
            Role.ASSISTANT,
            [
                toolCallPart(
                    'tc_7',
                    'fn',
                    {},
                    {
                        state: ToolState.DONE,
                        result: { ok: true },
                        mode: ToolMode.NATIVE
                        // 无 idMap
                    }
                )
            ],
            { ts: FRESH_TS }
        );
        const result = validateToolPairings([msg], {
            ageThresholdMs: AGE_THRESHOLD,
            nowMs: NOW
        });
        expect(result.valid).toBe(false);
        expect(result.orphans).toHaveLength(1);
        expect(result.orphans[0]).toMatchObject({
            msgIndex: 0,
            partIndex: 0,
            partId: 'tc_7',
            reason: 'idmap_missing'
        });
    });

    it('accumulates orphans across multiple assistant messages (multi-turn continuation)', () => {
        const m1 = createMessage(
            Role.ASSISTANT,
            [toolCallPart('tc_a', 'fn', {}, { state: ToolState.PENDING })],
            { ts: OLD_TS }
        );
        const m2 = createMessage(Role.USER, [textPart('continue')], { ts: OLD_TS + 1 });
        const m3 = createMessage(
            Role.ASSISTANT,
            [
                toolCallPart('tc_b', 'fn', {}, { state: ToolState.RUNNING }),
                toolCallPart(
                    'tc_c',
                    'fn',
                    {},
                    {
                        state: ToolState.DONE,
                        result: { ok: true },
                        mode: ToolMode.NATIVE
                        // 无 idMap
                    }
                )
            ],
            { ts: OLD_TS + 2 }
        );
        const result = validateToolPairings([m1, m2, m3], {
            ageThresholdMs: AGE_THRESHOLD,
            nowMs: NOW
        });
        expect(result.valid).toBe(false);
        expect(result.orphans).toHaveLength(3);
        // m1 PENDING
        expect(result.orphans[0]).toMatchObject({
            msgIndex: 0,
            partIndex: 0,
            reason: 'orphan_pending'
        });
        // m3 RUNNING
        expect(result.orphans[1]).toMatchObject({
            msgIndex: 2,
            partIndex: 0,
            reason: 'orphan_running'
        });
        // m3 idmap_missing
        expect(result.orphans[2]).toMatchObject({
            msgIndex: 2,
            partIndex: 1,
            reason: 'idmap_missing'
        });
    });
});

// ========== agePendingToolCallsInPlace ==========

describe('agePendingToolCallsInPlace', () => {
    const NOW = 1700000000000;
    const FRESH_TS = NOW - 1000;
    const OLD_TS = NOW - 60_000;
    const AGE_THRESHOLD = 30_000;

    it('returns 0 when messages is not array', () => {
        expect(agePendingToolCallsInPlace(null, { nowMs: NOW })).toBe(0);
        expect(agePendingToolCallsInPlace(undefined, { nowMs: NOW })).toBe(0);
        expect(agePendingToolCallsInPlace('not array', { nowMs: NOW })).toBe(0);
    });

    it('returns 0 when nowMs is missing (pure function semantics)', () => {
        const msg = createMessage(
            Role.ASSISTANT,
            [toolCallPart('tc_1', 'fn', {}, { state: ToolState.PENDING })],
            { ts: OLD_TS }
        );
        const aged = agePendingToolCallsInPlace([msg], { ageThresholdMs: AGE_THRESHOLD });
        expect(aged).toBe(0);
        expect(msg.parts[0].state).toBe(ToolState.PENDING);
    });

    it('ages PENDING tool_call beyond ageThresholdMs to ERROR + interrupted', () => {
        const msg = createMessage(
            Role.ASSISTANT,
            [toolCallPart('tc_1', 'fn', {}, { state: ToolState.PENDING })],
            { ts: OLD_TS }
        );
        const aged = agePendingToolCallsInPlace([msg], {
            ageThresholdMs: AGE_THRESHOLD,
            nowMs: NOW
        });
        expect(aged).toBe(1);
        expect(msg.parts[0].state).toBe(ToolState.ERROR);
        expect(msg.parts[0].result).toMatchObject({
            error: 'Tool execution was interrupted',
            is_error: true,
            interrupted: true,
            content: ''
        });
    });

    it('ages RUNNING tool_call beyond ageThresholdMs to ERROR', () => {
        const msg = createMessage(
            Role.ASSISTANT,
            [toolCallPart('tc_2', 'fn', {}, { state: ToolState.RUNNING })],
            { ts: OLD_TS }
        );
        const aged = agePendingToolCallsInPlace([msg], {
            ageThresholdMs: AGE_THRESHOLD,
            nowMs: NOW
        });
        expect(aged).toBe(1);
        expect(msg.parts[0].state).toBe(ToolState.ERROR);
        expect(msg.parts[0].result.interrupted).toBe(true);
    });

    it('force ages all PENDING/RUNNING when ageThresholdMs:0 (export sanitize 用例)', () => {
        const m1 = createMessage(
            Role.ASSISTANT,
            [toolCallPart('tc_1', 'fn', {}, { state: ToolState.PENDING })],
            { ts: FRESH_TS }
        );
        const m2 = createMessage(
            Role.ASSISTANT,
            [toolCallPart('tc_2', 'fn', {}, { state: ToolState.RUNNING })],
            { ts: FRESH_TS }
        );
        // ageThresholdMs:0 + 任意 nowMs -> 全部老化
        const aged = agePendingToolCallsInPlace([m1, m2], {
            ageThresholdMs: 0,
            nowMs: NOW
        });
        expect(aged).toBe(2);
        expect(m1.parts[0].state).toBe(ToolState.ERROR);
        expect(m2.parts[0].state).toBe(ToolState.ERROR);
    });

    it('leaves DONE/ERROR tool_calls untouched', () => {
        const m1 = createMessage(
            Role.ASSISTANT,
            [
                toolCallPart(
                    'tc_1',
                    'fn',
                    {},
                    {
                        state: ToolState.DONE,
                        result: { ok: true }
                    }
                )
            ],
            { ts: OLD_TS }
        );
        const originalResult = m1.parts[0].result;
        const m2 = createMessage(
            Role.ASSISTANT,
            [
                toolCallPart(
                    'tc_2',
                    'fn',
                    {},
                    {
                        state: ToolState.ERROR,
                        result: { error: 'prev' }
                    }
                )
            ],
            { ts: OLD_TS }
        );
        const aged = agePendingToolCallsInPlace([m1, m2], {
            ageThresholdMs: AGE_THRESHOLD,
            nowMs: NOW
        });
        expect(aged).toBe(0);
        expect(m1.parts[0].state).toBe(ToolState.DONE);
        expect(m1.parts[0].result).toBe(originalResult);
        expect(m2.parts[0].state).toBe(ToolState.ERROR);
        expect(m2.parts[0].result).toEqual({ error: 'prev' });
    });

    it('in-place modifies messages array (verifies reference identity)', () => {
        const part = toolCallPart('tc_1', 'fn', {}, { state: ToolState.PENDING });
        const msg = createMessage(Role.ASSISTANT, [part], { ts: OLD_TS });
        const messages = [msg];
        const sameRef = messages;
        const samePart = messages[0].parts[0];

        agePendingToolCallsInPlace(messages, {
            ageThresholdMs: AGE_THRESHOLD,
            nowMs: NOW
        });

        // 引用同一性：未替换数组、未替换 msg、未替换 part
        expect(messages).toBe(sameRef);
        expect(messages[0]).toBe(msg);
        expect(messages[0].parts[0]).toBe(samePart);
        expect(samePart.state).toBe(ToolState.ERROR);
    });

    it('uses opts.errorMessage when provided', () => {
        const msg = createMessage(
            Role.ASSISTANT,
            [toolCallPart('tc_1', 'fn', {}, { state: ToolState.PENDING })],
            { ts: OLD_TS }
        );
        const aged = agePendingToolCallsInPlace([msg], {
            ageThresholdMs: AGE_THRESHOLD,
            nowMs: NOW,
            errorMessage: 'Custom abort reason'
        });
        expect(aged).toBe(1);
        expect(msg.parts[0].result.error).toBe('Custom abort reason');
    });
});
