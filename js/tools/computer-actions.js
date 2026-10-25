/**
 * Claude computer use 动作执行与结果整理
 * 旧版 computer 工具的 action 与 computer 工具集成员共用同一套输入字段，坐标都位于回传截图的像素空间
 */

import { MediaKind } from '../messages/schema.js';
import { logger } from '../utils/logger.js';

export const COMPUTER_TOOLSET_NAME = 'computer';

// 批量动作中前一个失败后，后续动作必须原样回复这段文字
export const COMPUTER_HALT_MESSAGE =
    'Not executed: an earlier computer action in this turn failed.';

// 工具集成员对应的 Computer Use 权限；wait 不需要任何权限
export const COMPUTER_MEMBER_PERMISSIONS = Object.freeze({
    screenshot: 'screenshot',
    zoom: 'screenshot',
    left_click: 'mouse',
    right_click: 'mouse',
    middle_click: 'mouse',
    double_click: 'mouse',
    triple_click: 'mouse',
    left_click_drag: 'mouse',
    mouse_move: 'mouse',
    left_mouse_down: 'mouse',
    left_mouse_up: 'mouse',
    cursor_position: 'mouse',
    scroll: 'mouse',
    type: 'keyboard',
    key: 'keyboard',
    hold_key: 'keyboard',
    wait: null
});

// 结果本身就是图片的动作
export const COMPUTER_IMAGE_ACTIONS = Object.freeze(['screenshot', 'zoom']);

const CLICK_ACTIONS = Object.freeze({
    left_click: (api) => api.computerUse_clickMouse('left'),
    right_click: (api) => api.computerUse_clickMouse('right'),
    middle_click: (api) => api.computerUse_clickMouse('middle'),
    double_click: (api) => api.computerUse_doubleClickMouse('left'),
    triple_click: (api) => api.computerUse_tripleClickMouse('left')
});
const SCROLL_DIRECTIONS = Object.freeze(['up', 'down', 'left', 'right']);
const MAX_REPEAT = 100;
const MAX_DURATION_SECONDS = 300;

/**
 * @param {{ toolsetName?: string }} toolCall
 * @returns {boolean}
 */
export function isComputerToolsetCall(toolCall) {
    return toolCall?.toolsetName === COMPUTER_TOOLSET_NAME;
}

// ========== 输入校验 ==========

function unwrap(result, failureMessage) {
    if (result && result.success === false) {
        throw new Error(result.error || failureMessage);
    }
    return result;
}

function readPoint(value, label) {
    if (
        !Array.isArray(value) ||
        value.length !== 2 ||
        !value.every((n) => Number.isFinite(n) && n >= 0)
    ) {
        throw new Error(`${label} 需要 [x, y] 形式的非负坐标`);
    }
    return value;
}

function readOptionalPoint(value, label) {
    return value === undefined || value === null ? null : readPoint(value, label);
}

function readRegion(value) {
    if (
        !Array.isArray(value) ||
        value.length !== 4 ||
        !value.every((n) => Number.isFinite(n) && n >= 0)
    ) {
        throw new Error('zoom 需要 region: [x0, y0, x1, y1] 形式的非负坐标');
    }
    return value;
}

function readInteger(value, label, fallback) {
    const number = value ?? fallback;
    if (!Number.isInteger(number) || number < 1 || number > MAX_REPEAT) {
        throw new Error(`${label} 必须是 1 到 ${MAX_REPEAT} 的整数`);
    }
    return number;
}

function readSeconds(value, label) {
    const seconds = value ?? 1;
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > MAX_DURATION_SECONDS) {
        throw new Error(`${label} 必须在 0 到 ${MAX_DURATION_SECONDS} 秒之间`);
    }
    return seconds;
}

/**
 * 点击、拖拽、滚动的 text 是按住的修饰键，如 "shift"、"ctrl+shift"
 * @returns {string[]}
 */
function parseModifiers(text) {
    if (text === undefined || text === null || text === '') return [];
    if (typeof text !== 'string') {
        throw new Error('修饰键 text 必须是字符串，例如 "shift" 或 "ctrl+shift"');
    }
    return text
        .split('+')
        .map((key) => key.trim())
        .filter(Boolean);
}

