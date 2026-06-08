/**
 * Gemini API 请求处理器（薄壳）
 *
 * 实际逻辑下沉到 js/api/adapters/gemini-adapter.js（含 Vertex/AI Studio 端点、
 * 图片压缩、thoughtSignature、systemInstruction、API key in header vs query），
 * 横切关注点由 js/api/request-pipeline.js 编排。
 */

import { getAdapter } from './adapters/index.js';
import { executeRequest } from './request-pipeline.js';

/**
 * 发送 Gemini API 请求（AI Studio 或 Vertex AI）
 */
export async function sendGeminiRequest(endpoint, apiKey, model, signal = null) {
    const adapter = getAdapter('gemini');
    return executeRequest(adapter, { endpoint, apiKey, model, signal });
}
