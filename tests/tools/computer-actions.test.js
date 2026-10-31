/**
 * computer-actions.js 测试
 * computer 动作执行：截图坐标换算、修饰键、按键组合、等待取消、失败时释放按键
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../js/utils/logger.js', () => ({
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

vi.stubGlobal('window', {});

import {
    COMPUTER_GUI_PERMISSIONS,
    COMPUTER_MEMBER_PERMISSIONS,
    describeComputerAction,
    executeComputerAction,
    fetchScreenGeometry,
    hasComputerGuiPermission,
    isComputerToolsetCall,
    parseKeyCombo,
    releaseHeldMouseButton
} from '../../js/tools/computer-actions.js';

// 截图按 0.5 缩放：截图坐标 ×2 即屏幕坐标
const GEOMETRY = {
    success: true,
    scaleFactor: 0.5,
    width: 1280,
    height: 720,
    originalWidth: 2560,
    originalHeight: 1440
};

function createApi() {
    const ok = (extra = {}) => vi.fn(async () => ({ success: true, ...extra }));
    return {
        computerUse_screenshot: ok({ base64: 'SHOT', format: 'png', width: 1280, height: 720 }),
        computerUse_zoom: ok({ base64: 'ZOOM', format: 'png' }),
        computerUse_getScreenGeometry: vi.fn(async () => ({ ...GEOMETRY })),
        computerUse_moveMouse: ok(),
        computerUse_clickMouse: ok(),
        computerUse_doubleClickMouse: ok(),
        computerUse_tripleClickMouse: ok(),
        computerUse_dragMouse: ok(),
        computerUse_scrollMouse: ok(),
        computerUse_pressMouseButton: ok(),
        computerUse_releaseMouseButton: ok(),
        computerUse_typeText: ok(),
        computerUse_pressKey: ok(),
        computerUse_holdKey: ok(),
        computerUse_releaseKey: ok(),
        computerUse_getCursorPosition: ok({ x: 1000, y: 500 })
    };
}

let api;
const order = (fn, index = 0) => fn.mock.invocationCallOrder[index];

beforeEach(() => {
    api = createApi();
    window.electronAPI = api;
});

afterEach(async () => {
    vi.useRealTimers();
    // 左键按下状态是模块级的，换一套正常的接口松开，避免串到下一个用例
    window.electronAPI = createApi();
    await releaseHeldMouseButton();
});

describe('isComputerToolsetCall', () => {
    it('按 toolsetName 识别工具集成员调用', () => {
        expect(isComputerToolsetCall({ name: 'left_click', toolsetName: 'computer' })).toBe(true);
        expect(
            isComputerToolsetCall({ name: 'computer', arguments: { action: 'screenshot' } })
        ).toBe(false);
        expect(isComputerToolsetCall(null)).toBe(false);
    });

    it('17 个成员都有对应权限，wait 不需要权限', () => {
        expect(Object.keys(COMPUTER_MEMBER_PERMISSIONS)).toHaveLength(17);
        expect(COMPUTER_MEMBER_PERMISSIONS.wait).toBeNull();
    });
});

describe('hasComputerGuiPermission', () => {
    it('截图、鼠标、键盘三项任开一项即可，旧配置缺字段按开启处理', () => {
        expect([...COMPUTER_GUI_PERMISSIONS].sort()).toEqual(['keyboard', 'mouse', 'screenshot']);
        expect(hasComputerGuiPermission(undefined)).toBe(true);
        expect(hasComputerGuiPermission({ bash: true, textEditor: true })).toBe(true);
        expect(hasComputerGuiPermission({ mouse: false, keyboard: false, screenshot: true })).toBe(
            true
        );
        expect(hasComputerGuiPermission({ mouse: false, keyboard: false, screenshot: false })).toBe(
            false
        );
    });
});

describe('describeComputerAction', () => {
    it.each([
        ['screenshot', {}, '截取屏幕'],
        ['left_click', { coordinate: [10, 20] }, '左键单击 (10, 20)'],
        ['left_click', {}, '在当前位置左键单击'],
        ['right_click', { coordinate: [1, 2], text: 'shift' }, '按住 shift 右键单击 (1, 2)'],
        ['double_click', { coordinate: [3, 4] }, '双击 (3, 4)'],
        [
            'left_click_drag',
            { start_coordinate: [1, 2], coordinate: [3, 4] },
            '从 (1, 2) 拖拽到 (3, 4)'
        ],
        ['mouse_move', { coordinate: [5, 6] }, '移动鼠标到 (5, 6)'],
        ['left_mouse_down', {}, '按下左键'],
        ['left_mouse_up', { coordinate: [7, 8] }, '在 (7, 8) 松开左键'],
        [
            'scroll',
            { coordinate: [9, 9], scroll_direction: 'up', scroll_amount: 3 },
            '在 (9, 9) 向上滚动 3 格'
        ],
        ['zoom', { region: [0, 0, 100, 50] }, '放大查看区域 (0, 0) 到 (100, 50)'],
        ['type', { text: 'hi' }, '输入文本「hi」'],
        ['key', { text: 'ctrl+c' }, '按键 ctrl+c'],
        ['key', { text: 'Down', repeat: 3 }, '按键 Down（连按 3 次）'],
        ['hold_key', { text: 'shift', duration: 2 }, '按住 shift 2 秒'],
        ['wait', { duration: 1.5 }, '等待 1.5 秒'],
        ['cursor_position', {}, '读取光标位置']
    ])('%s %j → %s', (action, input, expected) => {
        expect(describeComputerAction(action, input)).toBe(expected);
    });

    it('输入里的换行显示成可见的回车，超长内容截断并注明总长', () => {
        expect(describeComputerAction('type', { text: 'rm -rf ~\n' })).toBe(
            '输入文本「rm -rf ~↵」'
        );
        const long = describeComputerAction('type', { text: 'a'.repeat(1200) });
        expect(long).toContain('…（共 1200 字）');
    });

    it('参数不合法或缺少 action 时仍给出描述而不抛错', () => {
        expect(describeComputerAction('mouse_move', { coordinate: 'x' })).toBe(
            '移动鼠标到 (未指定)'
        );
        expect(describeComputerAction(undefined, null)).toBe('未指定的桌面动作');
        expect(describeComputerAction('teleport')).toBe('执行 teleport');
    });
});

describe('parseKeyCombo', () => {
    it.each([
        ['Return', { key: 'Return', modifiers: [] }],
        ['ctrl+s', { key: 's', modifiers: ['ctrl'] }],
        ['ctrl+shift+t', { key: 't', modifiers: ['ctrl', 'shift'] }],
        [' alt + F4 ', { key: 'F4', modifiers: ['alt'] }],
        ['+', { key: '+', modifiers: [] }],
        ['ctrl++', { key: '+', modifiers: ['ctrl'] }]
    ])('%s', (text, expected) => {
        expect(parseKeyCombo(text)).toEqual(expected);
    });

    it('空文本或非字符串报错', () => {
        expect(() => parseKeyCombo('')).toThrow('需要 text 参数');
        expect(() => parseKeyCombo(undefined)).toThrow('需要 text 参数');
    });
});

describe('fetchScreenGeometry', () => {
    it('只返回尺寸字段', async () => {
        await expect(fetchScreenGeometry()).resolves.toEqual({
            scaleFactor: 0.5,
            width: 1280,
            height: 720,
            originalWidth: 2560,
            originalHeight: 1440
        });
    });

    it('主进程失败时抛出原因', async () => {
        api.computerUse_getScreenGeometry.mockResolvedValueOnce({
            success: false,
            error: 'No display'
        });
        await expect(fetchScreenGeometry()).rejects.toThrow('No display');
    });

    it('没有桌面端接口时报错', async () => {
        window.electronAPI = {};
        await expect(fetchScreenGeometry()).rejects.toThrow('仅在桌面端可用');
    });
});

describe('executeComputerAction 截图与放大', () => {
    it('截图以图片媒体返回，不附带文本，也不读取截图尺寸', async () => {
        const result = await executeComputerAction('screenshot');

        expect(result).toEqual({
            content: '',
            media: [{ type: 'image', url: 'data:image/png;base64,SHOT', mimeType: 'image/png' }]
        });
        expect(api.computerUse_getScreenGeometry).not.toHaveBeenCalled();
    });

    it('截图失败时抛出主进程给出的原因', async () => {
        api.computerUse_screenshot.mockResolvedValueOnce({
            success: false,
            error: 'Screenshot permission denied'
        });

        await expect(executeComputerAction('screenshot')).rejects.toThrow(
            'Screenshot permission denied'
        );
    });

    it('放大区域从截图坐标换算回屏幕坐标', async () => {
        const result = await executeComputerAction('zoom', { region: [10, 20, 110, 220] });

        expect(api.computerUse_zoom).toHaveBeenCalledWith(20, 40, 220, 440);
        expect(result.media[0].url).toBe('data:image/png;base64,ZOOM');
    });

    it('放大区域格式不对时报错且不调用主进程', async () => {
        await expect(executeComputerAction('zoom', { region: [10, 20, 110] })).rejects.toThrow(
            'region'
        );
        expect(api.computerUse_zoom).not.toHaveBeenCalled();
    });

    it('缺少输出尺寸时按 scaleFactor 换算', async () => {
        api.computerUse_getScreenGeometry.mockResolvedValueOnce({
            success: true,
            scaleFactor: 0.25
        });

        await executeComputerAction('zoom', { region: [100, 100, 200, 200] });

        expect(api.computerUse_zoom).toHaveBeenCalledWith(400, 400, 800, 800);
    });
});

describe('executeComputerAction 坐标换算', () => {
    it('宽高分别换算，截图右下角对应屏幕右下角', async () => {
        api.computerUse_getScreenGeometry.mockResolvedValueOnce({
            success: true,
            scaleFactor: 0.7447,
            width: 1429,
            height: 804,
            originalWidth: 1920,
            originalHeight: 1080
        });

        await executeComputerAction('mouse_move', { coordinate: [1429, 804] });

        expect(api.computerUse_moveMouse).toHaveBeenCalledWith(1920, 1080);
    });

    it('取不到截图尺寸时报错，不执行动作', async () => {
        api.computerUse_getScreenGeometry.mockResolvedValueOnce({
            success: false,
            error: 'No display'
        });

        await expect(executeComputerAction('left_click', { coordinate: [10, 10] })).rejects.toThrow(
            'No display'
        );
        expect(api.computerUse_moveMouse).not.toHaveBeenCalled();
        expect(api.computerUse_clickMouse).not.toHaveBeenCalled();
    });
});

describe('executeComputerAction 鼠标', () => {
    it('带修饰键的点击：按住 → 移动 → 点击 → 逆序释放', async () => {
        const result = await executeComputerAction('left_click', {
            coordinate: [100, 200],
            text: 'ctrl+shift'
        });

        expect(result).toEqual({ content: 'OK' });
        expect(api.computerUse_holdKey.mock.calls).toEqual([['ctrl'], ['shift']]);
        expect(api.computerUse_moveMouse).toHaveBeenCalledWith(200, 400);
        expect(api.computerUse_clickMouse).toHaveBeenCalledWith('left');
        expect(api.computerUse_releaseKey.mock.calls).toEqual([['shift'], ['ctrl']]);
        expect(order(api.computerUse_holdKey, 1)).toBeLessThan(order(api.computerUse_moveMouse));
        expect(order(api.computerUse_moveMouse)).toBeLessThan(order(api.computerUse_clickMouse));
        expect(order(api.computerUse_clickMouse)).toBeLessThan(order(api.computerUse_releaseKey));
    });

    it('没有坐标时在当前位置点击，不读取截图尺寸', async () => {
        await executeComputerAction('left_click');

        expect(api.computerUse_getScreenGeometry).not.toHaveBeenCalled();
        expect(api.computerUse_moveMouse).not.toHaveBeenCalled();
        expect(api.computerUse_clickMouse).toHaveBeenCalledWith('left');
    });

    it.each([
        ['right_click', 'computerUse_clickMouse', 'right'],
        ['middle_click', 'computerUse_clickMouse', 'middle'],
        ['double_click', 'computerUse_doubleClickMouse', 'left'],
        ['triple_click', 'computerUse_tripleClickMouse', 'left']
    ])('%s 走对应的点击接口', async (action, method, button) => {
        await executeComputerAction(action, { coordinate: [5, 5] });

        expect(api[method]).toHaveBeenCalledWith(button);
        expect(api.computerUse_moveMouse).toHaveBeenCalledWith(10, 10);
    });

    it('拖拽的起点与终点都换算到屏幕坐标', async () => {
        await executeComputerAction('left_click_drag', {
            start_coordinate: [10, 10],
            coordinate: [50, 60]
        });

        expect(api.computerUse_dragMouse).toHaveBeenCalledWith(20, 20, 100, 120);
    });

    it('拖拽缺少起点时报错', async () => {
        await expect(
            executeComputerAction('left_click_drag', { coordinate: [50, 60] })
        ).rejects.toThrow('start_coordinate');
        expect(api.computerUse_dragMouse).not.toHaveBeenCalled();
    });

    it('按下与松开左键，带坐标时先移动', async () => {
        await executeComputerAction('left_mouse_down', { coordinate: [10, 10] });
        await executeComputerAction('left_mouse_up');

        expect(api.computerUse_moveMouse).toHaveBeenCalledTimes(1);
        expect(api.computerUse_moveMouse).toHaveBeenCalledWith(20, 20);
        expect(api.computerUse_pressMouseButton).toHaveBeenCalledWith('left');
        expect(api.computerUse_releaseMouseButton).toHaveBeenCalledWith('left');
    });

    it('光标位置换算到截图坐标', async () => {
        const result = await executeComputerAction('cursor_position');

        expect(result).toEqual({ content: 'X=500, Y=250' });
    });

    it('滚动传递方向与格数，带坐标时先移动', async () => {
        await executeComputerAction('scroll', {
            coordinate: [100, 100],
            scroll_direction: 'left',
            scroll_amount: 3
        });

        expect(api.computerUse_moveMouse).toHaveBeenCalledWith(200, 200);
        expect(api.computerUse_scrollMouse).toHaveBeenCalledWith(3, 'left');
        expect(order(api.computerUse_moveMouse)).toBeLessThan(order(api.computerUse_scrollMouse));
    });

    it('滚动方向或格数不合法时报错', async () => {
        await expect(
            executeComputerAction('scroll', { scroll_direction: 'sideways' })
        ).rejects.toThrow('sideways');
        await expect(
            executeComputerAction('scroll', { scroll_direction: 'down', scroll_amount: 0 })
        ).rejects.toThrow('scroll_amount');
        expect(api.computerUse_scrollMouse).not.toHaveBeenCalled();
    });

    it('坐标为负数时报错', async () => {
        await expect(executeComputerAction('mouse_move', { coordinate: [-1, 5] })).rejects.toThrow(
            '非负坐标'
        );
        expect(api.computerUse_moveMouse).not.toHaveBeenCalled();
    });
});

describe('executeComputerAction 键盘', () => {
    it('输入文本', async () => {
        await executeComputerAction('type', { text: 'hello' });
        expect(api.computerUse_typeText).toHaveBeenCalledWith('hello');
    });

    it('输入缺少 text 时报错', async () => {
        await expect(executeComputerAction('type', {})).rejects.toThrow('text');
    });

    it('组合键按 repeat 重复按下', async () => {
        await executeComputerAction('key', { text: 'ctrl+s', repeat: 3 });

        expect(api.computerUse_pressKey).toHaveBeenCalledTimes(3);
        expect(api.computerUse_pressKey).toHaveBeenCalledWith('s', ['ctrl']);
    });

    it('repeat 超出范围时一次都不按', async () => {
        await expect(executeComputerAction('key', { text: 'Down', repeat: 101 })).rejects.toThrow(
            'repeat'
        );
        expect(api.computerUse_pressKey).not.toHaveBeenCalled();
    });

    it('按住按键到时长结束后逆序释放', async () => {
        vi.useFakeTimers();
        const pending = executeComputerAction('hold_key', { text: 'ctrl+a', duration: 2 });

        await vi.advanceTimersByTimeAsync(1500);
        expect(api.computerUse_holdKey.mock.calls).toEqual([['ctrl'], ['a']]);
        expect(api.computerUse_releaseKey).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(500);
        await expect(pending).resolves.toEqual({ content: 'OK' });
        expect(api.computerUse_releaseKey.mock.calls).toEqual([['a'], ['ctrl']]);
    });

    it('按住时长超过 300 秒时报错', async () => {
        await expect(
            executeComputerAction('hold_key', { text: 'shift', duration: 301 })
        ).rejects.toThrow('300');
        expect(api.computerUse_holdKey).not.toHaveBeenCalled();
    });
});

describe('executeComputerAction 等待、失败与未知动作', () => {
    it('等待期间取消立即结束', async () => {
        const controller = new AbortController();
        const pending = executeComputerAction(
            'wait',
            { duration: 60 },
            { signal: controller.signal }
        );
        controller.abort();

        await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('已取消的信号不再等待', async () => {
        const controller = new AbortController();
        controller.abort();

        await expect(
            executeComputerAction('wait', { duration: 1 }, { signal: controller.signal })
        ).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('按住按键期间取消时立即松开', async () => {
        const controller = new AbortController();
        const pending = executeComputerAction(
            'hold_key',
            { text: 'shift', duration: 60 },
            { signal: controller.signal }
        );
        await vi.waitFor(() => expect(api.computerUse_holdKey).toHaveBeenCalledWith('shift'));
        controller.abort();

        await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        expect(api.computerUse_releaseKey).toHaveBeenCalledWith('shift');
    });

    it('点击失败时抛出原因，并释放已按住的修饰键', async () => {
        api.computerUse_clickMouse.mockResolvedValueOnce({
            success: false,
            error: 'Mouse permission denied'
        });

        await expect(executeComputerAction('left_click', { text: 'shift' })).rejects.toThrow(
            'Mouse permission denied'
        );
        expect(api.computerUse_releaseKey).toHaveBeenCalledWith('shift');
    });

    it('修饰键按住失败时只释放已按住的键，不再点击', async () => {
        api.computerUse_holdKey
            .mockResolvedValueOnce({ success: true })
            .mockResolvedValueOnce({ success: false, error: 'Unsupported key: hyper' });

        await expect(executeComputerAction('left_click', { text: 'ctrl+hyper' })).rejects.toThrow(
            'Unsupported key: hyper'
        );
        expect(api.computerUse_releaseKey.mock.calls).toEqual([['ctrl']]);
        expect(api.computerUse_clickMouse).not.toHaveBeenCalled();
    });

    it('已停止时不调用任何主进程接口', async () => {
        const controller = new AbortController();
        controller.abort();

        await expect(
            executeComputerAction(
                'left_click',
                { coordinate: [1, 1] },
                { signal: controller.signal }
            )
        ).rejects.toMatchObject({ name: 'AbortError' });
        expect(api.computerUse_getScreenGeometry).not.toHaveBeenCalled();
        expect(api.computerUse_clickMouse).not.toHaveBeenCalled();
    });

    it('连按期间停止时不再按后续次数', async () => {
        const controller = new AbortController();
        api.computerUse_pressKey.mockImplementation(async () => {
            if (api.computerUse_pressKey.mock.calls.length === 2) controller.abort();
            return { success: true };
        });

        await expect(
            executeComputerAction(
                'key',
                { text: 'Down', repeat: 10 },
                { signal: controller.signal }
            )
        ).rejects.toMatchObject({ name: 'AbortError' });
        expect(api.computerUse_pressKey).toHaveBeenCalledTimes(2);
    });

    it('点击成功但修饰键松不开时报错，并说明哪个键', async () => {
        api.computerUse_releaseKey.mockResolvedValueOnce({
            success: false,
            error: 'Keyboard permission denied'
        });

        await expect(executeComputerAction('left_click', { text: 'shift' })).rejects.toThrow(
            '松开按键失败: shift（Keyboard permission denied）'
        );
        expect(api.computerUse_clickMouse).toHaveBeenCalledTimes(1);
    });

    it('动作失败且修饰键也松不开时保留动作本身的错误', async () => {
        api.computerUse_clickMouse.mockResolvedValueOnce({
            success: false,
            error: 'Mouse permission denied'
        });
        api.computerUse_releaseKey.mockResolvedValueOnce({ success: false, error: 'stuck' });

        await expect(executeComputerAction('left_click', { text: 'ctrl' })).rejects.toThrow(
            'Mouse permission denied'
        );
        expect(api.computerUse_releaseKey).toHaveBeenCalledWith('ctrl');
    });

    it('未知动作报错', async () => {
        await expect(executeComputerAction('teleport')).rejects.toThrow(
            'Unknown computer action: "teleport"'
        );
    });

    it('缺少 action 时报错并列出收到的参数', async () => {
        await expect(executeComputerAction(undefined, { coordinate: [1, 1] })).rejects.toThrow(
            "Missing required parameter 'action'"
        );
    });
});

describe('releaseHeldMouseButton', () => {
    it('left_mouse_down 之后松开左键，只松一次', async () => {
        await executeComputerAction('left_mouse_down');

        await expect(releaseHeldMouseButton()).resolves.toBe(true);
        await expect(releaseHeldMouseButton()).resolves.toBe(false);
        expect(api.computerUse_releaseMouseButton).toHaveBeenCalledTimes(1);
        expect(api.computerUse_releaseMouseButton).toHaveBeenCalledWith('left');
    });

    it.each([
        ['left_mouse_up', {}],
        ['left_click', {}],
        ['double_click', {}],
        ['left_click_drag', { start_coordinate: [1, 1], coordinate: [2, 2] }]
    ])('%s 之后左键已松开，不再补发', async (action, input) => {
        await executeComputerAction('left_mouse_down');
        await executeComputerAction(action, input);
        api.computerUse_releaseMouseButton.mockClear();

        await expect(releaseHeldMouseButton()).resolves.toBe(false);
        expect(api.computerUse_releaseMouseButton).not.toHaveBeenCalled();
    });

    it('右键点击不影响左键按下状态', async () => {
        await executeComputerAction('left_mouse_down');
        await executeComputerAction('right_click');

        await expect(releaseHeldMouseButton()).resolves.toBe(true);
    });

    it('左键没按着时不调用主进程', async () => {
        await expect(releaseHeldMouseButton()).resolves.toBe(false);
        expect(api.computerUse_releaseMouseButton).not.toHaveBeenCalled();
    });

    it('主进程松开失败时保留按下状态，下次再试', async () => {
        await executeComputerAction('left_mouse_down');
        api.computerUse_releaseMouseButton.mockResolvedValueOnce({
            success: false,
            error: 'input blocked'
        });

        await expect(releaseHeldMouseButton()).resolves.toBe(false);
        await expect(releaseHeldMouseButton()).resolves.toBe(true);
        expect(api.computerUse_releaseMouseButton).toHaveBeenCalledTimes(2);
    });

    it('按下失败时不记为按着', async () => {
        api.computerUse_pressMouseButton.mockResolvedValueOnce({
            success: false,
            error: 'Mouse permission denied'
        });

        await expect(executeComputerAction('left_mouse_down')).rejects.toThrow(
            'Mouse permission denied'
        );
        await expect(releaseHeldMouseButton()).resolves.toBe(false);
    });
});
