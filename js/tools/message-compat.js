/**
 * 工具调用消息兼容性模块
 * 确保工具调用消息与现有的编辑、删除功能兼容
 *
 * 处理的兼容性问题：
 * 1. 删除包含 tool_calls 的消息时，自动删除对应的工具结果消息
 * 2. 删除工具结果消息时，警告用户
 * 3. 防止编辑包含 tool_calls 的助手消息
 * 4. 为 role: 'tool' 消息提供正确的渲染
 */

import { state } from '../core/state.js';
import { elements } from '../core/elements.js';
import { eventBus } from '../core/events.js';
import { removeMessageAt } from '../core/state-mutations.js';
import { PartType } from '../messages/schema.js';
import { logger } from '../utils/logger.js';

// ========== 消息删除兼容性 ==========

/**
 * 检查消息是否包含工具调用
 * @param {Object} message - 消息对象
 * @returns {boolean}
 */
export function hasToolCalls(message) {
    return (
        Array.isArray(message?.parts) &&
        message.parts.some((part) => part.type === PartType.TOOL_CALL)
    );
}

/**
 * 安全删除消息（兼容工具调用）
 * @param {number} index - 消息索引
 * @returns {Object} 删除结果 { success, deletedIndices, warnings }
 */
export function safeDeleteMessage(index) {
    const messages = state.messages;
    const message = messages[index];

    if (!message) {
        return {
            success: false,
            error: '消息不存在'
        };
    }

    removeMessageAt(index);

    return {
        success: true,
        deletedIndices: [index],
        warnings: []
    };
}

// ========== 消息编辑兼容性 ==========

/**
 * 检查消息是否可编辑
 *
 * 含 tool_calls 的 assistant 消息允许编辑 text / thinking / media 部分；
 * editor 的三个 update 函数（updateMessageContent / updateMessageWithThinking /
 * updateMessageContentWithImages）都已显式保留 TOOL_CALL parts，
 * id / name / args / result 不变，tool_use ↔ tool_result 配对不破坏。
 *
 * @param {number} index - 消息索引
 * @returns {Object} { canEdit, reason }
 */
export function canEditMessage(index) {
    const messages = state.messages;
    const message = messages[index];

    if (!message) {
        return { canEdit: false, reason: '消息不存在' };
    }

    // 正在等待工具结果续写的消息禁止编辑（in-flight 状态保护，
    // 编辑会破坏 mergeContinuation 对该 DOM 引用的复用）
    const isContinuationPending =
        state.isToolCallContinuation &&
        state.toolCallContinuationElement?.dataset.messageIndex === String(index);
    if (isContinuationPending) {
        return {
            canEdit: false,
            reason: '该消息正在等待工具结果续写，请等待完成后再编辑'
        };
    }

    // 全面检查 part.state PENDING：continuation flag 只覆盖前台单流路径，多回复 /
    // background 工具执行中的 PENDING tool_call 漏判会让用户编辑后 part.result 被流式
    // 异步赋值导致新旧 args 混乱
    if (Array.isArray(message.parts)) {
        const hasPending = message.parts.some(
            (p) => p.type === 'tool_call' && (p.state === 'pending' || p.state === 'running')
        );
        if (hasPending) {
            return {
                canEdit: false,
                reason: '消息中有正在执行的工具调用，请等待完成后再编辑'
            };
        }
    }

    if (message.role === 'user' || message.role === 'assistant') {
        return { canEdit: true };
    }

    return { canEdit: false, reason: '此类型消息不可编辑' };
}

// ========== 消息渲染辅助 ==========

/**
 * 检查消息是否应该在 UI 中显示
 * @param {Object} message - 消息对象
 * @returns {boolean}
 */
export function shouldRenderMessage(message) {
    // 仅有工具调用、没有可见文本的助手消息不单独显示
    if (message.role === 'assistant' && hasToolCalls(message)) {
        return message.parts.some(
            (part) => part.type === PartType.TEXT && part.text && part.text.trim()
        );
    }

    return true;
}

/**
 * 获取用于渲染的消息列表（过滤工具消息）
 * @param {Array} messages - 原始消息列表
 * @returns {Array} 过滤后的消息列表
 */
export function getRenderableMessages(messages) {
    return messages.filter(shouldRenderMessage);
}

// ========== 辅助函数 ==========

/**
 * 从消息元素解析消息 hit
 * 委托 store.findByEl 统一入口，与 editor.js 自动一致
 * @param {HTMLElement} messageEl - 消息DOM元素
 * @returns {{msg: Object, index: number} | null}
 */
function resolveMessageHit(messageEl) {
    return state.messageStore.findByEl(messageEl, { messagesArea: elements.messagesArea });
}

// ========== 事件监听 ==========

// 初始化标志，防止重复注册事件监听器
let initialized = false;

/**
 * 初始化消息兼容性模块
 * 注册事件监听器（仅执行一次）
 */
export function initMessageCompat() {
    if (initialized) {
        logger.warn('[MessageCompat] ⚠️ 模块已初始化，跳过重复注册');
        return;
    }

    initialized = true;

    // 注意：这些监听器用于提供警告和通知，不拦截原有流程
    // 实际的拦截逻辑在 editor.js 中实现

    // 监听删除消息事件（提供警告）
    eventBus.on('message:delete-requested', ({ messageEl }) => {
        const hit = resolveMessageHit(messageEl);
        if (!hit) return;

        const { msg: message, index } = hit;
        if (!message) return;

        if (!hasToolCalls(message)) return;
        logger.debug(`[MessageCompat] 删除含工具调用的消息 #${index}`);
    });

    // 监听编辑消息事件（检查是否可编辑）
    eventBus.on('message:edit-requested', ({ messageEl }) => {
        const hit = resolveMessageHit(messageEl);
        if (!hit) return;

        const checkResult = canEditMessage(hit.index);

        if (!checkResult.canEdit) {
            logger.warn('[MessageCompat] 消息不可编辑:', checkResult.reason);
            eventBus.emit('ui:notification', {
                message: checkResult.reason,
                type: 'error',
                duration: 3000
            });
        }
    });

    logger.debug('[MessageCompat] 🔧 工具调用消息兼容性模块已加载');
}

// 自动初始化（模块加载时）
initMessageCompat();
