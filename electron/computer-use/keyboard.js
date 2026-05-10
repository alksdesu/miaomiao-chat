/**
 * 键盘控制模块
 * 使用 @nut-tree-fork/nut-js
 */

const { keyboard, Key } = require('@nut-tree-fork/nut-js');

// 按键映射表
const KEY_MAP = {
    // 修饰键
    'ctrl': Key.LeftControl,
    'alt': Key.LeftAlt,
    'shift': Key.LeftShift,
    'cmd': Key.LeftCmd,
    'meta': Key.LeftCmd,
    'win': Key.LeftWin,

    // 功能键
    'enter': Key.Enter,
    'return': Key.Enter,
    'tab': Key.Tab,
    'backspace': Key.Backspace,
    'delete': Key.Delete,
    'escape': Key.Escape,
    'esc': Key.Escape,
    'space': Key.Space,

    // 方向键
    'up': Key.Up,
    'down': Key.Down,
    'left': Key.Left,
    'right': Key.Right,

    // Home/End/PageUp/PageDown
    'home': Key.Home,
    'end': Key.End,
    'pageup': Key.PageUp,
    'pagedown': Key.PageDown,

    // F1-F12
    'f1': Key.F1,
    'f2': Key.F2,
    'f3': Key.F3,
    'f4': Key.F4,
    'f5': Key.F5,
    'f6': Key.F6,
    'f7': Key.F7,
    'f8': Key.F8,
    'f9': Key.F9,
    'f10': Key.F10,
    'f11': Key.F11,
    'f12': Key.F12,
};

/**
 * 将字符串按键转换为 nut.js Key 对象
 */
function parseKey(keyString) {
    const lower = keyString.toLowerCase();
    return KEY_MAP[lower] || keyString; // 如果不在映射表中，直接返回字符串（nut.js 会自动处理）
}

/**
 * 输入文本
 * @param {string} text - 要输入的文本
 */
async function type(text) {
    try {
        await keyboard.type(text);
        console.log(`[Keyboard] Typed: ${text.substring(0, 50)}${text.length > 50 ? '...' : ''}`);
    } catch (error) {
        console.error('[Keyboard] Type error:', error);
        throw error;
    }
}

/**
 * 按下按键
 * @param {string} key - 按键名称
 * @param {string[]} modifiers - 修饰键数组 ['ctrl', 'shift']
 */
async function press(key, modifiers = []) {
    try {
        const parsedKey = parseKey(key);
        const parsedModifiers = modifiers.map(parseKey);

        // 判断 parsedKey 是否为 Key 对象（特殊键）
        const isSpecialKey = typeof parsedKey === 'object' || KEY_MAP[key.toLowerCase()];

        if (parsedModifiers.length > 0) {
            // 按住修饰键
            for (const mod of parsedModifiers) {
                await keyboard.pressKey(mod);
            }

            // 按下主键
            if (isSpecialKey) {
                // 特殊键：使用 pressKey + releaseKey
                await keyboard.pressKey(parsedKey);
                await keyboard.releaseKey(parsedKey);
            } else {
                // 普通字符：使用 type
                await keyboard.type(parsedKey);
            }

            // 释放修饰键
            for (const mod of parsedModifiers.reverse()) {
                await keyboard.releaseKey(mod);
            }

            console.log(`[Keyboard] Pressed: ${modifiers.join('+')}+${key}`);
        } else {
            // 无修饰键
            if (isSpecialKey) {
                // 特殊键：使用 pressKey + releaseKey
                await keyboard.pressKey(parsedKey);
                await keyboard.releaseKey(parsedKey);
            } else {
                // 普通字符：使用 type
                await keyboard.type(parsedKey);
            }
            console.log(`[Keyboard] Pressed: ${key}`);
        }
    } catch (error) {
        console.error('[Keyboard] Press error:', error);
        throw error;
    }
}

/**
 * 按住按键
 * @param {string} key - 按键名称
 */
async function pressDown(key) {
    try {
        const parsedKey = parseKey(key);
        await keyboard.pressKey(parsedKey);
        console.log(`[Keyboard] Pressed down: ${key}`);
    } catch (error) {
        console.error('[Keyboard] Press down error:', error);
        throw error;
    }
}

/**
 * 释放按键
 * @param {string} key - 按键名称
 */
async function release(key) {
    try {
        const parsedKey = parseKey(key);
        await keyboard.releaseKey(parsedKey);
        console.log(`[Keyboard] Released: ${key}`);
    } catch (error) {
        console.error('[Keyboard] Release error:', error);
        throw error;
    }
}

module.exports = {
    type,
    press,
    pressDown,
    release
};
