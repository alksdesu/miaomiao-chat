/**
 * Claude API 请求处理器（薄壳）
 *
 * 实际逻辑下沉到 js/api/adapters/claude-adapter.js，
 * 横切关注点由 js/api/request-pipeline.js 编排。
 */

import { getAdapter } from './adapters/index.js';
import { executeRequest } from './request-pipeline.js';

/**
 * 发送 Claude Messages API 请求
 */
export async function sendClaudeRequest(endpoint, apiKey, model, signal = null) {
    const adapter = getAdapter('claude');
    return executeRequest(adapter, { endpoint, apiKey, model, signal });
}
