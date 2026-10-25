/**
 * 推理设置快照与各家共用的档位换算
 * 设置面板的思维链开关、强度、预算与 Claude adaptive 选项在发请求时读一次，由 adapter 翻译成自家字段
 */

import { state } from '../core/state.js';

/**
 * @typedef {Object} ReasoningIntent
 * @property {boolean} enabled              思维链开关
 * @property {string}  strength             minimal / low / medium / high / xhigh / max / custom
 * @property {number}  budget               strength 为 custom 时的 token 预算
 * @property {boolean} sendNoneWhenDisabled 关闭时显式发送 effort none
 * @property {boolean} adaptive             Claude adaptive thinking 开关
 * @property {string}  adaptiveEffort       Claude adaptive 的 effort 档位
 * @property {boolean} showSummary          请求返回思考摘要
 */

/**
 * @param {Object} [stateRef]
 * @returns {ReasoningIntent}
 */
export function captureReasoningIntent(stateRef = state) {
    return {
        enabled: !!stateRef.thinkingEnabled,
        strength: stateRef.thinkingStrength,
        budget: stateRef.thinkingBudget,
        sendNoneWhenDisabled: !!stateRef.thinkingNoneMode,
        adaptive: !!stateRef.claudeAdaptiveThinking,
        adaptiveEffort: stateRef.claudeEffortLevel,
        showSummary: !!stateRef.claudeShowThinking
    };
}

/**
 * 预算制格式没有 minimal / xhigh 档，归到相邻档位
 * @param {string} strength
 * @returns {string}
 */
export function normalizeBudgetStrength(strength) {
    if (strength === 'minimal') return 'low';
    if (strength === 'xhigh') return 'high';
    return strength;
}

/**
 * 按强度档位取思考预算；custom 用用户填写的预算
 * @param {ReasoningIntent} reasoning
 * @param {Object<string, number>} budgetMap
 * @param {number} [fallback]
 * @returns {number}
 */
export function resolveThinkingBudget(reasoning, budgetMap, fallback = 16384) {
    const strength = normalizeBudgetStrength(reasoning.strength);
    if (strength === 'custom') return reasoning.budget;
    return budgetMap[strength] || fallback;
}
