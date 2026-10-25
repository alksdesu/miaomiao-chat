/**
 * 截图尺寸与放大区域换算
 * computer 工具集的坐标位于返回截图的像素空间，渲染进程按这里给出的缩放比例换算回屏幕坐标
 */

// 同时满足各型号的图片上限：长边 1568 px、总像素约 1.15 MP
const MAX_LONG_EDGE = 1568;
const MAX_PIXELS = 1_150_000;

function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

/**
 * @param {{ width: number, height: number }} size 主显示器尺寸（DIP）
 * @returns {{ scaleFactor: number, width: number, height: number, originalWidth: number, originalHeight: number }}
 */
function computeScreenGeometry(size) {
    const longEdge = Math.max(size.width, size.height);
    const scaleFactor = Math.min(
        1,
        MAX_LONG_EDGE / longEdge,
        Math.sqrt(MAX_PIXELS / (size.width * size.height))
    );
    return {
        scaleFactor,
        width: Math.floor(size.width * scaleFactor),
        height: Math.floor(size.height * scaleFactor),
        originalWidth: size.width,
        originalHeight: size.height
    };
}

/**
 * 放大区域：区域钳制到屏幕内，按实际截图的像素密度裁剪，输出等比缩放到常规截图尺寸以内
 * @param {{ x1: number, y1: number, x2: number, y2: number }} region 屏幕坐标（DIP）
 * @param {{ width: number, height: number }} screenSize 主显示器尺寸（DIP）
 * @param {{ width: number, height: number }} imageSize 全屏截图的实际像素尺寸
 * @param {{ width: number, height: number }} box 常规截图尺寸
 * @returns {{ crop: { x: number, y: number, width: number, height: number }, output: { width: number, height: number } }}
 */
function computeZoomLayout(region, screenSize, imageSize, box) {
    const left = clamp(Math.min(region.x1, region.x2), 0, screenSize.width);
    const right = clamp(Math.max(region.x1, region.x2), 0, screenSize.width);
    const top = clamp(Math.min(region.y1, region.y2), 0, screenSize.height);
    const bottom = clamp(Math.max(region.y1, region.y2), 0, screenSize.height);
    if (right - left < 1 || bottom - top < 1) {
        throw new Error('Invalid region: width and height must be positive');
    }

    const ratio = imageSize.width / screenSize.width;
    const x = clamp(Math.round(left * ratio), 0, imageSize.width - 1);
    const y = clamp(Math.round(top * ratio), 0, imageSize.height - 1);
    const width = clamp(Math.round((right - left) * ratio), 1, imageSize.width - x);
    const height = clamp(Math.round((bottom - top) * ratio), 1, imageSize.height - y);

    const fit = Math.min(box.width / width, box.height / height);
    return {
        crop: { x, y, width, height },
        output: {
            width: Math.max(1, Math.round(width * fit)),
            height: Math.max(1, Math.round(height * fit))
        }
    };
}

/**
 * 主显示器内的坐标（DIP）与输入库的全局坐标互换：Windows、Linux 上输入库按物理像素定位，macOS 按 DIP
 * @param {string} platform process.platform
 * @param {{ scaleFactor?: number, bounds?: { x: number, y: number } }} display 主显示器
 * @returns {{ toNative: Function, toDip: Function }}
 */
function createInputSpace(platform, display) {
    const ratio = platform === 'darwin' || !(display?.scaleFactor > 0) ? 1 : display.scaleFactor;
    const originX = display?.bounds?.x || 0;
    const originY = display?.bounds?.y || 0;
    return {
        toNative: ({ x, y }) => ({
            x: Math.round((originX + x) * ratio),
            y: Math.round((originY + y) * ratio)
        }),
        toDip: ({ x, y }) => ({
            x: Math.round(x / ratio - originX),
            y: Math.round(y / ratio - originY)
        })
    };
}

module.exports = {
    computeScreenGeometry,
    computeZoomLayout,
    createInputSpace
};
