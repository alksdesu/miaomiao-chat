/**
 * 统一消息格式定义 + 工厂函数 + 校验
 *
 * 所有消息以 parts[] 数组承载内容，运行时只维护一份数据，
 * API 请求时由 js/api/adapters/*.js 的 adapter.partsToAPIMessages 转换为 OpenAI/Claude/Gemini 格式。
 */

import { generateMessageId } from '../utils/helpers.js';
import { TOOL_INTERRUPTED_MESSAGE, TOOL_AGE_THRESHOLD_MS } from '../utils/constants.js';

export const SCHEMA_VERSION = 1;

export const Role = Object.freeze({
    SYSTEM: 'system',
    USER: 'user',
    ASSISTANT: 'assistant'
});

export const PartType = Object.freeze({
    THINKING: 'thinking',
    TEXT: 'text',
    MEDIA: 'media',
    TOOL_CALL: 'tool_call',
    FILE: 'file'
});

export const MediaKind = Object.freeze({
    IMAGE: 'image',
    VIDEO: 'video',
    AUDIO: 'audio'
});

export const ToolState = Object.freeze({
    PENDING: 'pending',
    RUNNING: 'running',
    DONE: 'done',
    ERROR: 'error',
    // 多回复模式 BufferedSink 拦截但未执行的工具调用 —— 落库保留会话历史让用户能看到模型尝试了什么工具，
    // 但 adapter.partsToAPIMessages 跳过下发（既不输出 tool_use 也不输出 tool_result，避免孤儿 tool_use 触发 API 400）
    SKIPPED: 'skipped'
});

// 工具调用的来源模式：native 走原生 tool_use/function_call 协议，
// xml 走 system prompt 注入 + 文本 <tool_use> 解析的兜底协议。
// 持久化到 tool_call part 上，避免运行时切换 toggle 导致历史消息 mode 错乱。
export const ToolMode = Object.freeze({
    NATIVE: 'native',
    XML: 'xml'
});

// thinking part 的 signature 来源标识：Claude/Gemini/OpenAI 的 thinking 签名互不兼容
// （Claude HMAC vs Gemini thoughtSignature vs OpenAI encrypted_content），下发到非原产
// 家 API 会触发 invalid_signature 400。落 part 时记录原始格式，adapter 输出时校验匹配。
export const SignatureFormat = Object.freeze({
    CLAUDE: 'claude',
    GEMINI: 'gemini',
    OPENAI: 'openai'
});

// ========== 工厂函数 ==========

/**
 * 创建一条新消息
 * @param {string} role - Role.SYSTEM | Role.USER | Role.ASSISTANT
 * @param {Array} parts - 内容 parts 数组
 * @param {Object} [options] - 可选的 id / ts / meta / replies / error
 */
export function createMessage(role, parts = [], options = {}) {
    return {
        id: options.id || generateMessageId(),
        role,
        ts: options.ts || Date.now(),
        parts,
        meta: options.meta || createMeta(),
        replies: options.replies || null,
        error: options.error || null,
        _schemaVersion: SCHEMA_VERSION
    };
}

export function createMeta(overrides = {}) {
    return {
        model: '',
        provider: '',
        usage: null,
        stats: null,
        raw: {},
        ...overrides
    };
}

// opts 通用字段：_turn / _edited （continuation 与编辑追踪）
// opts 类型独有字段见各工厂函数说明

export function textPart(text, opts = {}) {
    const part = { type: PartType.TEXT, text };
    applyPartOpts(part, opts);
    return part;
}

/**
 * @param {string} text - 思维链文本（redacted 时为空字符串）
 * @param {string|null} signature - thinking 签名
 * @param {Object} [opts] - { redacted?, data?, signatureFormat?, _turn?, _edited? }
 *   redacted/data：Claude redacted_thinking block（text 为空，data 不可省）
 *   signatureFormat：'claude'|'gemini'|'openai' 标记 signature 来源，adapter 据此守门
 *     跨格式继承；signature 非空但 signatureFormat 缺失时视为旧数据，adapter 走宽容模式
 */
