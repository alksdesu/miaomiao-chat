/**
 * 鼠标控制模块
 * 使用 @nut-tree-fork/nut-js
 */

const { mouse, Button, Point, straightTo } = require('@nut-tree-fork/nut-js');

const BUTTONS = Object.freeze({
    left: Button.LEFT,
    right: Button.RIGHT,
    middle: Button.MIDDLE
});

// 未知按钮按左键处理；Button.LEFT 的枚举值是 0，不能用 || 回退
function toNutButton(button) {
    return BUTTONS[button] ?? Button.LEFT;
}

/**
 * 移动鼠标到指定位置
 * @param {number} x - X 坐标
 * @param {number} y - Y 坐标
 * @returns {Promise<{x: number, y: number}>}
 */
async function move(x, y) {
    try {
        // setPosition 只接受 Point，straightTo 返回的是路径 Promise
        await mouse.setPosition(new Point(x, y));
        console.log(`[Mouse] Moved to (${x}, ${y})`);
        return { x, y };
    } catch (error) {
        console.error('[Mouse] Move error:', error);
        throw error;
    }
}

/**
 * 鼠标点击
 * @param {string} button - 'left' | 'right' | 'middle'
 * @returns {Promise<void>}
 */
async function click(button = 'left') {
    try {
        await mouse.click(toNutButton(button));
        console.log(`[Mouse] Clicked ${button} button`);
    } catch (error) {
        console.error('[Mouse] Click error:', error);
        throw error;
    }
}

/**
 * 鼠标双击
 * @param {string} button - 'left' | 'right' | 'middle'
 */
async function doubleClick(button = 'left') {
    try {
        await mouse.doubleClick(toNutButton(button));
        console.log(`[Mouse] Double clicked ${button} button`);
    } catch (error) {
        console.error('[Mouse] Double click error:', error);
        throw error;
    }
}

/**
 * 鼠标三击
 * @param {string} button - 'left' | 'right' | 'middle'
 * @param {number} clickInterval - 点击间隔（毫秒），默认 50ms
 */
async function tripleClick(button = 'left', clickInterval = 50) {
    try {
        // nut.js 没有原生 tripleClick，使用三次点击模拟
        for (let i = 0; i < 3; i++) {
            await mouse.click(toNutButton(button));
            if (i < 2) {
                // 最后一次点击后不需要等待
                await new Promise((resolve) => setTimeout(resolve, clickInterval));
            }
        }

        console.log(`[Mouse] Triple clicked ${button} button with ${clickInterval}ms interval`);
    } catch (error) {
        console.error('[Mouse] Triple click error:', error);
        throw error;
    }
}

/**
 * 鼠标拖拽
 * @param {number} fromX - 起始 X 坐标
 * @param {number} fromY - 起始 Y 坐标
 * @param {number} toX - 目标 X 坐标
 * @param {number} toY - 目标 Y 坐标
 */
async function drag(fromX, fromY, toX, toY) {
    let pressed = false;
    try {
        await mouse.setPosition(new Point(fromX, fromY));
        await mouse.pressButton(Button.LEFT);
        pressed = true;
        // 沿路径移动到目标位置，拖放需要途中的移动事件
        await mouse.move(straightTo(new Point(toX, toY)));
        await mouse.releaseButton(Button.LEFT);
        pressed = false;

        console.log(`[Mouse] Dragged from (${fromX}, ${fromY}) to (${toX}, ${toY})`);
    } catch (error) {
        console.error('[Mouse] Drag error:', error);
        throw error;
    } finally {
        // 中途失败也要松开左键，否则系统里会一直按着
        if (pressed) {
            try {
                await mouse.releaseButton(Button.LEFT);
            } catch (releaseError) {
                console.error('[Mouse] Release button error:', releaseError);
            }
        }
    }
}

/**
 * 获取当前鼠标位置
 */
async function getPosition() {
    try {
        const position = await mouse.getPosition();
        return { x: position.x, y: position.y };
    } catch (error) {
        console.error('[Mouse] Get position error:', error);
        throw error;
    }
}

const SCROLL_METHODS = Object.freeze({
    up: 'scrollUp',
    down: 'scrollDown',
    left: 'scrollLeft',
    right: 'scrollRight'
});

/**
 * 鼠标滚轮
 * @param {number} amount - 滚动量；未给方向时正数向下、负数向上
 * @param {'up'|'down'|'left'|'right'} [direction] - 滚动方向，给出时 amount 取绝对值
 */
async function scroll(amount, direction) {
    try {
        if (direction) {
            const method = SCROLL_METHODS[direction];
            if (!method) {
                throw new Error(`Unsupported scroll direction: ${direction}`);
            }
            await mouse[method](Math.abs(amount));
            console.log(`[Mouse] Scrolled ${direction} ${Math.abs(amount)}`);
        } else if (amount > 0) {
            await mouse.scrollDown(amount);
            console.log(`[Mouse] Scrolled down ${amount}`);
        } else if (amount < 0) {
            await mouse.scrollUp(Math.abs(amount));
            console.log(`[Mouse] Scrolled up ${Math.abs(amount)}`);
        }
        // amount === 0 时不做任何操作
    } catch (error) {
        console.error('[Mouse] Scroll error:', error);
        throw error;
    }
}

/**
 * 按下鼠标按钮（不释放）
 * @param {string} button - 'left' | 'right' | 'middle'
 */
async function pressButton(button = 'left') {
    try {
        await mouse.pressButton(toNutButton(button));
        console.log(`[Mouse] Pressed ${button} button (held down)`);
    } catch (error) {
        console.error('[Mouse] Press button error:', error);
        throw error;
    }
}

/**
 * 释放鼠标按钮
 * @param {string} button - 'left' | 'right' | 'middle'
 */
async function releaseButton(button = 'left') {
    try {
        await mouse.releaseButton(toNutButton(button));
        console.log(`[Mouse] Released ${button} button`);
    } catch (error) {
        console.error('[Mouse] Release button error:', error);
        throw error;
    }
}

module.exports = {
    move,
    click,
    doubleClick,
    tripleClick,
    drag,
    getPosition,
    scroll,
    pressButton,
    releaseButton
};
