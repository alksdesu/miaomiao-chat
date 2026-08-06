/**
 * format-converter.js 测试
 */
import { describe, it, expect } from 'vitest';

import {
    generateIdSet,
    getMappedId,
    ensureIdMap,
    extractThoughtSignature,
    clearThoughtSignatures,
    hasThoughtSignatures,
    sanitizeMessageForExport
} from '../../js/api/format-converter.js';

// ========== generateIdSet ==========

describe('generateIdSet', () => {
    it('返回三槽对象', () => {
        const idMap = generateIdSet('call_abc');
        expect(idMap).toHaveProperty('openai');
        expect(idMap).toHaveProperty('claude');
        expect(idMap).toHaveProperty('gemini');
    });

    it('三槽前缀互异', () => {
        const idMap = generateIdSet('');
        expect(idMap.openai).toMatch(/^call_/);
        expect(idMap.claude).toMatch(/^toolu_/);
        expect(idMap.gemini).toMatch(/^gemini_/);
    });

    it('OpenAI 原生 id 留在 openai 槽', () => {
        const idMap = generateIdSet('call_origin');
        expect(idMap.openai).toBe('call_origin');
        expect(idMap.claude).toMatch(/^toolu_/);
        expect(idMap.gemini).toMatch(/^gemini_/);
    });

    it('Claude 原生 id 留在 claude 槽', () => {
        const idMap = generateIdSet('toolu_origin');
        expect(idMap.claude).toBe('toolu_origin');
        expect(idMap.openai).toMatch(/^call_/);
        expect(idMap.gemini).toMatch(/^gemini_/);
    });

    it('Gemini 原生 id 留在 gemini 槽', () => {
        const idMap = generateIdSet('gemini_origin');
        expect(idMap.gemini).toBe('gemini_origin');
        expect(idMap.openai).toMatch(/^call_/);
        expect(idMap.claude).toMatch(/^toolu_/);
    });

    it('非三家原生 id 三槽全部新生成', () => {
        const idMap = generateIdSet('oc_tc_xyz');
        expect(idMap.openai).toMatch(/^call_/);
        expect(idMap.claude).toMatch(/^toolu_/);
        expect(idMap.gemini).toMatch(/^gemini_/);
        // 原 id 不被任何槽采用
        expect(Object.values(idMap)).not.toContain('oc_tc_xyz');
    });

    it('空字符串 / null 也生成完整三槽', () => {
        const a = generateIdSet('');
        const b = generateIdSet(null);
        for (const fmt of ['openai', 'claude', 'gemini']) {
            expect(typeof a[fmt]).toBe('string');
            expect(typeof b[fmt]).toBe('string');
        }
    });

    it('多次调用生成不同 id（counter + random）', () => {
        const a = generateIdSet('');
        const b = generateIdSet('');
        expect(a.openai).not.toBe(b.openai);
        expect(a.claude).not.toBe(b.claude);
        expect(a.gemini).not.toBe(b.gemini);
    });

    it('显式 originalFormat 写入对应槽（无前缀启发式）', () => {
        // Gemini fc.id 通常不带 gemini_ 前缀，显式 originalFormat='gemini' 才能正确归位
        const idMap = generateIdSet('fc_short_123', 'gemini');
        expect(idMap.gemini).toBe('fc_short_123');
        expect(idMap.openai).toMatch(/^call_/);
        expect(idMap.claude).toMatch(/^toolu_/);
    });

    it('显式 originalFormat=claude 对 XML 短/非标 id 正确归位（parser-claude XML 对称性）', () => {
        const idMap = generateIdSet('xml_tool_abc', 'claude');
        expect(idMap.claude).toBe('xml_tool_abc');
        expect(idMap.openai).toMatch(/^call_/);
        expect(idMap.gemini).toMatch(/^gemini_/);
    });
});

// ========== getMappedId ==========

