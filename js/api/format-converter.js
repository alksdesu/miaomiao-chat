/**
 * 跨格式兼容性转换器
 * 处理工具调用 ID 重映射和 thoughtSignature 保存/恢复
 *
 * P0 
 * - 规范化 ID 解决双向查询问题
 * - Gemini 生成唯一 ID（不再 null）
 * - 会话清空时清理映射表
 * - LRU 淘汰策略防止内存泄漏
 *
 * P1 
 * - 签名备份/恢复机制
 * - ID 计数器避免并发冲突
 */

import { state } from '../core/state.js';
import { PartType } from '../messages/schema.js';

// ========== ID 映射管理 ==========

/**
 * 使用规范化 ID 作为键，解决双向查询问题
 * Map<canonicalId, { openaiId, claudeId, geminiId }>
 */
const idMappings = new Map();

/**
 * 反向索引，快速查找规范化 ID
 * Map<anyFormatId, canonicalId>
 */
const idIndex = new Map();

/**
 * ID 生成计数器，避免并发冲突
 */
let idCounter = 0;

/**
 * LRU 队列，最近使用的 ID
 */
const lruQueue = [];
const MAX_MAPPINGS = 1000;

/**
 * 规范化 ID：移除格式前缀，提取通用部分
 * @param {string} id - 任意格式的 ID
 * @returns {string} 规范化的 ID
 */
function normalizeId(id) {
    if (!id) return null;
    // 移除前缀：call_xxx -> xxx, toolu_xxx -> xxx, gemini_xxx -> xxx
    return id.replace(/^(call_|toolu_|gemini_)/, '');
}

/**
 * 生成唯一 ID（带计数器和时间戳）
 */
function generateUniqueId(prefix = '') {
    const timestamp = Date.now();
    const counter = idCounter++;
    const random = Math.random().toString(36).substr(2, 6);
    return `${prefix}${timestamp}_${counter}_${random}`;
}

/**
 * 生成 OpenAI 格式的工具调用 ID
 */
function generateOpenAIId() {
    return generateUniqueId('call_');
}

/**
 * 生成 Claude 格式的工具调用 ID
 */
function generateClaudeId() {
    return generateUniqueId('toolu_');
}

/**
 * P0 Gemini 也生成唯一 ID（内部使用，即使 API 不要求）
 */
function generateGeminiId() {
    return generateUniqueId('gemini_');
}

/**
 * LRU 淘汰策略，防止内存泄漏
 */
function evictOldMappings() {
    if (idMappings.size <= MAX_MAPPINGS) return;

    // 移除最旧的 10% 映射
    const toRemove = Math.floor(MAX_MAPPINGS * 0.1);
    for (let i = 0; i < toRemove && lruQueue.length > 0; i++) {
        const oldCanonical = lruQueue.shift();
        const oldMapping = idMappings.get(oldCanonical);

        if (oldMapping) {
            // 清除反向索引
            idIndex.delete(oldMapping.openaiId);
            idIndex.delete(oldMapping.claudeId);
            idIndex.delete(oldMapping.geminiId);
            // 清除映射
            idMappings.delete(oldCanonical);
        }
    }

    console.log(`[Format Converter] 🧹 LRU 淘汰: 移除 ${toRemove} 个旧映射，当前 ${idMappings.size} 个`);
}

/**
 * 更新 LRU 队列
 */
function touchId(canonicalId) {
    // 移除旧位置
    const index = lruQueue.indexOf(canonicalId);
    if (index > -1) {
        lruQueue.splice(index, 1);
    }
    // 添加到队尾（最近使用）
    lruQueue.push(canonicalId);
}

/**
 * P0 获取或创建映射的工具调用 ID
 * 使用规范化 ID 和反向索引解决双向查询问题
 *
 * @param {string} originalId - 原始 ID（任意格式）
 * @param {string} targetFormat - 目标格式 ('openai' | 'claude' | 'gemini')
 * @returns {string} 目标格式的 ID
 */
export function getOrCreateMappedId(originalId, targetFormat) {
    if (!originalId) {
        // 空 ID，直接生成新的
        return targetFormat === 'claude' ? generateClaudeId() :
               targetFormat === 'gemini' ? generateGeminiId() :
               generateOpenAIId();
    }

    // 先查反向索引，看是否已有映射
    let canonicalId = idIndex.get(originalId);

    if (!canonicalId) {
        // 第一次见到这个 ID，创建新映射
        canonicalId = normalizeId(originalId);

        const mapping = {
            openaiId: originalId.startsWith('call_') ? originalId : generateOpenAIId(),
            claudeId: originalId.startsWith('toolu_') ? originalId : generateClaudeId(),
            geminiId: originalId.startsWith('gemini_') ? originalId : generateGeminiId()
        };

        // 保存映射
        idMappings.set(canonicalId, mapping);

        // 建立反向索引（三个格式 ID 都指向同一个规范化 ID）
        idIndex.set(mapping.openaiId, canonicalId);
        idIndex.set(mapping.claudeId, canonicalId);
        idIndex.set(mapping.geminiId, canonicalId);

        // 更新 LRU
        touchId(canonicalId);

        // 检查是否需要淘汰
        evictOldMappings();
    } else {
        // 已有映射，更新 LRU
        touchId(canonicalId);
    }

    const mapping = idMappings.get(canonicalId);

    switch (targetFormat) {
        case 'claude':
            return mapping.claudeId;
        case 'gemini':
            return mapping.geminiId;
        case 'openai':
        default:
            return mapping.openaiId;
    }
}

