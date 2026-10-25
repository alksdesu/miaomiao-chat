/**
 * 截图功能模块
 * 使用 Electron 的 desktopCapturer API
 */

const { desktopCapturer, screen } = require('electron');
const { computeScreenGeometry, computeZoomLayout } = require('./geometry');

/**
 * 主显示器截图的缩放比例与输出尺寸（不截图）
 * @returns {{ scaleFactor: number, width: number, height: number, originalWidth: number, originalHeight: number }}
 */
function getGeometry() {
    return computeScreenGeometry(screen.getPrimaryDisplay().size);
}

async function capturePrimaryScreen(thumbnailSize) {
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize });
    // 多显示器时来源顺序不固定，按 display_id 取主显示器
    const primaryId = String(screen.getPrimaryDisplay().id);
    const source = sources.find((item) => item.display_id === primaryId) || sources[0];
    if (!source) {
        throw new Error('No screen sources available');
    }
    if (source.thumbnail.isEmpty()) {
        throw new Error('Screen capture returned an empty image');
    }
    return source.thumbnail;
}

/**
 * 捕获屏幕截图
 * @returns {Promise<{base64: string, width: number, height: number, scaleFactor: number, originalWidth: number, originalHeight: number}>}
 */
async function capture() {
    try {
        const geometry = getGeometry();
        console.log(
            `[Screenshot] Original: ${geometry.originalWidth}x${geometry.originalHeight}, Scaled: ${geometry.width}x${geometry.height}, Factor: ${geometry.scaleFactor.toFixed(3)}`
        );

        const thumbnail = await capturePrimaryScreen({
            width: geometry.width,
            height: geometry.height
        });
        // 缩略图按宽高比贴合请求尺寸，可能差 1 px；对齐后截图像素与坐标换算用的尺寸一致
        const { width, height } = thumbnail.getSize();
        const image =
            width === geometry.width && height === geometry.height
                ? thumbnail
                : thumbnail.resize({
                      width: geometry.width,
                      height: geometry.height,
                      quality: 'best'
                  });
        const base64 = image.toDataURL().split(',')[1];

        return {
            base64,
            width: geometry.width,
            height: geometry.height,
            scaleFactor: geometry.scaleFactor, // 返回缩放因子用于坐标转换
            originalWidth: geometry.originalWidth,
            originalHeight: geometry.originalHeight,
            format: 'png'
        };
    } catch (error) {
        console.error('[Screenshot] Error:', error);
        throw error;
    }
}

/**
 * 捕获屏幕指定区域，按原始像素密度裁剪后等比缩放到常规截图尺寸以内
 * @param {number} x1 - 起始 X 坐标
 * @param {number} y1 - 起始 Y 坐标
 * @param {number} x2 - 结束 X 坐标
 * @param {number} y2 - 结束 Y 坐标
 * @returns {Promise<{base64: string, width: number, height: number, region: {x1, y1, x2, y2}}>}
 */
async function captureRegion(x1, y1, x2, y2) {
    try {
        const display = screen.getPrimaryDisplay();
        const pixelRatio = display.scaleFactor || 1;
        const thumbnail = await capturePrimaryScreen({
            width: Math.round(display.size.width * pixelRatio),
            height: Math.round(display.size.height * pixelRatio)
        });

        const layout = computeZoomLayout(
            { x1, y1, x2, y2 },
            display.size,
            thumbnail.getSize(),
            getGeometry()
        );
        const resizedImage = thumbnail.crop(layout.crop).resize({
            width: layout.output.width,
            height: layout.output.height,
            quality: 'best'
        });
        const base64 = resizedImage.toDataURL().split(',')[1];

        console.log(
            `[Screenshot] Zoomed region (${x1},${y1},${x2},${y2}) to ${layout.output.width}x${layout.output.height}`
        );

        return {
            base64,
            width: layout.output.width,
            height: layout.output.height,
            region: {
                x1: Math.min(x1, x2),
                y1: Math.min(y1, y2),
                x2: Math.max(x1, x2),
                y2: Math.max(y1, y2)
            },
            format: 'png'
        };
    } catch (error) {
        console.error('[Screenshot] Zoom error:', error);
        throw error;
    }
}

module.exports = {
    capture,
    captureRegion,
    getGeometry
};
