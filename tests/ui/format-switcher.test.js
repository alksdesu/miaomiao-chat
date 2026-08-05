/**
 * format-switcher.js 测试
 * API 格式切换功能
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../js/core/state.js', () => ({
    state: {
        apiFormat: 'openai',
        messages: []
    }
}));

vi.mock('../../js/core/elements.js', () => ({
    elements: {
        geminiImageConfig: null,
        apiEndpoint: null
    }
}));

vi.mock('../../js/state/config.js', () => ({
    saveCurrentConfig: vi.fn()
}));

vi.mock('../../js/ui/models.js', () => ({
    populateModelSelect: vi.fn()
}));

vi.mock('../../js/core/state-mutations.js', () => ({
    rebuildMessageIdMap: vi.fn()
}));

vi.mock('../../js/core/events.js', () => ({
    eventBus: {
        on: vi.fn(),
        emit: vi.fn()
    }
}));

import { state } from '../../js/core/state.js';
import { elements } from '../../js/core/elements.js';
import { saveCurrentConfig } from '../../js/state/config.js';
import { rebuildMessageIdMap } from '../../js/core/state-mutations.js';
import { setApiFormat } from '../../js/ui/format-switcher.js';

beforeEach(() => {
    vi.clearAllMocks();
    state.apiFormat = 'openai';
    state.messages = [];
    document.body.innerHTML = `
        <div class="api-config" id="openai-config" style="display:block"></div>
        <div class="api-config" id="gemini-config" style="display:none"></div>
        <div class="api-config" id="claude-config" style="display:none"></div>
        <div class="api-config" id="openai-image-config" style="display:none"></div>
        <div id="reply-count-settings-group"></div>
    `;
    elements.geminiImageConfig = null;
    elements.apiEndpoint = document.createElement('input');
});

describe('setApiFormat', () => {
    it('无效格式不执行', () => {
        setApiFormat('invalid');
        expect(state.apiFormat).toBe('openai');
    });

    it('有效格式更新 state', () => {
        setApiFormat('gemini');
        expect(state.apiFormat).toBe('gemini');
    });

    it('支持 openai-responses 格式', () => {
        setApiFormat('openai-responses');
        expect(state.apiFormat).toBe('openai-responses');
    });

    it('支持 claude 格式', () => {
        setApiFormat('claude');
        expect(state.apiFormat).toBe('claude');
    });

    it('支持 openclaw 格式', () => {
        setApiFormat('openclaw');
        expect(state.apiFormat).toBe('openclaw');
    });

    it('支持 openai-image 并隐藏全局回复数量', () => {
        setApiFormat('openai-image');
        expect(state.apiFormat).toBe('openai-image');
        expect(document.getElementById('openai-image-config').style.display).toBe('block');
        expect(document.getElementById('reply-count-settings-group').hidden).toBe(true);
    });

    it('切换格式显示对应配置面板', () => {
        setApiFormat('gemini');
        const geminiConfig = document.getElementById('gemini-config');
        expect(geminiConfig.style.display).toBe('block');
    });

    it('隐藏其他配置面板', () => {
        setApiFormat('gemini');
        const openaiConfig = document.getElementById('openai-config');
        expect(openaiConfig.style.display).toBe('none');
    });

    it('相同格式不触发消息转换', () => {
        state.apiFormat = 'gemini';
        setApiFormat('gemini');
        expect(rebuildMessageIdMap).not.toHaveBeenCalled();
    });

    it('有历史消息时不再调用 rebuildMessageIdMap（格式切换不动 messages 数组，map 一致无需重建）', () => {
        state.messages = [{ role: 'user', content: 'hi' }];
        setApiFormat('gemini');
        expect(rebuildMessageIdMap).not.toHaveBeenCalled();
    });

    it('保存配置', () => {
        setApiFormat('claude');
        expect(saveCurrentConfig).toHaveBeenCalled();
    });

    it('更新 apiEndpoint placeholder', () => {
        setApiFormat('claude');
        expect(elements.apiEndpoint.placeholder).toContain('anthropic');
    });

    it('shouldFetchModels=false 不触发模型加载延时', () => {
        setApiFormat('gemini', false);
        expect(saveCurrentConfig).toHaveBeenCalled();
    });
});
