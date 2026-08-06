/**
 * 跨格式兼容辅助：tool_call 跨格式 ID 套件生成 + thoughtSignature 维护 + 消息导出过滤。
 *
 * tool_call 的跨格式 id 在落 part 时一次性生成并写入 part.idMap，不再维护全局映射表/LRU。
 * 读取统一走 getMappedId（纯 select，无副作用）；旧数据补齐统一走 ensureIdMap（显式入口）。
 */

import { PartType, agePendingToolCallsInPlace } from '../messages/schema.js';

// ========== 跨格式 tool_call ID 套件 ==========

const FORMAT_PREFIX = Object.freeze({
    openai: 'call_',
    claude: 'toolu_',
    // Gemini 内部生成的兜底 id 保持 `gemini_tc_` 前缀；adapter 用前缀区分"原生 fc.id"与"自生兜底 id"
    gemini: 'gemini_'
});

let idCounter = 0;
let _tabIdCache = null;

/**
 * 多 tab 共享同一 idCounter 全局命名空间会让两 tab 同毫秒下生成同 counter 同 random 的
 * 完全一致 id，配对错位。sessionStorage 天然 per-tab，懒初始化 4-char tab id 隔离即可
 */
function getTabId() {
    if (_tabIdCache !== null) return _tabIdCache;
    try {
        let id = sessionStorage.getItem('_format_converter_tab_id');
        if (!id) {
            id = Math.random().toString(36).slice(2, 6);
            sessionStorage.setItem('_format_converter_tab_id', id);
        }
        _tabIdCache = id;
    } catch {
        // sessionStorage 不可用（私密模式 / SSR）— 用进程级随机兜底
        _tabIdCache = Math.random().toString(36).slice(2, 6);
    }
    return _tabIdCache;
}

function generateFormatId(format) {
    const ts = Date.now();
    const counter = idCounter++;
    const tab = getTabId();
    const random = Math.random().toString(36).slice(2, 8);
    return `${FORMAT_PREFIX[format]}${ts}_${tab}_${counter}_${random}`;
}

/**
 * 给原始 tool_call id 生成跨三家格式 id 套件（part.idMap 字段）。
 *
 * 落 part 时由 parser → parts-builder 调用一次，写回 part.idMap 持久化。
 * adapter.partsToAPIMessages 读取 part.idMap[apiFormat]，无运行时查表/副作用。
 *
 * 已是某格式原生前缀的 id 保留入对应槽位（保证同会话同格式重发时 id 完全复用，不破坏 API 配对）；
 * 其他槽位用 generateFormatId 兜底（跨格式重发时仍能给出合法 id）。
 *
 * @param {string} originalId - parser 落 part 时的原始 id（call_xxx / toolu_xxx / gemini_xxx / oc_tc_xxx / 自定义）
 * @param {'openai'|'claude'|'gemini'|null} [originalFormat] - 已知原始 id 所属格式；
 *   提供时直接写入对应槽位（即使 id 不带该格式前缀），避免启发式前缀匹配在短 id 上漏判
 * @returns {{ openai: string, claude: string, gemini: string }}
 */
export function generateIdSet(originalId, originalFormat = null) {
    const idMap = { openai: null, claude: null, gemini: null };

    if (typeof originalId === 'string' && originalId.length > 0) {
        if (originalFormat && Object.prototype.hasOwnProperty.call(idMap, originalFormat)) {
            // 显式指定原始格式：直接写入对应槽，不做前缀启发式（Gemini fc.id 不带 gemini_ 前缀也能正确归位）
            idMap[originalFormat] = originalId;
        } else if (originalId.startsWith(FORMAT_PREFIX.openai)) {
            idMap.openai = originalId;
        } else if (originalId.startsWith(FORMAT_PREFIX.claude)) {
            idMap.claude = originalId;
        } else if (originalId.startsWith(FORMAT_PREFIX.gemini)) {
            idMap.gemini = originalId;
        }
    }

    for (const fmt of Object.keys(FORMAT_PREFIX)) {
        if (!idMap[fmt]) idMap[fmt] = generateFormatId(fmt);
    }

    return idMap;
}