export function thinkingPart(text, signature = null, opts = {}) {
    const part = { type: PartType.THINKING, text };
    if (signature) {
        part.signature = signature;
        if (opts.signatureFormat) part.signatureFormat = opts.signatureFormat;
    }
    if (opts.redacted) {
        part.redacted = true;
        if (opts.data) part.data = opts.data;
    }
    applyPartOpts(part, opts);
    return part;
}

/**
 * @param {Object} [opts] - { name?, _turn?, _edited? }
 */
export function mediaPart(kind, url, mime = '', opts = {}) {
    const part = { type: PartType.MEDIA, media: kind, url, mime };
    if (opts.name) part.name = opts.name;
    applyPartOpts(part, opts);
    return part;
}

/**
 * @param {string} id - 工具调用 ID
 * @param {string} name - 工具名称
 * @param {Object} args - 调用参数
 * @param {Object} [opts] - { state?, result?, mode?, idMap?, server?, call_id?, responseItemId?,
 *                            thoughtSignature?, error?, duration?, _turn?, _edited? }
 *   state 默认 PENDING；mode 默认 NATIVE（兼容 Stage 1 前历史消息）；
 *   idMap 缺省时由 parts-builder/migration 用 generateIdSet(id) 兜底；
 *   call_id/responseItemId 用于 OpenAI Responses；
 *   thoughtSignature 用于 Gemini functionCall；server=true 标记服务端工具调用
 * @returns {{ type, id, name, args, state, result, mode, idMap? }}
 *   result 完成后为 any（字符串、对象、MCP content 数组等），由消费方自行解释
 */
export function toolCallPart(id, name, args = {}, opts = {}) {
    const part = {
        type: PartType.TOOL_CALL,
        id,
        name,
        args,
        state: opts.state || ToolState.PENDING,
        result: opts.result ?? null,
        mode: opts.mode || ToolMode.NATIVE
    };
    if (opts.idMap) part.idMap = opts.idMap;
    if (opts.server) part.server = true;
    if (opts.call_id) part.call_id = opts.call_id;
    if (opts.responseItemId) part.responseItemId = opts.responseItemId;
    if (opts.thoughtSignature) part.thoughtSignature = opts.thoughtSignature;
    if (opts.error !== undefined) part.error = opts.error;
    if (opts.duration !== undefined) part.duration = opts.duration;
    applyPartOpts(part, opts);
    return part;
}

/**
 * @param {Object} [opts] - { encoding?, _turn?, _edited? }
 *   encoding 默认 'base64'，文本文件传 'text'
 */
export function filePart(name, mime, url, opts = {}) {
    const part = {
        type: PartType.FILE,
        name,
        mime,
        url,
        encoding: opts.encoding || 'base64'
    };
    applyPartOpts(part, opts);
    return part;
}

/**
 * 把通用 opts 字段（_turn / _edited）挂到 part 上（仅当显式传入）
 */
function applyPartOpts(part, opts) {
    if (opts._turn !== undefined) part._turn = opts._turn;
    if (opts._edited !== undefined) part._edited = opts._edited;
}

// ========== 读取辅助 ==========

export function filterParts(parts, type) {
    return parts?.filter((p) => p.type === type) || [];
}

/**
 * 提取文本内容（带旧格式兜底）
 */
export function getTextContent(msg) {
    if (hasParts(msg)) {
        return filterParts(msg.parts, PartType.TEXT)
            .map((p) => p.text)
            .join('');
    }
    if (typeof msg.content === 'string') return msg.content;
    if (Array.isArray(msg.content)) {
        return msg.content
            .filter((p) => p?.type === 'text')
            .map((p) => p.text || '')
            .join('');
    }
    return '';
}

/**
 * 提取思维链内容（带旧格式兜底）
 */
export function getThinkingContent(msg) {
    if (hasParts(msg)) {
        return filterParts(msg.parts, PartType.THINKING)
            .map((p) => p.text)
            .join('');
    }
    return msg.thinkingContent || ''; // 旧格式兜底，未迁移数据需要
}

/**
 * 提取工具调用列表
 */
export function getToolCalls(msg) {
    return filterParts(msg.parts, PartType.TOOL_CALL);
}

/**
 * 将 TOOL_CALL parts 转换为 restoreToolCallsGroup 期望的格式
 * 字段名差异：args→arguments、state→status（done→completed / error→failed）
 */
