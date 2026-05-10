/**
 * 状态变更辅助函数（统一消息格式版）
 *
 * state.messages 是唯一数据源（新 parts[] 格式）。
 */

import { state } from './state.js';
import { eventBus } from './events.js';
import { generateMessageId } from '../utils/helpers.js';
import { PartType, hasParts } from '../messages/schema.js';

function rebuildMessageIdMapFromIndex(fromIndex) {
    if (!state.messageIdMap) return;
    for (let i = fromIndex; i < state.messages.length; i++) {
        const id = state.messages[i]?.id;
        if (id) state.messageIdMap.set(id, i);
    }
}

/**
 * 重建消息 ID → 索引的完整映射
 */
export function rebuildMessageIdMap() {
    if (!state.messageIdMap) {
        state.messageIdMap = new Map();
    } else {
        state.messageIdMap.clear();
    }
    state.messages.forEach((msg, i) => {
        if (msg.id) state.messageIdMap.set(msg.id, i);
    });
}

/**
 * 添加消息（新格式，单参数）
 * @param {Object} msg - 新格式消息对象（含 parts[], meta 等）
 * @returns {number} 新消息的索引
 */
export function pushMessage(msg) {
    state.messages.push(msg);

    const index = state.messages.length - 1;

    if (msg.id && state.messageIdMap) {
        state.messageIdMap.set(msg.id, index);
    }

    state.sessionDirty = true;
    return index;
}

/**
 * 删除消息
 * @param {number} index - 消息索引
 */
export function removeMessageAt(index) {
    if (index < 0 || index >= state.messages.length) return;

    const removed = state.messages[index];
    if (removed.id && state.messageIdMap) {
        state.messageIdMap.delete(removed.id);
    }

    state.messages.splice(index, 1);

    if (state.messageIdMap) rebuildMessageIdMapFromIndex(index);
    state.sessionDirty = true;
}

/**
 * 删除指定索引后的所有消息
 * @param {number} fromIndex - 起始索引（该索引的消息保留）
 */
export function removeMessagesAfter(fromIndex) {
    if (fromIndex < 0) return;
    const removeCount = Math.max(0, state.messages.length - fromIndex - 1);
    if (removeCount === 0) return;

    if (state.messageIdMap) {
        for (let i = fromIndex + 1; i < state.messages.length; i++) {
            const id = state.messages[i]?.id;
            if (id) state.messageIdMap.delete(id);
        }
    }

    state.messages = state.messages.slice(0, fromIndex + 1);

    state.sessionDirty = true;
}

/**
 * 更新消息（spread merge 或完整替换）
 * @param {number} index
 * @param {Object} updates - 直接合并到 state.messages[index]
 * @param {boolean} replace - true 时完整替换
 */
export function updateMessageAt(index, updates, replace = false) {
    if (index < 0 || index >= state.messages.length) return;

    const old = state.messages[index];

    // replace 模式下维护 messageIdMap
    if (replace && old.id && state.messageIdMap) {
        state.messageIdMap.delete(old.id);
    }

    state.messages[index] = replace ? updates : { ...old, ...updates };

    // 确保新消息的 ID 在 map 中
    const newMsg = state.messages[index];
    if (newMsg.id && state.messageIdMap) {
        state.messageIdMap.set(newMsg.id, index);
    }

    state.sessionDirty = true;
}

/**
 * 替换所有消息
 * @param {Array} messages - 新格式消息数组
 */
export function replaceAllMessages(messages) {
    state.messages = [...messages];

    state.sessionDirty = false;
    rebuildMessageIdMap();
    eventBus.emit('state:messages-replaced', { newLength: state.messages.length });
}

/**
 * 弹出最后一条 assistant 消息
 * @returns {Object|null} 被弹出的消息，如果最后一条不是 assistant 则返回 null
 */