/**
 * "ctrl+s" → { key: 's', modifiers: ['ctrl'] }；"+" 与 "ctrl++" 中的 + 是按键本身
 * @returns {{ key: string, modifiers: string[] }}
 */
export function parseKeyCombo(text) {
    if (typeof text !== 'string' || !text.trim()) {
        throw new Error('需要 text 参数，例如 "Return" 或 "ctrl+s"');
    }
    const combo = text.trim();
    if (combo === '+') return { key: '+', modifiers: [] };
    const plusIsKey = combo.endsWith('++');
    const tokens = (plusIsKey ? combo.slice(0, -2) : combo)
        .split('+')
        .map((key) => key.trim())
        .filter(Boolean);
    const key = plusIsKey ? '+' : tokens.pop();
    return { key, modifiers: tokens };
}

// ========== 坐标换算 ==========

/**
 * 主显示器截图的缩放比例与输出尺寸，坐标按它在截图像素与屏幕之间换算
 * @returns {Promise<{ scaleFactor: number, width: number, height: number, originalWidth: number, originalHeight: number }>}
 */
export async function fetchScreenGeometry() {
    const api = window.electronAPI;
    if (typeof api?.computerUse_getScreenGeometry !== 'function') {
        throw new Error('Computer Use 仅在桌面端可用');
    }
    const { scaleFactor, width, height, originalWidth, originalHeight } = unwrap(
        await api.computerUse_getScreenGeometry(),
        '获取截图尺寸失败'
    );
    return { scaleFactor, width, height, originalWidth, originalHeight };
}

function createCoordinateMapper(geometry) {
    const fallback = geometry.scaleFactor || 1;
    const scaleX =
        geometry.width > 0 && geometry.originalWidth > 0
            ? geometry.width / geometry.originalWidth
            : fallback;
    const scaleY =
        geometry.height > 0 && geometry.originalHeight > 0
            ? geometry.height / geometry.originalHeight
            : fallback;
    return {
        toScreen: ([x, y]) => [Math.round(x / scaleX), Math.round(y / scaleY)],
        toImage: ([x, y]) => [Math.round(x * scaleX), Math.round(y * scaleY)]
    };
}

// ========== 执行辅助 ==========

