/**
 * 动态 import 统一入口
 * 强制声明失败语义（throw / log / notify / silent），替代裸 .then 和空 catch。
 */

import { logger } from './logger.js';
import { eventBus } from '../core/events.js';

/**
 * 调用方传入 () => import('./...') 工厂，import() 的相对路径在调用方所在文件解析，
 * 避免 dynamic-import.js 本身路径影响模块解析。
 *
 * @param {() => Promise<any>} importFactory - 工厂函数，形如 () => import('./xxx.js')
 * @param {{onError?: 'throw'|'log'|'notify'|'silent', context?: string}} [options]
 * @returns {Promise<any|null>} onError 非 throw 且失败时返回 null
 */
export async function loadModule(importFactory, options = {}) {
    if (typeof importFactory !== 'function') {
        throw new TypeError(
            '[loadModule] 第一个参数必须为工厂函数 () => import("..."), 不再接受裸路径字符串'
        );
    }
    const { onError = 'throw', context = '' } = options;

    try {
        return await importFactory();
    } catch (error) {
        const label = context || '<未命名模块>';

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
                const wrapped = new Error(`[loadModule] ${label} 加载失败: ${error.message}`);
                wrapped.cause = error;
                throw wrapped;
            }
        }
    }
}

/**
 * 加载模块并执行其命名导出函数。
 * @param {() => Promise<any>} importFactory - 工厂函数
 * @param {string} exportName - 待调用的命名导出
 * @param {object} [options] - 同 loadModule
 */
export async function loadAndCall(importFactory, exportName, options = {}) {
    const mod = await loadModule(importFactory, options);
    if (!mod) return undefined;

    const fn = mod[exportName];
    if (typeof fn !== 'function') {
        const available = Object.keys(mod).join(', ');
        const label = options.context || '<未命名模块>';
        const msg = `[loadAndCall] ${label} 未导出函数 ${exportName} (可用导出: ${available})`;
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
                err.exportName = exportName;
                err.availableExports = Object.keys(mod);
                throw err;
            }
        }
    }

    return fn();
}
