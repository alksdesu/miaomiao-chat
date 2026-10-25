/**
 * 请求参数采集
 * 读取设置面板里的原始参数快照，wire 格式的字段名与取值约束由各 adapter.buildGenerationParams 负责
 */

import { state } from '../core/state.js';
import { captureReasoningIntent } from './reasoning.js';

/**
 * @typedef {Object} GenerationSettings
 * @property {Object}  userParams    state.modelParams[apiFormat] 的副本（Responses / OpenClaw 共用 openai 参数）
 * @property {import('./reasoning.js').ReasoningIntent} reasoning
 * @property {string|null} verbosity 启用输出详细度时的档位
 * @property {boolean} streamEnabled
 */

/**
 * @param {string} apiFormat
 * @param {Object} [stateRef]
 * @returns {GenerationSettings}
 */
export function captureGenerationSettings(apiFormat, stateRef = state) {
    const modelParams = stateRef.modelParams || {};
    const userParams = modelParams[apiFormat] || modelParams.openai || {};
    return {
        userParams: { ...userParams },
        reasoning: captureReasoningIntent(stateRef),
        verbosity:
            stateRef.verbosityEnabled && stateRef.outputVerbosity ? stateRef.outputVerbosity : null,
        streamEnabled: !!stateRef.streamEnabled
    };
}

/**
 * 获取自定义请求头对象
 * @returns {Object} 自定义请求头
 */
export function getCustomHeadersObject() {
    const headers = {};
    state.customHeaders.forEach((h) => {
        if (h.key && h.value) {
            headers[h.key] = h.value;
        }
    });
    return headers;
}
