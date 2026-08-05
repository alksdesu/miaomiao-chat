import { PartType, MediaKind, Role } from '../../messages/schema.js';
import {
    OpenAIImageStreamParser,
    parseOpenAIImageStream
} from '../../stream/parser-openai-image.js';
import { buildOpenAIAuthHeaders } from './openai-shared.js';

const OUTPUT_MIME_TYPES = Object.freeze({
    png: 'image/png',
    jpeg: 'image/jpeg',
    jpg: 'image/jpeg',
    webp: 'image/webp'
});

function inferImageMime(base64, outputFormat = '') {
    const configured = OUTPUT_MIME_TYPES[String(outputFormat).toLowerCase()];
    if (configured) return configured;
    if (typeof base64 !== 'string') return 'image/png';
    if (base64.startsWith('/9j/')) return 'image/jpeg';
    if (base64.startsWith('UklGR')) return 'image/webp';
    return 'image/png';
}

function extractLegacyText(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
        .filter((item) => item?.type === 'text' && typeof item.text === 'string')
        .map((item) => item.text)
        .join('\n');
}

function extractLegacyImages(content) {
    if (!Array.isArray(content)) return [];
    return content
        .filter((item) => item?.type === 'image_url')
        .map((item) => item.image_url?.url || item.url)
        .filter(Boolean);
}

function partsToAPIMessages(messages) {
    const latestUserMessage = [...messages].reverse().find((message) => message.role === Role.USER);
    if (!latestUserMessage) return [];

    const parts = Array.isArray(latestUserMessage.parts) ? latestUserMessage.parts : [];
    const textParts = parts
        .filter((part) => part.type === PartType.TEXT && typeof part.text === 'string')
        .map((part) => part.text);
    const partImageUrls = parts
        .filter(
            (part) => part.type === PartType.MEDIA && part.media === MediaKind.IMAGE && part.url
        )
        .map((part) => part.url);
    const imageUrls =
        partImageUrls.length > 0 ? partImageUrls : extractLegacyImages(latestUserMessage.content);
    if (imageUrls.length > 16) throw new Error('图片编辑最多支持 16 张输入图片');

    return [
        {
            prompt:
                textParts.length > 0
                    ? textParts.join('\n')
                    : extractLegacyText(latestUserMessage.content),
            images: imageUrls
        }
    ];
}

function toImageContentPart(image, outputFormat) {
    if (image?.b64_json) {
        const mimeType = inferImageMime(image.b64_json, outputFormat);
        return {
            type: 'image_url',
            url: `data:${mimeType};base64,${image.b64_json}`,
            complete: true,
            mimeType
        };
    }
    if (image?.url) {
        return {
            type: 'image_url',
            url: image.url,
            complete: true,
            mimeType: OUTPUT_MIME_TYPES[String(outputFormat).toLowerCase()] || ''
        };
    }
    return null;
}

function parseResponse(data) {
    const contentParts = (Array.isArray(data?.data) ? data.data : [])
        .map((image) => toImageContentPart(image, data.output_format))
        .filter(Boolean);
    if (contentParts.length === 0) return null;

    return {
        content: '',
        contentParts,
        usage: data.usage || null
    };
}

function collectBuiltinTools() {
    return [];
}

function formatSystemTools() {
    return [];
}

function buildRequestBody({ messages, model, modelParams, state: stateRef }) {
    if (typeof model !== 'string' || !model.trim()) {
        throw new Error('请先为图片提供商选择或添加模型');
    }

    const requestInput = messages[0];
    if (!requestInput || !requestInput.prompt?.trim()) {
        throw new Error('图片生成提示词不能为空');
    }

    const requestBody = {
        model,
        prompt: requestInput.prompt,
        stream: !!stateRef.streamEnabled,
        ...modelParams
    };

    if (requestInput.images.length > 0) {
        requestBody.images = requestInput.images.map((imageUrl) => ({ image_url: imageUrl }));
    } else {
        delete requestBody.input_fidelity;
    }

    return requestBody;
}

function resolveEndpoint(baseEndpoint, _model, _isStreaming, requestBody) {
    const target = requestBody?.images?.length ? 'edits' : 'generations';
    let url;
    try {
        url = new URL(baseEndpoint);
    } catch {
        return baseEndpoint;
    }

    const path = url.pathname.replace(/\/+$/, '');
    if (/\/images\/(generations|edits)$/.test(path)) {
        url.pathname = path.replace(/\/(generations|edits)$/, `/${target}`);
    } else if (path === '' || path === '/') {
        url.pathname = `/v1/images/${target}`;
    } else if (path === '/v1') {
        url.pathname = `/v1/images/${target}`;
    } else if (path.endsWith('/images')) {
        url.pathname = `${path}/${target}`;
    }
    return url.toString();
}

function buildHeaders(apiKey) {
    return buildOpenAIAuthHeaders(apiKey);
}

function buildQueryString() {
    return '';
}

function streamParser(reader, sessionId, sink = null, signal = null) {
    return parseOpenAIImageStream(reader, sessionId, sink, signal);
}

function sanitizeRequestForLogging(requestBody) {
    return {
        ...requestBody,
        ...(requestBody.images
            ? { images: requestBody.images.map(() => ({ image_url: '[image omitted]' })) }
            : {})
    };
}

function sanitizeResponseForLogging(data) {
    return {
        ...data,
        data: Array.isArray(data?.data)
            ? data.data.map((image) => ({
                  ...image,
                  ...(image.b64_json ? { b64_json: `[base64 ${image.b64_json.length} chars]` } : {})
              }))
            : data?.data
    };
}

export const openaiImageAdapter = Object.freeze({
    name: 'OpenAI Image',
    apiFormat: 'openai-image',
    filterPosition: 'before',
    supportsMultiStream: false,
    supportsMultipleReplies: false,
    requestFeatures: Object.freeze({
        system: false,
        prefill: false,
        tools: false,
        thinking: false,
        verbosity: false
    }),

    parserClass: OpenAIImageStreamParser,
    streamParser,

    partsToAPIMessages,
    parseResponse,

    collectBuiltinTools,
    formatSystemTools,
    buildRequestBody,
    resolveEndpoint,
    buildHeaders,
    buildQueryString,
    sanitizeRequestForLogging,
    sanitizeResponseForLogging
});

export { inferImageMime };
