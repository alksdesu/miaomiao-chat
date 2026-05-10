import { logger } from '../utils/logger.js';

/**
 * EventBus - 轻量级发布/订阅事件系统
 * 用于模块间解耦通信，避免循环依赖
 */
export class EventBus {
    constructor() {
        // 事件监听器映射: Map<event, Set<callback>>
        this._listeners = new Map();
    }

    /**
     * 订阅事件
     * @param {string} event - 事件名称
     * @param {Function} callback - 回调函数
     * @returns {Function} 取消订阅函数
     */
    on(event, callback) {
        if (!this._listeners.has(event)) {
            this._listeners.set(event, new Set());
        }
        this._listeners.get(event).add(callback);

        // 返回取消订阅函数
        return () => this.off(event, callback);
    }

    /**
     * 取消订阅事件
     * @param {string} event - 事件名称
     * @param {Function} callback - 回调函数
     */
    off(event, callback) {
        this._listeners.get(event)?.delete(callback);
    }

    /**
     * 发出事件
     * @param {string} event - 事件名称
     * @param {*} data - 事件数据
     */
    emit(event, data) {
        const listeners = this._listeners.get(event);
        if (!listeners) return;

        listeners.forEach((callback) => {
            try {
                callback(data);
            } catch (error) {
                logger.error(`[EventBus] Error in event handler [${event}]:`, error);
            }
        });
    }

    /**
     * 一次性订阅（触发后自动取消）
     * @param {string} event - 事件名称
     * @param {Function} callback - 回调函数
     * @returns {Function} 取消订阅函数
     */
    once(event, callback) {
        const unsubscribe = this.on(event, (data) => {
            callback(data);
            unsubscribe();
        });
        return unsubscribe;
    }

    /**
     * 清除所有监听器
     */
    clear() {
        this._listeners.clear();
    }

    /**
     * 清除指定事件的所有监听器
     * @param {string} event - 事件名称
     */
    clearEvent(event) {
        this._listeners.delete(event);
    }

    /**
     * 调试：获取所有事件的监听器数量
     * @returns {Object} 事件名称 -> 监听器数量的映射
     */
    debug() {
        const stats = {};
        let total = 0;

        for (const [event, listeners] of this._listeners.entries()) {
            const count = listeners.size;
            stats[event] = count;
            total += count;
        }

        stats['__TOTAL__'] = total;
        stats['__EVENTS__'] = this._listeners.size;

        return stats;
    }

    /**
     * 调试：打印当前监听器状态
     */
    logDebug() {
        const stats = this.debug();
        logger.debug('📊 EventBus 状态:');
        logger.debug(`   总监听器数: ${stats.__TOTAL__}`);
        logger.debug(`   总事件数: ${stats.__EVENTS__}`);
        logger.debug('   详细信息:');

        for (const [event, count] of Object.entries(stats)) {
            if (!event.startsWith('__')) {
                logger.debug(`     ${event}: ${count}`);
            }
        }
    }

    /**
     * 检测内存泄漏（监听器数量超过阈值）
     * @param {number} threshold - 单个事件的监听器数量阈值
     * @returns {Array} 超过阈值的事件列表
     */
    detectLeaks(threshold = 10) {
        const leaks = [];

        for (const [event, listeners] of this._listeners.entries()) {
            if (listeners.size > threshold) {
                leaks.push({
                    event,
                    count: listeners.size,
                    threshold
                });
            }
        }

        if (leaks.length > 0) {
            logger.warn('⚠️ 检测到可能的内存泄漏:');
            leaks.forEach((leak) => {
                logger.warn(`   ${leak.event}: ${leak.count} 个监听器 (阈值: ${leak.threshold})`);
            });
        }

        return leaks;
    }
}

// 导出全局单例
export const eventBus = new EventBus();
