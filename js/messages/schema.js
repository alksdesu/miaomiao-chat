/**
 * 统一消息格式定义 + 工厂函数 + 校验
 *
 * 所有消息以 parts[] 数组承载内容，运行时只维护一份数据，
 * API 请求时由 api-adapters.js 实时转换为 OpenAI/Claude/Gemini 格式。
 */

import { generateMessageId } from '../utils/helpers.js';

export const SCHEMA_VERSION = 1;

export const Role = Object.freeze({
    SYSTEM:    'system',
    USER:      'user',
    ASSISTANT: 'assistant',
});

export const PartType = Object.freeze({
    THINKING:  'thinking',
    TEXT:      'text',
    MEDIA:     'media',
    TOOL_CALL: 'tool_call',
    FILE:      'file',
});

export const MediaKind = Object.freeze({
    IMAGE: 'image',
    VIDEO: 'video',
    AUDIO: 'audio',
});

export const ToolState = Object.freeze({
    PENDING:  'pending',
    RUNNING:  'running',
    DONE:     'done',
    ERROR:    'error',
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
        _schemaVersion: SCHEMA_VERSION,
    };
}

export function createMeta(overrides = {}) {
    return {
        model: '',
        provider: '',
        usage: null,
        stats: null,
        raw: {},
        ...overrides,
    };
}

export function textPart(text) {
    return { type: PartType.TEXT, text };
}

export function thinkingPart(text, signature = null) {
    const part = { type: PartType.THINKING, text };
    if (signature) part.signature = signature;
    return part;
}

export function mediaPart(kind, url, mime = '', name = '') {
    const part = { type: PartType.MEDIA, media: kind, url, mime };
    if (name) part.name = name;
    return part;
}

/**
 * @param {string} id - 工具调用 ID
 * @param {string} name - 工具名称
 * @param {Object} args - 调用参数
 * @returns {{ type, id, name, args, state, result }}
 *   result 完成后为 any（字符串、对象、MCP content 数组等），由消费方自行解释
 */
export function toolCallPart(id, name, args = {}) {
    return {
        type: PartType.TOOL_CALL,
        id,
        name,
        args,
        state: ToolState.PENDING,
        result: null,
    };
}

export function filePart(name, mime, url) {
    return { type: PartType.FILE, name, mime, url };
}

// ========== 读取辅助 ==========

export function filterParts(parts, type) {
    return parts?.filter(p => p.type === type) || [];
}

/**
 * 提取文本内容（带旧格式兜底）
 */
export function getTextContent(msg) {
    if (hasParts(msg)) {
        return filterParts(msg.parts, PartType.TEXT).map(p => p.text).join('');
    }
    if (typeof msg.content === 'string') return msg.content;
    if (Array.isArray(msg.content)) {
        return msg.content.filter(p => p?.type === 'text').map(p => p.text || '').join('');
    }
    return '';
}

/**
 * 提取思维链内容（带旧格式兜底）
 */
export function getThinkingContent(msg) {
    if (hasParts(msg)) {
        return filterParts(msg.parts, PartType.THINKING).map(p => p.text).join('');
    }
    return msg.thinkingContent || '';
}

/**
 * 提取工具调用列表
 */
export function getToolCalls(msg) {
    return filterParts(msg.parts, PartType.TOOL_CALL);
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
                else if (!p.text) errors.push(`parts[${i}] thinking.text 为空`);
                break;
            case PartType.MEDIA:
                if (!VALID_MEDIA_KINDS.has(p.media)) errors.push(`parts[${i}] 无效的 media: ${p.media}`);
                if (!p.url) errors.push(`parts[${i}] 缺少 url`);
                break;
            case PartType.TOOL_CALL:
                if (p.id == null) errors.push(`parts[${i}] 缺少 tool_call id`);
                if (!p.name) errors.push(`parts[${i}] 缺少 tool_call name`);
                if (!VALID_TOOL_STATES.has(p.state)) errors.push(`parts[${i}] 无效的 state: ${p.state}`);
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