describe('getMappedId', () => {
    it('优先读 part.idMap 已有槽位', () => {
        const part = {
            id: 'call_x',
            idMap: { openai: 'call_x', claude: 'toolu_y', gemini: 'gemini_z' }
        };
        expect(getMappedId(part, 'openai')).toBe('call_x');
        expect(getMappedId(part, 'claude')).toBe('toolu_y');
        expect(getMappedId(part, 'gemini')).toBe('gemini_z');
    });

    it('缺 idMap 时返回临时派生 id 但不写回 part（纯 select）', () => {
        const part = { id: 'call_orig' };
        const id = getMappedId(part, 'claude');
        // 拆 ensureIdMap 后 getMappedId 是纯 select，不再写回 part.idMap
        expect(part.idMap).toBeUndefined();
        expect(id).toMatch(/^toolu_/);
    });

    it('idMap 缺目标槽时返回临时派生 id 但不修改已有槽', () => {
        const part = {
            id: 'call_a',
            idMap: { openai: 'call_a', claude: null, gemini: 'gemini_b' }
        };
        const id = getMappedId(part, 'claude');
        expect(id).toMatch(/^toolu_/);
        // 不写回 part.idMap.claude，保持原 null
        expect(part.idMap.claude).toBeNull();
        // 已有槽不被覆盖
        expect(part.idMap.openai).toBe('call_a');
        expect(part.idMap.gemini).toBe('gemini_b');
    });

    it('part 为 null 返回空字符串', () => {
        expect(getMappedId(null, 'openai')).toBe('');
        expect(getMappedId(undefined, 'claude')).toBe('');
    });
});

// ========== ensureIdMap ==========

describe('ensureIdMap', () => {
    it('无 idMap 时补齐三槽并写回 part，返回 true', () => {
        const part = { id: 'call_orig' };
        const filled = ensureIdMap(part);
        expect(filled).toBe(true);
        expect(part.idMap).toBeDefined();
        expect(part.idMap.openai).toBe('call_orig'); // 前缀启发式保留原格式 id
        expect(part.idMap.claude).toMatch(/^toolu_/);
        expect(part.idMap.gemini).toMatch(/^gemini_/);
    });

    it('部分 idMap 缺槽时只补缺槽，已有非空槽不被覆盖', () => {
        const part = {
            id: 'call_a',
            idMap: { openai: 'call_a', claude: null, gemini: 'gemini_keep' }
        };
        const filled = ensureIdMap(part);
        expect(filled).toBe(true);
        expect(part.idMap.openai).toBe('call_a');
        expect(part.idMap.claude).toMatch(/^toolu_/);
        expect(part.idMap.gemini).toBe('gemini_keep');
    });

    it('三槽都已就绪时短路返回 false，不写入', () => {
        const original = { openai: 'call_x', claude: 'toolu_y', gemini: 'gemini_z' };
        const part = { id: 'call_x', idMap: { ...original } };
        const filled = ensureIdMap(part);
        expect(filled).toBe(false);
        expect(part.idMap).toEqual(original);
    });

    it('多槽都 === part.id 时回退前缀启发式，避免 inferOriginalFormat 误判', () => {
        // 导入合并/兼容数据：两槽都被错置成 part.id
        const part = {
            id: 'call_x',
            idMap: { openai: 'call_x', claude: 'call_x', gemini: null }
        };
        ensureIdMap(part);
        // gemini 槽补齐
        expect(part.idMap.gemini).toMatch(/^gemini_/);
        // 已有非空槽（即使 inferOriginalFormat 失败）保留
        expect(part.idMap.openai).toBe('call_x');
        expect(part.idMap.claude).toBe('call_x');
    });

    it('part 为 null / 非对象时返回 false 不抛', () => {
        expect(ensureIdMap(null)).toBe(false);
        expect(ensureIdMap(undefined)).toBe(false);
        expect(ensureIdMap('not-a-part')).toBe(false);
    });
});

// ========== extractThoughtSignature ==========

describe('extractThoughtSignature', () => {
    it('非 assistant 返回 null', () => {
        expect(extractThoughtSignature({ role: 'user' })).toBeNull();
    });

    it('新格式 parts 中提取签名', () => {
        const msg = {
            role: 'assistant',
            parts: [
                { type: 'thinking', text: 'thinking...', signature: 'sig123' },
                { type: 'text', text: 'answer' }
            ]
        };
        expect(extractThoughtSignature(msg)).toBe('sig123');
    });

    it('无签名返回 null', () => {
        expect(extractThoughtSignature({ role: 'assistant' })).toBeNull();
    });
});

// ========== clearThoughtSignatures ==========

