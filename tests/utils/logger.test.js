/**
 * logger.js 日志系统测试
 * 测试分级逻辑、level 切换、输出行为
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { logger } from '../../js/utils/logger.js';

describe('logger', () => {
    let logSpy, warnSpy, errorSpy;

    beforeEach(() => {
        logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        // 重置为默认 info 级别
        logger.setLevel('info');
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    // ========== getLevel ==========

    it('默认级别为 info', () => {
        expect(logger.getLevel()).toBe('info');
    });

    // ========== setLevel ==========

    it('setLevel 切换到 debug', () => {
        logger.setLevel('debug');
        expect(logger.getLevel()).toBe('debug');
    });

    it('setLevel 切换到 warn', () => {
        logger.setLevel('warn');
        expect(logger.getLevel()).toBe('warn');
    });

    it('setLevel 切换到 error', () => {
        logger.setLevel('error');
        expect(logger.getLevel()).toBe('error');
    });

    it('setLevel 无效值回退为 info', () => {
        logger.setLevel('invalid');
        expect(logger.getLevel()).toBe('info');
    });

    // ========== debug 级别 ==========

    it('info 级别下 debug 不输出', () => {
        logger.setLevel('info');
        logger.debug('test');
        expect(logSpy).not.toHaveBeenCalled();
    });

    it('debug 级别下 debug 输出', () => {
        logger.setLevel('debug');
        logger.debug('test message');
        expect(logSpy).toHaveBeenCalledWith('[DEBUG]', 'test message');
    });

    // ========== info 级别 ==========

    it('info 级别下 info 输出', () => {
        logger.setLevel('info');
        logger.info('info msg');
        expect(logSpy).toHaveBeenCalledWith('[INFO]', 'info msg');
    });

    it('warn 级别下 info 不输出', () => {
        logger.setLevel('warn');
        logger.info('should not show');
        expect(logSpy).not.toHaveBeenCalled();
    });

    // ========== warn 级别 ==========

    it('info 级别下 warn 输出', () => {
        logger.setLevel('info');
        logger.warn('warning');
        expect(warnSpy).toHaveBeenCalledWith('[WARN]', 'warning');
    });

    it('error 级别下 warn 不输出', () => {
        logger.setLevel('error');
        logger.warn('should not show');
        expect(warnSpy).not.toHaveBeenCalled();
    });

    // ========== error 级别 ==========

    it('error 始终输出（任何级别）', () => {
        logger.setLevel('error');
        logger.error('err msg');
        expect(errorSpy).toHaveBeenCalledWith('[ERROR]', 'err msg');
    });

    it('debug 级别下 error 也输出', () => {
        logger.setLevel('debug');
        logger.error('err msg');
        expect(errorSpy).toHaveBeenCalledWith('[ERROR]', 'err msg');
    });

    // ========== 多参数 ==========

    it('支持多参数传递', () => {
        logger.setLevel('debug');
        logger.debug('key:', 'value', 123);
        expect(logSpy).toHaveBeenCalledWith('[DEBUG]', 'key:', 'value', 123);
    });

    it('warn 支持多参数', () => {
        logger.warn('code:', 404);
        expect(warnSpy).toHaveBeenCalledWith('[WARN]', 'code:', 404);
    });

    // ========== 级别层次 ==========

    it('debug 级别输出所有级别', () => {
        logger.setLevel('debug');
        logger.debug('d');
        logger.info('i');
        logger.warn('w');
        logger.error('e');
        expect(logSpy).toHaveBeenCalledTimes(2); // debug + info
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(errorSpy).toHaveBeenCalledTimes(1);
    });

    it('error 级别只输出 error', () => {
        logger.setLevel('error');
        logger.debug('d');
        logger.info('i');
        logger.warn('w');
        logger.error('e');
        expect(logSpy).not.toHaveBeenCalled();
        expect(warnSpy).not.toHaveBeenCalled();
        expect(errorSpy).toHaveBeenCalledTimes(1);
    });
});
