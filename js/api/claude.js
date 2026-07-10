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
 *
 * 优先用调用方传入的快照 adapter，缺省回退固定 claude adapter（保留 factory 直调兼容）
 */
export async function sendClaudeRequest(endpoint, apiKey, model, signal = null, adapter = null) {
    return executeRequest(adapter || getAdapter('claude'), { endpoint, apiKey, model, signal });
}
