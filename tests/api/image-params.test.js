import { describe, expect, it } from 'vitest';
import {
    buildOpenAIImageParams,
    sanitizeOpenAIImageParams,
    validateOpenAIImageSize
} from '../../js/api/image-params.js';

describe('validateOpenAIImageSize', () => {
    it('接受标准尺寸和合法自定义尺寸', () => {
        expect(validateOpenAIImageSize('1024x1024')).toBeNull();
        expect(validateOpenAIImageSize('1536x864')).toBeNull();
    });

    it('拒绝非 16 倍数、越界比例和超大像素', () => {
        expect(validateOpenAIImageSize('1023x1024')).toContain('16');
        expect(validateOpenAIImageSize('3200x512')).toContain('1:3');
        expect(validateOpenAIImageSize('3840x3840')).toContain('像素');
    });
});

describe('buildOpenAIImageParams', () => {
    it('只输出有效且显式设置的参数', () => {
        expect(
            buildOpenAIImageParams(
                {
                    size: 'custom',
                    customSize: '1536x864',
                    quality: 'high',
                    output_format: 'webp',
                    output_compression: 80,
                    n: 3,
                    partial_images: 2
                },
                true
            )
        ).toEqual({
            size: '1536x864',
            quality: 'high',
            output_format: 'webp',
            output_compression: 80,
            n: 3,
            partial_images: 2
        });
    });

    it('非流式不发送 partial_images，PNG 不发送压缩率', () => {
        expect(
            buildOpenAIImageParams(
                { output_format: 'png', output_compression: 50, partial_images: 3 },
                false
            )
        ).toEqual({ output_format: 'png' });
    });

    it('JPEG 与透明背景冲突时抛错', () => {
        expect(() =>
            buildOpenAIImageParams({ output_format: 'jpeg', background: 'transparent' }, false)
        ).toThrow('透明背景');
    });
});

describe('图片参数取值范围', () => {
    it('自定义尺寸不能低于 655,360 像素', () => {
        expect(validateOpenAIImageSize('1024x640')).toBeNull();
        expect(validateOpenAIImageSize('1024x608')).toContain('655,360');
        expect(validateOpenAIImageSize('512x512')).toContain('655,360');
    });

    it('画质接受 xhigh / max', () => {
        expect(buildOpenAIImageParams({ quality: 'xhigh' }).quality).toBe('xhigh');
        expect(buildOpenAIImageParams({ quality: 'max' }).quality).toBe('max');
        expect(buildOpenAIImageParams({ quality: 'ultra' })).not.toHaveProperty('quality');
    });
});

describe('sanitizeOpenAIImageParams', () => {
    it('合法参数原样返回且不修改入参', () => {
        const params = { size: 'custom', customSize: '1536x864', output_format: 'png' };
        const result = sanitizeOpenAIImageParams(params);
        expect(result.corrections).toEqual([]);
        expect(result.params).toEqual(params);
        expect(result.params).not.toBe(params);
    });

    it('正在使用的自定义尺寸低于新下限时回到服务端默认', () => {
        const params = { size: 'custom', customSize: '512x512' };
        const { params: next, corrections } = sanitizeOpenAIImageParams(params);
        expect(next).toEqual({ size: null, customSize: '' });
        expect(corrections).toEqual([expect.stringContaining('512x512')]);
        expect(params.customSize).toBe('512x512');
    });

    it('未使用的失效自定义尺寸只清除，预设尺寸保留', () => {
        const { params: next, corrections } = sanitizeOpenAIImageParams({
            size: '1024x1024',
            customSize: '1024x608'
        });
        expect(next).toEqual({ size: '1024x1024', customSize: '' });
        expect(corrections).toEqual([expect.stringContaining('已清除')]);
    });

    it('旧版本保存的过小预设尺寸回到服务端默认', () => {
        const { params: next, corrections } = sanitizeOpenAIImageParams({ size: '256x256' });
        expect(next.size).toBeNull();
        expect(corrections).toHaveLength(1);
    });

    it('透明背景配 JPEG 时输出格式改为 PNG，纠正后不再触发构造错误', () => {
        const { params: next, corrections } = sanitizeOpenAIImageParams({
            background: 'transparent',
            output_format: 'jpeg'
        });
        expect(next.output_format).toBe('png');
        expect(corrections).toEqual([expect.stringContaining('PNG')]);
        expect(() => buildOpenAIImageParams(next)).not.toThrow();
    });
});
