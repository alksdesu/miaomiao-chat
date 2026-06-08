/**
 * tools/init.js 测试
 * 工具系统初始化
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockRegisterTool = vi.fn();
const mockLoadToolStates = vi.fn();
const mockLoadCustomTools = vi.fn();
const mockSetToolEnabled = vi.fn();
const mockGetToolStats = vi.fn(() => ({ total: 5, enabled: 3, builtin: 5, mcp: 0, custom: 0 }));
const mockDebugTools = vi.fn(() => ({}));

vi.mock('../../js/tools/manager.js', () => ({
    registerTool: (...args) => mockRegisterTool(...args),
    loadToolStates: (...args) => mockLoadToolStates(...args),
    loadCustomTools: (...args) => mockLoadCustomTools(...args),
    setToolEnabled: (...args) => mockSetToolEnabled(...args),
    getToolStats: (...args) => mockGetToolStats(...args),
    debugTools: (...args) => mockDebugTools(...args)
}));

vi.mock('../../js/tools/builtin/calculator.js', () => ({
    calculator: { id: 'calculator', name: 'calculator', type: 'builtin' }
}));

vi.mock('../../js/tools/builtin/datetime.js', () => ({
    datetime: { id: 'datetime', name: 'datetime', type: 'builtin' }
}));

vi.mock('../../js/tools/builtin/unit-converter.js', () => ({
    unitConverter: { id: 'unit_converter', name: 'unit_converter', type: 'builtin' }
}));

vi.mock('../../js/tools/builtin/text-formatter.js', () => ({
    textFormatter: { id: 'text_formatter', name: 'text_formatter', type: 'builtin' }
}));

vi.mock('../../js/tools/builtin/random-generator.js', () => ({
    randomGenerator: { id: 'random_generator', name: 'random_generator', type: 'builtin' }
}));

vi.mock('../../js/utils/platform.js', () => ({
    isElectron: vi.fn(() => false)
}));

vi.mock('../../js/utils/logger.js', () => ({
    logger: {
        debug: vi.fn(),
        warn: vi.fn(),
        error: vi.fn()
    }
}));

vi.mock('../../js/tools/history.js', () => ({
    loadToolHistory: vi.fn().mockResolvedValue()
}));

import { initTools, getToolSystemStatus } from '../../js/tools/init.js';
import { isElectron } from '../../js/utils/platform.js';

beforeEach(() => {
    vi.clearAllMocks();
    mockLoadToolStates.mockResolvedValue();
    mockLoadCustomTools.mockResolvedValue();
});

describe('initTools', () => {
    it('注册内置工具', async () => {
        await initTools();
        expect(mockRegisterTool).toHaveBeenCalled();
        expect(mockRegisterTool.mock.calls.length).toBeGreaterThanOrEqual(5);
    }, 10000);

    it('加载自定义工具', async () => {
        await initTools();
        expect(mockLoadCustomTools).toHaveBeenCalled();
    }, 10000);

    it('加载工具状态 (includeUnregistered=true)', async () => {
        await initTools();
        expect(mockLoadToolStates).toHaveBeenCalledWith(true);
    }, 10000);

    it('自定义工具加载失败不抛出', async () => {
        mockLoadCustomTools.mockRejectedValue(new Error('load failed'));
        await expect(initTools()).resolves.not.toThrow();
    }, 10000);

    it('工具状态加载失败不抛出', async () => {
        mockLoadToolStates.mockRejectedValue(new Error('state failed'));
        await expect(initTools()).resolves.not.toThrow();
    }, 10000);

    it('非 Electron 环境不注册 Computer Use', async () => {
        isElectron.mockReturnValue(false);
        await initTools();
        expect(mockSetToolEnabled).not.toHaveBeenCalled();
    }, 10000);
});

describe('getToolSystemStatus', () => {
    it('返回状态对象', async () => {
        const status = await getToolSystemStatus();
        expect(status).toHaveProperty('initialized', true);
        expect(status).toHaveProperty('stats');
        expect(status).toHaveProperty('debug');
    });

    it('stats 包含数量字段', async () => {
        const status = await getToolSystemStatus();
        expect(status.stats).toHaveProperty('total');
        expect(status.stats).toHaveProperty('enabled');
    });
});
