/**
 * shared-state.js 测试
 */
import { describe, it, expect } from 'vitest';

import { getSelectedProviderId, setSelectedProviderId } from '../../js/providers/shared-state.js';

describe('shared-state', () => {
    it('初始值为 null', () => {
        // 重置一下
        setSelectedProviderId(null);
        expect(getSelectedProviderId()).toBeNull();
    });

    it('设置和获取', () => {
        setSelectedProviderId('provider-1');
        expect(getSelectedProviderId()).toBe('provider-1');
    });

    it('更新值', () => {
        setSelectedProviderId('provider-1');
        setSelectedProviderId('provider-2');
        expect(getSelectedProviderId()).toBe('provider-2');
    });

    it('设置为 null', () => {
        setSelectedProviderId('something');
        setSelectedProviderId(null);
        expect(getSelectedProviderId()).toBeNull();
    });
});