/**
 * 推断 part 的原始格式：返回 idMap 中唯一 === part.id 的槽名，多槽匹配或无匹配返回 null
 *
 * 多槽都 === part.id（导入合并/兼容数据）时取首槽会误判 origin，
 * 返回 null 让调用方回退到 generateIdSet 的前缀启发式
 */
function inferOriginalFormat(part) {
    if (!part?.idMap) return null;
    const matchingSlots = [];
    for (const fmt of ['openai', 'claude', 'gemini']) {
        if (part.idMap[fmt] && part.idMap[fmt] === part.id) {
            matchingSlots.push(fmt);
        }
    }
    return matchingSlots.length === 1 ? matchingSlots[0] : null;
}

/**
 * 显式补齐 part.idMap 三槽（用于导入旧数据 / migration 入口）。
 *
 * 已有 idMap 三槽都非空时短路返回 false 不触发写；任一槽缺失时合并已有非空槽 +
 * 用 generateIdSet 兜底缺失槽，写回 part.idMap 并返回 true 让调用方决定是否置脏。
 *
 * 与 getMappedId 拆分目的：把"补齐 + sessionDirty"副作用从 get* 路径剥离，
 * 让请求路径上的 getMappedId 退化为纯 select，副作用集中在显式入口（import / migration）。
 *
 * @param {Object} part - tool_call part
 * @returns {boolean} 是否实际补齐过（true = 写入 part.idMap；false = 无需补齐）
 */
export function ensureIdMap(part) {
    if (!part || typeof part !== 'object') return false;
    const needFill = !part.idMap || !part.idMap.openai || !part.idMap.claude || !part.idMap.gemini;
    if (!needFill) return false;

    const originalFormat = inferOriginalFormat(part);
    const newIdMap = generateIdSet(part.id, originalFormat);
    const merged = { ...newIdMap };
    if (part.idMap) {
        for (const fmt of ['openai', 'claude', 'gemini']) {
            if (part.idMap[fmt]) merged[fmt] = part.idMap[fmt];
        }
    }
    part.idMap = merged;
    return true;
}

/**
 * 从 tool_call part 纯读目标格式 id（无副作用）。
 *
 * 主流程（5 parser + parts-builder + claude/gemini parseResponse）已在落 part 时
 * 预生成 idMap，本函数命中 part.idMap[format] 直返。
 *
 * 旧未迁移数据缺 idMap 时返回临时 generateFormatId 不写回 part，避免请求路径隐式置脏；
 * 真正需要持久化的补齐由导入入口主动调 ensureIdMap 完成。
 *
 * @param {Object} part - tool_call part
 * @param {'openai'|'claude'|'gemini'} format
 * @returns {string}
 */
export function getMappedId(part, format) {
    if (!part || typeof part !== 'object') return '';
    if (part.idMap && part.idMap[format]) return part.idMap[format];
    // 兜底：旧数据未补齐 idMap，返回临时派生 id 让 API 配对不至于空串崩
    // 不写回 part，等导入路径 / 下次保存触发 ensureIdMap 持久化
    return generateFormatId(format);
}

// ========== thoughtSignature 维护 ==========

/**
 * 从消息中提取签名（如果存在）
 * @param {Object} message
 * @param {number} toolCallIndex
 * @returns {string|null}
 */
export function extractThoughtSignature(message) {
    if (message.role !== 'assistant') return null;

    if (Array.isArray(message.parts)) {
        for (const p of message.parts) {
            if (p.type === PartType.THINKING && p.signature) {
                return p.signature;
            }
        }
    }

    return null;
}

/**
 * 清除指定索引之后的所有 thoughtSignature
 */
export function clearThoughtSignatures(messages, fromIndex) {
    let count = 0;

    for (let i = fromIndex; i < messages.length; i++) {
        const msg = messages[i];
        if (msg.role !== 'assistant') continue;

        if (Array.isArray(msg.parts)) {
            for (const p of msg.parts) {
                if (p.type === PartType.THINKING && p.signature) {
                    delete p.signature;
                    count++;
                }
            }
        }
    }

    return count;
}

/**
 * 检测消息数组中是否存在 thoughtSignature
 */
