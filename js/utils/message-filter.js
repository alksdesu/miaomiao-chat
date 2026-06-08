/**
 * 智能消息过滤模块
 * 根据模型能力过滤和转换历史消息，确保跨模型对话兼容性
 */

import { logger } from './logger.js';
import { PartType, MediaKind, hasParts, textPart, mediaPart } from '../messages/schema.js';

/**
 * 根据模型能力过滤和转换消息
 * @param {Array} messages - 原始消息数组（OpenAI 格式）
 * @param {Object} modelCapabilities - 当前模型的能力配置 {imageInput, imageOutput}
 * @returns {Array} 转换后的消息数组
 */
export function filterMessagesByCapabilities(messages, modelCapabilities) {
    if (!modelCapabilities) {
        logger.warn('[消息过滤] 无能力配置，跳过过滤');
        return messages;
    }

    logger.debug('[消息过滤] 开始过滤，能力配置:', modelCapabilities);

    const filteredMessages = messages.map((msg, index) => {
        // 只处理 assistant 和 user 消息，system 消息保持不变
        if (msg.role === 'system') return msg;

        // 检查消息是否包含图片（新格式优先）
        const hasImages = hasParts(msg) ? hasImageInParts(msg.parts) : hasImageContent(msg.content);
        if (!hasImages) return msg;

        // 根据角色和能力决定转换策略
        if (msg.role === 'assistant') {
            return handleAssistantImageMessage(msg, modelCapabilities, index);
        } else if (msg.role === 'user') {
            return handleUserImageMessage(msg, modelCapabilities);
        }

        return msg;
    });

    logger.debug(`[消息过滤] 完成：${messages.length} → ${filteredMessages.length} 条消息`);
    return filteredMessages;
}

/**
 * 处理 assistant 的图片消息
 * @param {Object} msg - 消息对象
 * @param {Object} capabilities - 模型能力 {imageInput, imageOutput}
 * @param {number} index - 消息索引
 * @returns {Object} 处理后的消息
 */
function handleAssistantImageMessage(msg, capabilities, index) {
    const { imageInput, imageOutput } = capabilities;

    // 策略 1: 模型支持图片输入但不支持输出 → 转为 user 消息
    if (imageInput && !imageOutput) {
        logger.debug(`[消息过滤] 转换 assistant 图片为 user（消息 #${index + 1}）`);
        return convertAssistantImageToUser(msg, index);
    }

    // 策略 2: 模型两者都不支持 → 删除图片，保留文本
    if (!imageInput && !imageOutput) {
        logger.debug(`[消息过滤] 删除 assistant 图片（模型不支持多模态，消息 #${index + 1}）`);
        return removeImagesFromMessage(msg, 'assistant');
    }

    // 策略 3: 模型支持图片输出 → 保留原样
    logger.debug(`[消息过滤] 保留 assistant 图片（模型支持输出，消息 #${index + 1}）`);
    return msg;
}

/**
 * 处理 user 的图片消息
 * @param {Object} msg - 消息对象
 * @param {Object} capabilities - 模型能力
 * @returns {Object} 处理后的消息
 */
function handleUserImageMessage(msg, capabilities) {
    // 如果模型不支持图片输入，删除用户的图片
    if (!capabilities.imageInput) {
        logger.debug('[消息过滤] 删除 user 图片（模型不支持 Vision）');
        return removeImagesFromMessage(msg, 'user');
    }

    logger.debug('[消息过滤] 保留 user 图片（模型支持 Vision）');
    return msg;
}

/**
 * 将 assistant 的图片消息转换为 user 消息
 * @param {Object} msg - 原始 assistant 消息
 * @param {number} messageIndex - 消息索引
 * @returns {Object} 转换后的 user 消息
 */
