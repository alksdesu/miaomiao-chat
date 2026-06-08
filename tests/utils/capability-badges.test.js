/**
 * capability-badges.js 测试
 * 能力徽章渲染
 */
import { describe, it, expect } from 'vitest';
import {
    renderCapabilityBadges,
    renderCapabilityBadgesText
} from '../../js/utils/capability-badges.js';

describe('renderCapabilityBadges', () => {
    it('null capabilities 返回空字符串', () => {
        expect(renderCapabilityBadges(null)).toBe('');
    });

    it('undefined capabilities 返回空字符串', () => {
        expect(renderCapabilityBadges(undefined)).toBe('');
    });

    it('无能力返回空字符串', () => {
        expect(renderCapabilityBadges({})).toBe('');
    });

    it('仅 imageInput 返回 V 徽章', () => {
        const result = renderCapabilityBadges({ imageInput: true, imageOutput: false });
        expect(result).toContain('vision');
        expect(result).toContain('>V<');
        expect(result).not.toContain('image"');
    });

    it('仅 imageOutput 返回 I 徽章', () => {
        const result = renderCapabilityBadges({ imageInput: false, imageOutput: true });
        expect(result).toContain('image"');
        expect(result).toContain('>I<');
        expect(result).not.toContain('vision');
    });

    it('两者都有返回两个徽章', () => {
        const result = renderCapabilityBadges({ imageInput: true, imageOutput: true });
        expect(result).toContain('vision');
        expect(result).toContain('>V<');
        expect(result).toContain('>I<');
    });

    it('结果以空格开头', () => {
        const result = renderCapabilityBadges({ imageInput: true });
        expect(result[0]).toBe(' ');
    });

    it('false 值不生成徽章', () => {
        expect(renderCapabilityBadges({ imageInput: false, imageOutput: false })).toBe('');
    });
});

describe('renderCapabilityBadgesText', () => {
    it('null 返回空', () => {
        expect(renderCapabilityBadgesText(null)).toBe('');
    });

    it('undefined 返回空', () => {
        expect(renderCapabilityBadgesText(undefined)).toBe('');
    });

    it('空对象返回空', () => {
        expect(renderCapabilityBadgesText({})).toBe('');
    });

    it('imageInput 返回 [V]', () => {
        expect(renderCapabilityBadgesText({ imageInput: true })).toContain('[V]');
    });

    it('imageOutput 返回 [I]', () => {
        expect(renderCapabilityBadgesText({ imageOutput: true })).toContain('[I]');
    });

    it('两者都有', () => {
        const result = renderCapabilityBadgesText({ imageInput: true, imageOutput: true });
        expect(result).toContain('[V]');
        expect(result).toContain('[I]');
    });

    it('结果以空格开头', () => {
        const result = renderCapabilityBadgesText({ imageInput: true });
        expect(result[0]).toBe(' ');
    });

    it('false 值不生成文本', () => {
        expect(renderCapabilityBadgesText({ imageInput: false, imageOutput: false })).toBe('');
    });
});
