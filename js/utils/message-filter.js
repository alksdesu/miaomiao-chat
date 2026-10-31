/**
 * 智能消息过滤模块
 * 根据模型能力过滤和转换历史消息，确保跨模型对话兼容性
 */

import { logger } from './logger.js';
import { PartType, MediaKind, Role, textPart } from '../messages/schema.js';
import { omitToolResultImages } from '../messages/tool-results.js';

/**
 * 根据模型能力过滤和转换消息
 *
 * 只替换模型收不了的图片，文件、思考块（签名）与工具调用原样保留；
 * 返回的是本次请求用的副本，不改动会话里的消息
 *
 * @param {Array} messages - 新格式消息数组（parts[]），必须在转成各家 API 格式之前调用
 * @param {Object} modelCapabilities - 当前模型的能力配置 {imageInput, imageOutput}
 * @returns {Array} 转换后的消息数组
 */
export function filterMessagesByCapabilities(messages, modelCapabilities) {
    if (!modelCapabilities) {
        logger.warn('[消息过滤] 无能力配置，跳过过滤');
        return messages;
    }

    logger.debug('[消息过滤] 开始过滤，能力配置:', modelCapabilities);

    const filteredMessages = [];
    messages.forEach((msg, index) => {
        if (msg.role === Role.SYSTEM) {
            filteredMessages.push(msg);
            return;
        }
        const withToolImages = modelCapabilities.imageInput
            ? msg
            : removeToolResultImages(msg, index);
        if (!hasImageInParts(withToolImages.parts)) {
            filteredMessages.push(withToolImages);
            return;
        }
        if (msg.role === Role.ASSISTANT) {
            filteredMessages.push(
                ...handleAssistantImageMessage(withToolImages, modelCapabilities, index)
            );
        } else if (msg.role === Role.USER && !modelCapabilities.imageInput) {
            logger.debug('[消息过滤] 删除 user 图片（模型不支持 Vision）');
            filteredMessages.push(
                replaceImages(
                    withToolImages,
                    (count) => `[你上传了 ${count} 张图片，但当前模型不支持图片理解]`
                )
            );
        } else {
            filteredMessages.push(withToolImages);
        }
    });

    const merged = mergeIntoNextUserMessage(filteredMessages);
    logger.debug(`[消息过滤] 完成：${messages.length} → ${merged.length} 条消息`);
    return merged;
}

/**
 * 挪出来的图片消息后面紧跟用户消息时并进去，避免连续两条 user 消息
 */
function mergeIntoNextUserMessage(messages) {
    const out = [];
    for (let i = 0; i < messages.length; i++) {
        const current = messages[i];
        const next = messages[i + 1];
        if (current._converted && next?.role === Role.USER && !next.error) {
            messages[i + 1] = { ...next, parts: [...current.parts, ...(next.parts || [])] };
            continue;
        }
        out.push(current);
    }
    return out;
}

/**
 * 处理 assistant 的图片消息
 * @returns {Array} 处理后的消息（可能拆成两条）
 */
function handleAssistantImageMessage(msg, capabilities, index) {
    const { imageInput, imageOutput } = capabilities;

    // 模型支持图片输入但不支持输出：assistant 里不能带图片，挪到紧随其后的一条 user 消息
    if (imageInput && !imageOutput) {
        logger.debug(`[消息过滤] assistant 图片转为 user 消息（消息 #${index + 1}）`);
        return moveImagesToUserMessage(msg, index);
    }

    if (!imageInput && !imageOutput) {
        logger.debug(`[消息过滤] 删除 assistant 图片（模型不支持多模态，消息 #${index + 1}）`);
        return [replaceImages(msg, (count) => `[AI 生成了 ${count} 张图片，但当前模型不支持显示]`)];
    }

    return [msg];
}

function isImagePart(part) {
    return part?.type === PartType.MEDIA && part.media === MediaKind.IMAGE;
}

/**
 * 图片换成一段说明文字，放在第一张图片原来的位置；其余 part 保持原样与原顺序
 */
function replaceImages(msg, describe) {
    const images = msg.parts.filter(isImagePart);
    const firstIndex = msg.parts.findIndex(isImagePart);
    const placeholder = textPart(describe(images.length), {
        ...(msg.parts[firstIndex]._turn !== undefined ? { _turn: msg.parts[firstIndex]._turn } : {})
    });
    const parts = msg.parts
        .map((part, index) => (index === firstIndex ? placeholder : part))
        .filter((part) => !isImagePart(part));
    return { ...msg, parts };
}

function moveImagesToUserMessage(msg, messageIndex) {
    const images = msg.parts.filter(isImagePart);
    const assistant = replaceImages(
        msg,
        (count) => `[AI 生成了 ${count} 张图片，已作为下一条消息发送]`
    );
    const userMessage = {
        id: `${msg.id}-images`,
        role: Role.USER,
        parts: [
            textPart(
                `[*] 第 ${messageIndex + 1} 条消息中 AI 生成的图片（${images.length} 张，当前模型不支持图片输出，以你的消息发送）：`
            ),
            ...images.map(({ _turn, ...image }) => image)
        ],
        meta: msg.meta,
        error: null,
        _converted: true,
        _originalRole: Role.ASSISTANT,
        _originalIndex: messageIndex
    };
    return [assistant, userMessage];
}

/**
 * 模型不支持图片输入时，工具结果里的截图等图片也发不出去，换成说明文字
 */
function removeToolResultImages(msg, index) {
    if (!Array.isArray(msg.parts)) return msg;
    let changed = false;
    const parts = msg.parts.map((part) => {
        if (part?.type !== PartType.TOOL_CALL || part.result == null) return part;
        const result = omitToolResultImages(
            part.result,
            (count) => `[工具返回了 ${count} 张图片，当前模型不支持图片输入，已省略]`
        );
        if (result === part.result) return part;
        changed = true;
        return { ...part, result };
    });
    if (!changed) return msg;
    logger.debug(`[消息过滤] 删除工具结果中的图片（模型不支持 Vision，消息 #${index + 1}）`);
    return { ...msg, parts };
}

/**
 * 检查新格式 parts 中是否包含图片
 */
function hasImageInParts(parts) {
    return Array.isArray(parts) && parts.some(isImagePart);
}
