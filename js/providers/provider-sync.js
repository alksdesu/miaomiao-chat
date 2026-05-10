/**
 * 提供商状态同步
 * 从 manager.js 提取，避免 manager.js <-> provider-crud.js 循环依赖
 */

import { state } from '../core/state.js';
import { eventBus } from '../core/events.js';
import { logger } from '../utils/logger.js';
import { setApiFormat, setGeminiApiKeyInHeader } from '../core/state-mutations.js';

/**
 * 同步提供商状态到全局 state
 * @param {object} provider - 提供商对象
 */
export function syncProviderState(provider) {
    if (!provider) return;

    const prevFormat = state.apiFormat;

    if (state.apiFormat !== provider.apiFormat) {
        setApiFormat(provider.apiFormat);
        logger.debug(`[syncProviderState] 同步 apiFormat: ${provider.apiFormat}`);
    }

    if (provider.apiFormat === 'gemini' && provider.geminiApiKeyInHeader !== undefined) {
        setGeminiApiKeyInHeader(provider.geminiApiKeyInHeader);
        logger.debug(
            `[syncProviderState] 同步 geminiApiKeyInHeader: ${provider.geminiApiKeyInHeader}`
        );
    }

    if (prevFormat !== provider.apiFormat || state.currentProviderId !== provider.id) {
        eventBus.emit('providers:switched', { provider });
    }
}
