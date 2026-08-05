const ENUM_PARAMS = Object.freeze({
    quality: new Set(['auto', 'low', 'medium', 'high']),
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
    if (Math.max(width, height) > 3840 || width * height > 3840 * 2160) {
        return '尺寸不能超过 3840×2160 的像素范围';
    }
    return null;
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