describe('clearThoughtSignatures', () => {
    it('清除新格式签名', () => {
        const msgs = [
            {
                role: 'assistant',
                parts: [{ type: 'thinking', text: 't', signature: 'sig1' }]
            }
        ];
        const count = clearThoughtSignatures(msgs, 0);
        expect(count).toBe(1);
        expect(msgs[0].parts[0].signature).toBeUndefined();
    });

    it('只清除 fromIndex 之后', () => {
        const msgs = [
            { role: 'assistant', parts: [{ type: 'thinking', signature: 'keep', text: '' }] },
            { role: 'assistant', parts: [{ type: 'thinking', signature: 'remove', text: '' }] }
        ];
        clearThoughtSignatures(msgs, 1);
        expect(msgs[0].parts[0].signature).toBe('keep');
        expect(msgs[1].parts[0].signature).toBeUndefined();
    });

    it('跳过 user 消息', () => {
        const msgs = [
            { role: 'user', parts: [{ type: 'thinking', signature: 'should_stay', text: '' }] }
        ];
        const count = clearThoughtSignatures(msgs, 0);
        expect(count).toBe(0);
        expect(msgs[0].parts[0].signature).toBe('should_stay');
    });
});

// ========== hasThoughtSignatures ==========

describe('hasThoughtSignatures', () => {
    it('有签名返回 true', () => {
        const msgs = [
            { role: 'user', parts: [{ type: 'text', text: 'hi' }] },
            { role: 'assistant', parts: [{ type: 'thinking', signature: 'sig', text: '' }] }
        ];
        expect(hasThoughtSignatures(msgs)).toBe(true);
    });

    it('无签名返回 false', () => {
        const msgs = [{ role: 'assistant', parts: [{ type: 'text', text: 'hello' }] }];
        expect(hasThoughtSignatures(msgs)).toBe(false);
    });

    it('fromIndex 参数', () => {
        const msgs = [
            { role: 'assistant', parts: [{ type: 'thinking', signature: 'sig', text: '' }] },
            { role: 'assistant', parts: [{ type: 'text', text: 'no sig' }] }
        ];
        expect(hasThoughtSignatures(msgs, 1)).toBe(false);
    });
});

// ========== sanitizeMessageForExport ==========

describe('sanitizeMessageForExport', () => {
    it('无私有字段返回深克隆等价对象', () => {
        // sanitizeMessageForExport 改深克隆后不再返回同引用，断言深相等即可
        const msg = { role: 'user', content: 'hello' };
        const cloned = sanitizeMessageForExport(msg);
        expect(cloned).toStrictEqual(msg);
        expect(cloned).not.toBe(msg);
    });

    it('清除 tool_calls 私有字段', () => {
        const msg = {
            role: 'assistant',
            tool_calls: [
                { id: 'tc1', _thoughtSignature: 'sig', _toolName: 'test', function: { name: 'fn' } }
            ]
        };
        const result = sanitizeMessageForExport(msg);
        expect(result.tool_calls[0]._thoughtSignature).toBeUndefined();
        expect(result.tool_calls[0]._toolName).toBeUndefined();
        expect(result.tool_calls[0].id).toBe('tc1');
    });

    it('清除 parts 中私有字段', () => {
        const msg = {
            role: 'assistant',
            parts: [{ type: 'text', text: 'hello', _internal: true }],
            _schemaVersion: 1
        };
        const result = sanitizeMessageForExport(msg);
        expect(result.parts[0]._internal).toBeUndefined();
        expect(result.parts[0].type).toBe('text');
    });

    it('保留 _schemaVersion', () => {
        const msg = {
            role: 'assistant',
            parts: [{ type: 'text', text: 'hello' }],
            _schemaVersion: 1,
            _tempData: 'remove'
        };
        const result = sanitizeMessageForExport(msg);
        expect(result._schemaVersion).toBe(1);
        expect(result._tempData).toBeUndefined();
    });

    it('清除顶层私有字段', () => {
        const msg = {
            role: 'assistant',
            content: 'hello',
            _internal: true,
            _debug: 'data'
        };
        const result = sanitizeMessageForExport(msg);
        expect(result._internal).toBeUndefined();
        expect(result._debug).toBeUndefined();
    });

    it('保留 parts.tool_call.idMap 公共字段', () => {
        const msg = {
            role: 'assistant',
            parts: [
                {
                    type: 'tool_call',
                    id: 'call_x',
                    name: 'fn',
                    args: {},
                    state: 'done',
                    result: null,
                    mode: 'native',
                    idMap: { openai: 'call_x', claude: 'toolu_y', gemini: 'gemini_z' }
                }
            ]
        };
        const result = sanitizeMessageForExport(msg);
        expect(result.parts[0].idMap).toEqual({
            openai: 'call_x',
            claude: 'toolu_y',
            gemini: 'gemini_z'
        });
    });
});