export function partsToToolCallRestoreFormat(parts) {
    return filterParts(parts, PartType.TOOL_CALL).map((tc) => ({
        id: tc.id,
        name: tc.name,
        arguments: tc.args,
        status:
            tc.state === ToolState.DONE
                ? 'completed'
                : tc.state === ToolState.ERROR
                  ? 'failed'
                  : tc.state,
        result: tc.result,
        error: tc.error,
        duration: tc.duration
    }));
}

/**
 * 提取媒体内容
 */
export function getMediaParts(msg) {
    return filterParts(msg.parts, PartType.MEDIA);
}

/**
 * 提取文件内容
 */
export function getFileParts(msg) {
    return filterParts(msg.parts, PartType.FILE);
}

// ========== 格式检测 ==========

/**
 * 检查消息是否为新格式（通过版本号判断）
 */
export function isNewFormat(msg) {
    return msg?._schemaVersion >= SCHEMA_VERSION;
}

/**
 * 检查消息是否有 parts 数组（结构检测）
 */
export function hasParts(msg) {
    return Array.isArray(msg?.parts) && msg.parts.length > 0;
}

/**
 * 检查 parts 数组是否为 schema 格式
 * 优先用 _schemaVersion 判断，回退到首个 part 的 type 检测
 */
export function isSchemaFormatParts(parts, msg = null) {
    if (msg?._schemaVersion >= SCHEMA_VERSION) return true;
    return Array.isArray(parts) && parts.length > 0 && VALID_PART_TYPES.has(parts[0]?.type);
}

// ========== 校验 ==========

const VALID_ROLES = new Set(Object.values(Role));
const VALID_PART_TYPES = new Set(Object.values(PartType));
const VALID_MEDIA_KINDS = new Set(Object.values(MediaKind));
const VALID_TOOL_STATES = new Set(Object.values(ToolState));
const VALID_TOOL_MODES = new Set(Object.values(ToolMode));
const VALID_SIGNATURE_FORMATS = new Set(Object.values(SignatureFormat));

/**
 * 校验单条消息，返回错误列表（空数组 = 合法）
 */
export function validateMessage(msg) {
    const errors = [];

    if (!msg || typeof msg !== 'object') {
        return ['消息不是对象'];
    }

    if (!msg.id || typeof msg.id !== 'string') {
        errors.push('缺少有效的 id');
    }
    if (!VALID_ROLES.has(msg.role)) {
        errors.push(`无效的 role: ${msg.role}`);
    }
    if (typeof msg.ts !== 'number' || msg.ts <= 0) {
        errors.push(`无效的 ts: ${msg.ts}`);
    }
    if (!Array.isArray(msg.parts)) {
        errors.push('parts 不是数组');
        return errors;
    }

    for (let i = 0; i < msg.parts.length; i++) {
        const p = msg.parts[i];

        if (!p || typeof p !== 'object') {
            errors.push(`parts[${i}] 不是对象`);
            continue;
        }
        if (!VALID_PART_TYPES.has(p.type)) {
            errors.push(`parts[${i}] 无效的 type: ${p.type}`);
            continue;
        }

        switch (p.type) {
            case PartType.TEXT:
                if (typeof p.text !== 'string') errors.push(`parts[${i}] text 不是字符串`);
                break;
            case PartType.THINKING:
                if (typeof p.text !== 'string') errors.push(`parts[${i}] thinking.text 不是字符串`);
                else if (!p.text && !(p.redacted && p.data))
                    errors.push(`parts[${i}] thinking.text 为空且无 redacted data`);
                if (
                    p.signatureFormat !== undefined &&
                    p.signatureFormat !== null &&
                    !VALID_SIGNATURE_FORMATS.has(p.signatureFormat)
                ) {
                    errors.push(`parts[${i}] 无效的 signatureFormat: ${p.signatureFormat}`);
                }
                break;
            case PartType.MEDIA:
                if (!VALID_MEDIA_KINDS.has(p.media))
                    errors.push(`parts[${i}] 无效的 media: ${p.media}`);
                if (!p.url) errors.push(`parts[${i}] 缺少 url`);
                break;
            case PartType.TOOL_CALL:
                if (p.id == null) errors.push(`parts[${i}] 缺少 tool_call id`);
                if (!p.name) errors.push(`parts[${i}] 缺少 tool_call name`);
                if (!VALID_TOOL_STATES.has(p.state))
                    errors.push(`parts[${i}] 无效的 state: ${p.state}`);
                // mode 字段缺失视为合法（兼容 Stage 1 前历史消息，消费端按 NATIVE 兜底）
                if (p.mode !== undefined && p.mode !== null && !VALID_TOOL_MODES.has(p.mode)) {
                    errors.push(`parts[${i}] 无效的 mode: ${p.mode}`);
                }
                // idMap 字段缺失视为合法（旧数据待 migration 补齐，adapter 用 getMappedId lazy 补齐）
                if (p.idMap !== undefined && p.idMap !== null) {
                    if (typeof p.idMap !== 'object' || Array.isArray(p.idMap)) {
                        errors.push(`parts[${i}] idMap 不是对象`);
                    }
                }
                break;
            case PartType.FILE:
                if (!p.name) errors.push(`parts[${i}] 缺少 file name`);
                break;
        }
    }

    if (msg.meta && typeof msg.meta !== 'object') {
        errors.push('meta 不是对象');
    }

    if (msg.replies !== null) {
        if (!msg.replies || typeof msg.replies !== 'object') {
            errors.push('replies 不是对象或 null');
        } else {
            if (!Array.isArray(msg.replies.all)) errors.push('replies.all 不是数组');
            if (typeof msg.replies.selected !== 'number') errors.push('replies.selected 不是数字');
        }
    }

    if (msg.error !== null && msg.error !== undefined) {
        if (typeof msg.error !== 'object') errors.push('error 不是对象或 null');
    }

    return errors;
}