/**
 * 清空所有 ID 映射（会话清空时调用）
 */
export function clearIdMappings() {
    idMappings.clear();
    idIndex.clear();
    lruQueue.length = 0;
    idCounter = 0;
    console.log('[Format Converter] 🧹 已清空所有工具调用 ID 映射');
}

// ========== thoughtSignature 管理 ==========

/**
 * 从消息中提取签名（如果存在）
 * P1 检测所有类型的签名（Gemini + Claude）
 * @param {Object} message - OpenAI 格式的消息
 * @param {number} toolCallIndex - 工具调用索引（默认 0）
 * @returns {string|null} 签名或 null
 */
export function extractThoughtSignature(message, toolCallIndex = 0) {
    if (message.role !== 'assistant') return null;

    // 新格式：从 parts 中的 thinking part 读取签名
    if (message.parts && Array.isArray(message.parts)) {
        for (const p of message.parts) {
            if (p.type === PartType.THINKING && p.signature) {
                return p.signature;
            }
        }
    }

    // 旧格式回退：检查工具调用中的 _thoughtSignature
    if (message.tool_calls) {
        const toolCall = message.tool_calls[toolCallIndex];
        if (toolCall?._thoughtSignature) {
            return toolCall._thoughtSignature;
        }
    }

    // 旧格式：消息级 thoughtSignature (Gemini)
    if (message.thoughtSignature) {
        return message.thoughtSignature;
    }

    // 旧格式：消息级 thinkingSignature (Claude)
    if (message.thinkingSignature) {
        return message.thinkingSignature;
    }

    return null;
}

/**
 * 清除指定索引之后的所有 thoughtSignature
 * @param {Array} messages - 消息数组
 * @param {number} fromIndex - 起始索引（不包含）
 * @returns {number} 清除的签名数量
 */
export function clearThoughtSignatures(messages, fromIndex) {
    let count = 0;

    for (let i = fromIndex; i < messages.length; i++) {
        const msg = messages[i];
        if (msg.role === 'assistant') {
            // 新格式：清理 parts 中的 thinking signature
            if (msg.parts && Array.isArray(msg.parts)) {
                for (const p of msg.parts) {
                    if (p.type === PartType.THINKING && p.signature) {
                        delete p.signature;
                        count++;
                    }
                }
            }

            // 旧格式：清理工具调用中的 _thoughtSignature
            if (msg.tool_calls) {
                for (const tc of msg.tool_calls) {
                    if (tc._thoughtSignature) {
                        delete tc._thoughtSignature;
                        count++;
                    }
                }
            }

            if (msg.thoughtSignature) { delete msg.thoughtSignature; count++; }
            if (msg.thinkingSignature) { delete msg.thinkingSignature; count++; }
        }
    }

    return count;
}

/**
 * 检测消息数组中是否存在 thoughtSignature
 * @param {Array} messages - 消息数组
 * @param {number} fromIndex - 起始索引
 * @returns {boolean}
 */
export function hasThoughtSignatures(messages, fromIndex = 0) {
    for (let i = fromIndex; i < messages.length; i++) {
        if (extractThoughtSignature(messages[i])) {
            return true;
        }
    }
    return false;
}

/**
 * 过滤消息中的私有字段（用于导出）
 * @param {Object} message - 消息对象
 * @returns {Object} 清理后的消息
 */
export function sanitizeMessageForExport(message) {
    const hasToolCalls = !!message.tool_calls;
    const hasParts = Array.isArray(message.parts);
    const hasPrivateTopLevel = message._schemaVersion !== undefined;

    if (!hasToolCalls && !hasParts && !hasPrivateTopLevel) return message;

    const result = { ...message };

    if (hasToolCalls) {
        result.tool_calls = message.tool_calls.map(tc => {
            // 移除所有私有字段（以 _ 开头）
            const { _thoughtSignature, _toolName, ...rest } = tc;
            return rest;
        });
    }

    // 清理 parts 中的私有字段
    if (hasParts) {
        result.parts = message.parts.map(p => {
            const clean = { ...p };
            Object.keys(clean).forEach(k => {
                if (k.startsWith('_')) delete clean[k];
            });
            return clean;
        });
    }

    // 移除顶层私有字段
    if (hasPrivateTopLevel) delete result._schemaVersion;

    return result;
}
