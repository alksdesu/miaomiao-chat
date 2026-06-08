/**
 * EventBus 事件总线测试
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { EventBus } from '../../js/core/events.js';

let bus;

beforeEach(() => {
    bus = new EventBus();
});

describe('on / emit', () => {
    it('订阅并接收事件', () => {
        const handler = vi.fn();
        bus.on('test', handler);
        bus.emit('test', { value: 1 });
        expect(handler).toHaveBeenCalledWith({ value: 1 });
    });

    it('多个订阅者都收到事件', () => {
        const h1 = vi.fn();
        const h2 = vi.fn();
        bus.on('test', h1);
        bus.on('test', h2);
        bus.emit('test', 'data');
        expect(h1).toHaveBeenCalledWith('data');
        expect(h2).toHaveBeenCalledWith('data');
    });

    it('未订阅的事件不触发', () => {
        const handler = vi.fn();
        bus.on('a', handler);
        bus.emit('b', 'data');
        expect(handler).not.toHaveBeenCalled();
    });

    it('无数据时 emit 不报错', () => {
        bus.emit('nonexistent');
    });

    it('handler 抛异常不影响其他 handler', () => {
        const h1 = vi.fn(() => {
            throw new Error('oops');
        });
        const h2 = vi.fn();
        bus.on('test', h1);
        bus.on('test', h2);
        bus.emit('test');
        expect(h2).toHaveBeenCalled();
    });
});

describe('off', () => {
    it('取消订阅后不再收到事件', () => {
        const handler = vi.fn();
        bus.on('test', handler);
        bus.off('test', handler);
        bus.emit('test', 'data');
        expect(handler).not.toHaveBeenCalled();
    });

    it('取消不存在的订阅不报错', () => {
        expect(() => bus.off('nonexistent', () => {})).not.toThrow();
    });
});

describe('on 返回的取消函数', () => {
    it('调用返回值取消订阅', () => {
        const handler = vi.fn();
        const unsub = bus.on('test', handler);
        unsub();
        bus.emit('test');
        expect(handler).not.toHaveBeenCalled();
    });
});

describe('once', () => {
    it('只触发一次', () => {
        const handler = vi.fn();
        bus.once('test', handler);
        bus.emit('test', 'first');
        bus.emit('test', 'second');
        expect(handler).toHaveBeenCalledTimes(1);
        expect(handler).toHaveBeenCalledWith('first');
    });

    it('返回取消函数', () => {
        const handler = vi.fn();
        const unsub = bus.once('test', handler);
        unsub();
        bus.emit('test');
        expect(handler).not.toHaveBeenCalled();
    });
});

describe('clear', () => {
    it('清除所有监听器', () => {
        const h1 = vi.fn();
        const h2 = vi.fn();
        bus.on('a', h1);
        bus.on('b', h2);
        bus.clear();
        bus.emit('a');
        bus.emit('b');
        expect(h1).not.toHaveBeenCalled();
        expect(h2).not.toHaveBeenCalled();
    });
});

describe('clearEvent', () => {
    it('只清除指定事件', () => {
        const h1 = vi.fn();
        const h2 = vi.fn();
        bus.on('a', h1);
        bus.on('b', h2);
        bus.clearEvent('a');
        bus.emit('a');
        bus.emit('b');
        expect(h1).not.toHaveBeenCalled();
        expect(h2).toHaveBeenCalled();
    });
});

describe('debug', () => {
    it('返回监听器统计', () => {
        bus.on('a', () => {});
        bus.on('a', () => {});
        bus.on('b', () => {});
        const stats = bus.debug();
        expect(stats.a).toBe(2);
        expect(stats.b).toBe(1);
        expect(stats.__TOTAL__).toBe(3);
        expect(stats.__EVENTS__).toBe(2);
    });

    it('空 bus 返回空统计', () => {
        const stats = bus.debug();
        expect(stats.__TOTAL__).toBe(0);
        expect(stats.__EVENTS__).toBe(0);
    });
});

describe('detectLeaks', () => {
    it('无泄漏返回空数组', () => {
        bus.on('test', () => {});
        expect(bus.detectLeaks(10)).toHaveLength(0);
    });

    it('检测到泄漏', () => {
        for (let i = 0; i < 15; i++) {
            bus.on('leaky', () => {});
        }
        const leaks = bus.detectLeaks(10);
        expect(leaks).toHaveLength(1);
        expect(leaks[0].event).toBe('leaky');
        expect(leaks[0].count).toBe(15);
    });

    it('自定义阈值', () => {
        for (let i = 0; i < 5; i++) {
            bus.on('test', () => {});
        }
        expect(bus.detectLeaks(3)).toHaveLength(1);
        expect(bus.detectLeaks(10)).toHaveLength(0);
    });
});
