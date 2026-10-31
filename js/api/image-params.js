// 可调尺寸的像素范围：下限约 1024×640，上限 3840×2160
const MIN_IMAGE_PIXELS = 655360;
const MAX_IMAGE_PIXELS = 3840 * 2160;

const ENUM_PARAMS = Object.freeze({
    quality: new Set(['auto', 'low', 'medium', 'high', 'xhigh', 'max']),
    output_format: new Set(['png', 'jpeg', 'webp']),
    background: new Set(['auto', 'opaque', 'transparent']),
    moderation: new Set(['auto', 'low']),
    input_fidelity: new Set(['low', 'high'])
});

export function validateOpenAIImageSize(size) {
    if (!size || size === 'auto') return null;
    const match = /^(\d+)x(\d+)$/.exec(size);
    if (!match) return '尺寸格式必须为 WIDTHxHEIGHT';

    const width = Number(match[1]);
    const height = Number(match[2]);
    if (width % 16 !== 0 || height % 16 !== 0) return '宽高必须均为 16 的倍数';

    const ratio = width / height;
    if (ratio < 1 / 3 || ratio > 3) return '宽高比必须在 1:3 到 3:1 之间';
    const pixels = width * height;
    if (Math.max(width, height) > 3840 || pixels > MAX_IMAGE_PIXELS) {
        return '尺寸不能超过 3840×2160 的像素范围';
    }
    if (pixels < MIN_IMAGE_PIXELS) return '尺寸不能小于 655,360 像素（如 1024×640）';
    return null;
}

/**
 * 按当前校验规则复查已保存的生图参数，返回纠正后的参数，不修改入参
 * 尺寸不合法时回到服务端默认；透明背景配 JPEG 时输出格式改为 PNG
 * @param {Object} params
 * @returns {{ params: Object, corrections: string[] }} corrections 为给用户看的纠正说明
 */
export function sanitizeOpenAIImageParams(params = {}) {
    const next = { ...params };
    const corrections = [];

    const customSize = typeof next.customSize === 'string' ? next.customSize.trim() : '';
    const customSizeError = customSize ? validateOpenAIImageSize(customSize) : null;
    if (customSizeError) {
        next.customSize = '';
        if (next.size === 'custom') {
            next.size = null;
            corrections.push(
                `自定义尺寸 ${customSize} 不符合当前要求（${customSizeError}），已改回服务端默认尺寸`
            );
        } else {
            corrections.push(
                `已清除不符合当前要求的自定义尺寸 ${customSize}（${customSizeError}）`
            );
        }
    }

    const presetSizeError =
        next.size && next.size !== 'custom' ? validateOpenAIImageSize(next.size) : null;
    if (presetSizeError) {
        corrections.push(
            `尺寸 ${next.size} 不符合当前要求（${presetSizeError}），已改回服务端默认尺寸`
        );
        next.size = null;
    }

    if (next.background === 'transparent' && next.output_format === 'jpeg') {
        next.output_format = 'png';
        corrections.push('透明背景仅支持 PNG 或 WebP，输出格式已改为 PNG');
    }

    return { params: next, corrections };
}

export function buildOpenAIImageParams(params = {}, streamEnabled = false) {
    const result = {};
    const size = params.size === 'custom' ? params.customSize?.trim() : params.size;
    if (size) {
        const sizeError = validateOpenAIImageSize(size);
        if (sizeError) throw new Error(sizeError);
        result.size = size;
    }

    for (const [key, values] of Object.entries(ENUM_PARAMS)) {
        const value = params[key];
        if (value && values.has(value)) result[key] = value;
    }

    if (Number.isInteger(params.n) && params.n >= 1 && params.n <= 10) {
        result.n = params.n;
    }

    if (
        Number.isInteger(params.output_compression) &&
        params.output_compression >= 0 &&
        params.output_compression <= 100 &&
        (result.output_format === 'jpeg' || result.output_format === 'webp')
    ) {
        result.output_compression = params.output_compression;
    }

    if (
        streamEnabled &&
        Number.isInteger(params.partial_images) &&
        params.partial_images >= 0 &&
        params.partial_images <= 3
    ) {
        result.partial_images = params.partial_images;
    }

    if (result.background === 'transparent' && result.output_format === 'jpeg') {
        throw new Error('透明背景仅支持 PNG 或 WebP 输出格式');
    }

    return result;
}