/**
 * 批量校验消息数组
 * @returns {{ valid: boolean, errors: Array<{index: number, errors: string[]}> }}
 */
export function validateMessages(messages) {
    const result = { valid: true, errors: [] };

    if (!Array.isArray(messages)) {
        result.valid = false;
        result.errors.push({ index: -1, errors: ['messages 不是数组'] });
        return result;
    }

    for (let i = 0; i < messages.length; i++) {
        const errs = validateMessage(messages[i]);
        if (errs.length > 0) {
            result.valid = false;
            result.errors.push({ index: i, errors: errs });
        }
    }

    return result;
}

// ========== 工具调用配对校验 / 老化 ==========

/**
 * 跨消息工具调用配对校验
 *
 * 检测 assistant 消息 parts 中的孤儿 tool_call：超时未完成的 pending/running、
 * 已完成但无 result、native 模式缺 idMap。SKIPPED 状态跳过（adapter 设计如此）。
 *
 * @param {Array} messages
 * @param {Object} [opts]
 * @param {boolean} [opts.treatSkippedAsValid=true] - SKIPPED 是否视为合法
 * @param {number} [opts.ageThresholdMs] - 超时阈值；不传则不做时间判定
 * @param {number} [opts.nowMs] - 当前时间戳；不传则不做时间判定
 * @returns {{ valid: boolean, orphans: Array<{msgIndex:number, partIndex:number, partId:any, reason:string, age?:number}> }}
 *   reason 枚举：'orphan_pending' | 'orphan_running' | 'missing_result' | 'idmap_missing'
 */
