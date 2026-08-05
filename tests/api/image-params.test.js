import { describe, expect, it } from 'vitest';
import { buildOpenAIImageParams, validateOpenAIImageSize } from '../../js/api/image-params.js';

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