export function hasThoughtSignatures(messages, fromIndex = 0) {
    for (let i = fromIndex; i < messages.length; i++) {
        if (extractThoughtSignature(messages[i])) return true;
    }
    return false;
}

/**
 * 清除所有消息 meta.raw 中 provider 私有的 reasoning/encrypted 字段。
 *
 * 用于跨 provider 切换（即使同 apiFormat，如 OpenAI proxy A → proxy B）：
 * encrypted_content 是 OpenAI Responses 服务端 HMAC 不可跨账号复用，
 * 切到新 provider 后下发会触发 reasoning_id_not_found 400。
 *
 * @param {Array} messages
 * @param {number} [fromIndex=0]
 * @returns {number} 被清理的 message 数量
 */
export function clearProviderSpecificRawMeta(messages, fromIndex = 0) {
    let count = 0;
    for (let i = fromIndex; i < messages.length; i++) {
        const msg = messages[i];
        if (msg.role !== 'assistant') continue;
        const raw = msg.meta?.raw;
        if (!raw || typeof raw !== 'object') continue;

        let touched = false;
        if (raw.openai && typeof raw.openai === 'object') {
            // reasoningItems 数组 / encryptedContent / reasoningItemId 都是 provider 私有
            if (raw.openai.reasoningItems) {
                delete raw.openai.reasoningItems;
                touched = true;
            }
            if (raw.openai.encryptedContent) {
                delete raw.openai.encryptedContent;
                touched = true;
            }
            if (raw.openai.reasoningItemId) {
                delete raw.openai.reasoningItemId;
                touched = true;
            }
        }
        if (touched) count++;
    }
    return count;
}

/**
 * 清除所有不属于 currentFormat 的 thinking part.signature。
 *
 * adapter.partsToAPIMessages 已有 part.signatureFormat 守门作为运行时防线，此 helper
 * 作为切换 apiFormat 时的主动清理（providers:switched 监听调用），物理删除残留签名
 * 让导出/导入 round-trip 不再携带跨家无意义字段。
 *
 * @param {Array} messages
 * @param {'claude'|'gemini'|'openai'} currentFormat
 * @param {number} [fromIndex=0]
 * @returns {number} 被清理的 signature 数量
 */
export function clearForeignSignatures(messages, currentFormat, fromIndex = 0) {
    let count = 0;
    for (let i = fromIndex; i < messages.length; i++) {
        const msg = messages[i];
        if (msg.role !== 'assistant') continue;

        if (Array.isArray(msg.parts)) {
            for (const p of msg.parts) {
                if (p.type !== PartType.THINKING) continue;
                if (!p.signature) continue;
                // signatureFormat 缺失视为同格式产物（旧消息宽容），不清
                if (!p.signatureFormat || p.signatureFormat === currentFormat) continue;
                delete p.signature;
                delete p.signatureFormat;
                count++;
            }
        }
    }
    return count;
}

// ========== 导出过滤 ==========

/**
 * 导出/导入 round-trip 必须保留的 `_` 前缀字段白名单。
 *
 * - `_turn`：Claude 多轮 continuation 拆分 assistant 消息的轮号标记，丢失会导致重导入时
 *   多轮 thinking 合并到一条消息触发 Anthropic API 严格校验 400
 * - `_edited`：用户手动编辑过的 thinking 标记，partsToAPIMessages 据此跳过 thinking 块
 *   避免编辑后文本+原 signature 不一致被 Claude 400
 * - `_schemaVersion`：schema 升级链版本号，迁移器据此决定升级路径
 * - `_originalRole` / `_originalIndex` / `_converted`：filterMessagesByCapabilities 转换
 *   assistant→user 时的溯源标记，下游 UI/调试可读
 */
const EXPORT_PRESERVE_PRIVATE_KEYS = new Set([
    '_turn',
    '_edited',
    '_schemaVersion',
    '_originalRole',
    '_originalIndex',
    '_converted'
]);

/**
 * 导出时主动剥离的敏感字段黑名单。
 *
 * 这些字段是各家 API 服务端 HMAC 签名 / 加密推理内容，跨账号/跨格式都无法复用，
 * 仅在原 session 上下文有意义；导出文件分享到他人 / 公开 repo 时是隐私敏感数据,
 * 主动剥离避免泄漏。adapter 重发时缺这些字段会走 _edited 路径正常降级
 */
