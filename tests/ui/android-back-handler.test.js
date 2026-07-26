/**
 * android-back-handler.js 返回键测试
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../js/utils/platform.js', () => ({
    isAndroid: vi.fn(() => false),
    isWeb: vi.fn(() => false)
}));

vi.mock('../../js/ui/notifications.js', () => ({
    showNotification: vi.fn()
}));

vi.mock('../../js/utils/logger.js', () => ({
    logger: { warn: vi.fn(), debug: vi.fn(), error: vi.fn(), info: vi.fn() }
}));

import { isAndroid } from '../../js/utils/platform.js';
import { initAndroidBackHandler } from '../../js/ui/android-back-handler.js';

describe('android-back-handler', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        document.body.innerHTML = '';
    });

    afterEach(() => {
        document.body.innerHTML = '';
    });

    it('非 Android 平台返回 false', async () => {
        isAndroid.mockReturnValue(false);
        const result = await initAndroidBackHandler();
        expect(result).toBe(false);
    });

    it('Android 但无 Capacitor 返回 false', async () => {
        isAndroid.mockReturnValue(true);
        // 没有 window.Capacitor
        const result = await initAndroidBackHandler();
        expect(result).toBe(false);
    });
});
