/**
 * unit-converter.js 测试
 */
import { describe, it, expect } from 'vitest';

import {
    unitConverterHandler,
    getSupportedUnits,
    getSupportedCategories
} from '../../../js/tools/builtin/unit-converter.js';

// ========== unitConverterHandler ==========

describe('unitConverterHandler', () => {
    // length
    it('米转英尺', async () => {
        const result = await unitConverterHandler({
            category: 'length',
            value: 1,
            from: 'meter',
            to: 'foot'
        });
        expect(result.output.value).toBeCloseTo(3.28084, 3);
    });

    it('千米转英里', async () => {
        const result = await unitConverterHandler({
            category: 'length',
            value: 1,
            from: 'kilometer',
            to: 'mile'
        });
        expect(result.output.value).toBeCloseTo(0.621371, 3);
    });

    it('英寸转厘米', async () => {
        const result = await unitConverterHandler({
            category: 'length',
            value: 1,
            from: 'inch',
            to: 'centimeter'
        });
        expect(result.output.value).toBeCloseTo(2.54, 2);
    });

    // weight
    it('千克转磅', async () => {
        const result = await unitConverterHandler({
            category: 'weight',
            value: 1,
            from: 'kilogram',
            to: 'pound'
        });
        expect(result.output.value).toBeCloseTo(2.20462, 3);
    });

    it('克转毫克', async () => {
        const result = await unitConverterHandler({
            category: 'weight',
            value: 1,
            from: 'gram',
            to: 'milligram'
        });
        expect(result.output.value).toBeCloseTo(1000, 0);
    });

    // temperature
    it('摄氏转华氏', async () => {
        const result = await unitConverterHandler({
            category: 'temperature',
            value: 100,
            from: 'celsius',
            to: 'fahrenheit'
        });
        expect(result.output.value).toBeCloseTo(212, 0);
    });

    it('华氏转摄氏', async () => {
        const result = await unitConverterHandler({
            category: 'temperature',
            value: 32,
            from: 'fahrenheit',
            to: 'celsius'
        });
        expect(result.output.value).toBeCloseTo(0, 1);
    });

    it('摄氏转开尔文', async () => {
        const result = await unitConverterHandler({
            category: 'temperature',
            value: 0,
            from: 'celsius',
            to: 'kelvin'
        });
        expect(result.output.value).toBeCloseTo(273.15, 1);
    });

    it('开尔文转摄氏', async () => {
        const result = await unitConverterHandler({
            category: 'temperature',
            value: 273.15,
            from: 'kelvin',
            to: 'celsius'
        });
        expect(result.output.value).toBeCloseTo(0, 1);
    });

    it('未知温度单位抛异常', async () => {
        await expect(
            unitConverterHandler({
                category: 'temperature',
                value: 0,
                from: 'unknown',
                to: 'celsius'
            })
        ).rejects.toThrow('不支持的温度单位');
        await expect(
            unitConverterHandler({
                category: 'temperature',
                value: 0,
                from: 'celsius',
                to: 'unknown'
            })
        ).rejects.toThrow('不支持的温度单位');
    });

    // area
    it('平方米转平方英尺', async () => {
        const result = await unitConverterHandler({
            category: 'area',
            value: 1,
            from: 'square_meter',
            to: 'square_foot'
        });
        expect(result.output.value).toBeCloseTo(10.7639, 2);
    });

    // volume
    it('升转加仑', async () => {
        const result = await unitConverterHandler({
            category: 'volume',
            value: 1,
            from: 'liter',
            to: 'gallon'
        });
        expect(result.output.value).toBeCloseTo(0.264172, 3);
    });

    // speed
    it('千米每小时转英里每小时', async () => {
        const result = await unitConverterHandler({
            category: 'speed',
            value: 100,
            from: 'kilometer_per_hour',
            to: 'mile_per_hour'
        });
        expect(result.output.value).toBeCloseTo(62.1371, 2);
    });

    // time
    it('小时转分钟', async () => {
        const result = await unitConverterHandler({
            category: 'time',
            value: 1,
            from: 'hour',
            to: 'minute'
        });
        expect(result.output.value).toBeCloseTo(60, 0);
    });

    // errors
    it('未知类别', async () => {
        await expect(
            unitConverterHandler({ category: 'unknown', value: 1, from: 'a', to: 'b' })
        ).rejects.toThrow('不支持的转换类别');
    });

    it('未知源单位', async () => {
        await expect(
            unitConverterHandler({ category: 'length', value: 1, from: 'unknown', to: 'meter' })
        ).rejects.toThrow('不支持的源单位');
    });

    it('未知目标单位', async () => {
        await expect(
            unitConverterHandler({ category: 'length', value: 1, from: 'meter', to: 'unknown' })
        ).rejects.toThrow('不支持的目标单位');
    });

    // formatted output
    it('结果包含 formatted', async () => {
        const result = await unitConverterHandler({
            category: 'length',
            value: 1,
            from: 'meter',
            to: 'foot'
        });
        expect(result.formatted).toContain('meter');
        expect(result.formatted).toContain('foot');
    });
});

// ========== getSupportedUnits ==========

describe('getSupportedUnits', () => {
    it('返回长度单位', () => {
        const units = getSupportedUnits('length');
        expect(units).toContain('meter');
        expect(units).toContain('kilometer');
    });

    it('未知类别返回空', () => {
        expect(getSupportedUnits('unknown')).toEqual([]);
    });
});

// ========== getSupportedCategories ==========

describe('getSupportedCategories', () => {
    it('包含所有类别', () => {
        const cats = getSupportedCategories();
        expect(cats).toContain('length');
        expect(cats).toContain('weight');
        expect(cats).toContain('temperature');
        expect(cats).toContain('area');
        expect(cats).toContain('volume');
        expect(cats).toContain('speed');
        expect(cats).toContain('time');
    });
});