export function validateToolPairings(messages, opts = {}) {
    const { treatSkippedAsValid = true, ageThresholdMs, nowMs } = opts;
    const orphans = [];

    if (!Array.isArray(messages)) {
        return { valid: true, orphans };
    }

    const canAge =
        typeof ageThresholdMs === 'number' &&
        ageThresholdMs > 0 &&
        typeof nowMs === 'number' &&
        nowMs > 0;

    for (let mi = 0; mi < messages.length; mi++) {
        const msg = messages[mi];
        if (!msg || msg.role !== Role.ASSISTANT || !Array.isArray(msg.parts)) continue;

        for (let pi = 0; pi < msg.parts.length; pi++) {
            const part = msg.parts[pi];
            if (!part || part.type !== PartType.TOOL_CALL) continue;

            if (part.state === ToolState.SKIPPED) {
                if (treatSkippedAsValid) continue;
            }

            if (part.state === ToolState.PENDING || part.state === ToolState.RUNNING) {
                if (!canAge) continue;
                const ts = part.ts || msg.ts;
                if (typeof ts !== 'number' || ts <= 0) {
                    // ts 缺失：保守视为孤儿
                    orphans.push({
                        msgIndex: mi,
                        partIndex: pi,
                        partId: part.id,
                        reason:
                            part.state === ToolState.PENDING ? 'orphan_pending' : 'orphan_running'
                    });
                    continue;
                }
                const age = nowMs - ts;
                if (age >= ageThresholdMs) {
                    orphans.push({
                        msgIndex: mi,
                        partIndex: pi,
                        partId: part.id,
                        reason:
                            part.state === ToolState.PENDING ? 'orphan_pending' : 'orphan_running',
                        age
                    });
                }
                continue;
            }

            if (part.state === ToolState.DONE || part.state === ToolState.ERROR) {
                if (part.result === null || part.result === undefined) {
                    orphans.push({
                        msgIndex: mi,
                        partIndex: pi,
                        partId: part.id,
                        reason: 'missing_result'
                    });
                    continue;
                }
            }

            // native 模式 DONE 状态缺 idMap：warn 级，adapter 用 generateFormatId 兜底
            const mode = part.mode || ToolMode.NATIVE;
            if (
                part.state === ToolState.DONE &&
                mode === ToolMode.NATIVE &&
                (!part.idMap || typeof part.idMap !== 'object')
            ) {
                orphans.push({
                    msgIndex: mi,
                    partIndex: pi,
                    partId: part.id,
                    reason: 'idmap_missing'
                });
            }
        }
    }

    return { valid: orphans.length === 0, orphans };
}

/**
 * 老化超时的 pending/running tool_call（in-place 修改）
 *
 * 把超过 ageThresholdMs 的 pending/running 工具调用强制翻成 ERROR，避免下次发送时
 * 出现孤儿 tool_use 触发 API 400。schema.js 是纯函数模块，nowMs 必须由调用方传入。
 *
 * @param {Array} messages - 会被原地修改
 * @param {Object} [opts]
 * @param {number} [opts.ageThresholdMs=TOOL_AGE_THRESHOLD_MS]
 * @param {number} [opts.nowMs] - 必传：当前时间戳；缺失时一律老化（保守）
 * @param {string} [opts.errorMessage=TOOL_INTERRUPTED_MESSAGE]
 * @returns {number} 老化的 part 数
 */
export function agePendingToolCallsInPlace(messages, opts = {}) {
    if (!Array.isArray(messages)) return 0;

    // ageThresholdMs:0 是合法的"强制全部老化"语义（导出剥离 pending 态用），不能 fallback 到 default
    const ageThresholdMs =
        typeof opts.ageThresholdMs === 'number' && opts.ageThresholdMs >= 0
            ? opts.ageThresholdMs
            : TOOL_AGE_THRESHOLD_MS;
    const nowMs = typeof opts.nowMs === 'number' && opts.nowMs > 0 ? opts.nowMs : null;
    const errorMessage =
        typeof opts.errorMessage === 'string' && opts.errorMessage
            ? opts.errorMessage
            : TOOL_INTERRUPTED_MESSAGE;

    let aged = 0;

    for (const msg of messages) {
        if (!msg || msg.role !== Role.ASSISTANT || !Array.isArray(msg.parts)) continue;

        for (const part of msg.parts) {
            if (!part || part.type !== PartType.TOOL_CALL) continue;
            if (part.state !== ToolState.PENDING && part.state !== ToolState.RUNNING) continue;

            const ts = part.ts || msg.ts;
            const hasTs = typeof ts === 'number' && ts > 0;

            let shouldAge = false;
            if (nowMs === null) {
                // nowMs 未传：跳过（保持纯函数语义，不调 Date.now）
                continue;
            }
            if (!hasTs) {
                // ts 缺失且 nowMs 给定：保守一律老化
                shouldAge = true;
            } else if (nowMs - ts >= ageThresholdMs) {
                shouldAge = true;
            }

            if (!shouldAge) continue;

            part.state = ToolState.ERROR;
            part.result = {
                error: errorMessage,
                is_error: true,
                interrupted: true,
                content: ''
            };
            aged++;
        }
    }

    return aged;
}
