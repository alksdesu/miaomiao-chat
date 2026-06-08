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
 */
export async function sendOpenAIRequest(endpoint, apiKey, model, signal = null) {
    const provider = getCurrentProvider();
    const apiFormat = provider?.apiFormat === 'openai-responses' ? 'openai-responses' : 'openai';
    const adapter = getAdapter(apiFormat);
    return executeRequest(adapter, { endpoint, apiKey, model, signal });
}