function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        const abortError = () => new DOMException('Tool execution aborted', 'AbortError');
        if (signal?.aborted) {
            reject(abortError());
            return;
        }
        const onAbort = () => {
            clearTimeout(timer);
            reject(abortError());
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

async function withHeldKeys(api, keys, run) {
    const held = [];
    try {
        for (const key of keys) {
            unwrap(await api.computerUse_holdKey(key), `按住 ${key} 失败`);
            held.push(key);
        }
        return await run();
    } finally {
        for (const key of held.reverse()) {
            try {
                await api.computerUse_releaseKey(key);
            } catch (error) {
                logger.warn(`[Computer Use] 释放按键 ${key} 失败:`, error);
            }
        }
    }
}

async function moveMouse(api, [x, y]) {
    unwrap(await api.computerUse_moveMouse(x, y), '移动鼠标失败');
}

function textResult(text) {
    return { content: text };
}

function imageResult(raw) {
    const mimeType = `image/${raw.format || 'png'}`;
    return {
        content: '',
        media: [{ type: MediaKind.IMAGE, url: `data:${mimeType};base64,${raw.base64}`, mimeType }]
    };
}

// ========== 动作执行 ==========

/**
 * 执行一个 computer 动作
 * 结果只含文本或图片：截图与放大返回图片，cursor_position 返回坐标文本，其余返回 OK
 *
 * @param {string} action 旧版工具的 input.action，或工具集成员名
 * @param {Object} input 动作参数（坐标、文本、时长等），坐标位于回传截图的像素空间
 * @param {Object} [options]
 * @param {AbortSignal|null} [options.signal] wait / hold_key 期间可被取消
 * @returns {Promise<{ content: string, media?: Array<{ type: string, url: string, mimeType: string }> }>}
 */
export async function executeComputerAction(action, input = {}, options = {}) {
    const { signal = null } = options;
    const api = window.electronAPI;
    if (!action) {
        throw new Error(
            "Missing required parameter 'action' for computer tool. " +
                `Received parameters: ${Object.keys(input).join(', ') || 'none'}`
        );
    }
    const mapper = async () => createCoordinateMapper(await fetchScreenGeometry());

    switch (action) {
        case 'screenshot':
            return imageResult(unwrap(await api.computerUse_screenshot(), '截图失败'));

        case 'zoom': {
            const [x0, y0, x1, y1] = readRegion(input.region);
            const { toScreen } = await mapper();
            const [left, top] = toScreen([x0, y0]);
            const [right, bottom] = toScreen([x1, y1]);
            return imageResult(
                unwrap(await api.computerUse_zoom(left, top, right, bottom), '区域放大失败')
            );
        }

        case 'left_click':
        case 'right_click':
        case 'middle_click':
        case 'double_click':
        case 'triple_click': {
            const target = readOptionalPoint(input.coordinate, action);
            const screenTarget = target ? (await mapper()).toScreen(target) : null;
            await withHeldKeys(api, parseModifiers(input.text), async () => {
                if (screenTarget) await moveMouse(api, screenTarget);
                unwrap(await CLICK_ACTIONS[action](api), `${action} 失败`);
            });
            return textResult('OK');
        }

        case 'left_click_drag': {
            const start = readPoint(input.start_coordinate, 'left_click_drag start_coordinate');
            const end = readPoint(input.coordinate, 'left_click_drag coordinate');
            const { toScreen } = await mapper();
            const [fromX, fromY] = toScreen(start);
            const [toX, toY] = toScreen(end);
            await withHeldKeys(api, parseModifiers(input.text), async () => {
                unwrap(await api.computerUse_dragMouse(fromX, fromY, toX, toY), '拖拽失败');
            });
            return textResult('OK');
        }

        case 'mouse_move': {
            const target = readPoint(input.coordinate, 'mouse_move');
            const { toScreen } = await mapper();
            await moveMouse(api, toScreen(target));
            return textResult('OK');
        }

        case 'left_mouse_down':
        case 'left_mouse_up': {
            const target = readOptionalPoint(input.coordinate, action);
            if (target) await moveMouse(api, (await mapper()).toScreen(target));
            const result =
                action === 'left_mouse_down'
                    ? await api.computerUse_pressMouseButton('left')
                    : await api.computerUse_releaseMouseButton('left');
            unwrap(result, `${action} 失败`);
            return textResult('OK');
        }

        case 'cursor_position': {
            const position = unwrap(await api.computerUse_getCursorPosition(), '获取光标位置失败');
            const { toImage } = await mapper();
            const [x, y] = toImage([position.x, position.y]);
            return textResult(`X=${x}, Y=${y}`);
        }

        case 'scroll': {
            const direction = input.scroll_direction ?? 'down';
            if (!SCROLL_DIRECTIONS.includes(direction)) {
                throw new Error(`不支持的滚动方向: ${direction}`);
            }
            const amount = readInteger(input.scroll_amount, 'scroll_amount', 1);
            const target = readOptionalPoint(input.coordinate, 'scroll');
            const screenTarget = target ? (await mapper()).toScreen(target) : null;
            await withHeldKeys(api, parseModifiers(input.text), async () => {
                if (screenTarget) await moveMouse(api, screenTarget);
                unwrap(await api.computerUse_scrollMouse(amount, direction), '滚动失败');
            });
            return textResult('OK');
        }

        case 'type': {
            if (typeof input.text !== 'string') throw new Error('type 需要 text 参数');
            unwrap(await api.computerUse_typeText(input.text), '输入文本失败');
            return textResult('OK');
        }

        case 'key': {
            const { key, modifiers } = parseKeyCombo(input.text);
            const repeat = readInteger(input.repeat, 'repeat', 1);
            for (let i = 0; i < repeat; i++) {
                unwrap(await api.computerUse_pressKey(key, modifiers), `按键 ${input.text} 失败`);
            }
            return textResult('OK');
        }

        case 'hold_key': {
            const { key, modifiers } = parseKeyCombo(input.text);
            const seconds = readSeconds(input.duration, 'hold_key duration');
            await withHeldKeys(api, [...modifiers, key], () => sleep(seconds * 1000, signal));
            return textResult('OK');
        }

        case 'wait':
            await sleep(readSeconds(input.duration, 'wait duration') * 1000, signal);
            return textResult('OK');

        default:
            throw new Error(`Unknown computer action: "${action}"`);
    }
}