function convertAssistantImageToUser(msg, messageIndex) {
    const textParts = [];
    const imageParts = [];
    const thinkingParts = [];

    // 新格式：从 parts 读取
    if (hasParts(msg)) {
        for (const p of msg.parts) {
            if (p.type === PartType.TEXT) textParts.push(p.text);
            else if (p.type === PartType.THINKING) thinkingParts.push(p.text);
            else if (p.type === PartType.MEDIA && p.media === MediaKind.IMAGE) {
                imageParts.push({ type: 'image_url', image_url: { url: p.url } });
            }
        }
    }
    // 旧格式：从 content 读取
    else if (Array.isArray(msg.content)) {
        msg.content.forEach((part) => {
            if (part.type === 'text') {
                textParts.push(part.text);
            } else if (part.type === 'thinking') {
                thinkingParts.push(part.text);
            } else if (part.type === 'image_url') {
                imageParts.push(part);
            }
        });
    } else if (typeof msg.content === 'string') {
        textParts.push(msg.content);
    }

    // 构建转换后的内容
    const newContent = [];

    // 添加占位符说明
    let placeholder = `[*] 第 ${messageIndex + 1} 条消息中 AI 的回复已转为你的消息（当前模型不支持图片输出）\n\n`;

    // 添加思维链内容（如果有）
    if (thinkingParts.length > 0) {
        placeholder += `AI 的思考过程：\n${thinkingParts.join('\n\n')}\n\n`;
    }

    // 添加文本内容
    if (textParts.length > 0) {
        placeholder += `AI 说：${textParts.join('\n\n')}`;
    }

    // 如果有图片，添加图片说明
    if (imageParts.length > 0) {
        placeholder += `\n\nAI 生成的图片（${imageParts.length} 张）：`;
    }

    newContent.push({ type: 'text', text: placeholder });

    // 添加图片
    imageParts.forEach((img) => {
        newContent.push(img);
    });

    // 同步重建 parts[] 与 content 字段一致 — Claude/Gemini 的 partsToAPIMessages
    // 只迭代 msg.parts，若 delete result.parts 转换后的 user 消息整条丢失
    const newParts = [textPart(placeholder)];
    for (const img of imageParts) {
        const url = img.image_url?.url;
        if (url) newParts.push(mediaPart(MediaKind.IMAGE, url, ''));
    }

    // 返回转换后的 user 消息（保留原消息的 id 等字段）
    return {
        ...msg,
        role: 'user',
        content: newContent,
        parts: newParts,
        _converted: true,
        _originalRole: 'assistant',
        _originalIndex: messageIndex
    };
}

/**
 * 从消息中删除图片，保留文本
 * @param {Object} msg - 原始消息
 * @param {string} role - 消息角色 (user/assistant)
 * @returns {Object} 处理后的消息
 */
function removeImagesFromMessage(msg, role) {
    const textParts = [];
    const thinkingParts = [];
    let imageCount = 0;

    // 新格式：从 parts 读取
    if (hasParts(msg)) {
        for (const p of msg.parts) {
            if (p.type === PartType.TEXT) textParts.push(p.text);
            else if (p.type === PartType.THINKING) thinkingParts.push(p.text);
            else if (p.type === PartType.MEDIA && p.media === MediaKind.IMAGE) imageCount++;
        }
    }
    // 旧格式：从 content 读取
    else if (Array.isArray(msg.content)) {
        msg.content.forEach((part) => {
            if (part.type === 'text') {
                textParts.push(part.text);
            } else if (part.type === 'thinking') {
                thinkingParts.push(part.text);
            } else if (part.type === 'image_url') {
                imageCount++;
            }
        });
    } else if (typeof msg.content === 'string') {
        return msg; // 纯文本消息，无需处理
    }

    // 如果没有图片，返回原消息
    if (imageCount === 0) {
        return msg;
    }

    // 构建新的文本内容
    let newText = '';

    // 添加思维链内容（如果有）
    if (thinkingParts.length > 0) {
        newText += thinkingParts.join('\n\n') + '\n\n';
    }

    // 添加文本内容
    if (textParts.length > 0) {
        newText += textParts.join('\n\n');
    }

    // 添加占位符说明
    const placeholder =
        role === 'assistant'
            ? `\n\n[AI 生成了 ${imageCount} 张图片，但当前模型不支持显示]`
            : `\n\n[你上传了 ${imageCount} 张图片，但当前模型不支持图片理解]`;

    newText = (newText + placeholder).trim();

    // 简化为字符串格式 + 同步重建 parts[] 让 Claude/Gemini partsToAPIMessages
    // 走 parts 路径时也能拿到合并后的文本（之前只覆写首个 TEXT 不处理多 TEXT/THINKING 合并）
    const newParts = [textPart(newText)];
    return {
        ...msg,
        content: newText,
        parts: newParts
    };
}

/**
 * 检查消息内容是否包含图片
 * @param {string|Array} content - 消息内容
 * @returns {boolean} 是否包含图片
 */
function hasImageContent(content) {
    if (Array.isArray(content)) {
        return content.some((part) => part.type === 'image_url');
    }
    return false;
}

/**
 * 检查新格式 parts 中是否包含图片
 */
function hasImageInParts(parts) {
    if (Array.isArray(parts)) {
        return parts.some((p) => p.type === PartType.MEDIA && p.media === MediaKind.IMAGE);
    }
    return false;
}
