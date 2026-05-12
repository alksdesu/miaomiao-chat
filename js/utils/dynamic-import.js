/**
 * 动态 import 统一入口
 * 强制声明失败语义（throw / log / notify / silent），替代裸 .then 和空 catch。
 */

import { logger } from './logger.js';
import { eventBus } from '../core/events.js';

/**
 * @param {string} path - 模块路径
 * @param {{onError?: 'throw'|'log'|'notify'|'silent', context?: string}} [options]
 * @returns {Promise<any|null>} onError 非 throw 且失败时返回 null
 */
export async function loadModule(path, options = {}) {
    if (typeof path !== 'string' || !path) {
        throw new TypeError(`[loadModule] path 必须为非空字符串，实际收到: ${path}`);
    }
    const { onError = 'throw', context = '' } = options;

    try {
        return await import(/* @vite-ignore */ path);
    } catch (error) {
        const label = context ? `${context} (${path})` : path;

        switch (onError) {
            case 'silent':
                return null;

            case 'log':
                logger.error(`[loadModule] ${label} 加载失败:`, error);
                return null;

            case 'notify':
                logger.error(`[loadModule] ${label} 加载失败:`, error);
                eventBus.emit('ui:notification', {
                    message: `${context || '模块'}加载失败`,
                    type: 'error'
                });
                return null;

            case 'throw':
            default: {
                // throw 路径不写日志（交给上层 catch 决定是否记录），但补充原始错误信息便于定位
                const wrapped = new Error(`[loadModule] ${label} 加载失败: ${error.message}`);
                wrapped.cause = error;
                wrapped.modulePath = path;
                throw wrapped;
            }
        }
    }
}

/**
 * 加载模块并执行其命名导出函数，适合"import 一次就调一个函数"的高频场景
 */
export async function loadAndCall(path, exportName, options = {}) {
    const mod = await loadModule(path, options);
    if (!mod) return undefined;

    const fn = mod[exportName];
    if (typeof fn !== 'function') {
        const available = Object.keys(mod).join(', ');
        const msg = `[loadAndCall] 模块 ${path} 未导出函数 ${exportName} (可用导出: ${available})`;
        switch (options.onError) {
            case 'silent':
                return undefined;
            case 'log':
                logger.error(msg);
                return undefined;
            case 'notify':
                logger.error(msg);
                eventBus.emit('ui:notification', {
                    message: `${options.context || '模块'}加载失败`,
                    type: 'error'
                });
                return undefined;
            default: {
                const err = new Error(msg);
                err.modulePath = path;
                err.exportName = exportName;
                err.availableExports = Object.keys(mod);
                throw err;
            }
        }
    }

    return fn();
}
