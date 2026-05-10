/**
 * 截图功能模块
 * 使用 Electron 的 desktopCapturer API
 */

const { desktopCapturer, screen } = require('electron');

/**
 * 捕获屏幕截图
 * @returns {Promise<{base64: string, width: number, height: number, scaleFactor: number, originalWidth: number, originalHeight: number}>}
 */
async function capture() {
    try {
        const primaryDisplay = screen.getPrimaryDisplay();
        const { width: originalWidth, height: originalHeight } = primaryDisplay.size;

        // Claude API 限制
        const MAX_LONG_EDGE = 1568;
        const MAX_PIXELS = 1_150_000;

        // 计算缩放因子
        const longEdge = Math.max(originalWidth, originalHeight);
        const totalPixels = originalWidth * originalHeight;

        const scaleFactor = Math.min(
            1.0,
            MAX_LONG_EDGE / longEdge,
            Math.sqrt(MAX_PIXELS / totalPixels)
        );

        // 计算缩放后的尺寸
        const scaledWidth = Math.floor(originalWidth * scaleFactor);
        const scaledHeight = Math.floor(originalHeight * scaleFactor);

        console.log(`[Screenshot] Original: ${originalWidth}x${originalHeight}, Scaled: ${scaledWidth}x${scaledHeight}, Factor: ${scaleFactor.toFixed(3)}`);

        // 使用 desktopCapturer 获取屏幕源（使用缩放后的尺寸）
        const sources = await desktopCapturer.getSources({
            types: ['screen'],
            thumbnailSize: { width: scaledWidth, height: scaledHeight }
        });

        if (sources.length === 0) {
            throw new Error('No screen sources available');
        }

        // 获取主屏幕的截图
        const primarySource = sources[0];
        const thumbnail = primarySource.thumbnail;

        // 转换为 base64
        const base64 = thumbnail.toDataURL().split(',')[1];

        return {
            base64,
            width: thumbnail.getSize().width,
            height: thumbnail.getSize().height,
            scaleFactor,  // 返回缩放因子用于坐标转换
            originalWidth,
            originalHeight,
            format: 'png'
        };
    } catch (error) {
        console.error('[Screenshot] Error:', error);
        throw error;
    }
}

/**
 * 捕获屏幕指定区域并放大
 * @param {number} x1 - 起始 X 坐标
 * @param {number} y1 - 起始 Y 坐标
 * @param {number} x2 - 结束 X 坐标
 * @param {number} y2 - 结束 Y 坐标
 * @returns {Promise<{base64: string, width: number, height: number, region: {x1, y1, x2, y2}}>}
 */
async function captureRegion(x1, y1, x2, y2) {
    try {
        // 确保坐标顺序正确
        const left = Math.min(x1, x2);
        const top = Math.min(y1, y2);
        const right = Math.max(x1, x2);
        const bottom = Math.max(y1, y2);

        const regionWidth = right - left;
        const regionHeight = bottom - top;

        if (regionWidth <= 0 || regionHeight <= 0) {
            throw new Error('Invalid region: width and height must be positive');
        }

        const primaryDisplay = screen.getPrimaryDisplay();
        const { width: screenWidth, height: screenHeight } = primaryDisplay.size;

        // 获取全屏截图
        const sources = await desktopCapturer.getSources({
            types: ['screen'],
            thumbnailSize: { width: screenWidth, height: screenHeight }
        });

        if (sources.length === 0) {
            throw new Error('No screen sources available');
        }

        const primarySource = sources[0];
        const fullScreenshot = primarySource.thumbnail;

        // 裁剪指定区域
        const croppedImage = fullScreenshot.crop({
            x: left,
            y: top,
            width: regionWidth,
            height: regionHeight
        });

        // 放大到合适的大小（全分辨率）
        const MAX_LONG_EDGE = 1568;
        const longEdge = Math.max(regionWidth, regionHeight);
        const scaleFactor = Math.min(MAX_LONG_EDGE / longEdge, 1.0);

        const zoomedWidth = Math.floor(regionWidth * scaleFactor);
        const zoomedHeight = Math.floor(regionHeight * scaleFactor);

        const resizedImage = croppedImage.resize({
            width: zoomedWidth,
            height: zoomedHeight,
            quality: 'best'
        });

        // 转换为 base64
        const base64 = resizedImage.toDataURL().split(',')[1];

        console.log(`[Screenshot] Zoomed region (${left},${top},${right},${bottom}) to ${zoomedWidth}x${zoomedHeight}`);

        return {
            base64,
            width: zoomedWidth,
            height: zoomedHeight,
            region: { x1: left, y1: top, x2: right, y2: bottom },
            format: 'png'
        };
    } catch (error) {
        console.error('[Screenshot] Zoom error:', error);
        throw error;
    }
}

module.exports = {
    capture,
    captureRegion
};
