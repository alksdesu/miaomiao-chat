import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Button, Point } = require('@nut-tree-fork/shared');

const nutMouse = {
    setPosition: vi.fn(async () => {}),
    move: vi.fn(async () => {}),
    click: vi.fn(async () => {}),
    doubleClick: vi.fn(async () => {}),
    pressButton: vi.fn(async () => {}),
    releaseButton: vi.fn(async () => {}),
    getPosition: vi.fn(async () => new Point(10, 20)),
    scrollUp: vi.fn(async () => {}),
    scrollDown: vi.fn(async () => {}),
    scrollLeft: vi.fn(async () => {}),
    scrollRight: vi.fn(async () => {})
};
const straightTo = vi.fn((target) => Promise.resolve([target]));

// mouse.js 以 CommonJS 加载 nut-js，先占住模块缓存，避免加载原生输入库
const nutPath = require.resolve('@nut-tree-fork/nut-js');
const mousePath = require.resolve('../../electron/computer-use/mouse.js');
const originalNut = require.cache[nutPath];
require.cache[nutPath] = {
    id: nutPath,
    filename: nutPath,
    loaded: true,
    exports: { mouse: nutMouse, Button, Point, straightTo }
};
const mouse = require(mousePath);

afterAll(() => {
    delete require.cache[mousePath];
    if (originalNut) {
        require.cache[nutPath] = originalNut;
    } else {
        delete require.cache[nutPath];
    }
});

beforeEach(() => {
    vi.clearAllMocks();
    nutMouse.move.mockImplementation(async () => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('mouse.move', () => {
    it('直接定位到 Point，而不是把路径 Promise 交给 setPosition', async () => {
        await mouse.move(30, 40);

        const [target] = nutMouse.setPosition.mock.calls[0];
        expect(target).toBeInstanceOf(Point);
        expect(target).toMatchObject({ x: 30, y: 40 });
    });
});

describe('mouse.drag', () => {
    it('定位起点 → 按下 → 沿路径移动 → 松开', async () => {
        await mouse.drag(1, 2, 300, 400);

        expect(nutMouse.setPosition).toHaveBeenCalledWith(expect.objectContaining({ x: 1, y: 2 }));
        expect(straightTo).toHaveBeenCalledWith(expect.objectContaining({ x: 300, y: 400 }));
        expect(nutMouse.move).toHaveBeenCalledWith(straightTo.mock.results[0].value);
        expect(nutMouse.pressButton).toHaveBeenCalledWith(Button.LEFT);
        expect(nutMouse.releaseButton).toHaveBeenCalledTimes(1);
        const order = (fn) => fn.mock.invocationCallOrder[0];
        expect(order(nutMouse.setPosition)).toBeLessThan(order(nutMouse.pressButton));
        expect(order(nutMouse.pressButton)).toBeLessThan(order(nutMouse.move));
        expect(order(nutMouse.move)).toBeLessThan(order(nutMouse.releaseButton));
    });

    it('移动途中失败时仍松开左键', async () => {
        nutMouse.move.mockImplementationOnce(async () => {
            throw new Error('input blocked');
        });

        await expect(mouse.drag(1, 2, 3, 4)).rejects.toThrow('input blocked');
        expect(nutMouse.releaseButton).toHaveBeenCalledTimes(1);
        expect(nutMouse.releaseButton).toHaveBeenCalledWith(Button.LEFT);
    });

    it('按下之前失败时不发送松开', async () => {
        nutMouse.setPosition.mockImplementationOnce(async () => {
            throw new Error('no display');
        });

        await expect(mouse.drag(1, 2, 3, 4)).rejects.toThrow('no display');
        expect(nutMouse.pressButton).not.toHaveBeenCalled();
        expect(nutMouse.releaseButton).not.toHaveBeenCalled();
    });
});

describe('mouse.scroll', () => {
    it.each([
        ['up', 'scrollUp'],
        ['down', 'scrollDown'],
        ['left', 'scrollLeft'],
        ['right', 'scrollRight']
    ])('%s 方向调用 %s', async (direction, method) => {
        await mouse.scroll(3, direction);
        expect(nutMouse[method]).toHaveBeenCalledWith(3);
    });

    it('未给方向时按正负号上下滚动', async () => {
        await mouse.scroll(-2);
        await mouse.scroll(4);
        expect(nutMouse.scrollUp).toHaveBeenCalledWith(2);
        expect(nutMouse.scrollDown).toHaveBeenCalledWith(4);
    });

    it('不支持的方向报错', async () => {
        await expect(mouse.scroll(1, 'sideways')).rejects.toThrow('Unsupported scroll direction');
    });
});

describe('鼠标按钮', () => {
    it.each([
        ['left', Button.LEFT],
        ['right', Button.RIGHT],
        ['middle', Button.MIDDLE],
        ['unknown', Button.LEFT]
    ])('%s', async (name, expected) => {
        await mouse.click(name);
        await mouse.pressButton(name);
        await mouse.releaseButton(name);

        expect(nutMouse.click).toHaveBeenCalledWith(expected);
        expect(nutMouse.pressButton).toHaveBeenCalledWith(expected);
        expect(nutMouse.releaseButton).toHaveBeenCalledWith(expected);
    });
});
