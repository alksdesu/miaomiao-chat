/**
 * OpenAI API 请求处理器（薄壳）
 *
 * 实际逻辑下沉到 js/api/adapters/openai-chat-adapter.js 与 openai-responses-adapter.js，
 * 横切关注点由 js/api/request-pipeline.js 编排。本文件仅按 provider.apiFormat 选 adapter。
 */

import { getCurrentProvider } from './current.js';
import { getAdapter } from './adapters/index.js';
import { executeRequest } from './request-pipeline.js';

/**
 * 发送 OpenAI 格式的请求（Chat Completions / Responses API 自动派发）
 *
 * 优先用调用方传入的快照 adapter（sendToAPI 锁定），避免请求往返期间切 provider 后
 * 重查 provider 选到错误 adapter；缺省时才回退自查（保留 factory 直调兼容）
 */
export async function sendOpenAIRequest(
    endpoint,
    apiKey,
    model,
    signal = null,
    adapter = null,
    requestContext = null
) {
    const resolved =
        adapter ||
        getAdapter(
            getCurrentProvider()?.apiFormat === 'openai-responses' ? 'openai-responses' : 'openai'
        );
    return executeRequest(resolved, {
        endpoint,
        apiKey,
        model,
        signal,
        sessionId: requestContext?.sessionId,
        sourceMessages: requestContext?.sourceMessages,
        requestProfile: requestContext?.requestProfile
    });
}
