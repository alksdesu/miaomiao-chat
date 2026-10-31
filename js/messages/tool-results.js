import { PartType, Role, ToolState, MediaKind } from './schema.js';
import { parseDataURL } from '../utils/file-helpers.js';
import { TOOL_INTERRUPTED_MESSAGE } from '../utils/constants.js';

export function applyToolResultsToMessages(messages, toolResults) {
    if (!Array.isArray(messages) || !Array.isArray(toolResults) || toolResults.length === 0) {
        return { messages, matched: 0, changedIndexes: [] };
    }

    const resultsById = new Map(
        toolResults.filter((result) => result?.id).map((result) => [result.id, result])
    );
    let matched = 0;
    const changedIndexes = [];
    const nextMessages = messages.map((message, index) => {
        if (message?.role !== Role.ASSISTANT || !Array.isArray(message.parts)) return message;

        let changed = false;
        const parts = message.parts.map((part) => {
            if (part.type !== PartType.TOOL_CALL || !part.id) return part;
            const result = resultsById.get(part.id);
            if (!result) return part;
            changed = true;
            matched++;
            return {
                ...part,
                result: result.result,
                state: result.isError ? ToolState.ERROR : ToolState.DONE
            };
        });

        if (!changed) return message;
        changedIndexes.push(index);
        return { ...message, parts };
    });

    return { messages: nextMessages, matched, changedIndexes };
}

// ========== 工具结果 → 发给模型的内容 ==========

// 工具结果可能含 DOM Node / 自循环对象（MCP 服务端不规范输出），
// 裸 JSON.stringify 抛 'Converting circular structure to JSON' 会让整轮 partsToAPIMessages
// 中断 → continuation 失败。replacer 在第二次遇到同对象时返回占位字符串
function safeStringify(value) {
    try {
        return JSON.stringify(value);
    } catch (_e) {
        const seen = new WeakSet();
        try {
            return JSON.stringify(value, (_k, v) => {
                if (v && typeof v === 'object') {
                    if (seen.has(v)) return '[Circular]';
                    seen.add(v);
                }
                return v;
            });
        } catch {
            return '[unserializable tool result]';
        }
    }
}

export function stringifyToolResult(result, fallback = TOOL_INTERRUPTED_MESSAGE) {
    if (result == null) return fallback;
    if (typeof result === 'string') return result;
    // executeToolCalls 失败 schema {error, is_error: true, ...} — 含 "Do NOT retry" 指令优先透传
    if (result.is_error === true && typeof result.error === 'string') return result.error;
    if (typeof result.content === 'string') return result.content;
    // 历史兼容：仅含 error 字符串（无 is_error 标记）也透传
    if (typeof result.error === 'string') return result.error;
    if (result.content !== undefined) return safeStringify(result.content);
    if (result.error !== undefined) return safeStringify({ error: result.error });
    return safeStringify(result);
}

// orchestrator 从 MCP content 里转出的媒体字段，以及 computer 动作回传的 media
const MEDIA_RESULT_KEYS = Object.freeze(['media', 'image', 'images', 'video', 'videos']);

/**
 * MCP 标准结果的 content 数组所在层：{ content: [...] } 或客户端包裹的 { result: { content: [...] } }
 */
function findMcpPayload(result) {
    if (Array.isArray(result.content)) return result;
    if (
        result.result &&
        typeof result.result === 'object' &&
        Array.isArray(result.result.content)
    ) {
        return result.result;
    }
    return null;
}

function toImageDataUrl(item) {
    if (typeof item.data === 'string' && item.data) {
        return `data:${item.mimeType || item.media_type || 'image/png'};base64,${item.data}`;
    }
    return typeof item.url === 'string' ? item.url : '';
}

/**
 * orchestrator 转出的 image / images 已按单图与累计上限裁过（超限的换成文本占位），
 * 有这两个字段时以它们为准，不再读原始 content 里的 base64
 */
