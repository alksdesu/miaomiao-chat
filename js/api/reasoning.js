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
 * 预算制格式没有 minimal / xhigh / max 档，归到相邻档位
 * @param {string} strength
 * @returns {string}
 */
export function normalizeBudgetStrength(strength) {
    if (strength === 'minimal') return 'low';
    if (strength === 'xhigh' || strength === 'max') return 'high';
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

/**
 * 自定义预算换算成最接近的 low / medium / high 档位
 * @param {number} budget
 * @param {{ low: number, medium: number, high: number }} budgetMap
 * @returns {'low'|'medium'|'high'}
 */
export function nearestBudgetStrength(budget, budgetMap) {
    const value = Number(budget) || 0;
    const { low, medium, high } = budgetMap;
    if (value < (low + medium) / 2) return 'low';
    if (value < (medium + high) / 2) return 'medium';
    return 'high';
}

/**
 * 档位收敛到型号支持的范围：优先取更低的最近档位，没有更低的档位时取支持的最低档
 * @param {string} level
 * @param {readonly string[]} order 由低到高的全部档位
 * @param {readonly string[]|null} supported 型号支持的档位，null 表示不限制
 * @returns {string}
 */
export function clampToSupportedLevel(level, order, supported) {
    if (!supported || supported.includes(level)) return level;
    const usable = order.filter((item) => supported.includes(item));
    if (usable.length === 0) return level;
    const rank = order.indexOf(level);
    const lower = usable.filter((item) => order.indexOf(item) < rank);
    return lower.length > 0 ? lower[lower.length - 1] : usable[0];
}
