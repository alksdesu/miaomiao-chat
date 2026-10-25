import { describe, expect, it } from 'vitest';
import geometry from '../../electron/computer-use/geometry.js';

const { computeScreenGeometry, computeZoomLayout, createInputSpace } = geometry;

describe('computeScreenGeometry', () => {
    it('1080p 按 1.15 MP 上限等比缩小', () => {
        const result = computeScreenGeometry({ width: 1920, height: 1080 });

        expect(result.scaleFactor).toBeCloseTo(0.7447, 4);
        expect(result).toMatchObject({
            width: 1429,
            height: 804,
            originalWidth: 1920,
            originalHeight: 1080
        });
        expect(result.width * result.height).toBeLessThanOrEqual(1_150_000);
    });

    it('超宽屏按 1568 px 长边上限缩小', () => {
        const result = computeScreenGeometry({ width: 3440, height: 480 });

        expect(result.width).toBe(1568);
        expect(result.scaleFactor).toBeCloseTo(1568 / 3440, 6);
    });

    it('小屏幕不放大', () => {
        expect(computeScreenGeometry({ width: 1280, height: 720 })).toEqual({
            scaleFactor: 1,
            width: 1280,
            height: 720,
            originalWidth: 1280,
            originalHeight: 720
        });
    });
});

describe('computeZoomLayout', () => {
    const screen = { width: 1920, height: 1080 };
    const box = { width: 1429, height: 804 };

    it('按截图实际像素密度裁剪，输出等比放大到常规截图尺寸以内', () => {
        const layout = computeZoomLayout(
            { x1: 100, y1: 100, x2: 500, y2: 400 },
            screen,
            { width: 3840, height: 2160 },
            box
        );

        expect(layout.crop).toEqual({ x: 200, y: 200, width: 800, height: 600 });
        expect(layout.output).toEqual({ width: 1072, height: 804 });
    });

    it('起止点顺序颠倒时结果相同', () => {
        const image = { width: 1920, height: 1080 };
        expect(
            computeZoomLayout({ x1: 500, y1: 400, x2: 100, y2: 100 }, screen, image, box)
        ).toEqual(computeZoomLayout({ x1: 100, y1: 100, x2: 500, y2: 400 }, screen, image, box));
    });

    it('超出屏幕的部分钳制到屏幕边缘', () => {
        const layout = computeZoomLayout(
            { x1: 1800, y1: 1000, x2: 2500, y2: 1500 },
            screen,
            { width: 1920, height: 1080 },
            box
        );

        expect(layout.crop).toEqual({ x: 1800, y: 1000, width: 120, height: 80 });
        expect(layout.output).toEqual({ width: 1206, height: 804 });
    });

    it('宽或高为零、或整块落在屏幕外时报错', () => {
        const image = { width: 1920, height: 1080 };
        expect(() =>
            computeZoomLayout({ x1: 100, y1: 100, x2: 100, y2: 300 }, screen, image, box)
        ).toThrow('Invalid region');
        expect(() =>
            computeZoomLayout({ x1: 2000, y1: 0, x2: 2100, y2: 100 }, screen, image, box)
        ).toThrow('Invalid region');
    });
});

describe('createInputSpace', () => {
    const primary = (scaleFactor, x = 0, y = 0) => ({ scaleFactor, bounds: { x, y } });

    it('Windows 与 Linux 按缩放比例换算到物理像素', () => {
        for (const platform of ['win32', 'linux']) {
            const space = createInputSpace(platform, primary(1.25));
            expect(space.toNative({ x: 1536, y: 864 })).toEqual({ x: 1920, y: 1080 });
            expect(space.toDip({ x: 1920, y: 1080 })).toEqual({ x: 1536, y: 864 });
        }
    });

    it('macOS 输入库按 DIP 定位，不换算', () => {
        const space = createInputSpace('darwin', primary(2));
        expect(space.toNative({ x: 100, y: 50 })).toEqual({ x: 100, y: 50 });
        expect(space.toDip({ x: 100, y: 50 })).toEqual({ x: 100, y: 50 });
    });

    it('主显示器不在原点时加上它的偏移', () => {
        const space = createInputSpace('linux', primary(2, 1280, 0));
        expect(space.toNative({ x: 10, y: 20 })).toEqual({ x: 2580, y: 40 });
        expect(space.toDip({ x: 2580, y: 40 })).toEqual({ x: 10, y: 20 });
    });

    it('缩放比例缺失或无效时不换算', () => {
        expect(createInputSpace('win32', {}).toNative({ x: 10, y: 20 })).toEqual({ x: 10, y: 20 });
        expect(createInputSpace('win32', primary(0)).toDip({ x: 10, y: 20 })).toEqual({
            x: 10,
            y: 20
        });
        expect(createInputSpace('win32', undefined).toNative({ x: 3, y: 4 })).toEqual({
            x: 3,
            y: 4
        });
    });
});
