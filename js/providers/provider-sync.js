/**
 * 提供商状态同步
 * 从 manager.js 提取，避免 manager.js <-> provider-crud.js 循环依赖
 */

import { state } from '../core/state.js';
import { eventBus } from '../core/events.js';
import { EVENTS } from '../core/events-registry.js';
import { logger } from '../utils/logger.js';
import { clearForeignSignatures, clearProviderSpecificRawMeta } from '../api/format-converter.js';

// 把 provider.apiFormat 折叠到 signature 维度（openai-chat / openai-responses 共享 'openai' 槽）
function apiFormatToSignatureFormat(apiFormat) {
    if (!apiFormat) return null;
    if (apiFormat.startsWith('openai')) return 'openai';
    if (apiFormat === 'claude' || apiFormat === 'openclaw') return 'claude';
    if (apiFormat === 'gemini') return 'gemini';
    return null;
}

// 单 pending cleanup：连续切换 N 次只保留最后一次的目标，避免历史回调堆积乱写
let _pendingCleanup = null;
let _pendingCleanupBound = false;
function _runPendingCleanup() {
    const fn = _pendingCleanup;
    _pendingCleanup = null;
    if (fn) fn();
}

/**
 * 同步提供商状态到全局 state
 * @param {object} provider - 提供商对象
 */
export function syncProviderState(provider) {
    if (!provider) return;

    const prevFormat = state.apiFormat;
    const prevSignatureFormat = apiFormatToSignatureFormat(prevFormat);
    const nextSignatureFormat = apiFormatToSignatureFormat(provider.apiFormat);

    if (state.apiFormat !== provider.apiFormat) {
        state.apiFormat = provider.apiFormat;
        logger.debug(`[syncProviderState] 同步 apiFormat: ${provider.apiFormat}`);
    }

    if (provider.apiFormat === 'gemini' && provider.geminiApiKeyInHeader !== undefined) {
        state.geminiApiKeyInHeader = !!provider.geminiApiKeyInHeader;
        logger.debug(
            `[syncProviderState] 同步 geminiApiKeyInHeader: ${provider.geminiApiKeyInHeader}`
        );
    }

    // 流式生成中切换 provider 会与正在写入的 parser 抢同一条消息：
    // 清掉刚累积一半的 signature 后 parser 继续写入新块，落库 thinking text 与签名错位。
    // 延后到 stream:complete 再执行清理；用户切到新 provider 前的会话状态保持完整
    const streamingInFlight = state.isLoading || state.isSending;

    const performSignatureCleanup = () => {
        if (
            prevSignatureFormat &&
            nextSignatureFormat &&
            prevSignatureFormat !== nextSignatureFormat &&
            Array.isArray(state.messages) &&
            state.messages.length > 0
        ) {
            const cleared = clearForeignSignatures(state.messages, nextSignatureFormat);
            if (cleared > 0) {
                logger.info(
                    `[syncProviderState] 跨家切换 ${prevSignatureFormat}→${nextSignatureFormat}, 清理 ${cleared} 个外家 signature`
                );
                state.sessionDirty = true;
            }
        }

        // 跨 provider 切换（即使同 apiFormat，如 OpenAI proxy A → proxy B）：
        // encrypted_content / reasoningItems 是 provider 服务端私有 HMAC，跨账号下发
        // 触发 reasoning_id_not_found 400。同 provider 自切（id 不变）走早期 return
        const providerIdChanged =
            state.currentProviderId && state.currentProviderId !== provider.id;
        if (providerIdChanged && Array.isArray(state.messages) && state.messages.length > 0) {
            const cleared = clearProviderSpecificRawMeta(state.messages);
            if (cleared > 0) {
                logger.info(
                    `[syncProviderState] 跨 provider 切换 ${state.currentProviderId}→${provider.id}, 清理 ${cleared} 条消息的 reasoning/encrypted 元数据`
                );
                state.sessionDirty = true;
                // reasoning 上下文跨账号无法复用，下次发送时模型看不到上轮推理链，
                // 提示用户避免误以为模型"忘记"了之前的思考过程
                eventBus.emit('ui:notification', {
                    message: `已切换提供商，${cleared} 条消息的推理上下文将重新生成`,
                    type: 'info',
                    duration: 6000
                });
            }
        }
    };

    if (streamingInFlight) {
        logger.debug('[syncProviderState] 流式中切换，延后到 stream:complete 再清理 signature');
        // 仅保留最近一次 cleanup，旧的 pending 被覆盖
        _pendingCleanup = () => {
            // stale 守卫：cleanup 真跑时若用户又切到别的 provider，本次目标已无意义，放弃
            if (state.currentProviderId === provider.id) {
                performSignatureCleanup();
            }
        };
        if (!_pendingCleanupBound) {
            _pendingCleanupBound = true;
            eventBus.on(EVENTS.STREAM_COMPLETE, _runPendingCleanup);
        }
    } else {
        performSignatureCleanup();
    }

    if (prevFormat !== provider.apiFormat || state.currentProviderId !== provider.id) {
        eventBus.emit('providers:switched', { provider });
    }
}
