/**
 * key-manager-ui.js 密钥管理 UI 测试
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../js/core/state.js', () => ({
    state: { providers: [] }
}));

vi.mock('../../js/providers/manager.js', () => ({
    addApiKey: vi.fn(),
    removeApiKey: vi.fn(),
    setCurrentKey: vi.fn(),
    updateApiKey: vi.fn(),
    setKeyRotationConfig: vi.fn(),
    ensureApiKeysArray: vi.fn((p) => {
        if (!p.apiKeys) {
            p.apiKeys = [];
            p.currentKeyId = null;
            p.keyRotation = { enabled: false };
        }
    }),
    clearModelsCache: vi.fn()
}));

vi.mock('../../js/utils/helpers.js', () => ({
    escapeHtml: vi.fn((s) => s)
}));

vi.mock('../../js/ui/notifications.js', () => ({
    showNotification: vi.fn()
}));

vi.mock('../../js/utils/dialogs.js', () => ({
    showConfirmDialog: vi.fn(() => Promise.resolve(false))
}));

vi.mock('../../js/utils/modal-stack.js', () => ({
    applyModalLayerZIndex: vi.fn(),
    bindTopmostEscape: vi.fn(() => vi.fn()),
    MODAL_LAYER_Z_INDEX: 10000,
    setupModalFocus: vi.fn(() => vi.fn())
}));

import { maskApiKey, renderApiKeysCollapsible } from '../../js/providers/key-manager-ui.js';

describe('key-manager-ui', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('maskApiKey', () => {
        it('空密钥返回未设置', () => {
            expect(maskApiKey('')).toBe('未设置');
            expect(maskApiKey(null)).toBe('未设置');
            expect(maskApiKey(undefined)).toBe('未设置');
        });

        it('短密钥返回 ****', () => {
            expect(maskApiKey('sk-1234')).toBe('****');
            expect(maskApiKey('12345678')).toBe('****');
        });

        it('长密钥显示首尾', () => {
            expect(maskApiKey('sk-abcdefghijk')).toBe('sk-a...hijk');
        });

        it('正常长度密钥', () => {
            const key = 'sk-proj-abcdefghijklmnop';
            const masked = maskApiKey(key);
            expect(masked).toMatch(/^sk-p.*mnop$/);
            expect(masked).toContain('...');
        });
    });

    describe('renderApiKeysCollapsible', () => {
        it('空提供商渲染默认状态', () => {
            const html = renderApiKeysCollapsible({ name: 'Test' });
            expect(html).toContain('API 密钥管理');
            expect(html).toContain('0 个密钥');
        });

        it('有密钥显示数量', () => {
            const provider = {
                apiKeys: [
                    { id: 'k1', key: 'sk-1', name: '密钥 1', enabled: true },
                    { id: 'k2', key: 'sk-2', name: '密钥 2', enabled: true }
                ],
                currentKeyId: 'k1',
                keyRotation: { enabled: false }
            };
            const html = renderApiKeysCollapsible(provider);
            expect(html).toContain('2 个密钥');
        });

        it('轮询启用显示 badge', () => {
            const provider = {
                apiKeys: [{ id: 'k1', key: 'sk-1', name: '密钥 1', enabled: true }],
                currentKeyId: 'k1',
                keyRotation: { enabled: true }
            };
            const html = renderApiKeysCollapsible(provider);
            expect(html).toContain('轮询中');
        });

        it('当前密钥预览', () => {
            const provider = {
                apiKeys: [{ id: 'k1', key: 'sk-abcdefghijklm', name: 'Key', enabled: true }],
                currentKeyId: 'k1',
                keyRotation: { enabled: false }
            };
            const html = renderApiKeysCollapsible(provider);
            expect(html).toContain('sk-a...jklm');
        });
    });
});
