import { BaseStreamParser } from './base-parser.js';

const OUTPUT_MIME_TYPES = Object.freeze({
    png: 'image/png',
    jpeg: 'image/jpeg',
    jpg: 'image/jpeg',
    webp: 'image/webp'
});

function inferMimeType(base64, outputFormat = '') {
    const configured = OUTPUT_MIME_TYPES[String(outputFormat).toLowerCase()];
    if (configured) return configured;
    if (base64?.startsWith('/9j/')) return 'image/jpeg';
    if (base64?.startsWith('UklGR')) return 'image/webp';
    return 'image/png';
}

function buildImagePart(event) {
    if (event?.url) {
        return {
            type: 'image_url',
            url: event.url,
            complete: true,
            mimeType: OUTPUT_MIME_TYPES[String(event.output_format).toLowerCase()] || ''
        };
    }
    if (!event?.b64_json) return null;
    const mimeType = inferMimeType(event.b64_json, event.output_format);
    return {
        type: 'image_url',
        url: `data:${mimeType};base64,${event.b64_json}`,
        complete: true,
        mimeType
    };
}

export class OpenAIImageStreamParser extends BaseStreamParser {
    constructor(sessionId = null, sink = null) {
        super(sessionId, sink);
        this.currentEvent = '';
        this.usage = null;
        this.completedImageFingerprints = new Set();
        this.finalized = false;
    }

    collectExtraSaveFields() {
        return { usage: this.usage };
    }

    async processLine(line) {
        const trimmed = line.trim();
        if (!trimmed) return false;

        if (trimmed.startsWith('event:')) {
            this.currentEvent = trimmed.slice(6).trim();
            return false;
        }
        const payload = trimmed.startsWith('data:')
            ? trimmed.slice(5).trim()
            : trimmed.startsWith('{')
              ? trimmed
              : null;
        if (!payload) return false;
        if (payload === '[DONE]') {
            this.completeStream();
            return true;
        }

        let event;
        try {
            event = JSON.parse(payload);
        } catch {
            return false;
        }

        if (event.error) {
            const code = event.error.code || event.error.type || 'image_generation_error';
            this.finalized = true;
            this.finalizeStreamWithError(code, event.error.message || '图片生成失败');
            return true;
        }

        if (Array.isArray(event.data)) {
            for (const image of event.data) {
                this.appendCompletedImage({
                    ...image,
                    output_format: event.output_format,
                    usage: event.usage
                });
            }
            return false;
        }

        const eventType = event.type || this.currentEvent;
        if (eventType.endsWith('.partial_image')) {
            const partialPart = buildImagePart(event);
            if (partialPart) {
                this.stats.recordFirstToken();
                this.totalReceived = Math.max(this.totalReceived, 1);
                this.sink.renderFinalContent([partialPart], '');
            }
            return false;
        }

        if (eventType.endsWith('.completed')) {
            this.appendCompletedImage(event);
        }

        return false;
    }

    appendCompletedImage(event) {
        const finalPart = buildImagePart(event);
        const imageValue = event.b64_json || event.url || '';
        const fingerprint = `${imageValue.length}:${imageValue.slice(0, 32)}:${imageValue.slice(-32)}`;
        if (finalPart && !this.completedImageFingerprints.has(fingerprint)) {
            this.stats.recordFirstToken();
            this.completedImageFingerprints.add(fingerprint);
            this.contentParts.push(finalPart);
            this.totalReceived = this.contentParts.length;
            this.sink.renderFinalContent(this.contentParts, '');
        }
        if (event.usage) this.usage = event.usage;
    }

    async onStreamEnd() {
        this.completeStream();
    }

    completeStream() {
        if (this.finalized) return;
        this.finalized = true;
        if (this.contentParts.length === 0) {
            this.finalizeStreamWithError('incomplete_image', '图片流未返回最终结果');
            return;
        }
        this.finalizeStream(this.collectExtraSaveFields());
    }
}

export async function parseOpenAIImageStream(reader, sessionId, sink = null, signal = null) {
    const parser = new OpenAIImageStreamParser(sessionId, sink);
    await parser.parse(reader, signal);
    return parser;
}
