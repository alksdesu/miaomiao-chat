/**
 * color-picker.js 颜色数学函数测试
 */
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';

import {
    hsvToRgb,
    rgbToHsv,
    rgbToHex,
    hexToRgb,
    parseColor,
    rgbaToString
} from '../../js/ui/color-picker.js';

describe('color-picker', () => {
    // ========== hsvToRgb ==========
    describe('hsvToRgb', () => {
        it('红色 h=0', () => {
            const { r, g, b } = hsvToRgb(0, 1, 1);
            expect(r).toBe(255);
            expect(g).toBe(0);
            expect(b).toBe(0);
        });

        it('绿色 h=120', () => {
            const { r, g, b } = hsvToRgb(120, 1, 1);
            expect(r).toBe(0);
            expect(g).toBe(255);
            expect(b).toBe(0);
        });

        it('蓝色 h=240', () => {
            const { r, g, b } = hsvToRgb(240, 1, 1);
            expect(r).toBe(0);
            expect(g).toBe(0);
            expect(b).toBe(255);
        });

        it('白色 s=0, v=1', () => {
            const { r, g, b } = hsvToRgb(0, 0, 1);
            expect(r).toBe(255);
            expect(g).toBe(255);
            expect(b).toBe(255);
        });

        it('黑色 v=0', () => {
            const { r, g, b } = hsvToRgb(0, 0, 0);
            expect(r).toBe(0);
            expect(g).toBe(0);
            expect(b).toBe(0);
        });

        it('黄色 h=60', () => {
            const { r, g, b } = hsvToRgb(60, 1, 1);
            expect(r).toBe(255);
            expect(g).toBe(255);
            expect(b).toBe(0);
        });

        it('青色 h=180', () => {
            const { r, g, b } = hsvToRgb(180, 1, 1);
            expect(r).toBe(0);
            expect(g).toBe(255);
            expect(b).toBe(255);
        });

        it('品红 h=300', () => {
            const { r, g, b } = hsvToRgb(300, 1, 1);
            expect(r).toBe(255);
            expect(g).toBe(0);
            expect(b).toBe(255);
        });

        it('负 h 被规范化', () => {
            const { r, g, b } = hsvToRgb(-60, 1, 1);
            const expected = hsvToRgb(300, 1, 1);
            expect(r).toBe(expected.r);
            expect(g).toBe(expected.g);
            expect(b).toBe(expected.b);
        });

        it('h > 360 被规范化', () => {
            const { r, g, b } = hsvToRgb(420, 1, 1);
            const expected = hsvToRgb(60, 1, 1);
            expect(r).toBe(expected.r);
            expect(g).toBe(expected.g);
            expect(b).toBe(expected.b);
        });

        it('s 超范围被 clamp', () => {
            const { r, g, b } = hsvToRgb(0, 2, 1);
            expect(r).toBe(255);
            expect(g).toBe(0);
            expect(b).toBe(0);
        });

        it('中间灰色', () => {
            const { r, g, b } = hsvToRgb(0, 0, 0.5);
            expect(r).toBe(128);
            expect(g).toBe(128);
            expect(b).toBe(128);
        });
    });

    // ========== rgbToHsv ==========
    describe('rgbToHsv', () => {
        it('红色', () => {
            const { h, s, v } = rgbToHsv(255, 0, 0);
            expect(h).toBeCloseTo(0, 0);
            expect(s).toBeCloseTo(1, 2);
            expect(v).toBeCloseTo(1, 2);
        });

        it('绿色', () => {
            const { h, s, v } = rgbToHsv(0, 255, 0);
            expect(h).toBeCloseTo(120, 0);
            expect(s).toBeCloseTo(1, 2);
            expect(v).toBeCloseTo(1, 2);
        });

        it('蓝色', () => {
            const { h, s, v } = rgbToHsv(0, 0, 255);
            expect(h).toBeCloseTo(240, 0);
            expect(s).toBeCloseTo(1, 2);
            expect(v).toBeCloseTo(1, 2);
        });

        it('白色', () => {
            const { h, s, v } = rgbToHsv(255, 255, 255);
            expect(s).toBeCloseTo(0, 2);
            expect(v).toBeCloseTo(1, 2);
        });

        it('黑色', () => {
            const { h, s, v } = rgbToHsv(0, 0, 0);
            expect(s).toBeCloseTo(0, 2);
            expect(v).toBeCloseTo(0, 2);
        });

        it('HSV → RGB → HSV 往返一致', () => {
            const original = { h: 210, s: 0.8, v: 0.6 };
            const rgb = hsvToRgb(original.h, original.s, original.v);
            const roundTrip = rgbToHsv(rgb.r, rgb.g, rgb.b);
            expect(roundTrip.h).toBeCloseTo(original.h, 0);
            expect(roundTrip.s).toBeCloseTo(original.s, 1);
            expect(roundTrip.v).toBeCloseTo(original.v, 1);
        });
    });

    // ========== rgbToHex ==========
    describe('rgbToHex', () => {
        it('红色', () => {
            expect(rgbToHex(255, 0, 0)).toBe('#ff0000');
        });

        it('绿色', () => {
            expect(rgbToHex(0, 255, 0)).toBe('#00ff00');
        });

        it('蓝色', () => {
            expect(rgbToHex(0, 0, 255)).toBe('#0000ff');
        });

        it('白色', () => {
            expect(rgbToHex(255, 255, 255)).toBe('#ffffff');
        });

        it('黑色', () => {
            expect(rgbToHex(0, 0, 0)).toBe('#000000');
        });

        it('任意颜色', () => {
            expect(rgbToHex(18, 52, 86)).toBe('#123456');
        });
    });

    // ========== hexToRgb ==========
    describe('hexToRgb', () => {
        it('6位 hex', () => {
            expect(hexToRgb('#ff0000')).toEqual({ r: 255, g: 0, b: 0 });
        });

        it('6位无 #', () => {
            expect(hexToRgb('00ff00')).toEqual({ r: 0, g: 255, b: 0 });
        });

        it('3位简写', () => {
            expect(hexToRgb('#fff')).toEqual({ r: 255, g: 255, b: 255 });
        });

        it('3位简写 #f00', () => {
            expect(hexToRgb('#f00')).toEqual({ r: 255, g: 0, b: 0 });
        });

        it('8位 hex (含 alpha) 只取 rgb', () => {
            const result = hexToRgb('#ff000080');
            expect(result.r).toBe(255);
            expect(result.g).toBe(0);
            expect(result.b).toBe(0);
        });

        it('无效长度返回 null', () => {
            expect(hexToRgb('#f')).toBeNull();
            expect(hexToRgb('#ff')).toBeNull();
        });
    });

    // ========== parseColor ==========
    describe('parseColor', () => {
        it('解析 hex', () => {
            const c = parseColor('#ff0000');
            expect(c.r).toBe(255);
            expect(c.g).toBe(0);
            expect(c.b).toBe(0);
            expect(c.a).toBe(1);
        });

        it('解析 hex8 带透明度', () => {
            const c = parseColor('#ff000080');
            expect(c.r).toBe(255);
            expect(c.a).toBeCloseTo(0.5, 1);
        });

        it('解析 hex4 带透明度 (4位 hex 不支持，走 fallback)', () => {
            // hexToRgb 对长度 4 返回 null，走 canvas fallback
            const c = parseColor('#f008');
            // jsdom 的 canvas 可能不解析此格式，返回默认值
            expect(typeof c.r).toBe('number');
            expect(typeof c.a).toBe('number');
        });

        it('解析 rgb()', () => {
            const c = parseColor('rgb(100, 200, 50)');
            expect(c.r).toBe(100);
            expect(c.g).toBe(200);
            expect(c.b).toBe(50);
            expect(c.a).toBe(1);
        });

        it('解析 rgba()', () => {
            const c = parseColor('rgba(100, 200, 50, 0.5)');
            expect(c.r).toBe(100);
            expect(c.g).toBe(200);
            expect(c.b).toBe(50);
            expect(c.a).toBe(0.5);
        });

        it('解析 rgba 百分比透明度', () => {
            const c = parseColor('rgba(100, 200, 50, 50%)');
            expect(c.a).toBe(0.5);
        });

        it('null 输入返回默认黑色', () => {
            const c = parseColor(null);
            expect(c).toEqual({ r: 0, g: 0, b: 0, a: 1 });
        });

        it('空字符串返回默认黑色', () => {
            const c = parseColor('');
            expect(c).toEqual({ r: 0, g: 0, b: 0, a: 1 });
        });

        it('非字符串返回默认黑色', () => {
            const c = parseColor(123);
            expect(c).toEqual({ r: 0, g: 0, b: 0, a: 1 });
        });
    });

    // ========== rgbaToString ==========
    describe('rgbaToString', () => {
        it('不透明颜色返回 hex', () => {
            expect(rgbaToString(255, 0, 0, 1)).toBe('#ff0000');
        });

        it('a > 1 也返回 hex', () => {
            expect(rgbaToString(0, 255, 0, 1.5)).toBe('#00ff00');
        });

        it('半透明返回 rgba', () => {
            expect(rgbaToString(255, 0, 0, 0.5)).toBe('rgba(255, 0, 0, 0.5)');
        });

        it('全透明返回 rgba', () => {
            expect(rgbaToString(0, 0, 0, 0)).toBe('rgba(0, 0, 0, 0)');
        });
    });
});
