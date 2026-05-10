/**
 * 流统计模块
 * 记录流式生成的性能指标（TTFT、TPS 等）
 */

import { state } from '../core/state.js';
import { setStreamStats } from '../core/state-mutations.js';

/**
 * 每个解析器实例持有独立统计，避免全局单例在高并发下数据污染
 */
export class StreamStats {
    constructor() {
        this.requestStartTime = Date.now();
        this.firstTokenTime = 0;
        this.endTime = 0;
        this.tokenCount = 0;
        this.isFirstToken = true;
    }

    recordFirstToken() {
        if (this.isFirstToken) {
            this.firstTokenTime = Date.now();
            this.isFirstToken = false;
        }
    }

    recordTokens(text) {
        if (!text) return;
        this.tokenCount += estimateTokenCount(text);
    }

    recalculateTokenCount({ textContent = '', thinkingContent = '', contentParts = [] } = {}) {
        const TOOL_PLACEHOLDER = '(调用工具)';
        let combinedText = [thinkingContent, textContent].filter(Boolean).join('\n');
        if (combinedText === TOOL_PLACEHOLDER) combinedText = '';
        if (!combinedText && Array.isArray(contentParts) && contentParts.length > 0) {
            combinedText = contentParts
                .filter(
                    (p) =>
                        (p?.type === 'text' || p?.type === 'thinking') &&
                        typeof p.text === 'string' &&
                        p.text &&
                        p.text !== TOOL_PLACEHOLDER
                )
                .map((p) => p.text)
                .join('\n');
        }
        this.tokenCount = estimateTokenCount(combinedText);
        return this.tokenCount;
    }

    finalize() {
        this.endTime = Date.now();
    }

    getData() {
        if (!this.requestStartTime) return null;
        const ttft = this.firstTokenTime
            ? ((this.firstTokenTime - this.requestStartTime) / 1000).toFixed(2)
            : '-';
        const totalTime = this.endTime
            ? ((this.endTime - this.requestStartTime) / 1000).toFixed(2)
            : '-';
        const tokens = this.tokenCount || 0;
        const tps =
            this.endTime && this.firstTokenTime && this.endTime > this.firstTokenTime
                ? (tokens / ((this.endTime - this.firstTokenTime) / 1000)).toFixed(1)
                : '-';
        return { ttft, totalTime, tokens, tps };
    }

    getPartialData() {
        if (!this.requestStartTime) return null;
        const ttft = this.firstTokenTime
            ? ((this.firstTokenTime - this.requestStartTime) / 1000).toFixed(2)
            : '-';
        const tokens = this.tokenCount || 0;
        return { ttft, totalTime: '-', tokens, tps: '-', isPartial: true };
    }

    syncToGlobal() {
        setStreamStats({
            requestStartTime: this.requestStartTime,
            firstTokenTime: this.firstTokenTime,
            endTime: this.endTime,
            tokenCount: this.tokenCount,
            isFirstToken: this.isFirstToken
        });
    }
}

/**
 * 估算 token 数（与 recordTokens 使用相同的粗略规则）
 * @param {string} text
 * @returns {number}
 */
export function estimateTokenCount(text) {
    if (!text) return 0;
    const chineseChars = (text.match(/[\u4e00-\u9fff]/g) || []).length;
    const otherText = text.replace(/[\u4e00-\u9fff]/g, ' ');
    const words = otherText.split(/\s+/).filter((w) => w.length > 0).length;
    return chineseChars + words;
}

/**
 * 重置流统计
 */
export function resetStreamStats() {
    setStreamStats({
        requestStartTime: Date.now(),
        firstTokenTime: 0,
        endTime: 0,
        tokenCount: 0,
        isFirstToken: true
    });
}

/**
 * 结束流统计
 */
export function finalizeStreamStats() {
    state.streamStats.endTime = Date.now();
}

/**
 * 获取当前流统计数据（用于保存）
 * @returns {Object|null} 统计数据
 */
export function getCurrentStreamStatsData() {
    const stats = state.streamStats;
    if (!stats.requestStartTime) return null;

    const ttft = stats.firstTokenTime
        ? ((stats.firstTokenTime - stats.requestStartTime) / 1000).toFixed(2)
        : '-';
    const totalTime = stats.endTime
        ? ((stats.endTime - stats.requestStartTime) / 1000).toFixed(2)
        : '-';
    const tokens = stats.tokenCount || 0;
    const tps =
        stats.endTime && stats.firstTokenTime && stats.endTime > stats.firstTokenTime
            ? (tokens / ((stats.endTime - stats.firstTokenTime) / 1000)).toFixed(1)
            : '-';

    return { ttft, totalTime, tokens, tps };
}

/**
 * 从保存的数据生成统计 HTML
 * @param {Object} statsData - 统计数据
 * @returns {string} 统计 HTML
 */
export function renderStreamStatsFromData(statsData) {
    if (!statsData) return '';

    const { ttft, totalTime, tokens, tps } = statsData;

    return `<div class="stream-stats">
        <span title="首字时间 (TTFT)">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
            </svg>
            ${ttft}s
        </span>
        <span title="总耗时">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M5 22h14M5 2h14M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2"/>
            </svg>
            ${totalTime}s
        </span>
        <span title="输出 tokens">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>
            </svg>
            ${tokens}
        </span>
        <span title="生成速度 (tokens/s)">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
            </svg>
            ${tps} t/s
        </span>
    </div>`;
}

/**
 * 获取当前流统计 HTML
 * @returns {string} 统计 HTML
 */
export function getStreamStatsHTML() {
    return renderStreamStatsFromData(getCurrentStreamStatsData());
}

/**
 * 将统计信息追加到消息末尾
 * 支持多种获取消息容器的方式，防止 state.currentAssistantMessage 被清空时失败
 */
export function appendStreamStats() {
    const statsHTML = getStreamStatsHTML();
    if (!statsHTML) return;

    // 尝试多种方式获取消息容器
    let wrapper = null;

    // 方式1：使用 state.currentAssistantMessage
    if (state.currentAssistantMessage) {
        wrapper = state.currentAssistantMessage.closest('.message-content-wrapper');
    }

    // 方式2：如果方式1失败，找到 DOM 中最后一条助手消息
    if (!wrapper) {
        const allAssistantMsgs = document.querySelectorAll('.message.assistant');
        if (allAssistantMsgs.length > 0) {
            const lastAssistantMsg = allAssistantMsgs[allAssistantMsgs.length - 1];
            wrapper = lastAssistantMsg.querySelector('.message-content-wrapper');
        }
    }

    if (wrapper) {
        // 移除旧的统计（如果有）
        const oldStats = wrapper.querySelector('.stream-stats');
        if (oldStats) oldStats.remove();
        wrapper.insertAdjacentHTML('beforeend', statsHTML);
    }
}
