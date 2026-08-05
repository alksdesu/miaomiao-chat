/**
 * FormatAdapter 注册中心
 *
 * adapter 静态 import 后由本模块统一注册，避免循环依赖（早期版本让每家
 * adapter 在自身模块顶部调 registerAdapter，会触发 TDZ）。
 */

import { logger } from '../../utils/logger.js';
import { openaiChatAdapter } from './openai-chat-adapter.js';
import { openaiResponsesAdapter } from './openai-responses-adapter.js';
import { claudeAdapter } from './claude-adapter.js';
import { geminiAdapter } from './gemini-adapter.js';
import { openclawAdapter } from './openclaw-adapter.js';
import { openaiImageAdapter } from './openai-image-adapter.js';

const registry = new Map([
    [openaiChatAdapter.apiFormat, openaiChatAdapter],
    [openaiResponsesAdapter.apiFormat, openaiResponsesAdapter],
    [claudeAdapter.apiFormat, claudeAdapter],
    [geminiAdapter.apiFormat, geminiAdapter],
    [openclawAdapter.apiFormat, openclawAdapter],
    [openaiImageAdapter.apiFormat, openaiImageAdapter]
]);

/**
 * 取 adapter；未知 apiFormat 抛 Error，与 factory.getSendFunction 行为对齐
 * （避免发送侧 throw + 解析侧静默降级 openai 的不一致导致响应被错误解析）
 * @param {string} apiFormat
 * @returns {import('./format-adapter-types.js').FormatAdapter}
 */
export function getAdapter(apiFormat) {
    const adapter = registry.get(apiFormat);
    if (adapter) return adapter;
    logger.error(`[adapters] 未知 apiFormat="${apiFormat}"，无可用 adapter`);
    throw new Error(`Unsupported API format: ${apiFormat}`);
}

/**
 * 列出所有已注册 apiFormat（用于诊断 / 测试）
 */
export function listAdapters() {
    return Array.from(registry.keys());
}
