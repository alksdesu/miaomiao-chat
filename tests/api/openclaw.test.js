import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../js/core/state.js', () => ({
    state: { currentSessionId: 'current-session' }
}));

vi.mock('../../js/core/events.js', () => ({
    eventBus: { emit: vi.fn() }
}));

vi.mock('../../js/messages/schema.js', () => ({
    PartType: { TEXT: 'text' }
}));

vi.mock('../../js/utils/constants.js', () => ({
    WS_HEARTBEAT_TIMEOUT_RATIO: 2.5
}));

vi.mock('../../js/state/session-message-repository.js', () => ({
    materializeSessionMessages: vi.fn(async (_sessionId, messages) => messages)
}));

vi.mock('../../js/state/storage.js', () => ({
    loadSessionMessages: vi.fn(async () => ({ messages: [] }))
}));

vi.mock('../../js/utils/logger.js', () => ({
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

import { openclawClient, sendOpenClawRequest } from '../../js/api/openclaw.js';

describe('sendOpenClawRequest', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        globalThis.WebSocket = { OPEN: 1 };
        openclawClient.connected = true;
        openclawClient.url = 'wss://gateway.example';
        openclawClient.ws = { readyState: 1, send: vi.fn() };
        openclawClient._clearActiveRun();
    });

    afterEach(async () => {
        openclawClient.completeRun({ done: true });
        await Promise.resolve();
        openclawClient.ws = null;
        openclawClient.connected = false;
    });

    it('准备阶段即锁定全局单飞，拒绝并发请求', async () => {
        const context = {
            sessionId: 'session-a',
            sourceMessages: [{ role: 'user', parts: [{ type: 'text', text: 'hello' }] }],
            requestProfile: {
                modelParams: { temperature: 0.2 },
                thinkingCfg: null,
                tools: [],
                isXmlMode: false
            }
        };

        const first = sendOpenClawRequest(
            'wss://gateway.example',
            'token',
            'model-a',
            null,
            null,
            context
        );
        const second = sendOpenClawRequest(
            'wss://gateway.example',
            'token',
            'model-b',
            null,
            null,
            { ...context, sessionId: 'session-b' }
        );

        await expect(second).rejects.toThrow('当前已有请求正在运行');
        await expect(first).resolves.toMatchObject({ ok: true, status: 200 });

        const payload = JSON.parse(openclawClient.ws.send.mock.calls[0][0]);
        expect(payload.params).toMatchObject({
            sessionKey: 'session-a',
            message: 'hello',
            model: 'model-a',
            temperature: 0.2
        });
    });
});
