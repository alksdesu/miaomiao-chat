/**
 * 统一日志系统
 * 支持分级输出，生产模式隐藏 debug 级别
 */

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
let currentLevel = LOG_LEVELS.info;

export const logger = {
    debug: (...args) => currentLevel <= LOG_LEVELS.debug && console.log('[DEBUG]', ...args),
    info: (...args) => currentLevel <= LOG_LEVELS.info && console.log('[INFO]', ...args),
    warn: (...args) => currentLevel <= LOG_LEVELS.warn && console.warn('[WARN]', ...args),
    error: (...args) => currentLevel <= LOG_LEVELS.error && console.error('[ERROR]', ...args),
    setLevel: (level) => {
        currentLevel = LOG_LEVELS[level] ?? LOG_LEVELS.info;
    },
    getLevel: () => Object.keys(LOG_LEVELS).find((k) => LOG_LEVELS[k] === currentLevel) || 'info'
};