export function popLastAssistantMessage() {
    const len = state.messages.length;
    if (len === 0) return null;

    const msg = state.messages[len - 1];
    if (msg.role !== 'assistant') return null;

    state.messages.pop();

    if (msg.id && state.messageIdMap) state.messageIdMap.delete(msg.id);
    state.sessionDirty = true;
    return msg;
}

/**
 * 临时扩展消息数组（工具调用 continuation）
 * 原地追加，恢复时只删除临时消息，保留续写产生的新消息
 * @param {Array} extraMessages - 要追加的额外消息
 * @returns {Object} 备份信息（插入位置和数量）
 */
export function extendMessagesTemporarily(extraMessages) {
    const backup = {
        insertIndex: state.messages.length,
        count: extraMessages.length
    };
    state.messages.push(...extraMessages);
    return backup;
}

/**
 * 恢复被 extendMessagesTemporarily 临时扩展的消息数组
 * 只移除临时追加的工具结果消息，保留续写期间产生的合并/新增
 * @param {Object} backup - extendMessagesTemporarily 返回的备份对象
 */
export function restoreMessages(backup) {
    if (backup?.count > 0 && backup.insertIndex != null) {
        state.messages.splice(backup.insertIndex, backup.count);
        rebuildMessageIdMapFromIndex(backup.insertIndex);
    }
}

/**
 * 更新消息中的文本内容（新格式：修改 parts 中的 text part）
 */
export function updateMessageTextAt(index, newText) {
    if (index < 0 || index >= state.messages.length) return;

    const msg = state.messages[index];

    // 新格式：修改 parts 中的第一个 text part
    if (hasParts(msg)) {
        const textPart = msg.parts.find((p) => p.type === PartType.TEXT);
        if (textPart) {
            textPart.text = newText;
        } else {
            msg.parts.push({ type: PartType.TEXT, text: newText });
        }
    } else {
        // 旧格式兜底：创建 parts 而非写 content
        if (!msg.parts) msg.parts = [];
        msg.parts.push({ type: PartType.TEXT, text: newText });
    }

    state.sessionDirty = true;
}

/**
 * 批量补充缺少 ID 的消息
 */
export function ensureMessageIds() {
    let count = 0;
    for (const msg of state.messages) {
        if (!msg.id) {
            msg.id = generateMessageId();
            count++;
        }
    }
    if (count > 0) {
        rebuildMessageIdMap();
        state.sessionDirty = true;
    }
    return count;
}

/**
 * 通用状态设置（任意属性）
 * @param {string} key - 状态属性名
 * @param {*} value - 新值
 */
export function setState(key, value) {
    state[key] = value;
}

// ========== Setter 工厂 ==========

function createSetter(key) {
    return (value) => {
        state[key] = value;
    };
}

function createBoolSetter(key) {
    return (value) => {
        state[key] = !!value;
    };
}

// ========== 布尔 setter（!!value 强转）==========

export const setIsLoading = createBoolSetter('isLoading');
export const setIsSending = createBoolSetter('isSending');
export const setSessionDirty = createBoolSetter('sessionDirty');
export const setIsToolCallPending = createBoolSetter('isToolCallPending');
export const setIsToolCallContinuation = createBoolSetter('isToolCallContinuation');
export const setIsSavingContinuation = createBoolSetter('isSavingContinuation');
export const setIsImageCompressionRetry = createBoolSetter('isImageCompressionRetry');
export const setGeminiApiKeyInHeader = createBoolSetter('geminiApiKeyInHeader');
export const setStreamEnabled = createBoolSetter('streamEnabled');
export const setThinkingEnabled = createBoolSetter('thinkingEnabled');
export const setWebSearchEnabled = createBoolSetter('webSearchEnabled');
export const setXmlToolCallingEnabled = createBoolSetter('xmlToolCallingEnabled');
export const setThinkingNoneMode = createBoolSetter('thinkingNoneMode');
export const setClaudeAdaptiveThinking = createBoolSetter('claudeAdaptiveThinking');
export const setClaudeShowThinking = createBoolSetter('claudeShowThinking');
export const setMonitorEnabled = createBoolSetter('monitorEnabled');
export const setVerbosityEnabled = createBoolSetter('verbosityEnabled');
export const setPrefillEnabled = createBoolSetter('prefillEnabled');
export const setGeminiSystemPartsEnabled = createBoolSetter('geminiSystemPartsEnabled');
export const setToolHistoryEnabled = createBoolSetter('toolHistoryEnabled');
export const setIsSwitchingSession = createBoolSetter('isSwitchingSession');
export const setFastImageCompression = createBoolSetter('fastImageCompression');
export const setCodeExecutionEnabled = createBoolSetter('codeExecutionEnabled');
export const setComputerUseEnabled = createBoolSetter('computerUseEnabled');

