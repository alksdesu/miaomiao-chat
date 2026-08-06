import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../js/core/state.js', () => ({
    state: {
        sessions: [],
        backgroundTasks: new Map()
    }
}));

vi.mock('../../js/core/events.js', () => ({
    eventBus: { emit: vi.fn() }
}));

import { RequestTaskRegistry } from '../../js/core/request-task-registry.js';
import { state } from '../../js/core/state.js';

describe('RequestTaskRegistry', () => {
    let registry;

    beforeEach(() => {
        registry = new RequestTaskRegistry();
        state.backgroundTasks.clear();
    });

    it('同一会话单飞，不同会话可以并行', () => {
        const first = registry.create({
            sessionId: 'session-a',
            abortController: new AbortController()
        });
        const duplicate = registry.create({
            sessionId: 'session-a',
            abortController: new AbortController()
        });
        const other = registry.create({
            sessionId: 'session-b',
            abortController: new AbortController()
        });

        expect(first).toBeTruthy();
        expect(duplicate).toBeNull();
        expect(other).toBeTruthy();
    });

    it('detach 只转后台，不中止请求', () => {
        const controller = new AbortController();
        const task = registry.create({ sessionId: 'session-a', abortController: controller });

        expect(registry.detach(task)).toBe(true);
        expect(controller.signal.aborted).toBe(false);
        expect(task.isDetached).toBe(true);
        expect(state.backgroundTasks.get('session-a')).toBe(task);

        expect(registry.attach(task)).toBe(true);
        expect(task.isDetached).toBe(false);
        expect(state.backgroundTasks.has('session-a')).toBe(false);
    });

    it('旧任务不能修改替代它的新任务', () => {
        const oldTask = registry.create({
            sessionId: 'session-a',
            abortController: new AbortController()
        });
        registry.finish(oldTask, 'completed');
        const currentTask = registry.create({
            sessionId: 'session-a',
            abortController: new AbortController()
        });

        expect(registry.setPhase(oldTask, 'error')).toBe(false);
        expect(registry.getBySession('session-a')).toBe(currentTask);
        expect(currentTask.phase).toBe('sending');
    });

    it('finish 等待方可观察结果并释放索引', async () => {
        const task = registry.create({
            sessionId: 'session-a',
            abortController: new AbortController()
        });
        const completion = task.completionPromise;

        expect(registry.finish(task, 'completed', { saved: true })).toBe(true);
        await expect(completion).resolves.toMatchObject({
            phase: 'completed',
            detail: { saved: true }
        });
        expect(registry.getBySession('session-a')).toBeNull();
        expect(registry.getById(task.id)).toBeNull();
    });

    it('abort 同时取消请求和工具执行', () => {
        const requestController = new AbortController();
        const toolController = new AbortController();
        const task = registry.create({
            sessionId: 'session-a',
            abortController: requestController
        });
        registry.setToolAbortController(task, toolController);

        expect(registry.abort(task)).toBe(true);
        expect(requestController.signal.aborted).toBe(true);
        expect(toolController.signal.aborted).toBe(true);
        expect(registry.isActive(task)).toBe(false);
        expect(registry.detach(task)).toBe(false);
        expect(registry.attach(task)).toBe(false);
    });

    it('替换已结束任务时释放旧任务的完成等待', async () => {
        const oldTask = registry.create({
            sessionId: 'session-a',
            abortController: new AbortController()
        });
        registry.setPhase(oldTask, 'cancelled');

        const currentTask = registry.create({
            sessionId: 'session-a',
            abortController: new AbortController()
        });

        await expect(oldTask.completionPromise).resolves.toMatchObject({
            phase: 'cancelled',
            detail: { reason: 'terminal-replaced' }
        });
        expect(registry.getBySession('session-a')).toBe(currentTask);
    });
});
