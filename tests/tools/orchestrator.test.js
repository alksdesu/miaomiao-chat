/**
 * tools/orchestrator.js 工具调用编排器测试
 * 覆盖 executeToolCalls 并行执行/错误处理 + writeToolResultsBackToState 写回 part.result
 * （原 tests/stream/tool-call-handler.test.js 的非 accumulator 部分迁移）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// mock 依赖
vi.mock('../../js/core/events.js', () => ({
    eventBus: { emit: vi.fn(), on: vi.fn(), off: vi.fn() }
}));

vi.mock('../../js/core/state.js', () => ({
    state: {
        apiFormat: 'openai',
        isToolCallPending: false,
        currentAssistantMessage: null,
        currentSessionId: 'session-a',
        backgroundTasks: new Map(),
        sessions: [],
        messages: [],
        computerUseEnabled: true
    }
}));

// updateMessageAt mock 真实合并 updates 到 state.messages[i]，
// 让基于 state.messages 的断言能继续验证 mutator 写回结果
vi.mock('../../js/core/state-mutations.js', async () => {
    const { state } = await import('../../js/core/state.js');
    return {
        updateMessageAt: vi.fn((index, updates) => {
            if (index < 0 || index >= state.messages.length) return;
            state.messages[index] = { ...state.messages[index], ...updates };
        })
    };
});

vi.mock('../../js/core/request-state-machine.js', () => ({
    requestStateMachine: {
        transition: vi.fn(),
        transitionFor: vi.fn(),
        forceReset: vi.fn()
    },
    RequestState: {
        TOOL_CALLING: 'tool_calling',
        CONTINUATION: 'continuation',
        COMPLETED: 'completed',
        ERROR: 'error',
        CANCELLED: 'cancelled'
    }
}));

vi.mock('../../js/tools/executor.js', () => ({
    executeTool: vi.fn(async () => ({ text: 'result' }))
}));

vi.mock('../../js/tools/computer-actions.js', async (importOriginal) => ({
    ...(await importOriginal()),
    executeComputerAction: vi.fn(async () => ({
        content: '',
        media: [{ type: 'image', url: 'data:image/png;base64,SHOT', mimeType: 'image/png' }]
    })),
    releaseHeldMouseButton: vi.fn(async () => false)
}));

vi.mock('../../js/ui/tool-display.js', () => ({
    createToolCallUI: vi.fn(async () => {}),
    updateToolCallStatus: vi.fn()
}));

vi.mock('../../js/tools/undo.js', () => ({
    snapshotBeforeToolCall: vi.fn()
}));

vi.mock('../../js/providers/manager.js', () => ({
    getCurrentProvider: vi.fn(() => ({ apiFormat: 'openai' })),
    getActiveApiKey: vi.fn(() => 'test-key')
}));

vi.mock('../../js/messages/schema.js', async (importOriginal) => ({
    ...(await importOriginal()),
    validateToolPairings: vi.fn(() => ({ valid: true, orphans: [] }))
}));

vi.mock('../../js/messages/sync.js', () => ({
    writeToolResultsToBackgroundSession: vi.fn(async () => 1)
}));

vi.mock('../../js/api/handler.js', () => ({
    resendWithToolResults: vi.fn(async () => {})
}));

import {
    abortToolExecution,
    executeToolCalls,
    handleToolCallStream,
    writeToolResultsBackToState
} from '../../js/tools/orchestrator.js';
import { executeTool } from '../../js/tools/executor.js';
import {
    COMPUTER_ABORT_MESSAGE,
    COMPUTER_HALT_MESSAGE,
    executeComputerAction,
    releaseHeldMouseButton
} from '../../js/tools/computer-actions.js';
import { createToolCallUI, updateToolCallStatus } from '../../js/ui/tool-display.js';
import { state } from '../../js/core/state.js';
import { requestTaskRegistry } from '../../js/core/request-task-registry.js';
import { writeToolResultsToBackgroundSession } from '../../js/messages/sync.js';
import { resendWithToolResults } from '../../js/api/handler.js';
import { createToolNotFoundError } from '../../js/tools/tool-errors.js';

beforeEach(() => {
    vi.clearAllMocks();
    state.currentSessionId = 'session-a';
    state.backgroundTasks = new Map();
    state.isToolCallPending = false;
    requestTaskRegistry.clearForTests();
});

describe('handleToolCallStream 跨会话归属', () => {
    it('task 已 detach 但 currentSessionId 尚未切换时走后台写回', async () => {
        const task = requestTaskRegistry.create({
            sessionId: 'session-a',
            abortController: new AbortController()
        });
        requestTaskRegistry.detach(task);
        state.messages = [
            {
                role: 'assistant',
                parts: [
                    {
                        type: 'tool_call',
                        id: 'tc_detached',
                        name: 'search',
                        args: {},
                        state: 'pending'
                    }
                ]
            }
        ];
        executeTool.mockResolvedValueOnce({ text: 'done' });

        await handleToolCallStream([{ id: 'tc_detached', name: 'search', arguments: {} }], {
            sourceSessionId: 'session-a',
            task
        });

        expect(writeToolResultsToBackgroundSession).toHaveBeenCalledWith(
            'session-a',
            expect.arrayContaining([expect.objectContaining({ id: 'tc_detached' })])
        );
        expect(resendWithToolResults).toHaveBeenCalledWith(null, task);
        expect(state.messages[0].parts[0].state).toBe('pending');
        expect(state.isToolCallPending).toBe(false);
    });

    function createDetachedTask() {
        const task = requestTaskRegistry.create({
            sessionId: 'session-b',
            abortController: new AbortController()
        });
        requestTaskRegistry.detach(task);
        state.sessions = [{ id: 'session-b', name: '后台会话' }];
        return task;
    }

    it('后台工具结果没能写回时结束任务，并在提示里标明会话', async () => {
        const { eventBus } = await import('../../js/core/events.js');
        const task = createDetachedTask();
        writeToolResultsToBackgroundSession.mockResolvedValueOnce(0);

        await handleToolCallStream([{ id: 'tc_lost', name: 'search', arguments: {} }], {
            sourceSessionId: 'session-b',
            task
        });

        expect(resendWithToolResults).not.toHaveBeenCalled();
        expect(requestTaskRegistry.owns(task)).toBe(false);
        expect(requestTaskRegistry.hasFailure('session-b')).toBe(true);
        expect(eventBus.emit).toHaveBeenCalledWith(
            'ui:notification',
            expect.objectContaining({
                type: 'error',
                message: expect.stringContaining('「后台会话」')
            })
        );
    });

    it('后台工具流程失败时提示带会话名，失败结果写回出错也照样结束任务', async () => {
        const { eventBus } = await import('../../js/core/events.js');
        const task = createDetachedTask();
        resendWithToolResults.mockRejectedValueOnce(new Error('续作失败'));
        writeToolResultsToBackgroundSession
            .mockResolvedValueOnce(1)
            .mockRejectedValueOnce(new Error('写回失败'));

        await handleToolCallStream([{ id: 'tc_fail', name: 'search', arguments: {} }], {
            sourceSessionId: 'session-b',
            task
        });

        expect(requestTaskRegistry.owns(task)).toBe(false);
        expect(task.isToolCallPending).toBe(false);
        expect(eventBus.emit).toHaveBeenCalledWith(
            'ui:notification',
            expect.objectContaining({ message: '「后台会话」工具调用失败: 续作失败' })
        );
    });
});

// ========== executeToolCalls ==========

describe('executeToolCalls', () => {
    it('执行单个工具调用并返回结果', async () => {
        const toolCalls = [{ id: 'tc_1', name: 'search', arguments: { q: 'test' } }];
        executeTool.mockResolvedValueOnce({ text: 'found it' });

        const results = await executeToolCalls(toolCalls);

        expect(results).toHaveLength(1);
        expect(results[0].id).toBe('tc_1');
        expect(results[0].isError).toBe(false);
        expect(createToolCallUI).toHaveBeenCalledWith(
            expect.objectContaining({ id: 'tc_1', name: 'search' })
        );
        expect(updateToolCallStatus).toHaveBeenCalledWith('tc_1', 'completed', expect.any(Object));
    });

    it('并行执行多个工具调用', async () => {
        const toolCalls = [
            { id: 'tc_1', name: 'search', arguments: { q: 'a' } },
            { id: 'tc_2', name: 'calc', arguments: { expr: '1+1' } }
        ];
        executeTool.mockResolvedValue({ text: 'result' });

        const results = await executeToolCalls(toolCalls);

        expect(results).toHaveLength(2);
        expect(createToolCallUI).toHaveBeenCalledTimes(2);
    });

    it('处理工具执行失败', async () => {
        const toolCalls = [{ id: 'tc_1', name: 'broken_tool', arguments: {} }];
        executeTool.mockRejectedValueOnce(new Error('Tool not found'));

        const results = await executeToolCalls(toolCalls);

        expect(results).toHaveLength(1);
        expect(results[0].isError).toBe(true);
        expect(results[0].result.is_error).toBe(true);
        expect(updateToolCallStatus).toHaveBeenCalledWith('tc_1', 'failed', expect.any(Object));
    });

    it('处理缺少参数错误', async () => {
        const toolCalls = [{ id: 'tc_1', name: 'strict_tool', arguments: {} }];
        executeTool.mockRejectedValueOnce(new Error('Missing required parameter: query'));

        const results = await executeToolCalls(toolCalls);

        expect(results[0].result.error).toContain('Missing required parameter');
        expect(results[0].result.error).toContain('Do NOT retry');
    });

    it('处理工具不存在错误', async () => {
        const toolCalls = [{ id: 'tc_1', name: 'missing', arguments: {} }];
        executeTool.mockRejectedValueOnce(createToolNotFoundError('工具不存在: missing'));

        const results = await executeToolCalls(toolCalls);

        expect(results[0].result.error).toContain('not available');
    });

    it('错误文字里含 not found 的普通失败不当成工具不存在', async () => {
        executeTool.mockRejectedValueOnce(new Error('record not found'));

        const results = await executeToolCalls([{ id: 'tc_1', name: 'lookup', arguments: {} }]);

        expect(results[0].result.error).not.toContain('not available');
        expect(results[0].result.error).toContain('record not found');
    });

    it('命令与文件编辑失败只回报原因，模型可以改参数继续', async () => {
        executeTool.mockRejectedValueOnce(new Error('old_str not found in file'));

        const results = await executeToolCalls([
            { id: 'tc_1', name: 'str_replace_based_edit_tool', arguments: {}, mode: 'native' }
        ]);

        expect(results[0].result.error).toBe('Error: old_str not found in file');
    });

    it('处理 MCP content 数组格式结果', async () => {
        const toolCalls = [{ id: 'tc_1', name: 'mcp_tool', arguments: {} }];
        executeTool.mockResolvedValueOnce({
            content: [
                { type: 'text', text: 'hello' },
                { type: 'image', data: 'base64data', mimeType: 'image/png' }
            ]
        });

        const results = await executeToolCalls(toolCalls);

        expect(results[0].isError).toBe(false);
    });

    it('后台执行不创建前台工具 UI 或撤销快照', async () => {
        const { snapshotBeforeToolCall } = await import('../../js/tools/undo.js');
        await executeToolCalls([{ id: 'tc_bg', name: 'search', arguments: {} }], {
            captureUndo: false,
            resolveTargetContainer: () => null,
            sessionId: 'session-a'
        });

        expect(createToolCallUI).not.toHaveBeenCalled();
        expect(updateToolCallStatus).not.toHaveBeenCalled();
        expect(snapshotBeforeToolCall).not.toHaveBeenCalled();
    });

    it('把发起时格式快照和会话传给执行器', async () => {
        await executeToolCalls([{ id: 'tc_profile', name: 'computer', arguments: {} }], {
            sessionId: 'session-a',
            turnId: 'request-a',
            requestProfile: { providerApiFormat: 'claude', isXmlMode: true }
        });

        expect(executeTool).toHaveBeenCalledWith(
            'computer',
            {},
            expect.objectContaining({
                apiFormat: 'claude',
                isXmlMode: true,
                sessionId: 'session-a',
                turnId: 'request-a'
            })
        );
    });
});

// ========== computer 动作 ==========

describe('executeToolCalls computer 动作', () => {
    const toolsetCall = (id, name, args = {}) => ({
        id,
        name,
        arguments: args,
        toolsetName: 'computer',
        mode: 'native'
    });

    // 记录同时在执行的调用数，GUI 动作必须逐个执行
    function trackConcurrency(resolveValue = { content: 'OK' }) {
        const tracker = { active: 0, peak: 0, actions: [] };
        executeTool.mockImplementation(async (toolId, args) => {
            tracker.active++;
            tracker.peak = Math.max(tracker.peak, tracker.active);
            tracker.actions.push(args?.action ?? toolId);
            await new Promise((resolve) => setTimeout(resolve, 5));
            tracker.active--;
            return resolveValue;
        });
        return tracker;
    }

    afterEach(() => {
        executeTool.mockReset();
        executeTool.mockImplementation(async () => ({ text: 'result' }));
    });

    it('工具集成员按顺序以 computer 工具执行，成员名作为 action', async () => {
        const tracker = trackConcurrency();

        await executeToolCalls(
            [
                toolsetCall('a', 'left_click', { coordinate: [10, 20] }),
                toolsetCall('b', 'type', { text: 'hi' }),
                toolsetCall('c', 'screenshot')
            ],
            { requestProfile: { providerApiFormat: 'claude', isXmlMode: false } }
        );

        expect(tracker.peak).toBe(1);
        expect(tracker.actions).toEqual(['left_click', 'type', 'screenshot']);
        expect(executeTool).toHaveBeenNthCalledWith(
            1,
            'computer',
            { coordinate: [10, 20], action: 'left_click' },
            expect.objectContaining({ apiFormat: 'claude', isXmlMode: false })
        );
    });

    it('一个动作失败后其余动作不执行，并回复固定的中止文字', async () => {
        executeTool.mockRejectedValueOnce(new Error('Mouse permission denied'));

        const results = await executeToolCalls([
            toolsetCall('a', 'left_click'),
            toolsetCall('b', 'type', { text: 'x' }),
            toolsetCall('c', 'key', { text: 'Return' })
        ]);

        expect(executeTool).toHaveBeenCalledTimes(1);
        expect(results.map((r) => r.isError)).toEqual([true, true, true]);
        expect(results[0].result.error).toBe('Error: Mouse permission denied');
        expect(results[1].result).toEqual({
            error: COMPUTER_HALT_MESSAGE,
            is_error: true,
            error_kind: 'not_executed'
        });
        expect(results[2].result.error).toBe(COMPUTER_HALT_MESSAGE);
        // 界面按未执行展示，不算失败；发给模型的仍是英文原文
        expect(updateToolCallStatus).toHaveBeenCalledWith('b', 'skipped', {
            result: results[1].result
        });
        expect(updateToolCallStatus).not.toHaveBeenCalledWith('b', 'failed', expect.anything());
        expect(executeComputerAction).not.toHaveBeenCalled();
    });

    it('批量动作没有以截图结束时，最后一个动作的结果附带截图', async () => {
        executeTool.mockResolvedValue({ content: 'OK' });

        const results = await executeToolCalls([
            toolsetCall('a', 'left_click'),
            toolsetCall('b', 'type', { text: 'x' })
        ]);

        expect(executeComputerAction).toHaveBeenCalledTimes(1);
        expect(executeComputerAction).toHaveBeenCalledWith('screenshot', {}, { signal: null });
        expect(results[0].result).toEqual({ content: 'OK' });
        expect(results[1].result).toEqual({
            content: 'OK',
            media: [expect.objectContaining({ type: 'image', url: 'data:image/png;base64,SHOT' })]
        });
        // 截图并进结果后才更新一次 UI，完成计数不会重复累加
        const lastCallUpdates = updateToolCallStatus.mock.calls.filter(([id]) => id === 'b');
        expect(lastCallUpdates).toEqual([['b', 'completed', { result: results[1].result }]]);
    });

    it('截图权限关闭时不补截图', async () => {
        executeTool.mockResolvedValue({ content: 'OK' });
        state.computerUsePermissions = { screenshot: false };
        try {
            const results = await executeToolCalls([toolsetCall('a', 'left_click')]);

            expect(executeComputerAction).not.toHaveBeenCalled();
            expect(results[0].result).toEqual({ content: 'OK' });
        } finally {
            delete state.computerUsePermissions;
        }
    });

    it('以截图或放大结束的批量动作不再补截图', async () => {
        executeTool.mockResolvedValue({ content: '', media: [] });

        await executeToolCalls([toolsetCall('a', 'left_click'), toolsetCall('b', 'zoom')]);

        expect(executeComputerAction).not.toHaveBeenCalled();
    });

    it('补截图失败不影响动作本身的结果', async () => {
        executeTool.mockResolvedValue({ content: 'OK' });
        executeComputerAction.mockRejectedValueOnce(new Error('Screenshot permission denied'));

        const results = await executeToolCalls([toolsetCall('a', 'left_click')]);

        expect(results[0]).toMatchObject({ isError: false, result: { content: 'OK' } });
    });

    it('请求已取消时不补截图', async () => {
        executeTool.mockResolvedValue({ content: 'OK' });
        const controller = new AbortController();
        controller.abort();

        await executeToolCalls([toolsetCall('a', 'left_click')], { signal: controller.signal });

        expect(executeComputerAction).not.toHaveBeenCalled();
    });

    it('旧版 computer 工具的多个调用也逐个执行，失败不中止后续调用', async () => {
        const tracker = trackConcurrency();
        const tracked = executeTool.getMockImplementation();
        executeTool.mockImplementationOnce(async (...args) => {
            await tracked(...args);
            throw new Error('Keyboard permission denied');
        });

        const results = await executeToolCalls([
            { id: 'a', name: 'computer', arguments: { action: 'key', text: 'a' }, mode: 'native' },
            { id: 'b', name: 'computer', arguments: { action: 'screenshot' }, mode: 'native' }
        ]);

        expect(tracker.peak).toBe(1);
        expect(results[0].result.error).toBe('Error: Keyboard permission denied');
        expect(results[1].isError).toBe(false);
        expect(executeComputerAction).not.toHaveBeenCalled();
    });

    it('普通工具与 computer 动作同轮时照常并行执行', async () => {
        const tracker = trackConcurrency();

        await executeToolCalls([
            toolsetCall('a', 'left_click'),
            { id: 'b', name: 'search', arguments: { q: 'x' } },
            toolsetCall('c', 'screenshot')
        ]);

        expect(tracker.peak).toBe(2);
    });

    it('XML 模式下名为 computer 的自定义工具不按 GUI 动作排队', async () => {
        const tracker = trackConcurrency();

        await executeToolCalls([
            { id: 'a', name: 'computer', arguments: { action: 'bash' }, mode: 'xml' },
            { id: 'b', name: 'computer', arguments: { action: 'bash' }, mode: 'xml' }
        ]);

        expect(tracker.peak).toBe(2);
    });

    it('Computer Use 关闭后不再补截图', async () => {
        executeTool.mockResolvedValue({ content: 'OK' });
        state.computerUseEnabled = false;
        try {
            await executeToolCalls([toolsetCall('a', 'left_click')]);

            expect(executeComputerAction).not.toHaveBeenCalled();
        } finally {
            state.computerUseEnabled = true;
        }
    });
});

// ========== 停止请求与输入状态释放 ==========

describe('executeToolCalls 停止请求', () => {
    const toolsetCall = (id, name, args = {}) => ({
        id,
        name,
        arguments: args,
        toolsetName: 'computer',
        mode: 'native'
    });
    const abortedResult = {
        error: COMPUTER_ABORT_MESSAGE,
        is_error: true,
        error_kind: 'aborted',
        executed: false
    };

    afterEach(() => {
        executeTool.mockReset();
        executeTool.mockImplementation(async () => ({ text: 'result' }));
    });

    it('停止后排队中的工具集动作不再执行，记为已中止而不是成功或用户拒绝', async () => {
        const controller = new AbortController();
        executeTool.mockImplementationOnce(async () => {
            controller.abort();
            return { content: 'OK' };
        });

        const results = await executeToolCalls(
            [
                toolsetCall('a', 'left_click'),
                toolsetCall('b', 'type', { text: 'x' }),
                toolsetCall('c', 'key', { text: 'Return' })
            ],
            { signal: controller.signal }
        );

        expect(executeTool).toHaveBeenCalledTimes(1);
        expect(results[0]).toMatchObject({ isError: false, result: { content: 'OK' } });
        expect(results[1]).toMatchObject({ isError: true, result: abortedResult });
        expect(results[2]).toMatchObject({ isError: true, result: abortedResult });
        expect(updateToolCallStatus).toHaveBeenCalledWith('b', 'skipped', {
            result: results[1].result
        });
        expect(updateToolCallStatus).not.toHaveBeenCalledWith('b', 'completed', expect.anything());
        expect(executeComputerAction).not.toHaveBeenCalled();
    });

    it('停止后排队中的旧版 computer 动作同样不再执行', async () => {
        const controller = new AbortController();
        executeTool.mockImplementationOnce(async () => {
            controller.abort();
            return { content: 'OK' };
        });

        const results = await executeToolCalls(
            [
                { id: 'a', name: 'computer', arguments: { action: 'key', text: 'a' } },
                { id: 'b', name: 'computer', arguments: { action: 'left_click' } }
            ],
            { signal: controller.signal }
        );

        expect(executeTool).toHaveBeenCalledTimes(1);
        expect(results[1]).toMatchObject({ isError: true, result: abortedResult });
    });

    it('执行中被停止的动作显示为已中止，后续动作按已停止回复而不是失败中止文字', async () => {
        const controller = new AbortController();
        executeTool.mockImplementationOnce(async () => {
            controller.abort();
            throw new DOMException('Tool execution aborted', 'AbortError');
        });

        const results = await executeToolCalls(
            [toolsetCall('a', 'wait', { duration: 30 }), toolsetCall('b', 'left_click')],
            { signal: controller.signal }
        );

        expect(results[0].result.error_kind).toBe('aborted');
        expect(results[0].result.error).toContain('aborted by the user');
        expect(results[1].result).toEqual(abortedResult);
        expect(updateToolCallStatus).toHaveBeenCalledWith('a', 'skipped', {
            result: results[0].result
        });
    });

    it('前一个动作已经失败时，停止后其余动作仍回复失败中止文字', async () => {
        const controller = new AbortController();
        executeTool.mockImplementationOnce(async () => {
            controller.abort();
            throw new Error('Mouse permission denied');
        });

        const results = await executeToolCalls(
            [toolsetCall('a', 'left_click'), toolsetCall('b', 'type', { text: 'x' })],
            { signal: controller.signal }
        );

        expect(results[1].result.error).toBe(COMPUTER_HALT_MESSAGE);
    });

    it('确认弹窗期间被停止的动作记为未执行，computer 动作回复已停止文字', async () => {
        const notExecuted = () =>
            Object.assign(new DOMException('aborted', 'AbortError'), { notExecuted: true });
        executeTool.mockRejectedValueOnce(notExecuted()).mockRejectedValueOnce(notExecuted());

        const results = await executeToolCalls([
            toolsetCall('a', 'left_click'),
            { id: 't', name: 'search', arguments: {} }
        ]);

        expect(results[0].result).toMatchObject({
            error: COMPUTER_ABORT_MESSAGE,
            error_kind: 'aborted',
            executed: false
        });
        expect(results[1].result).toMatchObject({ error_kind: 'aborted', executed: false });
        expect(results[1].result.error).toContain('was not executed');
        expect(updateToolCallStatus).toHaveBeenCalledWith('a', 'skipped', {
            result: results[0].result
        });
    });

    it('普通工具执行中被停止时显示为已中止，不显示失败', async () => {
        executeTool.mockRejectedValueOnce(new DOMException('aborted', 'AbortError'));

        const results = await executeToolCalls([{ id: 't', name: 'search', arguments: {} }]);

        expect(results[0].result.error_kind).toBe('aborted');
        expect(updateToolCallStatus).toHaveBeenCalledWith('t', 'skipped', {
            result: results[0].result
        });
        expect(updateToolCallStatus).not.toHaveBeenCalledWith('t', 'failed', expect.anything());
    });

    it('动作失败或被停止后松开 left_mouse_down 按下的左键；正常完成不松开', async () => {
        executeTool.mockResolvedValue({ content: 'OK' });
        await executeToolCalls([toolsetCall('a', 'left_mouse_down'), toolsetCall('b', 'zoom')]);
        expect(releaseHeldMouseButton).not.toHaveBeenCalled();

        executeTool.mockRejectedValueOnce(new Error('Mouse permission denied'));
        await executeToolCalls([toolsetCall('c', 'mouse_move'), toolsetCall('d', 'screenshot')]);
        expect(releaseHeldMouseButton).toHaveBeenCalled();

        releaseHeldMouseButton.mockClear();
        const controller = new AbortController();
        executeTool.mockImplementationOnce(async () => {
            controller.abort();
            return { content: 'OK' };
        });
        await executeToolCalls([toolsetCall('e', 'mouse_move')], { signal: controller.signal });
        expect(releaseHeldMouseButton).toHaveBeenCalled();
    });
});

describe('handleToolCallStream 停止后释放任务', () => {
    afterEach(() => {
        executeTool.mockReset();
        executeTool.mockImplementation(async () => ({ text: 'result' }));
    });

    it('不指定任务的取消不会中止属于某个请求任务的工具执行', async () => {
        const task = requestTaskRegistry.create({
            sessionId: 'session-a',
            abortController: new AbortController()
        });
        let seenSignal = null;
        executeTool.mockImplementationOnce(async (_name, _args, options) => {
            abortToolExecution();
            seenSignal = options.signal;
            return { content: 'OK' };
        });

        await handleToolCallStream([{ id: 't1', name: 'search', arguments: {} }], {
            sourceSessionId: 'session-a',
            task
        });

        expect(seenSignal.aborted).toBe(false);
    });

    it('停止后不等排队动作跑完就结束任务，输入框随即可用', async () => {
        const task = requestTaskRegistry.create({
            sessionId: 'session-a',
            abortController: new AbortController()
        });
        state.messages = [
            {
                role: 'assistant',
                parts: ['a', 'b', 'c'].map((id) => ({
                    type: 'tool_call',
                    id,
                    name: 'left_click',
                    toolsetName: 'computer',
                    args: {},
                    state: 'pending'
                }))
            }
        ];
        executeTool.mockImplementationOnce(async () => {
            abortToolExecution(task);
            return { content: 'OK' };
        });

        await handleToolCallStream(
            ['a', 'b', 'c'].map((id) => ({
                id,
                name: 'left_click',
                arguments: {},
                toolsetName: 'computer',
                mode: 'native'
            })),
            { sourceSessionId: 'session-a', task }
        );

        expect(executeTool).toHaveBeenCalledTimes(1);
        expect(resendWithToolResults).not.toHaveBeenCalled();
        expect(requestTaskRegistry.getBySession('session-a')).toBeNull();
        expect(state.isToolCallPending).toBe(false);
        expect(state.messages[0].parts.map((part) => part.state)).toEqual([
            'done',
            'error',
            'error'
        ]);
        expect(state.messages[0].parts[1].result).toMatchObject({
            error: COMPUTER_ABORT_MESSAGE,
            error_kind: 'aborted'
        });
    });
});

// ========== Code Execution 文件下载 ==========

describe('Code Execution 文件下载', () => {
    const fileResult = (fileId) => ({
        content: {
            type: 'bash_code_execution_result',
            content: [{ type: 'file', file_id: fileId, file_type: 'image/png' }]
        }
    });
    const codeCall = { id: 'code', name: 'code_execution', arguments: {} };
    let fetchSpy;

    beforeEach(() => {
        fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
            ok: true,
            arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer
        });
    });

    afterEach(() => {
        fetchSpy.mockRestore();
        executeTool.mockReset();
        executeTool.mockImplementation(async () => ({ text: 'result' }));
    });

    it('用任务锁定的端点与密钥下载，不读当前渠道', async () => {
        executeTool.mockResolvedValueOnce(fileResult('file/1'));

        const results = await executeToolCalls([codeCall], {
            requestOrigin: {
                requestFormat: 'claude',
                endpoint: 'https://proxy.example.com/anthropic/v1/messages',
                apiKey: 'origin-key'
            },
            requestProfile: { customHeaders: { 'X-Proxy-Token': 't' } }
        });

        expect(fetchSpy).toHaveBeenCalledWith(
            'https://proxy.example.com/anthropic/v1/files/file%2F1',
            {
                headers: expect.objectContaining({
                    'x-api-key': 'origin-key',
                    'X-Proxy-Token': 't'
                })
            }
        );
        expect(results[0].result.images[0].url).toBe('data:image/png;base64,AQID');
    });

    it('没有请求来源、来源不是 Claude 或端点不是 messages 地址时不下载', async () => {
        executeTool.mockResolvedValue(fileResult('file_1'));

        await executeToolCalls([codeCall]);
        await executeToolCalls([codeCall], {
            requestOrigin: {
                requestFormat: 'openai',
                endpoint: 'https://api.openai.com/v1/chat/completions',
                apiKey: 'openai-key'
            }
        });
        await executeToolCalls([codeCall], {
            requestOrigin: {
                requestFormat: 'claude',
                endpoint: 'https://proxy.example.com/claude',
                apiKey: 'k'
            }
        });

        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('handleToolCallStream 把任务的请求来源传给下载', async () => {
        const task = requestTaskRegistry.create({
            sessionId: 'session-a',
            abortController: new AbortController()
        });
        task.requestOrigin = {
            requestFormat: 'claude',
            endpoint: 'https://api.anthropic.com/v1/messages',
            apiKey: 'task-key'
        };
        state.messages = [
            {
                role: 'assistant',
                parts: [{ type: 'tool_call', id: 'code', name: 'code_execution', state: 'pending' }]
            }
        ];
        executeTool.mockResolvedValueOnce(fileResult('file_9'));

        await handleToolCallStream([codeCall], { sourceSessionId: 'session-a', task });

        expect(fetchSpy).toHaveBeenCalledWith('https://api.anthropic.com/v1/files/file_9', {
            headers: expect.objectContaining({ 'x-api-key': 'task-key' })
        });
    });
});

// ========== writeToolResultsBackToState ==========

describe('writeToolResultsBackToState', () => {
    beforeEach(() => {
        state.messages = [];
    });

    it('把 result 写回最后一条 assistant 的对应 part', () => {
        state.messages = [
            { role: 'user', parts: [{ type: 'text', text: 'q' }] },
            {
                role: 'assistant',
                parts: [
                    { type: 'text', text: '调用工具' },
                    {
                        type: 'tool_call',
                        id: 'tc_1',
                        name: 'search',
                        args: {},
                        state: 'pending',
                        result: null
                    }
                ]
            }
        ];

        writeToolResultsBackToState([
            { id: 'tc_1', name: 'search', result: { content: 'ok' }, isError: false }
        ]);

        const assistant = state.messages[1];
        expect(assistant.parts[1].result).toEqual({ content: 'ok' });
        expect(assistant.parts[1].state).toBe('done');
    });

    it('忽略不匹配 id 的 result', () => {
        state.messages = [
            {
                role: 'assistant',
                parts: [
                    {
                        type: 'tool_call',
                        id: 'tc_real',
                        name: 'search',
                        state: 'pending',
                        result: null
                    }
                ]
            }
        ];

        writeToolResultsBackToState([
            { id: 'tc_fake', name: 'search', result: { content: 'ignored' }, isError: false }
        ]);

        expect(state.messages[0].parts[0].result).toBeNull();
        expect(state.messages[0].parts[0].state).toBe('pending');
    });

    it('倒序找最近 assistant 消息，跳过 user/system', () => {
        state.messages = [
            {
                role: 'assistant',
                parts: [
                    {
                        type: 'tool_call',
                        id: 'tc_old',
                        name: 'old',
                        state: 'done',
                        result: { content: 'old' }
                    }
                ]
            },
            { role: 'user', parts: [{ type: 'text', text: 'next' }] },
            {
                role: 'assistant',
                parts: [
                    {
                        type: 'tool_call',
                        id: 'tc_new',
                        name: 'new',
                        state: 'pending',
                        result: null
                    }
                ]
            }
        ];

        writeToolResultsBackToState([
            { id: 'tc_new', name: 'new', result: { content: 'fresh' }, isError: false }
        ]);

        // 第一条 assistant 不被覆盖
        expect(state.messages[0].parts[0].result).toEqual({ content: 'old' });
        // 第二条 assistant 收到结果
        expect(state.messages[2].parts[0].result).toEqual({ content: 'fresh' });
    });

    it('错误 result 写 state=error', () => {
        state.messages = [
            {
                role: 'assistant',
                parts: [
                    {
                        type: 'tool_call',
                        id: 'tc_1',
                        name: 'broken',
                        state: 'pending',
                        result: null
                    }
                ]
            }
        ];

        writeToolResultsBackToState([
            {
                id: 'tc_1',
                name: 'broken',
                result: { error: 'Tool failed. Do NOT retry.', is_error: true },
                isError: true
            }
        ]);

        expect(state.messages[0].parts[0].state).toBe('error');
        expect(state.messages[0].parts[0].result.is_error).toBe(true);
    });

    it('跨越纯文本 assistant 找到含 tool_call 的更早 assistant 写回', () => {
        // 场景：pause_turn 后落了一条纯 thinking/text assistant，
        // 前一条带 pending tool_call 的 assistant 才是 writeBack 目标
        state.messages = [
            {
                role: 'assistant',
                parts: [
                    {
                        type: 'tool_call',
                        id: 'tc_real',
                        name: 'search',
                        state: 'pending',
                        result: null
                    }
                ]
            },
            {
                role: 'assistant',
                parts: [{ type: 'text', text: 'pause_turn 后的纯文本' }]
            }
        ];

        writeToolResultsBackToState([
            { id: 'tc_real', name: 'search', result: { content: 'found' }, isError: false }
        ]);

        // 纯文本 assistant 被跳过，前一条含 tool_call 的写回
        expect(state.messages[0].parts[0].result).toEqual({ content: 'found' });
        expect(state.messages[0].parts[0].state).toBe('done');
    });
});

// ========== writeToolResultsBackToState multi-turn coverage ==========

describe('writeToolResultsBackToState multi-turn coverage', () => {
    beforeEach(() => {
        state.messages = [];
    });

    it('matches tool_call in oldest assistant when newer assistants have no tool_call', () => {
        state.messages = [
            {
                role: 'assistant',
                parts: [
                    { type: 'text', text: '调用工具中' },
                    {
                        type: 'tool_call',
                        id: 'tc_oldest',
                        name: 'search',
                        args: {},
                        state: 'pending',
                        result: null
                    }
                ]
            },
            { role: 'user', parts: [{ type: 'text', text: '继续' }] },
            { role: 'assistant', parts: [{ type: 'text', text: '中间纯文本回复' }] },
            { role: 'user', parts: [{ type: 'text', text: '再继续' }] },
            { role: 'assistant', parts: [{ type: 'text', text: '另一段纯文本' }] }
        ];

        const matched = writeToolResultsBackToState([
            { id: 'tc_oldest', name: 'search', result: { content: 'old result' }, isError: false }
        ]);

        expect(matched).toBe(1);
        expect(state.messages[0].parts[1].result).toEqual({ content: 'old result' });
        expect(state.messages[0].parts[1].state).toBe('done');
        expect(state.messages[2].parts[0].text).toBe('中间纯文本回复');
        expect(state.messages[4].parts[0].text).toBe('另一段纯文本');
    });

    it('matches tool_call in multiple assistants when continuation produced multi-turn (id 唯一不会错配)', () => {
        state.messages = [
            {
                role: 'assistant',
                parts: [
                    {
                        type: 'tool_call',
                        id: 'tc_a',
                        name: 'search',
                        args: { q: 'a' },
                        state: 'pending',
                        result: null
                    }
                ]
            },
            {
                role: 'assistant',
                parts: [
                    { type: 'text', text: '继续调用' },
                    {
                        type: 'tool_call',
                        id: 'tc_b',
                        name: 'calc',
                        args: { expr: '1+1' },
                        state: 'pending',
                        result: null
                    }
                ]
            },
            {
                role: 'assistant',
                parts: [
                    {
                        type: 'tool_call',
                        id: 'tc_c',
                        name: 'fetch',
                        args: { url: 'x' },
                        state: 'pending',
                        result: null
                    }
                ]
            }
        ];

        const matched = writeToolResultsBackToState([
            { id: 'tc_a', name: 'search', result: { content: 'res-a' }, isError: false },
            { id: 'tc_b', name: 'calc', result: { content: 'res-b' }, isError: false },
            { id: 'tc_c', name: 'fetch', result: { content: 'res-c' }, isError: false }
        ]);

        expect(matched).toBe(3);
        expect(state.messages[0].parts[0].result).toEqual({ content: 'res-a' });
        expect(state.messages[0].parts[0].state).toBe('done');
        expect(state.messages[1].parts[1].result).toEqual({ content: 'res-b' });
        expect(state.messages[1].parts[1].state).toBe('done');
        expect(state.messages[2].parts[0].result).toEqual({ content: 'res-c' });
        expect(state.messages[2].parts[0].state).toBe('done');
    });

    it('returns partial matched count when only some toolResults find matching parts', () => {
        state.messages = [
            {
                role: 'assistant',
                parts: [
                    {
                        type: 'tool_call',
                        id: 'tc_have_1',
                        name: 'search',
                        state: 'pending',
                        result: null
                    }
                ]
            },
            {
                role: 'assistant',
                parts: [
                    {
                        type: 'tool_call',
                        id: 'tc_have_2',
                        name: 'calc',
                        state: 'pending',
                        result: null
                    }
                ]
            }
        ];

        const matched = writeToolResultsBackToState([
            { id: 'tc_have_1', name: 'search', result: { content: 'r1' }, isError: false },
            { id: 'tc_missing', name: 'ghost', result: { content: 'never' }, isError: false },
            { id: 'tc_have_2', name: 'calc', result: { content: 'r2' }, isError: false }
        ]);

        expect(matched).toBe(2);
        expect(state.messages[0].parts[0].result).toEqual({ content: 'r1' });
        expect(state.messages[0].parts[0].state).toBe('done');
        expect(state.messages[1].parts[0].result).toEqual({ content: 'r2' });
        expect(state.messages[1].parts[0].state).toBe('done');
    });

    it('does not break on first match (verifies all含 tool_call 的 assistant 都被遍历)', () => {
        state.messages = [
            {
                role: 'assistant',
                parts: [
                    {
                        type: 'tool_call',
                        id: 'tc_first',
                        name: 'search',
                        state: 'pending',
                        result: null
                    }
                ]
            },
            { role: 'user', parts: [{ type: 'text', text: '继续' }] },
            {
                role: 'assistant',
                parts: [
                    {
                        type: 'tool_call',
                        id: 'tc_second',
                        name: 'fetch',
                        state: 'pending',
                        result: null
                    }
                ]
            }
        ];

        const matched = writeToolResultsBackToState([
            { id: 'tc_first', name: 'search', result: { content: 'first-done' }, isError: false },
            { id: 'tc_second', name: 'fetch', result: { content: 'second-done' }, isError: true }
        ]);

        expect(matched).toBe(2);
        expect(state.messages[0].parts[0].result).toEqual({ content: 'first-done' });
        expect(state.messages[0].parts[0].state).toBe('done');
        expect(state.messages[2].parts[0].result).toEqual({ content: 'second-done' });
        expect(state.messages[2].parts[0].state).toBe('error');
    });
});
