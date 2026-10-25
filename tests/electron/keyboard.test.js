import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Key } = require('@nut-tree-fork/shared');

const nutKeyboard = {
    type: vi.fn(async () => {}),
    pressKey: vi.fn(async () => {}),
    releaseKey: vi.fn(async () => {})
};

// keyboard.js 以 CommonJS 加载 nut-js，先占住模块缓存，避免加载原生输入库
const nutPath = require.resolve('@nut-tree-fork/nut-js');
const keyboardPath = require.resolve('../../electron/computer-use/keyboard.js');
const originalNut = require.cache[nutPath];
require.cache[nutPath] = {
    id: nutPath,
    filename: nutPath,
    loaded: true,
    exports: { keyboard: nutKeyboard, Key }
};
const keyboard = require(keyboardPath);

afterAll(() => {
    delete require.cache[keyboardPath];
    if (originalNut) {
        require.cache[nutPath] = originalNut;
    } else {
        delete require.cache[nutPath];
    }
});

beforeEach(() => {
    vi.clearAllMocks();
    nutKeyboard.pressKey.mockImplementation(async () => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('keyboard.press', () => {
    it('Escape 按下对应按键，而不是输入单词', async () => {
        await keyboard.press('Escape');

        expect(nutKeyboard.pressKey).toHaveBeenCalledWith(Key.Escape);
        expect(nutKeyboard.releaseKey).toHaveBeenCalledWith(Key.Escape);
        expect(nutKeyboard.type).not.toHaveBeenCalled();
    });

    it('组合键里的字母发按键事件，修饰键逆序松开', async () => {
        await keyboard.press('s', ['ctrl', 'shift']);

        expect(nutKeyboard.pressKey.mock.calls).toEqual([
            [Key.LeftControl],
            [Key.LeftShift],
            [Key.S]
        ]);
        expect(nutKeyboard.releaseKey.mock.calls).toEqual([
            [Key.S],
            [Key.LeftShift],
            [Key.LeftControl]
        ]);
        expect(nutKeyboard.type).not.toHaveBeenCalled();
    });

    it.each([
        ['+', Key.Add],
        ['-', Key.Minus],
        ['5', Key.Num5]
    ])('组合键里的 %s 映射到物理按键', async (char, expected) => {
        await keyboard.press(char, ['ctrl']);
        expect(nutKeyboard.pressKey).toHaveBeenLastCalledWith(expected);
    });

    it('没有修饰键的普通字符直接输入', async () => {
        await keyboard.press('a');

        expect(nutKeyboard.type).toHaveBeenCalledWith('a');
        expect(nutKeyboard.pressKey).not.toHaveBeenCalled();
    });

    it('修饰键或主键不认识时报错，且一个键都不按', async () => {
        await expect(keyboard.press('s', ['hyper'])).rejects.toThrow('Unsupported key: hyper');
        await expect(keyboard.press('launch', ['ctrl'])).rejects.toThrow('Unsupported key: launch');
        expect(nutKeyboard.pressKey).not.toHaveBeenCalled();
    });

    it('按主键失败时仍松开已按住的修饰键', async () => {
        nutKeyboard.pressKey
            .mockImplementationOnce(async () => {})
            .mockImplementationOnce(async () => {
                throw new Error('input blocked');
            });

        await expect(keyboard.press('s', ['ctrl'])).rejects.toThrow('input blocked');
        expect(nutKeyboard.releaseKey).toHaveBeenCalledWith(Key.LeftControl);
    });
});

describe('keyboard.pressDown / release', () => {
    it.each([
        ['shift', Key.LeftShift],
        ['Page_Down', Key.PageDown],
        ['a', Key.A],
        ['7', Key.Num7],
        [';', Key.Semicolon],
        ['escape', Key.Escape]
    ])('%s', async (name, expected) => {
        await keyboard.pressDown(name);
        await keyboard.release(name);

        expect(nutKeyboard.pressKey).toHaveBeenCalledWith(expected);
        expect(nutKeyboard.releaseKey).toHaveBeenCalledWith(expected);
    });

    it('super 按平台映射到 Command / Windows / Super 键', async () => {
        await keyboard.pressDown('super');

        const expected =
            process.platform === 'darwin'
                ? Key.LeftCmd
                : process.platform === 'win32'
                  ? Key.LeftWin
                  : Key.LeftSuper;
        expect(nutKeyboard.pressKey).toHaveBeenCalledWith(expected);
    });

    it('不认识的键报错', async () => {
        await expect(keyboard.pressDown('hyper')).rejects.toThrow('Unsupported key: hyper');
        expect(nutKeyboard.pressKey).not.toHaveBeenCalled();
    });
});
