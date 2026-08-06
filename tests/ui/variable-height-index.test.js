import { describe, expect, it } from 'vitest';
import { VariableHeightIndex } from '../../js/ui/variable-height-index.js';

describe('VariableHeightIndex', () => {
    it('维护前缀高度并按偏移定位消息', () => {
        const index = new VariableHeightIndex(4, 100);
        expect(index.getTotalHeight()).toBe(400);
        expect(index.findIndexAtOffset(0)).toBe(0);
        expect(index.findIndexAtOffset(199)).toBe(1);

        expect(index.setHeight(1, 250)).toBe(150);
        expect(index.prefixSum(2)).toBe(350);
        expect(index.rangeSum(1, 3)).toBe(350);
        expect(index.findIndexAtOffset(349)).toBe(1);
        expect(index.findIndexAtOffset(350)).toBe(2);
        expect(index.getMeasuredCount()).toBe(1);
    });

    it('接受历史实测高度作为初值', () => {
        const index = new VariableHeightIndex();
        index.reset(3, [80, 0, 240]);
        expect(index.getHeight(0)).toBe(80);
        expect(index.getHeight(1)).toBe(160);
        expect(index.getHeight(2)).toBe(240);
    });
});
