/**
 * 键盘控制模块
 * 使用 @nut-tree-fork/nut-js
 */

const { keyboard, Key } = require('@nut-tree-fork/nut-js');

// Claude 的 super 指 Command 或 Windows 键
const SUPER_KEY =
    process.platform === 'darwin'
        ? Key.LeftCmd
        : process.platform === 'win32'
          ? Key.LeftWin
          : Key.LeftSuper;

// 按键映射表
const KEY_MAP = {
    // 修饰键
    ctrl: Key.LeftControl,
    alt: Key.LeftAlt,
    shift: Key.LeftShift,
    cmd: Key.LeftCmd,
    meta: Key.LeftCmd,
    win: Key.LeftWin,
    super: SUPER_KEY,
    super_l: SUPER_KEY,
    command: Key.LeftCmd,
    option: Key.LeftAlt,
    control: Key.LeftControl,
    control_l: Key.LeftControl,
    ctrl_l: Key.LeftControl,
    alt_l: Key.LeftAlt,
    shift_l: Key.LeftShift,

    // 功能键
    enter: Key.Enter,
    return: Key.Enter,
    tab: Key.Tab,
    backspace: Key.Backspace,
    delete: Key.Delete,
    escape: Key.Escape,
    esc: Key.Escape,
    space: Key.Space,

    // 方向键
    up: Key.Up,
    down: Key.Down,
    left: Key.Left,
    right: Key.Right,

    // Home/End/PageUp/PageDown
    home: Key.Home,
    end: Key.End,
    pageup: Key.PageUp,
    pagedown: Key.PageDown,
    page_up: Key.PageUp,
    page_down: Key.PageDown,
    insert: Key.Insert,
    caps_lock: Key.CapsLock,
    print: Key.Print,
    kp_enter: Key.Enter,

    // xdotool 风格的符号键名
    minus: Key.Minus,
    equal: Key.Equal,
    comma: Key.Comma,
    period: Key.Period,
    slash: Key.Slash,
    backslash: Key.Backslash,
    semicolon: Key.Semicolon,
    apostrophe: Key.Quote,
    grave: Key.Grave,
    bracketleft: Key.LeftBracket,
    bracketright: Key.RightBracket,

    // F1-F12
    f1: Key.F1,
    f2: Key.F2,
    f3: Key.F3,
    f4: Key.F4,
    f5: Key.F5,
    f6: Key.F6,
    f7: Key.F7,
    f8: Key.F8,
    f9: Key.F9,
    f10: Key.F10,
    f11: Key.F11,
    f12: Key.F12
};

// 单个字符对应的物理按键
const CHAR_KEYS = {
    '-': Key.Minus,
    '=': Key.Equal,
    '+': Key.Add,
    ',': Key.Comma,
    '.': Key.Period,
    '/': Key.Slash,
    '\\': Key.Backslash,
    ';': Key.Semicolon,
    "'": Key.Quote,
    '`': Key.Grave,
    '[': Key.LeftBracket,
    ']': Key.RightBracket,
    ' ': Key.Space
};

/**
 * 映射表里的按键名转成 Key 枚举，其余原样返回，按普通字符输入
 */
function parseKey(keyString) {
    const mapped = KEY_MAP[keyString.toLowerCase()];
    // Key.Escape 的枚举值是 0，不能用 || 回退
    return mapped !== undefined ? mapped : keyString;
}

/**
 * @returns {number|undefined} 单个字母、数字、符号对应的 Key 枚举
 */
function charToKey(char) {
    if (/^[a-z]$/i.test(char)) return Key[char.toUpperCase()];
    if (/^[0-9]$/.test(char)) return Key[`Num${char}`];
    return CHAR_KEYS[char];
}

/**
 * 按住与释放只接受 Key 枚举
 */
function toNutKey(keyString) {
    const parsed = parseKey(keyString);
    const key = typeof parsed === 'number' ? parsed : charToKey(keyString);
    if (key === undefined) {
        throw new Error(`Unsupported key: ${keyString}`);
    }
    return key;
}

/**
 * 输入文本
 * @param {string} text - 要输入的文本
 */
async function type(text) {
    try {
        await keyboard.type(text);
        console.log(`[Keyboard] Typed ${text.length} chars`);
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
    const held = [];
    try {
        const modifierKeys = modifiers.map(toNutKey);
        const parsedKey = parseKey(key);
        // 组合键里的字符要发按键事件，输入字符的方式不会和按住的修饰键组合
        const mainKey =
            modifierKeys.length > 0
                ? toNutKey(key)
                : typeof parsedKey === 'number'
                  ? parsedKey
                  : null;

        for (const modifierKey of modifierKeys) {
            await keyboard.pressKey(modifierKey);
            held.push(modifierKey);
        }
        if (mainKey !== null) {
            await keyboard.pressKey(mainKey);
            await keyboard.releaseKey(mainKey);
        } else {
            await keyboard.type(key);
        }
        console.log(`[Keyboard] Pressed: ${[...modifiers, key].join('+')}`);
    } catch (error) {
        console.error('[Keyboard] Press error:', error);
        throw error;
    } finally {
        // 失败时也松开已按住的修饰键，否则系统里会一直按着
        for (const modifierKey of held.reverse()) {
            try {
                await keyboard.releaseKey(modifierKey);
            } catch (releaseError) {
                console.error('[Keyboard] Release modifier error:', releaseError);
            }
        }
    }
}

/**
 * 按住按键
 * @param {string} key - 按键名称
 */
async function pressDown(key) {
    try {
        await keyboard.pressKey(toNutKey(key));
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
        await keyboard.releaseKey(toNutKey(key));
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