const EXPORT_SENSITIVE_KEYS = new Set([
    'signature', // Claude HMAC thinking signature
    'signatureFormat', // 关联标识也一并剥离
    'thoughtSignature', // Gemini thoughtSignature (tool_call/message 级)
    'thinkingSignature', // 历史字段
    'encryptedContent', // OpenAI Responses encrypted_content（驼峰）
    'encrypted_content', // 同上（snake，meta.raw.openai.reasoningItems[i] 内嵌）
    'reasoningItemId' // OpenAI Responses item id
]);

/**
 * 递归 in-place 剥离 `_` 前缀的非白名单字段
 *
 * 之前只删顶层 `_` key，meta.raw.openai.reasoningItems[i]._someInternalFlag
 * 之类的嵌套字段无法清除；通过 Map/Set/RegExp/Date 等非平凡对象时跳过避免误伤。
 * stats[0] = 剥离的敏感字段数（让导出路径透明告知用户）
 */
function stripPrivateFields(obj, stats = null) {
    if (obj == null || typeof obj !== 'object') return;
    if (
        obj instanceof Map ||
        obj instanceof Set ||
        obj instanceof Date ||
        obj instanceof RegExp ||
        obj instanceof ArrayBuffer
    ) {
        return;
    }
    if (Array.isArray(obj)) {
        for (const item of obj) stripPrivateFields(item, stats);
        return;
    }
    for (const k of Object.keys(obj)) {
        if (k.startsWith('_') && !EXPORT_PRESERVE_PRIVATE_KEYS.has(k)) {
            delete obj[k];
            continue;
        }
        // 服务端 HMAC 签名 / 加密推理内容：跨账号不可复用 + 分享时是隐私敏感数据，主动剥离
        if (EXPORT_SENSITIVE_KEYS.has(k)) {
            delete obj[k];
            if (stats) stats.sensitiveStripped++;
            continue;
        }
        const v = obj[k];
        if (v && typeof v === 'object') stripPrivateFields(v, stats);
    }
}

function sanitizePartsList(parts) {
    if (!Array.isArray(parts)) return parts;
    return parts.map((p) => {
        const clean = { ...p };
        stripPrivateFields(clean);
        return clean;
    });
}

/**
 * 深拷贝（structuredClone 兜底 JSON 序列化）
 */
function deepClone(obj) {
    if (typeof globalThis.structuredClone === 'function') {
        try {
            return globalThis.structuredClone(obj);
        } catch {
            /* fallback */
        }
    }
    return JSON.parse(JSON.stringify(obj));
}

/**
 * 过滤消息中的私有字段（用于导出）
 *
 * stripPrivateFields 已改为递归 in-place 修改，必须深克隆整条 message 避免污染
 * 原 state.messages（之前浅克隆 + 嵌套 mapClone 只对 parts/replies.all
 * 三处生效，meta.raw.openai.reasoningItems 之类嵌套结构仍会被 in-place 修改）。
 *
 * idMap 是公共 derive 字段，保留以便跨格式重导入不丢配对。
 */
export function sanitizeMessageForExport(message, stats = null) {
    if (!message || typeof message !== 'object') return message;

    const result = deepClone(message);
    stripPrivateFields(result, stats);

    // 导出前强制把 pending/running tool_call 老化为 error, 避免污染态跨设备传播
    agePendingToolCallsInPlace([result], { nowMs: Date.now(), ageThresholdMs: 0 });

    // 二次走 sanitizePartsList 保证 parts / replies.all[].parts 单独走 mapClone 路径，
    // 与历史行为对齐（理论上 stripPrivateFields 递归已覆盖，保留作显式契约 + 单测兼容点）
    if (Array.isArray(result.parts)) {
        result.parts = sanitizePartsList(result.parts);
    }
    if (Array.isArray(result.replies?.all)) {
        result.replies.all = result.replies.all.map((r) => {
            if (Array.isArray(r?.parts)) {
                return { ...r, parts: sanitizePartsList(r.parts) };
            }
            return r;
        });
    }

    return result;
}
