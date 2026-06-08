/**
 * tool-injection.js 测试
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../js/core/state.js', () => ({
    state: { xmlToolCallingEnabled: true }
}));

import { state } from '../../js/core/state.js';
import {
    injectToolsToOpenAI,
    injectToolsToClaude,
    injectToolsToGemini,
    getXMLInjectionStats,
    trackXMLToolCall,
    getMetrics,
    resetMetrics
} from '../../js/tools/tool-injection.js';

beforeEach(() => {
    state.xmlToolCallingEnabled = true;
    resetMetrics();
});

// ========== injectToolsToOpenAI ==========

describe('injectToolsToOpenAI', () => {
    it('注入到现有 system 消息', () => {
        const messages = [
            { role: 'system', content: 'You are an assistant.' },
            { role: 'user', content: 'hello' }
        ];
        injectToolsToOpenAI(messages, [{ name: 'search', description: 'Search' }]);
        expect(messages[0].content).toContain('search');
    });

    it('创建新 system 消息', () => {
        const messages = [{ role: 'user', content: 'hello' }];
        injectToolsToOpenAI(messages, [{ name: 'tool1' }]);
        expect(messages[0].role).toBe('system');
        expect(messages[0].content).toContain('tool1');
    });

    it('XML 未启用时不注入', () => {
        state.xmlToolCallingEnabled = false;
        const messages = [{ role: 'system', content: 'original' }];
        injectToolsToOpenAI(messages, [{ name: 'tool1' }]);
        expect(messages[0].content).toBe('original');
    });

    it('空工具列表不注入', () => {
        const messages = [{ role: 'system', content: 'original' }];
        injectToolsToOpenAI(messages, []);
        expect(messages[0].content).toBe('original');
    });

    it('null 工具列表不注入', () => {
        const messages = [{ role: 'system', content: 'original' }];
        injectToolsToOpenAI(messages, null);
        expect(messages[0].content).toBe('original');
    });
});

// ========== injectToolsToClaude ==========

describe('injectToolsToClaude', () => {
    it('追加到现有 system', () => {
        const body = { system: 'You are Claude.' };
        injectToolsToClaude(body, [{ name: 'calc' }]);
        expect(body.system).toContain('calc');
        expect(body.system).toContain('You are Claude.');
    });

    it('创建新 system', () => {
        const body = {};
        injectToolsToClaude(body, [{ name: 'tool1' }]);
        expect(body.system).toContain('tool1');
    });

    it('XML 未启用时不注入', () => {
        state.xmlToolCallingEnabled = false;
        const body = { system: 'original' };
        injectToolsToClaude(body, [{ name: 'tool1' }]);
        expect(body.system).toBe('original');
    });
});

// ========== injectToolsToGemini ==========

describe('injectToolsToGemini', () => {
    it('追加到现有 systemInstruction', () => {
        const body = { systemInstruction: { parts: [{ text: 'You are Gemini.' }] } };
        injectToolsToGemini(body, [{ name: 'search' }]);
        expect(body.systemInstruction.parts).toHaveLength(2);
    });

    it('创建新 systemInstruction', () => {
        const body = {};
        injectToolsToGemini(body, [{ name: 'tool1' }]);
        expect(body.systemInstruction.parts).toHaveLength(1);
        expect(body.systemInstruction.parts[0].text).toContain('tool1');
    });

    it('扁平化 functionDeclarations', () => {
        const body = {};
        const tools = [{ functionDeclarations: [{ name: 'fn1' }, { name: 'fn2' }] }];
        injectToolsToGemini(body, tools);
        expect(body.systemInstruction.parts[0].text).toContain('fn1');
        expect(body.systemInstruction.parts[0].text).toContain('fn2');
    });

    it('XML 未启用时不注入', () => {
        state.xmlToolCallingEnabled = false;
        const body = {};
        injectToolsToGemini(body, [{ name: 'tool1' }]);
        expect(body.systemInstruction).toBeUndefined();
    });
});

// ========== getXMLInjectionStats ==========

describe('getXMLInjectionStats', () => {
    it('空工具列表', () => {
        const stats = getXMLInjectionStats([]);
        expect(stats.toolCount).toBe(0);
        expect(stats.estimatedTokens).toBe(0);
    });

    it('null 工具列表', () => {
        const stats = getXMLInjectionStats(null);
        expect(stats.toolCount).toBe(0);
    });

    it('有工具时返回统计', () => {
        const stats = getXMLInjectionStats([{ name: 'test', description: 'A test tool' }]);
        expect(stats.toolCount).toBe(1);
        expect(stats.estimatedTokens).toBeGreaterThan(0);
        expect(stats.descriptionLength).toBeGreaterThan(0);
    });
});

// ========== trackXMLToolCall / getMetrics / resetMetrics ==========

describe('监控指标', () => {
    it('成功调用', () => {
        trackXMLToolCall(true, 100);
        const m = getMetrics();
        expect(m.xmlToolCallsAttempted).toBe(1);
        expect(m.xmlToolCallsSucceeded).toBe(1);
        expect(m.averageXMLTokens).toBe(100);
    });

    it('失败调用', () => {
        trackXMLToolCall(false, 0, 'parse error');
        const m = getMetrics();
        expect(m.xmlToolCallsAttempted).toBe(1);
        expect(m.xmlToolCallsSucceeded).toBe(0);
        expect(m.recentErrors).toHaveLength(1);
    });

    it('成功率计算', () => {
        trackXMLToolCall(true, 50);
        trackXMLToolCall(true, 100);
        trackXMLToolCall(false, 0, 'err');
        const m = getMetrics();
        expect(m.successRate).toBe('66.67%');
    });

    it('无调用时 successRate 为 N/A', () => {
        expect(getMetrics().successRate).toBe('N/A');
    });

    it('resetMetrics 清空', () => {
        trackXMLToolCall(true, 100);
        resetMetrics();
        const m = getMetrics();
        expect(m.xmlToolCallsAttempted).toBe(0);
        expect(m.xmlToolCallsSucceeded).toBe(0);
    });

    it('平均 token 计算', () => {
        trackXMLToolCall(true, 100);
        trackXMLToolCall(true, 200);
        expect(getMetrics().averageXMLTokens).toBe(150);
    });

    it('errors 限制 100 个', () => {
        for (let i = 0; i < 110; i++) {
            trackXMLToolCall(false, 0, `err${i}`);
        }
        const m = getMetrics();
        expect(m.recentErrors.length).toBeLessThanOrEqual(10);
    });
});