function collectResultImages(result, payload) {
    const images = [];
    const seen = new Set();
    const add = (url, mimeType) => {
        if (typeof url !== 'string' || !url || seen.has(url)) return;
        seen.add(url);
        images.push({ url, mimeType: mimeType || parseDataURL(url)?.mimeType || '' });
    };

    for (const item of Array.isArray(result.media) ? result.media : []) {
        if (item?.type === MediaKind.IMAGE) add(item.url, item.mimeType || item.mime);
    }
    if (result.image !== undefined || result.images !== undefined) {
        add(result.image);
        for (const item of Array.isArray(result.images) ? result.images : []) {
            add(typeof item === 'string' ? item : item?.url, item?.mimeType);
        }
    } else if (payload) {
        for (const item of payload.content) {
            if (item?.type === 'image') add(toImageDataUrl(item), item.mimeType || item.media_type);
        }
    }
    return images;
}

function countResultVideos(result, payload) {
    const mediaVideos = (Array.isArray(result.media) ? result.media : []).filter(
        (item) => item?.type === MediaKind.VIDEO
    ).length;
    if (Array.isArray(result.videos)) return mediaVideos + result.videos.length;
    if (result.video) return mediaVideos + 1;
    const payloadVideos = payload
        ? payload.content.filter((item) => item?.type === 'video').length
        : 0;
    return mediaVideos + payloadVideos;
}

function describeContentItem(item) {
    if (!item || typeof item !== 'object') return '';
    if (item.type === 'text') return typeof item.text === 'string' ? item.text : '';
    if (item.type === 'image' || item.type === 'video') return '';
    if (item.type === 'resource' && typeof item.resource?.text === 'string') {
        return item.resource.text;
    }
    if (typeof item.data === 'string') return `[${item.type || 'binary'} 内容已省略]`;
    return safeStringify(item);
}

function omitMediaFields(result) {
    const rest = { ...result };
    for (const key of MEDIA_RESULT_KEYS) delete rest[key];
    return rest;
}

function describeResultText(result, payload) {
    if (result.is_error === true && typeof result.error === 'string') return result.error;
    if (typeof result.content === 'string') return result.content;
    const items = payload ? payload.content : [];
    if (typeof result.text === 'string') {
        const extras = items
            .filter((item) => item?.type !== 'text')
            .map(describeContentItem)
            .filter(Boolean);
        return [result.text, ...extras].filter(Boolean).join('\n');
    }
    if (payload) return items.map(describeContentItem).filter(Boolean).join('\n');
    if (typeof result.error === 'string') return result.error;
    const rest = omitMediaFields(result);
    return Object.keys(rest).length > 0 ? stringifyToolResult(rest, '') : '';
}

/**
 * 工具结果拆成发给模型的文本与图片：截图、MCP 图片由各家按原生图片格式回传，base64 不写进文本
 * @param {*} result tool_call part 的 result
 * @param {string} [fallback] 没有结果时的文本
 * @returns {{ text: string, images: Array<{ url: string, mimeType: string }> }}
 */
export function splitToolResultContent(result, fallback = TOOL_INTERRUPTED_MESSAGE) {
    if (result == null || typeof result !== 'object') {
        return { text: stringifyToolResult(result, fallback), images: [] };
    }
    const payload = findMcpPayload(result);
    const images = collectResultImages(result, payload);
    const videoCount = countResultVideos(result, payload);
    const hasMediaFields = MEDIA_RESULT_KEYS.some((key) => result[key] !== undefined);
    if (!payload && !hasMediaFields) {
        return { text: stringifyToolResult(result, fallback), images };
    }
    const lines = [describeResultText(result, payload)];
    if (videoCount > 0) lines.push(`[工具返回了 ${videoCount} 段视频，未发送给模型]`);
    return { text: lines.filter(Boolean).join('\n'), images };
}

/**
 * 去掉工具结果里的图片，换成说明文字：当前模型不支持图片输入时用
 * @returns {*} 没有图片时原样返回
 */
export function omitToolResultImages(result, notice) {
    const { text, images } = splitToolResultContent(result, '');
    if (images.length === 0) return result;
    const content = [text, notice(images.length)].filter(Boolean).join('\n');
    return result?.is_error === true ? { error: content, is_error: true, content } : { content };
}