// ========== 透传 setter ==========

export const setCurrentAssistantMessage = createSetter('currentAssistantMessage');
export const setCurrentAbortController = createSetter('currentAbortController');
export const setSelectedReplyIndex = createSetter('selectedReplyIndex');
export const setEditingIndex = createSetter('editingIndex');
export const setEditingElement = createSetter('editingElement');
export const setCurrentSessionId = createSetter('currentSessionId');
export const setApiFormat = createSetter('apiFormat');
export const setCurrentReplies = createSetter('currentReplies');
export const setUploadedImages = createSetter('uploadedImages');
export const setCurrentProviderId = createSetter('currentProviderId');
export const setLastUserMessage = createSetter('lastUserMessage');
export const setToolCallContinuationElement = createSetter('toolCallContinuationElement');
export const setImageRetryMessageElement = createSetter('imageRetryMessageElement');
export const setSelectedModel = createSetter('selectedModel');
export const setPrefillPresets = createSetter('prefillPresets');
export const setActivePrefillPresetId = createSetter('activePrefillPresetId');
export const setThinkingBudget = createSetter('thinkingBudget');
export const setThinkingStrength = createSetter('thinkingStrength');
export const setSystemPrompt = createSetter('systemPrompt');
export const setCurrentConfigName = createSetter('currentConfigName');
export const setImageSize = createSetter('imageSize');
export const setReplyCount = createSetter('replyCount');
export const setClaudeEffortLevel = createSetter('claudeEffortLevel');
export const setOutputVerbosity = createSetter('outputVerbosity');
export const setCurrentPrefillPresetName = createSetter('currentPrefillPresetName');
export const setCurrentSystemPrefillPresetName = createSetter('currentSystemPrefillPresetName');
export const setCurrentGeminiPartsPresetName = createSetter('currentGeminiPartsPresetName');
export const setFolders = createSetter('folders');
export const setCharName = createSetter('charName');
export const setUserName = createSetter('userName');
export const setPrefillMessages = createSetter('prefillMessages');
export const setSystemPrefillMessages = createSetter('systemPrefillMessages');
export const setGeminiSystemParts = createSetter('geminiSystemParts');
export const setToolCallHistory = createSetter('toolCallHistory');
export const setMaxToolHistorySize = createSetter('maxToolHistorySize');
export const setMcpServers = createSetter('mcpServers');
export const setQuickMessages = createSetter('quickMessages');
export const setSessions = createSetter('sessions');
export const setStorageMode = createSetter('storageMode');
export const setMessageHistory = createSetter('messageHistory');
export const setPdfMode = createSetter('pdfMode');
export const setStreamStats = createSetter('streamStats');
export const setSavedConfigs = createSetter('savedConfigs');
export const setSavedPrefillPresets = createSetter('savedPrefillPresets');
export const setSavedSystemPrefillPresets = createSetter('savedSystemPrefillPresets');
export const setSavedGeminiPartsPresets = createSetter('savedGeminiPartsPresets');
export const setToolPermissions = createSetter('toolPermissions');
export const setPendingModelSelection = createSetter('pendingModelSelection');
